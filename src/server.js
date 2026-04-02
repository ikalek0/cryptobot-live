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
const { PaperShadow } = require("./paperShadow");
const { ClientBotManager } = require("./clientManager");
const clientManager = new ClientBotManager();
const { runIntradayWalkForward } = require("./backtest");
const shadow = new PaperShadow();
const { fetchFearGreed, calcRealtimeFearGreed, fgCalibrator, fetchNewsAlert, fetchAllKlines, runNightlyReplay, fetchLongShortRatio, fetchFundingRate, fetchOpenInterest, fetchTakerVolume, fetchRedditSentiment } = require("./feeds");
const { evaluateIncomingParams, calcSyncStats } = require("./sync");
const tg         = require("./telegram");

const PORT    = process.env.PORT    || 3000;
const TICK_MS = parseInt(process.env.TICK_MS || "10000"); // Más lento = más conservador

// En LIVE_MODE, el capital real se obtiene de Binance al arrancar
// CAPITAL_USDT es el fallback para modo PAPER-LIVE
let CAPITAL_USDT = parseFloat(process.env.CAPITAL_USDC || process.env.CAPITAL_USDT || "100");
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
  tg.testTelegram && tg.testTelegram();
  tg.scheduleReports(() => ({ ...bot.getState(), instance:bot.mode }));
  tgControls = tg.startCommandListener(
  () => ({...bot.getState(), instance:bot.mode, syncHistory, dailyPnlPct:bot._dailyPnlPct||0, momentumMult:bot.hourMultiplier||1, cryptoPanic:cryptoPanic.getStatus()}),
  { getBalance: getAccountBalance, setPaused: (v) => { if(bot) bot._pausedByTelegram=v; } }
);
  fetchFearGreed().then(fg => { bot.fearGreed=fg.value; bot.fearGreedPublished=fg.publishedAt; bot.fearGreedSource=fg.source||"unknown"; console.log(`[F&G] ${fg.value} (${fg.source||"?"}) publicado: ${fg.publishedAt||"?"}`); });

  // CRÍTICO: limpiar estado huérfano ANTES de empezar el loop
  // Esto evita que el circuit breaker se dispare por estados corruptos de DB
  if(LIVE_MODE) {
    await verifyLiveBalance();
    // Resetear el circuit breaker después de limpiar el estado
    // (el CB puede haberse disparado por el estado corrupto)
    if(bot.breaker) {
      bot.breaker.reset && bot.breaker.reset();
      bot._cbResetOnStart = true;
      console.log("[LIVE] Circuit breaker reseteado tras verificación de balance");
    }
  }
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
app.get("/api/summary", (_,res) => {
  if(!bot) return res.json({loading:true, instance:"LIVE"});
  const s = bot.getState();
  // Lightweight summary for Bafir dashboard — avoids sending full log/history
  res.json({
    instance:   "LIVE",
    totalValue: s.totalValue||0,
    cash:       s.cash||0,
    returnPct:  s.returnPct||0,
    winRate:    s.winRate||0,
    tick:       s.tick||0,
    marketRegime:    s.marketRegime||"UNKNOWN",
    fearGreed:       s.fearGreed||50,
    fearGreedSource: s.fearGreedSource||null,
    dailyPnlPct:     bot._dailyPnlPct||0,
    momentumMult:    bot.hourMultiplier||1,
    openPositions:   Object.keys(s.portfolio||{}).length,
    recentTrades:    (s.log||[]).filter(l=>l.type==="SELL").slice(0,10),
    circuitBreaker:  s.circuitBreaker||null,
    cryptoPanic:     s.cryptoPanic||null,
    confidence:      s.confidence||null,
    longShortRatio:  s.longShortRatio||null,
    fundingRate:     s.fundingRate||null,
    drawdownPct:     s.drawdownPct||0,
    winStreak:       s.winStreak||0,
    dailyLimit:      s.dailyLimit||0,
    dailyTrades:     s.dailyTrades||null,
    equity:          (s.equity||[]).slice(-60),   // last hour only
    loading:         false,
  });
});

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

