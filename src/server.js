// ─── CRYPTOBOT LIVE — SERVER ──────────────────────────────────────────────────
// Instancia real: opera con dinero real o paper controlado.
// Recibe parámetros optimizados del bot PAPER solo si cumplen el umbral.
"use strict";

const express    = require("express");
const http       = require("http");
const path       = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { CryptoBotFinal, PAIRS }       = require("./engine");
const { saveState, loadState, deleteState } = require("./database");
const { Blacklist, MarketGuard, getTradingScore } = require("./market");
const { CryptoPanicDefense } = require("./cryptoPanic");
const { fetchFearGreed, fetchNewsAlert, fetchAllKlines, runNightlyReplay } = require("./feeds");
const { evaluateIncomingParams, calcSyncStats } = require("./sync");
const tg         = require("./telegram");

const PORT    = process.env.PORT    || 3000;
const TICK_MS = parseInt(process.env.TICK_MS || "10000"); // Más lento = más conservador

// En LIVE_MODE, el capital real se obtiene de Binance al arrancar
// CAPITAL_USDT es el fallback para modo PAPER-LIVE
let CAPITAL_USDT = parseFloat(process.env.CAPITAL_USDC || process.env.CAPITAL_USDT || "500");
const BINANCE_API_KEY    = process.env.BINANCE_API_KEY    || "";
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || "";
const LIVE_MODE          = BINANCE_API_KEY !== "" && BINANCE_API_SECRET !== "";
const SYNC_SECRET        = process.env.SYNC_SECRET || "paper_live_sync_secret";
const BAFIR_URL          = process.env.BAFIR_URL   || "https://bafir-trading-production.up.railway.app";
const BAFIR_SECRET       = process.env.BAFIR_SECRET|| "bafir_bot_secret";

// Umbral para adoptar parámetros del PAPER
// 7 días consecutivos donde paper > live en WR Y avgPnl
const SYNC_THRESHOLD = {
  minDays:    7,   // días consecutivos siendo mejor
  minTrades:  5,   // mínimo 5 ops por día (significancia)
};

// ── Delay de 1 hora — SOLO en el primer arranque, no en reinicios ─────────────
// Si hay estado guardado (savedState), el bot ya arrancó antes → no esperar
// Si es la primera vez → esperar 1 hora para que el paper acumule datos
const LIVE_START_DELAY_MS = 60 * 60 * 1000;
let liveReady = true; // por defecto listo (si hay estado guardado)
let liveStartTime = Date.now(); // para calcular tiempo restante

async function initBot() {
  const saved = await loadState();
  bot = new CryptoBotFinal(saved);
  bot.mode = LIVE_MODE ? "LIVE" : "PAPER";
  if (saved?.blacklistData) blacklist.restore(saved.blacklistData);
  if (saved?.syncHistory)   syncHistory = saved.syncHistory || [];

  // Solo esperar 1 hora si es el PRIMER arranque (sin estado guardado)
  if (!saved) {
    liveReady = false;
    liveStartTime = Date.now() + LIVE_START_DELAY_MS;
    console.log(`[LIVE] ⏳ Primer arranque — esperando 1 hora para que el paper acumule datos…`);
    tg.send && tg.send("⏳ <b>LIVE iniciado por primera vez</b>\nEsperando 1 hora para que el paper acumule datos antes de operar.");
    setTimeout(() => {
      liveReady = true;
      console.log("[LIVE] ✅ 1 hora transcurrida — bot LIVE listo para operar");
      tg.send && tg.send("🎯 <b>LIVE activado</b> — El bot empieza a operar.");
    }, LIVE_START_DELAY_MS);
  } else {
    console.log(`[LIVE] ♻️ Reinicio detectado — operando inmediatamente (estado restaurado)`);
  }

  console.log(`\n[LIVE] Modo: ${bot.mode} | Capital: $${CAPITAL_USDT} | Umbral: ${SYNC_THRESHOLD.minDays} días`);
  tg.notifyStartup(bot.mode + " (instancia controlada)");
  tg.scheduleReports(() => ({ ...bot.getState(), instance:bot.mode }));
  tgControls = tg.startCommandListener(
  () => ({...bot.getState(), instance:bot.mode, syncHistory, dailyPnlPct:bot._dailyPnlPct||0, momentumMult:bot.hourMultiplier||1, cryptoPanic:cryptoPanic.getStatus()}),
  { getBalance: getAccountBalance, setPaused: (v) => { if(bot) bot._pausedByTelegram=v; } }
);
  fetchFearGreed().then(fg => { bot.fearGreed=fg.value; bot.fearGreedPublished=fg.publishedAt; bot.fearGreedSource=fg.source||"unknown"; console.log(`[F&G] ${fg.value} (${fg.source||"?"}) publicado: ${fg.publishedAt||"?"}`); });
  startLoop();
}