// Check EGRESS IP (what external services like Binance actually see)
app.get("/api/myip-egress", (_,res)=>{
  const https2=require("https");
  // Use multiple services to cross-check
  const check = (url, cb) => {
    https2.get(url, r=>{
      let d=""; r.on("data",c=>d+=c);
      r.on("end",()=>{ try{ cb(JSON.parse(d)); }catch{ cb({error:"parse fail"}); } });
    }).on("error",e=>cb({error:e.message}));
  };
  check("https://api.ipify.org?format=json", ipify => {
    check("https://api64.ipify.org?format=json", ipify64 => {
      res.json({
        ipify_v4: ipify?.ip || ipify,
        ipify_v64: ipify64?.ip || ipify64,
        note: "These are the egress IPs Railway uses for outbound HTTPS requests",
        binanceNote: "Add ALL of these to your Binance API whitelist"
      });
    });
  });
});

// ScoreScore de confianza — consumido por BAFIR dashboard
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
// Reset endpoint eliminado por seguridad — no exponer esta funcionalidad

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
// ── Paper Shadow sync ──────────────────────────────────────────────────────────
// Paper notifica a live cuando abre/cierra una posición
app.post("/api/shadow/entry", (req,res) => {
  const {secret, symbol, entryPrice, strategy, regime, stateKey} = req.body;
  if(secret !== (process.env.BOT_SECRET||"bafir_bot_secret")) return res.status(401).json({error:"Unauthorized"});
  shadow.shadowEntry(symbol, entryPrice, strategy, regime, stateKey);
  res.json({ok:true, adopted: shadow.shouldExecute(strategy, regime), confidence: shadow.getConfidence(strategy, regime)});
});

app.post("/api/shadow/exit", (req,res) => {
  const {secret, symbol, exitPrice, pnl} = req.body;
  if(secret !== (process.env.BOT_SECRET||"bafir_bot_secret")) return res.status(401).json({error:"Unauthorized"});
  shadow.shadowExit(symbol, exitPrice, pnl);
  res.json({ok:true, stats: shadow.getStats()});
});

app.get("/api/shadow/status", (req,res) => {
  res.json(shadow.getStats());
});

// ── Alert config from Bafir ────────────────────────────────────────────────────
app.post("/api/set-alert-config", (req,res) => {
  const {secret, alertConfig} = req.body;
  if(secret !== (process.env.BOT_SECRET||"bafir_bot_secret")) return res.status(401).json({error:"No autorizado"});
  if(alertConfig) {
    global._alertConfig = alertConfig;
    console.log(`[ALERT-CFG] Win: ${alertConfig.winPct}% Loss: ${alertConfig.lossPct}%`);
  }
  res.json({ok:true});
});

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
// ── Transfer learning: recibe pesos DQN y Q-table del paper ─────────────────
app.post("/api/sync/transfer", (req,res) => {
  const sig = req.headers["x-signature"];
  const body = JSON.stringify(req.body);
  if(!sig) return res.status(401).json({error:"Firma requerida"});
  const expected = require("crypto").createHmac("sha256", SYNC_SECRET).update(body).digest("hex");
  try {
    if(!require("crypto").timingSafeEqual(Buffer.from(sig,"hex"), Buffer.from(expected,"hex")))
      return res.status(401).json({error:"Firma inválida"});
  } catch(e) { return res.status(401).json({error:"Firma inválida"}); }

  if(!bot) return res.status(503).json({error:"Bot no listo"});
  const { dqnWeights, qTable, paperStats } = req.body;
  if(!dqnWeights && !qTable) return res.status(400).json({error:"Sin datos"});

  const wr = paperStats?.winRate||0;
  const trades = paperStats?.nTrades||0;

  // Solo transferir si paper tiene suficiente experiencia y buen WR
  if(trades < 50) return res.json({adopted:false, reason:`Paper solo tiene ${trades} trades (mínimo 50)`});
  if(wr < 30) return res.json({adopted:false, reason:`WR paper ${wr}% muy bajo para transferir`});

  // Registrar WR del live ANTES de la transferencia para medir impacto después
  const liveSells = (bot.log||[]).filter(l=>l.type==="SELL");
  const liveWrBefore = liveSells.length >= 10
    ? Math.round(liveSells.slice(-20).filter(l=>l.pnl>0).length / Math.min(20, liveSells.length) * 100)
    : null;
  bot._transferHistory = bot._transferHistory || [];
  const transferRecord = {
    ts: new Date().toISOString(),
    paperWR: wr, paperTrades: trades,
    liveWRbefore: liveWrBefore,
    liveWRafter: null,  // se rellena 2h después
    blend: Math.min(0.4, trades/500),
    improved: null,
  };
  bot._transferHistory.push(transferRecord);
  if(bot._transferHistory.length > 20) bot._transferHistory.shift();
  // Ajustar blend según historial de transferencias anteriores
  const goodTransfers = (bot._transferHistory||[]).filter(t=>t.improved===true).length;
  const badTransfers  = (bot._transferHistory||[]).filter(t=>t.improved===false).length;
  const totalEval = goodTransfers + badTransfers;
  let adaptiveBlend = Math.min(0.4, trades/500);
  if(totalEval >= 3) {
    const successRate = goodTransfers / totalEval;
    adaptiveBlend = Math.max(0.05, Math.min(0.50, adaptiveBlend * successRate * 2));
    console.log(`[TRANSFER] Blend adaptativo: ${(adaptiveBlend*100).toFixed(0)}% (${goodTransfers}/${totalEval} transferencias mejoraron)`);
  }
  transferRecord.blend = adaptiveBlend;

  let transferred = [];

  // Transferir pesos DQN (blend 30% paper, 70% live para no perder lo aprendido en live)
  if(dqnWeights && bot.dqn) {
    try {
      const BLEND = Math.min(0.4, trades/500); // más trades = más confianza en paper
      const blendWeights = (live, paper) => {
        if(!live || !paper || live.length !== paper.length) return live;
        return live.map((v, i) => v * (1-BLEND) + paper[i] * BLEND);
      };
      if(dqnWeights.W1) bot.dqn.W1 = blendWeights(bot.dqn.W1, dqnWeights.W1);
      if(dqnWeights.W2) bot.dqn.W2 = blendWeights(bot.dqn.W2, dqnWeights.W2);
      if(dqnWeights.W3) bot.dqn.W3 = blendWeights(bot.dqn.W3, dqnWeights.W3);
      if(dqnWeights.b1) bot.dqn.b1 = blendWeights(bot.dqn.b1, dqnWeights.b1);
      if(dqnWeights.b2) bot.dqn.b2 = blendWeights(bot.dqn.b2, dqnWeights.b2);
      if(dqnWeights.b3) bot.dqn.b3 = blendWeights(bot.dqn.b3, dqnWeights.b3);
      transferred.push(`DQN (blend ${(BLEND*100).toFixed(0)}%)`);
    } catch(e) { console.warn("[TRANSFER] DQN error:", e.message); }
  }

  // Transferir Q-table (merge: mantener lo de live, añadir estados nuevos del paper)
  if(qTable && bot.qLearning?.q) {
    try {
      let newStates = 0;
      for(const [state, actions] of Object.entries(qTable)) {
        if(!bot.qLearning.q[state]) {
          bot.qLearning.q[state] = actions; // nuevo estado del paper
          newStates++;
        } else {
          // Blend existing states
          for(const [action, val] of Object.entries(actions)) {
            if(bot.qLearning.q[state][action] != null) {
              bot.qLearning.q[state][action] = bot.qLearning.q[state][action]*0.7 + val*0.3;
            } else {
              bot.qLearning.q[state][action] = val;
            }
          }
        }
      }
      transferred.push(`Q-table (+${newStates} estados nuevos)`);
    } catch(e) { console.warn("[TRANSFER] Q-table error:", e.message); }
  }

  const msg = `✅ Transfer learning: ${transferred.join(", ")} | paper WR:${wr}% trades:${trades} | blend:${(adaptiveBlend*100).toFixed(0)}%`;
  console.log(`[TRANSFER] ${msg}`);
  tg.send && tg.send(`🧠 <b>[LIVE] Transfer learning recibido</b>\n${msg}\n<i>Midiendo impacto en 2h...</i>`);

  // Evaluar impacto 2h después
  setTimeout(() => {
    if(!bot) return;
    const afterSells = (bot.log||[]).filter(l=>l.type==="SELL");
    const liveWrAfter = afterSells.length >= 10
      ? Math.round(afterSells.slice(-20).filter(l=>l.pnl>0).length / Math.min(20, afterSells.length) * 100)
      : null;
    // Buscar el registro de esta transferencia
    const rec = (bot._transferHistory||[]).find(t=>t.liveWRafter===null && t.liveWRbefore!==null);
    if(rec && liveWrAfter !== null && rec.liveWRbefore !== null) {
      rec.liveWRafter = liveWrAfter;
      rec.improved = liveWrAfter >= rec.liveWRbefore;
      const delta = liveWrAfter - rec.liveWRbefore;
      const verdict = rec.improved ? `✅ Mejoró +${delta}%` : `❌ Empeoró ${delta}%`;
      console.log(`[TRANSFER] Evaluación 2h: WR antes=${rec.liveWRbefore}% después=${liveWrAfter}% → ${verdict}`);
      tg.send && tg.send(
        `📊 <b>[LIVE] Evaluación transfer learning</b>\n` +
        `WR antes: ${rec.liveWRbefore}% → después: ${liveWrAfter}%\n` +
        `${verdict}\n` +
        (rec.improved
          ? `El blend del paper aumentará en la próxima transferencia`
          : `El blend del paper se reducirá — el live confía menos en estos pesos`)
      );
      save().catch(()=>{});
    }
  }, 2 * 60 * 60 * 1000); // 2 horas

  save().catch(()=>{});
  res.json({adopted:true, transferred, blend: adaptiveBlend});
});

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
  if(bot.multiAgent)    s.multiAgentData = bot.multiAgent.serialize();
  if(bot.adaptiveStop)   s.adaptiveStop   = bot.adaptiveStop.serialize();
  if(bot.adaptiveHours)  s.adaptiveHours  = bot.adaptiveHours.serialize();
  if(bot.newsLearner)    s.newsLearner    = bot.newsLearner.serialize();
  if(bot.regimeDetector) s.regimeDetector = bot.regimeDetector.serialize();
  if(bot._transferHistory) s.transferHistory = bot._transferHistory;
  await saveState(s);
}
process.on("SIGTERM",async()=>{await save();process.exit(0);});
process.on("SIGINT", async()=>{await save();process.exit(0);});