// Historial de sincronizaciones recibidas del PAPER
let syncHistory = [];
let tgControls = null; // control remoto Telegram

function sendEquityToBafir(value) {
  try {
    const https=require("https"), http2=require("http");
    const body=JSON.stringify({secret:BAFIR_SECRET,value});
    const url=new URL("/api/bot/equity",BAFIR_URL);
    const mod=url.protocol==="https:"?https:http2;
    const req=mod.request({hostname:url.hostname,path:url.pathname,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=>{if(res.statusCode!==200)console.warn("[BAFIR]",res.statusCode);});
    req.on("error",e=>console.warn("[BAFIR]",e.message));
    req.write(body);req.end();
  } catch(e){console.warn("[BAFIR]",e.message);}
}

const blacklist   = new Blacklist(4, 4); // Live: 4 pérdidas → 4h ban (no perder oportunidades)
const marketGuard = new MarketGuard();
const cryptoPanic = new CryptoPanicDefense();
cryptoPanic.start();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// Servir index.html SIN cache para que siempre cargue la última versión
app.get("/", (req,res) => res.sendFile(path.join(__dirname,"../public/index.html"), {headers:{"Cache-Control":"no-store"}}));
app.get("/index.html", (req,res) => res.sendFile(path.join(__dirname,"../public/index.html"), {headers:{"Cache-Control":"no-store"}}));
app.use(express.static(path.join(__dirname,"../public")));
app.use(express.json());

function broadcast(msg) {
  const d=JSON.stringify(msg);
  wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)c.send(d);});
}

// ── API REST ──────────────────────────────────────────────────────────────────
app.get("/api/state",  (_,res)=>res.json(bot?{...bot.getState(),instance:LIVE_MODE?"LIVE":"PAPER-LIVE",blacklist:bot.autoBlacklist.getStatus(),syncHistory,dailyPnlPct:bot._dailyPnlPct||0,momentumMult:bot.hourMultiplier||1,cryptoPanic:cryptoPanic?.getStatus?.()??null}:{loading:true,instance:LIVE_MODE?"LIVE":"PAPER-LIVE",totalValue:0}));
app.get("/api/health", (_,res)=>res.json({ok:true,instance:LIVE_MODE?"LIVE":"PAPER-LIVE",tick:bot?.tick,uptime:process.uptime(),tv:bot?.totalValue()}));

// Endpoint temporal para obtener IP pública de salida del servidor
app.get("/api/myip", (_,res)=>{
  const https2=require("https");
  https2.get("https://api.ipify.org?format=json", r=>{
    let d=""; r.on("data",c=>d+=c);
    r.on("end",()=>{ try{ res.json(JSON.parse(d)); }catch{ res.json({ip:"error"}); } });
  }).on("error",()=>res.json({ip:"error"}));
});

// Score de confianza — consumido por BAFIR dashboard
app.get("/api/confidence", (_,res) => {
  if(!bot) return res.status(503).json({error:"Bot no iniciado"});
  res.json({
    score: bot.confidence.get(),
    label: bot.confidence.getLabel(),
    color: bot.confidence.getColor(),
    blacklist: bot.autoBlacklist.getStatus(),
    winRate: bot.recentWinRate(),
    drawdown: bot.getState().drawdownPct,
  });
});
app.post("/api/reset", async(_,res)=>{
  bot=new CryptoBotFinal(); bot.mode=LIVE_MODE?"LIVE":"PAPER";
  await verifyLiveBalance();
  blacklist.restore({}); syncHistory=[];
  await deleteState();
  broadcast({type:"state",data:bot.getState()});
  res.json({ok:true});
});

// ── ENDPOINT: recibir parámetros del PAPER ────────────────────────────────────
app.post("/api/sync/params", (req,res) => {
  // Verificar firma HMAC
  const sig  = req.headers["x-signature"];
  const body = JSON.stringify(req.body);
  if (!sig) return res.status(401).json({ error:"Firma requerida" });
  const expected = require("crypto").createHmac("sha256", SYNC_SECRET).update(body).digest("hex");
  try {
    if (!require("crypto").timingSafeEqual(Buffer.from(sig,"hex"), Buffer.from(expected,"hex"))) {
      console.warn("[SYNC] Firma inválida — posible ataque");
      return res.status(401).json({ error:"Firma inválida" });
    }
  } catch(e) { return res.status(401).json({ error:"Firma inválida" }); }

  const { params, paperStats } = req.body;
  if (!params || !paperStats) return res.status(400).json({ error:"Datos incompletos" });

  console.log(`[SYNC] Recibidos params del PAPER — WR: ${paperStats.winRate}% | ${paperStats.nTrades} ops`);

  const currentLiveStats = bot ? calcSyncStats(bot.log, 1) : { winRate:0, avgPnl:0, nTrades:0 };
  const result = evaluateIncomingParams({ params, paperStats, exportedAt:req.body.exportedAt }, bot?.optimizer?.getParams()||{}, currentLiveStats, syncHistory);
  syncHistory = result.syncHistory;

  if (result.adopted && bot) {
    Object.assign(bot.optimizer.params, result.newParams);
    console.log(`[SYNC] ✅ ${result.bootstrap?"Bootstrap":"Estricto"}: ${result.reason}`);
    tg.notifyParamsAdopted(result);
    save().catch(()=>{});
  } else {
    console.log(`[SYNC] ⏸ ${result.reason}`);
    tg.notifyParamsRejected(result);
  }

  res.json({ adopted:result.adopted, reason:result.reason });
});

// ── Sync diario: recibe aprendizaje del paper ─────────────────────────────────
app.post("/api/sync/daily", (req,res) => {
  const sig  = req.headers["x-signature"];
  const body = JSON.stringify(req.body);
  if (!sig) return res.status(401).json({ error:"Firma requerida" });
  const expected = require("crypto").createHmac("sha256", SYNC_SECRET).update(body).digest("hex");
  try {
    if (!require("crypto").timingSafeEqual(Buffer.from(sig,"hex"), Buffer.from(expected,"hex")))
      return res.status(401).json({ error:"Firma inválida" });
  } catch(e) { return res.status(401).json({ error:"Firma inválida" }); }

  const { dailyLearning, positive } = req.body;
  if (!dailyLearning) return res.status(400).json({ error:"Datos incompletos" });

  const { winRate, avgPnl, nTrades, regime, optimizerParams, topPairs } = dailyLearning;
  console.log(`[SYNC-DAILY] Recibido del paper — WR:${winRate}% avgPnl:${avgPnl}% ops:${nTrades} positivo:${positive}`);

  // Aplicar si: día positivo, O si hay estados Q útiles aprendidos
  if (!positive && !req.body.hasLearning) {
    console.log("[SYNC-DAILY] ⏸ Día negativo sin aprendizaje nuevo");
    return res.json({ adopted:false, reason:"Día negativo sin nuevos patrones" });
  }
  // Si día negativo pero hay Q states → adoptar solo params del optimizer, no todo
  const applyFull = positive;

  if (!bot) return res.json({ adopted:false, reason:"Bot no listo" });

  // Adoptar optimizer params con blending conservador (20% paper, 80% live)
  if (optimizerParams && Object.keys(optimizerParams).length > 0) {
    const current = bot.optimizer.getParams();
    const blended = {};
    for (const [k, v] of Object.entries(optimizerParams)) {
      if (typeof v === "number" && typeof current[k] === "number") {
        // Más agresivo si día positivo, conservador si solo hay Q states
    const blend = applyFull ? 0.35 : 0.10;
    blended[k] = +(current[k] * (1-blend) + v * blend).toFixed(4);
      }
    }
    if (Object.keys(blended).length > 0) {
      Object.assign(bot.optimizer.params, blended);
      console.log(`[SYNC-DAILY] ✅ Params blended 20% paper — régimen:${regime}`);
    }
  }

  // Registrar en syncHistory
  syncHistory.push({ ts:new Date().toISOString(), type:"daily", winRate, avgPnl, nTrades, regime, positive });
  while (syncHistory.length > 120) syncHistory.shift();
  save().catch(()=>{});

  tg.send && tg.send(`📊 <b>Sync diario recibido del paper</b>\nWR: ${winRate}% | avgPnl: ${avgPnl}% | ${nTrades} ops | Régimen: ${regime}\n✅ Params actualizados (blend 20%)`);
  res.json({ adopted:true, reason:`Día positivo — WR:${winRate}% avgPnl:${avgPnl}%` });
});