// ── Capturar errores no manejados para evitar crashes silenciosos ─────────────
process.on("uncaughtException", (err) => {
  console.error("[CRASH] uncaughtException:", err.message);
  console.error(err.stack);
  // Guardar estado antes de reiniciar
  save().catch(()=>{}).finally(()=>{
    // No salimos - Railway reiniciará si el proceso muere
    // pero intentamos seguir corriendo
  });
});
process.on("unhandledRejection", (reason) => {
  console.error("[CRASH] unhandledRejection:", reason?.message||reason);
  // No salimos - solo logueamos
});

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

// ── TWAP: divide orden en partes para reducir slippage ───────────────────────
// Pares ilíquidos (ARB, OP, NEAR, APT) → 3 partes con 30s entre ellas
// Pares principales (BTC, ETH, SOL, BNB) → 1 sola orden (alta liquidez)
const ILLIQUID_PAIRS = ["OPUSDC","ARBUSDC","NEARUSDC","APTUSDC","ATOMUSDC","DOTUSDC","POLUSDC"];
const TWAP_PARTS     = { illiquid: 3, liquid: 1 };
const TWAP_DELAY_MS  = 30000; // 30s entre partes

async function sleep_ms(ms) { return new Promise(r=>setTimeout(r,ms)); }

async function placeTWAPBuy(symbol, usdtAmount) {
  // SAFETY: verificar que Binance tiene suficiente USDC antes de ordenar
  // Protege contra usar dinero de otras operaciones del usuario
  try {
    const balances = await getAccountBalance();
    const usdcBal = balances ? parseFloat((balances.find(b=>b.asset==="USDC")||{}).free||0) : 0;
    if(usdcBal < usdtAmount * 0.95) {
      console.error(`[TWAP] ❌ SAFETY: Binance tiene $${usdcBal.toFixed(2)} USDC libre pero necesitamos $${usdtAmount.toFixed(2)} — orden cancelada`);
      tg.send && tg.send(`🎯 ⚠️ <b>[LIVE] ORDEN CANCELADA</b>\nBalance USDC insuficiente: $${usdcBal.toFixed(2)} libre\nNecesario: $${usdtAmount.toFixed(2)}`);
      return [];
    }
  } catch(e) { console.warn("[TWAP] No se pudo verificar balance:", e.message); }

  const isIlliquid = ILLIQUID_PAIRS.includes(symbol);
  const parts = isIlliquid ? TWAP_PARTS.illiquid : TWAP_PARTS.liquid;
  const partSize = +(usdtAmount / parts).toFixed(2);
  const orders = [];

  for(let i=0; i<parts; i++) {
    try {
      const order = await binanceRequest("POST", "order", {
        symbol, side:"BUY", type:"MARKET", quoteOrderQty: partSize.toFixed(2)
      });
      if(order?.orderId) {
        orders.push(order);
        const avgPrice = order.fills?.reduce((s,f)=>s+parseFloat(f.price)*parseFloat(f.qty),0) /
                         order.fills?.reduce((s,f)=>s+parseFloat(f.qty),0) || 0;
        console.log(`[TWAP][BUY] ${i+1}/${parts} ${symbol} $${partSize} @ ~$${avgPrice.toFixed(2)} → ${order.orderId}`);
      }
      if(i < parts-1) await sleep_ms(TWAP_DELAY_MS);
    } catch(e) { console.error(`[TWAP][BUY] Part ${i+1} error:`, e.message); }
  }
  return orders;
}