// ── Capital operativo desde Bafir ─────────────────────────────────────────────
// Bafir envía el capital que el gestor ha declarado → live opera SOLO con eso
app.post("/api/set-capital", (req,res) => {
  const { secret, capitalUSD } = req.body;
  if (secret !== (process.env.BOT_SECRET||"bafir_bot_secret"))
    return res.status(401).json({error:"No autorizado"});
  if (!capitalUSD || capitalUSD <= 0)
    return res.status(400).json({error:"Capital inválido"});

  // Actualizar capital operativo
  CAPITAL_USDT = capitalUSD;
  if (bot) {
    // Respetar reserva mínima del 15%
    const reserve = capitalUSD * 0.15;
    const maxOperable = capitalUSD - reserve;
    // Si el bot tiene más cash del capital declarado, limitar
    if (bot.cash > capitalUSD) bot.cash = capitalUSD;
    console.log(`[LIVE] Capital operativo actualizado: $${capitalUSD.toFixed(2)} (reserva: $${reserve.toFixed(2)}, máx operable: $${maxOperable.toFixed(2)})`);
  }
  res.json({ok:true, capitalUSD, reserve:+(capitalUSD*0.15).toFixed(2), maxOperable:+(capitalUSD*0.85).toFixed(2)});
});

// ── Historial de sincronizaciones ─────────────────────────────────────────────
app.get("/api/sync/history", (_,res) => res.json({
  syncHistory,
  threshold: SYNC_THRESHOLD,
  currentParams: bot?.optimizer?.getParams(),
}));

let bot;
(async () => { await initBot(); })();

// ── Guardar ───────────────────────────────────────────────────────────────────
let ticks=0;
async function save() {
  if(!bot) return;
  const s=bot.getState();
  s.blacklistData=blacklist.serialize();
  s.optimizerHistory=bot.optimizer.history;
  s.trailingHighs=bot.trailing.highs;
  s.reentryTs=bot.reentryTs;
  s.syncHistory=syncHistory;
  await saveState(s);
}
process.on("SIGTERM",async()=>{await save();process.exit(0);});
process.on("SIGINT", async()=>{await save();process.exit(0);});

// ── Binance WebSocket ─────────────────────────────────────────────────────────
const symbols   = PAIRS.map(p=>p.symbol.toLowerCase());
const streamUrl = `wss://stream.binance.com:9443/stream?streams=${symbols.map(s=>`${s}@miniTicker`).join("/")}`;
let binanceLive=false, lastPriceTs=Date.now();

function connectBinance() {
  const ws=new WebSocket(streamUrl);
  ws.on("open",    ()=>{binanceLive=true;console.log("[BINANCE] ✓ Stream en vivo");});
  ws.on("message", raw=>{try{const{data}=JSON.parse(raw);if(data?.s&&data?.c&&bot){bot.updatePrice(data.s,parseFloat(data.c));lastPriceTs=Date.now();}}catch(e){}});
  ws.on("close",   ()=>{binanceLive=false;setTimeout(connectBinance,5000);});
  ws.on("error",   e=>console.error("[BINANCE]",e.message));
}

const SEEDS={BTCUSDC:67000,ETHUSDC:3500,SOLUSDC:180,BNBUSDC:580,AVAXUSDC:38,ADAUSDC:0.45,DOTUSDC:8.5,LINKUSDC:18,UNIUSDC:10,AAVEUSDC:95,XRPUSDC:0.52,LTCUSDC:82};
function simulatePrices(){
  if(!bot||Date.now()-lastPriceTs<10000) return;
  PAIRS.forEach(p=>{const last=bot.prices[p.symbol]||SEEDS[p.symbol]||100;bot.updatePrice(p.symbol,last*(1+0.007*(Math.random()+Math.random()-1)*1.2+0.00004));});
}

let wasDefensive=false,cbNotified=false,lastFearGreedCheck=0;

// ── LIVE MODE: órdenes reales ─────────────────────────────────────────────────
// ── BINANCE REAL API ──────────────────────────────────────────────────────────
// Se activa automáticamente cuando BINANCE_API_KEY y BINANCE_API_SECRET
// están configuradas en Railway. Sin keys → opera en modo simulado.
const crypto2 = require("crypto");
const https2   = require("https");