async function placeLiveBuy(symbol, usdtAmount) {
  try {
    if (!LIVE_MODE) return null;
    const maxSafe = (bot?.totalValue()||CAPITAL_USDT) * 0.40;
    const safe = Math.min(usdtAmount, maxSafe);
    if (safe < 5) { console.log(`[LIVE][BUY] ${symbol} importe muy pequeño ($${safe}), omitido`); return null; }
    const orders = await placeTWAPBuy(symbol, safe);
    if(orders?.length) {
      // Registrar precio real de ejecución para ajustar cash virtual
      const fills = orders.flatMap(o=>o.fills||[]);
      const realSpent = fills.reduce((s,f)=>s+parseFloat(f.price)*parseFloat(f.qty),0) || safe;
      const realQty = fills.reduce((s,f)=>s+parseFloat(f.qty),0);
      const avgPrice = realQty>0 ? realSpent/realQty : safe;
      console.log(`[LIVE][BUY] Real: gastado $${realSpent.toFixed(2)} @ avg $${avgPrice.toFixed(2)}`);
      // Ajustar bot.cash con el precio real (no el estimado)
      if(bot && Math.abs(realSpent - safe) > 0.01) {
        const drift = realSpent - safe;
        bot.cash += drift; // corregir por slippage real
        console.log(`[LIVE] Corrección slippage: ${drift>0?"+":""}${drift.toFixed(3)} USDC`);
      }
      tg.send && tg.send(`🟢 <b>[LIVE] BUY ${symbol}</b>\n$${realSpent.toFixed(2)} gastados en ${orders.length} parte(s)\nPrecio medio: $${avgPrice.toFixed(2)}`);
    }
    return orders?.[0]||null;
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
    if (sellQty <= 0) {
      console.log(`[LIVE][SELL] ${symbol} sin balance real → cerrando posición virtual`);
      // Si no hay balance real, la posición es huérfana — cerrarla virtualmente
      if(bot?.portfolio?.[symbol]) {
        const orphanPos = bot.portfolio[symbol];
        // Restaurar cash que se gastó en la compra virtual (nunca ejecutada realmente)
        const orphanCost = (orphanPos.qty||0) * (orphanPos.entryPrice||0);
        if(orphanCost > 0) {
          bot.cash = (bot.cash||0) + orphanCost;
          // Eliminar también el log entry de esta posición huérfana
          bot.log = (bot.log||[]).filter(l=>!(l.symbol===symbol && l.type==="BUY" && 
            Math.abs(l.price-(orphanPos.entryPrice||0))<0.01));
          console.log(`[LIVE] Posición huérfana ${symbol} eliminada — cash restaurado +$${orphanCost.toFixed(2)}`);
        }
        delete bot.portfolio[symbol];
      }
      return null;
    }
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
      // -2010 = insufficient balance → position doesn't exist in Binance
      // Close virtual position to stay in sync
      if(order?.code === -2010 && bot?.portfolio?.[symbol]) {
        delete bot.portfolio[symbol];
        console.log(`[LIVE] Posición virtual ${symbol} cerrada por -2010 (no existe en Binance)`);
      }
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

    // VIRTUAL CAPITAL LEDGER:
    // El bot maneja su propia cuenta de $CAPITAL_USDT (100 USD)
    // NO usa el balance total de Binance (puede tener más dinero de otras ops)
    // Solo verifica que Binance tiene suficiente para ejecutar cada orden
    const virtualCapital = CAPITAL_USDT; // 100 USD declarados en Railway
    
    if (bot) {
      // En LIVE real: siempre usar virtualCapital como referencia de cash libre
      // El cash de la DB puede ser incorrecto si el capital declarado cambió
      // Solo respetamos el estado guardado si es menor (el bot ha perdido dinero)
      if (bot.cash > virtualCapital * 1.05) {
        // Cash guardado es mayor que el capital declarado → resetear al declarado
        console.log(`[LIVE] 💼 Cash DB ($${bot.cash.toFixed(2)}) > capital declarado ($${virtualCapital.toFixed(2)}) → ajustando`);
        bot.cash = virtualCapital;
      } else if (bot.cash <= 0) {
        bot.cash = virtualCapital;
        console.log(`[LIVE] 💼 Cash cero → asignando capital: $${virtualCapital.toFixed(2)} USDC`);
      } else {
        console.log(`[LIVE] 💼 Capital restaurado: $${bot.cash.toFixed(2)} USDC (declarado: $${virtualCapital.toFixed(2)})`);
      }
    }

    // Sanity check: Binance debe tener AL MENOS el cash libre del bot
    if (bot && usdtBalance < bot.cash * 0.90) {
      console.warn(`[LIVE] ⚠️ Binance tiene $${usdtBalance.toFixed(2)} USDC libre pero bot espera $${bot.cash.toFixed(2)}`);
    }

    // Limpiar portfolio huérfano SIEMPRE en modo LIVE al arrancar
    // Un portfolio huérfano tiene posiciones que no existen en Binance real
    if (bot && LIVE_MODE) {
      const tv = bot.totalValue();
      const posCount = Object.keys(bot.portfolio||{}).length;
      if (tv > virtualCapital * 1.1 && posCount > 0) {
        console.warn(`[LIVE] ⚠️ Estado huérfano: totalValue $${tv.toFixed(2)} con ${posCount} posiciones >> capital $${virtualCapital.toFixed(2)} → limpiando`);
        bot.portfolio = {};
        bot.cash = virtualCapital;
        // Resetear equity para evitar drawdown falso
        bot.maxEquity = virtualCapital;
        bot.drawdownAlerted = false;
        console.log(`[LIVE] ✅ Portfolio limpiado. Cash = $${virtualCapital.toFixed(2)}`);
        tg.send && tg.send(`🔧 <b>[LIVE]</b> Estado huérfano limpiado al arrancar.\nCapital: <b>$${virtualCapital.toFixed(2)}</b> USDC\nPosiciones anteriores eliminadas (no existían en Binance real)`);
      }
    }

    // Mostrar balance total de Binance (informativo, no lo usamos para operar)
    console.log(`[LIVE] ✅ Balance USDC total en Binance: $${usdtBalance.toFixed(2)} (bot opera solo con $${virtualCapital.toFixed(2)})`);
    const others = balances.filter(b=>b.asset!=="USDC"&&b.asset!=="USDT"&&b.asset!=="BNB"&&parseFloat(b.free)>0.001);
    if (others.length>0) console.log(`[LIVE] Otros activos en Binance: ${others.map(b=>b.asset+":"+parseFloat(b.free).toFixed(4)).join(", ")} (no gestionados por el bot)`);
    
    if (tg?.send) tg.send(`🎯 <b>[LIVE] BINANCE ACTIVADO</b>\n💼 Capital bot: <b>$${bot?.cash?.toFixed(2)||virtualCapital}</b> USDC\n📊 Balance total Binance: $${usdtBalance.toFixed(2)} USDC\n${others.length>0?"(+otros activos no gestionados)":"Sin otras posiciones"}`);

  } catch(e) {
    console.error("[LIVE] ❌ verifyLiveBalance FAILED:", e.message);
    // CRITICAL: no podemos verificar balance real → pausar bot por seguridad
    // No pausar automáticamente - la IP puede causar falsos negativos
    // Solo alertar por Telegram
    tg.send && tg.send("⚠️ <b>[LIVE] Advertencia balance</b>\nNo se pudo verificar balance Binance al arrancar.\nPuede ser IP issue. El bot continúa operando.\nVerifica con /balance");
    console.warn("[LIVE] Advertencia: balance no verificado al arrancar (posible IP issue).");
  }
}

function startLoop(){
  connectBinance();
  let _tickRunning = false;
  setInterval(async()=>{
    if(!bot) return;
    if(_tickRunning){ console.warn("[LIVE] Tick overlap - saltando"); return; }
    _tickRunning = true;
    try {
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
    let signals=[],newTrades=[],circuitBreaker=null,optimizerResult=null,drawdownAlert=null,dailyLimit=50,dailyUsed=0;
    try {
      ({signals,newTrades,circuitBreaker,optimizerResult,drawdownAlert,dailyLimit,dailyUsed}=bot.evaluate());
    } catch(evalErr) {
      console.error("[LIVE] bot.evaluate() error:", evalErr.message);
      console.error(evalErr.stack?.split("\n").slice(0,3).join("\n"));
      ticks++;
      return; // skip this tick, don't crash
    }
    ticks++;

    for(const trade of newTrades){
      if(trade.type==="SELL"){
        const liveCfg=global._alertConfig||{winPct:3,lossPct:3};
        if(trade.pnl>=liveCfg.winPct)  tg.notifyBigWin(trade);
        if(trade.pnl<=-liveCfg.lossPct) tg.notifyBigLoss(trade);
        // Explicabilidad: notificar trades significativos con explicación
        if(Math.abs(trade.pnl||0)>=2) tg.notifyTradeWithExplanation(trade, bot.marketRegime, 50);
        if(trade.pnl<0){const wasBl=blacklist.isBlacklisted(trade.symbol);blacklist.recordLoss(trade.symbol);if(!wasBl&&blacklist.isBlacklisted(trade.symbol))tg.notifyBlacklist(trade.symbol);}
        else blacklist.recordWin(trade.symbol);
      }
      // ── ÓRDENES REALES BINANCE ─────────────────────────────────────────────
      if(LIVE_MODE){
        // No usamos await aquí — las órdenes se procesan en background
        // para no bloquear el tick loop (TWAP puede tardar 60s)
        if(trade.type==="BUY") {
          placeLiveBuy(trade.symbol, trade.qty*trade.price).catch(e=>console.error("[ORDER] BUY error:",e.message));
          // Copy trade to clients (proporcionalmente a su capital)
          clientManager.copyBuy(trade.symbol, trade.qty*trade.price, bot.totalValue())
            .catch(e=>console.warn("[CLIENT] copyBuy error:", e.message));
        }
        if(trade.type==="SELL") {
          placeLiveSell(trade.symbol, trade.qty).catch(e=>console.error("[ORDER] SELL error:",e.message));
          // Copy sell to clients
          clientManager.copySell(trade.symbol, trade.qty)
            .catch(e=>console.warn("[CLIENT] copySell error:", e.message));
        }
      }
    }

    if(circuitBreaker?.triggered&&!cbNotified){tg.notifyCircuitBreaker(circuitBreaker.drawdown);cbNotified=true;}
    if(!circuitBreaker?.triggered)cbNotified=false;
    if(drawdownAlert?.triggered)tg.notifyMaxDrawdown(drawdownAlert);
    if(!circuitBreaker?.triggered) cbNotified=false;
    if(optimizerResult?.changes?.length>0) tg.notifyOptimizer(optimizerResult);

    // Real-time F&G — actualizar cada tick
    if(bot && bot.history) {
      const rtFG = calcRealtimeFearGreed(bot, {
        longShortRatio: bot.longShortRatio,
        fundingRate: bot.fundingRate,
        openInterest: bot.openInterest,
        redditSentiment: bot.redditSentiment,
        officialFearGreed: bot._officialFearGreed || bot.fearGreed,
      });
      bot.fearGreedRealtime = rtFG;
      bot.fearGreed = rtFG.value;
      bot.fearGreedSource = rtFG.source;
    }

    if(Date.now()-lastFearGreedCheck>1800000){
      lastFearGreedCheck=Date.now();
      fetchFearGreed().then(fg=>{
        try {
          bot._officialFearGreed=fg.value; bot.fearGreed=fg.value;
          if(bot.fearGreedRealtime?.scores && fg.source !== "fallback" && fgCalibrator?.recordObservation) {
            fgCalibrator.recordObservation(bot.fearGreedRealtime.scores, bot.fearGreedRealtime.synthetic, fg.value);
          }
          bot.fearGreedPublished=fg.publishedAt; bot.fearGreedSource=fg.source||"unknown";
          console.log(`[F&G] ${fg.value} (${fg.source||"?"}) · ${fg.publishedAt?.slice(0,16)||"?"}`);
        } catch(e) { console.warn("[F&G] calibration error:", e.message); }
      }).catch(e=>console.warn("[F&G] fetch failed:", e.message));
      // Market data for Telegram /mercado command
      fetchLongShortRatio("BTCUSDT").then(ls=>{bot.longShortRatio=ls;}).catch(()=>{});
      fetchFundingRate("BTCUSDT").then(fr=>{bot.fundingRate=fr;}).catch(()=>{});
      fetchOpenInterest("BTCUSDT").then(oi=>{bot.openInterest=oi;}).catch(()=>{});
      if(Date.now()-(bot._lastRedditFetch||0)>7200000){
        bot._lastRedditFetch=Date.now();
        fetchRedditSentiment().then(rs=>{bot.redditSentiment=rs;}).catch(()=>{});
      }
    }

    if(ticks%120===0){ fetchNewsAlert().then(news=>{if(news?.negative)tg.notifyNewsAlert(news);}); }

    // Enviar equity a BAFIR
    if(ticks%60===0) sendEquityToBafir(bot.totalValue());
    // WF intradía cada 30min en live (sin API, usa historial en RAM)
    if(ticks%180===0 && ticks>0) {
      try {
        const wf = runIntradayWalkForward(bot);
        if(wf) {
          bot._intradayWF = wf;
          if(wf.verdict==="SOBREAJUSTE") {
            console.warn(`[WF-LIVE] ⚠️ Ratio ${wf.avgRatio} — posible sobreajuste intradía`);
          } else {
            console.log(`[WF-LIVE] Ratio ${wf.avgRatio} — ${wf.verdict}`);
          }
        }
      } catch(e) {}
    }
    // Reconciliación periódica cada 30 ticks: comparar cash virtual vs Binance real
    if(LIVE_MODE && ticks%180===0) {
      getAccountBalance().then(balances => {
        if(!balances||!bot) return;
        const realUSDC = parseFloat((balances.find(b=>b.asset==="USDC")||{}).free||0);
        const virtualFree = bot.cash;
        const openPositions = Object.keys(bot.portfolio||{}).length;

        if(virtualFree > CAPITAL_USDT * 2) {
          // cash virtual corrupto → corregir
          console.warn(`[RECONCILE] cash virtual $${virtualFree.toFixed(2)} >> capital $${CAPITAL_USDT} → corrigiendo`);
          bot.cash = CAPITAL_USDT;
          bot.portfolio = {};
          bot.maxEquity = CAPITAL_USDT;
          bot.breaker?.reset && bot.breaker.reset(CAPITAL_USDT);
        } else if(realUSDC < 1 && openPositions === 0 && virtualFree > 10) {
          // Puede ser problema de IP (API key restringida) o falta de fondos
          // Solo avisar, no pausar automáticamente (la IP puede causar $0 falso)
          bot._reconcileZeroCount = (bot._reconcileZeroCount||0) + 1;
          if(bot._reconcileZeroCount === 1) {
            console.warn(`[RECONCILE] ⚠️ Binance USDC=$0 pero virtual=$${virtualFree.toFixed(2)} — puede ser restricción de IP`);
            tg.send && tg.send(`⚠️ <b>[LIVE]</b> Binance muestra $0 USDC libre.\nPuede ser restricción de IP en API key.\nEl bot continúa operando. Si persiste más de 30min, verifica en Binance.`);
          }
        } else {
          const drift = realUSDC - virtualFree;
          if(Math.abs(drift) > 2 && Math.abs(drift) < 15) {
            console.warn(`[RECONCILE] Drift: real=$${realUSDC.toFixed(2)} virtual=$${virtualFree.toFixed(2)} diff=${drift>0?"+":""}${drift.toFixed(2)}`);
            bot.cash += drift * 0.1; // corrección suave 10%
          }
        }
      }).catch(()=>{});
    }

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
        clientStatus:clientManager.getStatus(),
      }
    });

    } catch(loopErr) {
      console.error("[LIVE] Loop error:", loopErr.message);
    } finally {
      _tickRunning = false;
    }
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