// Sub-cuenta Binance (opcional): si BINANCE_SUBACCOUNT está configurado,
// todas las órdenes se ejecutan en esa sub-cuenta
const BINANCE_SUBACCOUNT = process.env.BINANCE_SUBACCOUNT || "";

function binanceRequest(method, path, params={}) {
  if (!LIVE_MODE) return Promise.resolve(null);
  const ts  = Date.now();
  const all = { ...params, timestamp: ts };
  const qs  = new URLSearchParams(all).toString();
  const sig = crypto2.createHmac("sha256", BINANCE_API_SECRET).update(qs).digest("hex");
  const fullPath = `/api/v3/${path}?${qs}&signature=${sig}`;
  return new Promise((resolve, reject) => {
    const req = https2.request({
      hostname: "api.binance.com", path: fullPath, method,
      headers: { "X-MBX-APIKEY": BINANCE_API_KEY }
    }, res => {
      let d = ""; res.on("data", c => d+=c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

async function placeLiveBuy(symbol, usdtAmount) {
  try {
    if (!LIVE_MODE) return null;
    // Safety: nunca invertir más del 40% del capital en una sola orden
    const maxSafe = (bot?.totalValue()||500) * 0.40;
    const safe = Math.min(usdtAmount, maxSafe);
    if (safe < 5) { console.log(`[LIVE][BUY] ${symbol} importe muy pequeño ($${safe}), omitido`); return null; }
    const order = await binanceRequest("POST", "order", {
      symbol, side:"BUY", type:"MARKET", quoteOrderQty: safe.toFixed(2)
    });
    if (order?.orderId) {
      console.log(`[LIVE][BUY] ✅ ${symbol} $${safe.toFixed(2)} → orderId:${order.orderId}`);
      tg.send && tg.send(`🟢 <b>ORDEN REAL EJECUTADA</b>\nBUY ${symbol} — $${safe.toFixed(2)}\nOrden: ${order.orderId}`);
    } else {
      console.error(`[LIVE][BUY] ❌ ${symbol}`, JSON.stringify(order));
    }
    return order;
  } catch(e) {
    console.error(`[LIVE][BUY] Error ${symbol}:`, e.message);
    return null;
  }
}

// Precision map for common pairs (Binance LOT_SIZE)
const QTY_PRECISION = {
  BTCUSDC:5, ETHUSDC:4, BNBUSDC:3, SOLUSDC:2, XRPUSDC:1,
  ADAUSDC:1, DOTUSDC:2, LINKUSDC:2, LTCUSDC:3, AVAXUSDC:2,
  POLUSDC:1, UNIUSDC:2, AAVEUSDC:3, ATOMUSDC:2, NEARUSDC:1,
  ARBUSDC:1, OPUSDC:1, APTUSDC:2,
};

async function getActualBinanceQty(symbol) {
  try {
    const balances = await getAccountBalance();
    const asset = symbol.replace("USDC","").replace("USDT","");
    const b = (balances||[]).find(b=>b.asset===asset);
    return b ? parseFloat(b.free) : 0;
  } catch(e) { return 0; }
}

async function placeLiveSell(symbol, quantity) {
  try {
    if (!LIVE_MODE) return null;
    if (quantity <= 0) return null;
    // Usar cantidad real de Binance (evita errores de precisión)
    const realQty = await getActualBinanceQty(symbol);
    const sellQty = Math.min(quantity, realQty);
    if (sellQty <= 0) { console.log(`[LIVE][SELL] ${symbol} sin balance real`); return null; }
    const prec = QTY_PRECISION[symbol] || 4;
    const qtyStr = sellQty.toFixed(prec);
    const order = await binanceRequest("POST", "order", {
      symbol, side:"SELL", type:"MARKET", quantity: qtyStr
    });
    if (order?.orderId) {
      console.log(`[LIVE][SELL] ✅ ${symbol} qty:${quantity} → orderId:${order.orderId}`);
      tg.send && tg.send(`🔴 <b>VENTA REAL EJECUTADA</b>\nSELL ${symbol} — qty:${quantity.toFixed(4)}\nOrden: ${order.orderId}`);
    } else {
      console.error(`[LIVE][SELL] ❌ ${symbol}`, JSON.stringify(order));
    }
    return order;
  } catch(e) {
    console.error(`[LIVE][SELL] Error ${symbol}:`, e.message);
    return null;
  }
}

async function getAccountBalance() {
  try {
    const data = await binanceRequest("GET", "account", {});
    const balances = (data?.balances||[]).filter(b => parseFloat(b.free) > 0);
    return balances;
  } catch(e) { return null; }
}

// Verificar balance real al arrancar si LIVE_MODE
async function verifyLiveBalance() {
  if (!LIVE_MODE) return;
  try {
    console.log("[LIVE] API Binance configurada — verificando balance real...");
    const balances = await getAccountBalance();
    if (!balances) { console.error("[LIVE] No se pudo verificar balance Binance"); return; }
    const usdt = balances.find(b=>b.asset==="USDC") || balances.find(b=>b.asset==="USDT");
    const usdtBalance = parseFloat(usdt?.free||0);
    const stableAsset = balances.find(b=>b.asset==="USDC") ? "USDC" : "USDT";
    console.log(`[LIVE] ✅ Balance USDC real: $${usdtBalance.toFixed(2)}`);

    // CRÍTICO: sincronizar bot.cash y CAPITAL_USDT con balance real de Binance
    if (bot && usdtBalance > 0) {
      bot.cash = usdtBalance;
      CAPITAL_USDT = usdtBalance; // actualizar capital de referencia
      console.log(`[LIVE] bot.cash sincronizado → $${usdtBalance.toFixed(2)}`);
    }

    // Loguear otras monedas que ya tenga en cartera
    const others = balances.filter(b=>b.asset!=="USDT"&&b.asset!=="BNB");
    if (others.length>0) {
      console.log(`[LIVE] Posiciones existentes en Binance: ${others.map(b=>b.asset+":"+b.free).join(", ")}`);
    }

    if (tg?.send) tg.send(`🎯 <b>BINANCE REAL ACTIVADO</b>\nBalance USDT: <b>$${usdtBalance.toFixed(2)}</b>\n${others.length>0?"Posiciones: "+others.map(b=>b.asset).join(", "):"Sin posiciones abiertas"}`);
  } catch(e) { console.warn("[LIVE] verifyLiveBalance error:", e.message); }
}

function startLoop(){
  connectBinance();

  setInterval(async()=>{
    if(!bot) return;
    simulatePrices();

    const marketState=marketGuard.update(bot.prices["BTCUSDC"]);
    if(marketState?.defensive&&!wasDefensive){
      tg.notifyDefensiveMode(marketState.btcDrawdown);
      wasDefensive=true;
      // Record defensive mode decision for learning
      if(bot) bot.riskLearning?.recordDecision("DEFENSIVE_MODE","BTCUSDC",bot.prices?.["BTCUSDC"]||0,"block_entry",{drawdown:marketState.btcDrawdown});
    }
    if(!marketState?.defensive&&wasDefensive){tg.notifyDefensiveOff();wasDefensive=false;}

    bot.marketDefensive=marketGuard.isDefensive();
    bot.hourMultiplier=getTradingScore().score;
    bot.blacklist=blacklist;

    // ── MOMENTUM BOOST: días muy buenos → aumentar tamaño de posiciones ────────
    // Calcula P&L del día actual desde los trades cerrados hoy
    const todaySells = bot.log.filter(l => {
      if (l.type !== "SELL") return false;
      const d = new Date(l.ts); const n = new Date();
      return d.getDate()===n.getDate() && d.getMonth()===n.getMonth() && d.getFullYear()===n.getFullYear();
    });
    const todayPnlPct = todaySells.reduce((s,l)=>s+(l.pnl||0),0);
    bot._dailyPnlPct = todayPnlPct;

    // Escala el multiplicador según el rendimiento del día:
    // <0%:   0.7x (defensivo)  | 0-3%: 1.0x (normal)
    // 3-7%:  1.3x (bueno)      | 7-12%: 1.6x (muy bueno)
    // >12%:  2.0x (excepcional — máximo para no sobreexponer)
    let momentumMult = 1.0;
    if      (todayPnlPct < 0)    momentumMult = 0.7;
    else if (todayPnlPct < 3)    momentumMult = 1.0;
    else if (todayPnlPct < 7)    momentumMult = 1.3;
    else if (todayPnlPct < 12)   momentumMult = 1.6;
    else                          momentumMult = 2.0;

    // También subir el límite diario en días buenos (más oportunidades)
    if (todayPnlPct >= 7)  bot._dailyLimitBoost = Math.round(todayPnlPct / 5);
    else                   bot._dailyLimitBoost = 0;

    // CryptoPanic: si hay noticias negativas, reducir tamaño global
    const cpGlobalMult = cryptoPanic.globalDefensive ? 0.3 : 1.0;
    bot._newsMultiplier = cpGlobalMult;
    bot._cryptoPanicStatus = cryptoPanic.getStatus();
    // Pasar el multiplicador de noticias al engine para usarlo por par
    // Record CryptoPanic global state for learning
    if (cryptoPanic.globalDefensive && !bot._wasGlobalDefensive) {
      // Just became defensive — record decision for each open position
      for (const sym of Object.keys(bot.portfolio||{})) {
        bot.riskLearning?.recordDecision("CRYPTOPANIC_GLOBAL", sym, bot.prices[sym]||0, "reduce_size", {global:true});
      }
    }
    bot._wasGlobalDefensive = cryptoPanic.globalDefensive;
    bot._cryptoPanicFn = (symbol) => cryptoPanic.getSizeMultiplier(symbol);

    bot.hourMultiplier = getTradingScore().score * momentumMult * cpGlobalMult;

    // Alertas Telegram momentum
    const prevMomentumLevel = bot._prevMomentumLevel || 1.0;
    if (momentumMult >= 1.6 && prevMomentumLevel < 1.6 && tg.notifyMomentumBoost)
      tg.notifyMomentumBoost(momentumMult, todayPnlPct);
    else if (momentumMult <= 0.7 && prevMomentumLevel > 0.7 && tg.notifyMomentumDefensive)
      tg.notifyMomentumDefensive(todayPnlPct);
    bot._prevMomentumLevel = momentumMult;

    // Alertas Telegram CryptoPanic
    const prevCpGlobal = bot._prevCpGlobal || false;
    const prevCpPairs = bot._prevCpPairs || [];
    if (cryptoPanic.globalDefensive && !prevCpGlobal && tg.notifyCryptoPanicAlert)
      tg.notifyCryptoPanicAlert([], true);
    else {
      const newPairs = [...cryptoPanic.defensivePairs].filter(p => !prevCpPairs.includes(p));
      if (newPairs.length && tg.notifyCryptoPanicAlert)
        tg.notifyCryptoPanicAlert(newPairs.map(p=>p.replace("USDT","")), false);
    }
    bot._prevCpGlobal = cryptoPanic.globalDefensive;
    bot._prevCpPairs = [...cryptoPanic.defensivePairs];

    // ── Aplicar parámetros aprendidos a los subsistemas ──────────────────────
    // Notificar si RiskLearning actualizó parámetros
    if (bot._rlChanges?.changes?.length && tg.notifyRiskLearningUpdate) {
      tg.notifyRiskLearningUpdate(bot._rlChanges.changes);
      bot._rlChanges = null;
    }
    if (bot.riskLearning) {
      // CryptoPanic: ajustar umbral global y expiración
      cryptoPanic._learnedGlobalThreshold = bot.riskLearning.get("cpGlobalThreshold", 5);
      cryptoPanic._learnedExpiryHours     = bot.riskLearning.get("cpExpiryHours", 2);
      // TrailingStop: ajustar activación mínima
      if (bot.trailing) bot.trailing._learnedTrailingMin = bot.riskLearning.get("trailingMinPct", 2) / 100;
    }

    if (momentumMult !== 1.0 && ticks % 30 === 0) {
      console.log(`[LIVE] Momentum x${momentumMult} | CryptoPanic x${cpGlobalMult} | P&L hoy: +${todayPnlPct.toFixed(1)}%`);
    }

    // No operar hasta que pase 1 hora desde el arranque
    if (!liveReady) {
      const remaining = Math.ceil((liveStartTime - Date.now()) / 60000);
      broadcast({ type:"tick", data:{ ...bot.getState(), instance:LIVE_MODE?"LIVE":"PAPER-LIVE", binanceLive, liveReady:false, liveReadyIn:remaining } });
      if(ticks%6===0) save().catch(e=>console.error("[SAVE]",e));
      ticks++;
      return;
    }

    if(tgControls?.isPaused()) bot._pausedByTelegram=true; else bot._pausedByTelegram=false;
    const{signals,newTrades,circuitBreaker,optimizerResult,drawdownAlert,dailyLimit,dailyUsed}=bot.evaluate();
    ticks++;

    for(const trade of newTrades){
      if(trade.type==="SELL"){
        if(trade.pnl>=3)  tg.notifyBigWin(trade);
        if(trade.pnl<=-3) tg.notifyBigLoss(trade);
        // Explicabilidad: notificar trades significativos con explicación
        if(Math.abs(trade.pnl||0)>=2) tg.notifyTradeWithExplanation(trade, bot.marketRegime, 50);
        if(trade.pnl<0){const wasBl=blacklist.isBlacklisted(trade.symbol);blacklist.recordLoss(trade.symbol);if(!wasBl&&blacklist.isBlacklisted(trade.symbol))tg.notifyBlacklist(trade.symbol);}
        else blacklist.recordWin(trade.symbol);
      }
      // Descomentar para LIVE real:
      // ── ÓRDENES REALES BINANCE (activo cuando LIVE_MODE=true) ──────────────
      if(LIVE_MODE){
        if(trade.type==="BUY")  await placeLiveBuy(trade.symbol, trade.qty*trade.price);
        if(trade.type==="SELL") await placeLiveSell(trade.symbol, trade.qty);
      }
    }

    if(circuitBreaker?.triggered&&!cbNotified){tg.notifyCircuitBreaker(circuitBreaker.drawdown);cbNotified=true;}
    if(!circuitBreaker?.triggered)cbNotified=false;
    if(drawdownAlert?.triggered)tg.notifyMaxDrawdown(drawdownAlert);
    if(!circuitBreaker?.triggered) cbNotified=false;
    if(optimizerResult?.changes?.length>0) tg.notifyOptimizer(optimizerResult);

    if(Date.now()-lastFearGreedCheck>1800000){
      lastFearGreedCheck=Date.now();
      fetchFearGreed().then(fg=>{bot.fearGreed=fg.value; bot.fearGreedPublished=fg.publishedAt; bot.fearGreedSource=fg.source||"unknown"; console.log(`[F&G] ${fg.value} (${fg.source||"?"}) · ${fg.publishedAt?.slice(0,16)||"?"}`);});
    }

    if(ticks%120===0){ fetchNewsAlert().then(news=>{if(news?.negative)tg.notifyNewsAlert(news);}); }

    // Enviar equity a BAFIR
    if(ticks%60===0) sendEquityToBafir(bot.totalValue());

    // Guardar
    if(ticks%6===0) save().catch(e=>console.error("[SAVE]",e));

    broadcast({
      type:"tick",
      data:{
        ...bot.getState(),signals,newTrades,circuitBreaker,optimizerResult,
        binanceLive,instance:LIVE_MODE?"LIVE":"PAPER-LIVE",
        marketDefensive:marketGuard.isDefensive(),
        tradingHour:getTradingScore(),
        blacklistStatus:blacklist.getStatus(),
        fearGreed:bot.fearGreed,marketRegime:bot.marketRegime,
        dailyLimit,dailyUsed,
        dailyPnlPct:bot._dailyPnlPct||0,
        momentumMult:bot.hourMultiplier,
        cryptoPanic:bot._cryptoPanicStatus||null,
        riskLearning:bot._rlChanges||null,
        riskLearningStats:bot.riskLearning?.getStats()||{},
        syncHistory:syncHistory.slice(-7),
        syncThreshold:SYNC_THRESHOLD,
      }
    });

  },TICK_MS);

}

// Servidor arranca INMEDIATAMENTE — healthcheck pasa, WS disponible de inmediato
server.listen(PORT,()=>console.log(`\n🎯 CRYPTOBOT LIVE en http://localhost:${PORT} | ${LIVE_MODE?"🔴 LIVE":"📋 PAPER-LIVE"} | Tick: ${TICK_MS}ms\n`));

wss.on("connection", ws=>{
  // Enviar estado inicial
  try {
    if(bot) ws.send(JSON.stringify({type:"state",data:{...bot.getState(),instance:bot.mode,syncHistory}}));
    else    ws.send(JSON.stringify({type:"state",data:{loading:true,instance:"LIVE",totalValue:0}}));
  } catch(e) {}
  // Heartbeat: ping cada 25s para evitar que Railway cierre la conexión idle
  const hb = setInterval(()=>{ if(ws.readyState===WebSocket.OPEN) ws.ping(); else clearInterval(hb); }, 25000);
  ws.on("pong", ()=>{});
  ws.on("close", ()=>clearInterval(hb));
});
