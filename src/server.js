// ─── CRYPTOBOT LIVE — SERVER ──────────────────────────────────────────────────
// Instancia real: opera con dinero real o paper controlado.
// Recibe parámetros optimizados del bot PAPER solo si cumplen el umbral.
"use strict";

const express    = require("express");
const http       = require("http");
const path       = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { CryptoBotFinal, PAIRS }       = require("./engine");
const { ensureTradeLogTable } = require("./trade_logger");
const { scheduleWeeklyReport, scheduleTradeAnalysisReminder } = require("./weekly_report");
const { saveState, loadState, deleteState, saveSimpleState, loadSimpleState } = require("./database");
const { Blacklist, MarketGuard, getTradingScore } = require("./market");
const { CryptoPanicDefense } = require("./cryptoPanic");
const { PaperShadow } = require("./paperShadow");
const { ClientBotManager } = require("./clientManager");
const clientManager = new ClientBotManager();
const { runIntradayWalkForward } = require("./backtest");
const shadow = new PaperShadow();
const { fetchFearGreed, calcRealtimeFearGreed, fgCalibrator, fetchNewsAlert, fetchAllKlines, runNightlyReplay, fetchLongShortRatio, fetchFundingRate, fetchOpenInterest, fetchTakerVolume, fetchRedditSentiment, fetchLiquidations, fetchBTCDominance, fetchCoinbasePremium, fetchExchangeFlow, fetchBinanceReserve } = require("./feeds");
const { evaluateIncomingParams, calcSyncStats } = require("./sync");
const { SimpleBotEngine } = require("./engine_simple");
const tg         = require("./telegram");
const S = require("./trading/state");

const PORT    = process.env.PORT    || 3000;
const TICK_MS = parseInt(process.env.TICK_MS || "10000"); // Más lento = más conservador

// En LIVE_MODE, el capital real se obtiene de Binance al arrancar
// CAPITAL_USDT es el fallback para modo PAPER-LIVE
const BINANCE_API_KEY    = process.env.BINANCE_API_KEY    || "";
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || "";
const LIVE_MODE          = process.env.LIVE_MODE === "true";
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
let liveStartTime = Date.now(); // para calcular tiempo restante

async function initBot() {
  const saved = await loadState();
  S.bot = new CryptoBotFinal(saved);
  S.bot.mode = LIVE_MODE ? "LIVE" : "PAPER";
  if (saved?.blacklistData) blacklist.restore(saved.blacklistData);
  if (saved?.syncHistory)   S.syncHistory = saved.syncHistory || [];

  // Solo esperar 1 hora si es el PRIMER arranque (sin estado guardado)
  if (!saved) {
    S.liveReady = false;
    liveStartTime = Date.now() + LIVE_START_DELAY_MS;
    console.log(`[LIVE] ⏳ Primer arranque — esperando 1 hora para que el paper acumule datos…`);
    tg.send && tg.send("✅ <b>LIVE iniciado</b> — Esperando datos del paper.");
    setTimeout(() => {
      S.liveReady = true;
      console.log("[LIVE] ✅ 1 hora transcurrida — bot LIVE listo para operar");
// live activated - no notification
    }, LIVE_START_DELAY_MS);
  } else {
    console.log(`[LIVE] ♻️ Reinicio detectado — operando inmediatamente (estado restaurado)`);
  }

  console.log(`\n[LIVE] Modo: ${S.bot.mode} | Capital: $${S.CAPITAL_USDT} | Umbral: ${SYNC_THRESHOLD.minDays} días`);

// ── SimpleBotEngine — 7 estrategias validadas ──────────────────────────
try {
  const savedSimple = await loadSimpleState().catch(()=>null);
  S.simpleBot = new SimpleBotEngine(savedSimple || {});
  console.log("[SIMPLE] 7 estrategias inicializadas (Capa1+Capa2)");
  S.simpleBot.setContext(null, "live", S.bot?.marketRegime||"UNKNOWN", S.bot?.fearGreed||50);
} catch(e) {
  console.warn("[SIMPLE] Error init:", e.message);
  S.simpleBot = new SimpleBotEngine({});
}

// ── Prefill velas históricas de Binance para simpleBot ──────────────────
async function prefillSimpleBotCandles() {
  // Fetch USDT pairs (more liquid) and store as USDC keys (what engine_simple expects)
  const PAIRS_TF = [
    {api:"BNBUSDT",  key:"BNBUSDC",  tf:"1h"},
    {api:"SOLUSDT",  key:"SOLUSDC",  tf:"1h"},
    {api:"BTCUSDT",  key:"BTCUSDC",  tf:"30m"},
    {api:"BTCUSDT",  key:"BTCUSDC",  tf:"30m"},
    {api:"XRPUSDT",  key:"XRPUSDC",  tf:"4h"},
    {api:"SOLUSDT",  key:"SOLUSDC",  tf:"4h"},
    {api:"BNBUSDT",  key:"BNBUSDC",  tf:"1d"},
  ];
  const seen = new Set();
  let filled = 0;
  for(const {api, key, tf} of PAIRS_TF) {
    const candleKey = `${key}_${tf}`;
    if(seen.has(candleKey)) continue;
    seen.add(candleKey);
    // Skip if already has enough candles (from saved state)
    if(S.simpleBot._candles?.[candleKey]?.length >= 50) {
      console.log(`[SIMPLE-PREFILL] ${candleKey}: ya tiene ${S.simpleBot._candles[candleKey].length} velas, skip`);
      filled++;
      continue;
    }
    try {
      const limit = tf==="1d" ? 250 : 60;
      const url = `https://api.binance.com/api/v3/klines?symbol=${api}&interval=${tf}&limit=${limit}`;
      const res = await fetch(url);
      const klines = await res.json();
      if(!Array.isArray(klines)) continue;
      if(!S.simpleBot._candles) S.simpleBot._candles = {};
      if(!S.simpleBot._candles[candleKey]) S.simpleBot._candles[candleKey] = [];
      for(const k of klines) {
        S.simpleBot._candles[candleKey].push({
          open:parseFloat(k[1]), high:parseFloat(k[2]),
          low:parseFloat(k[3]), close:parseFloat(k[4]),
          start:k[0],
        });
      }
      if(S.simpleBot._candles[candleKey].length > 300)
        S.simpleBot._candles[candleKey] = S.simpleBot._candles[candleKey].slice(-300);
      filled++;
      console.log(`[SIMPLE-PREFILL] ${candleKey}: ${S.simpleBot._candles[candleKey].length} velas`);
    } catch(e) { console.warn(`[SIMPLE-PREFILL] Error ${api}/${tf}:`, e.message); }
  }
  console.log(`[SIMPLE-PREFILL] ✅ ${filled} pares prefilled`);
}
await prefillSimpleBotCandles();

  tg.notifyStartup(S.bot.mode + " (instancia controlada)");
  tg.testTelegram && tg.testTelegram();
  // Auto reports disabled — use /situacion on demand
  S.tgControls = tg.startCommandListener(
  () => ({...S.bot.getState(), instance:S.bot.mode, syncHistory: S.syncHistory, dailyPnlPct:S.bot._dailyPnlPct||0, momentumMult:S.bot.hourMultiplier||1, cryptoPanic:cryptoPanic.getStatus()}),
  {
    getBalance:    getAccountBalance,
    setPaused:     (v) => { if(S.bot) S.bot._pausedByTelegram=v; },
    getSimpleState: () => S.simpleBot?.getState() || null,
    setCapital:    (v) => {
      S.CAPITAL_USDT = v;
      if(S.bot) { if(S.bot.cash>v) S.bot.cash=v; }
      if(S.simpleBot) {
        S.simpleBot.capa1Cash = v*0.60;
        S.simpleBot.capa2Cash = v*0.40;
      }
      console.log("[TG] Capital actualizado a $"+v);
    },
  }
);

  // Startup historical simulation: teach DQN about crisis before facing real market
  // Live bot gets a condensed version: 2022 crash + recent 30 days only
  setTimeout(async () => {
    if(!S.bot || !S.bot.dqn) return;
    console.log("[HistSim-LIVE] Entrenando DQN con datos históricos de crisis...");
    const crisis_pairs = ["BTCUSDC","ETHUSDC","SOLUSDC"];
    const periods = [
      { start:"2022-05-01", end:"2022-06-30", label:"Crash LUNA/2022" },
      { start:"2022-11-01", end:"2022-12-31", label:"Crash FTX/2022" },
    ];
    let simTrades = 0;
    for(const pair of crisis_pairs) {
      for(const period of periods) {
        try {
          const klines = await fetchAllKlines(pair, "5m", period.start, period.end);
          if(!klines || klines.length < 50) continue;
          // Simulate simplified learning: treat each 5% drop as a failed MR signal
          for(let i=20; i<klines.length-5; i++) {
            const window = klines.slice(i-20,i).map(k=>k.close);
            const rsiVal = window.length>=14 ? (()=>{
              let gains=0,losses=0;
              for(let j=1;j<14;j++){const d=window[j]-window[j-1];d>0?gains+=d:losses+=-d;}
              return 100-100/(1+gains/14/(losses/14||0.001));
            })() : 50;
            const pnl5 = (klines[i+5].close - klines[i].close) / klines[i].close * 100;
            const isDowntrend = klines[i].close < klines[Math.max(0,i-12)].close * 0.97;
            // In a crisis downtrend, MR entries fail → teach SKIP
            if(isDowntrend && rsiVal < 40) {
              const state = S.bot.dqn.encodeState({
                rsi: rsiVal, bbZone:"below_lower", regime:"LATERAL",
                trend: isDowntrend?"down":"neutral", fearGreed: 20,
                btcTrend24h: -5, volatilityPct: 80
              });
              S.bot.dqn.remember(state, "BUY", pnl5>0?0.5:-0.8, state);
              simTrades++;
            }
          }
          if(S.bot.dqn.replayBuffer.length>=20) S.bot.dqn.trainBatch(2);
          console.log("[HistSim-LIVE] "+period.label+" "+pair+" — "+simTrades+" trades sintéticos");
        } catch(e) { /* non-blocking */ }
      }
    }
    console.log("[HistSim-LIVE] ✅ "+simTrades+" trades de crisis aprendidos por DQN");
  }, 15000); // 15s después del arranque

  fetchFearGreed().then(fg => { S.bot.fearGreed=fg.value; S.bot.fearGreedPublished=fg.publishedAt; S.bot.fearGreedSource=fg.source||"unknown"; console.log(`[F&G] ${fg.value} (${fg.source||"?"}) publicado: ${fg.publishedAt||"?"}`); });

  // CRÍTICO: limpiar estado huérfano ANTES de empezar el loop
  // Esto evita que el circuit breaker se dispare por estados corruptos de DB
  if(LIVE_MODE) {
    await verifyLiveBalance();
    // Resetear el circuit breaker después de limpiar el estado
    // (el CB puede haberse disparado por el estado corrupto)
    if(S.bot.breaker) {
      S.bot.breaker.reset && S.bot.breaker.reset();
      S.bot._cbResetOnStart = true;
      console.log("[LIVE] Circuit breaker reseteado tras verificación de balance");
    }
  }
  startLoop({
    connectBinance, simulatePrices, broadcast, save,
    placeLiveBuy, placeLiveSell, getAccountBalance, sendEquityToBafir,
    marketGuard, blacklist, cryptoPanic, clientManager,
    LIVE_MODE, TICK_MS, SYNC_THRESHOLD,
    getLiveStartTime: () => liveStartTime,
  });
}

// Historial de sincronizaciones recibidas del PAPER

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
  if(!S.bot) return res.json({loading:true, instance:"LIVE"});
  const s = S.bot.getState();
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
    dailyPnlPct:     S.bot._dailyPnlPct||0,
    momentumMult:    S.bot.hourMultiplier||1,
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

app.get("/api/simple", (_,res) => res.json(S.simpleBot ? S.simpleBot.getState() : {loading:true}));
app.get("/api/state",  (_,res)=>res.json(S.bot?{...S.bot.getState(),instance:LIVE_MODE?"LIVE":"PAPER-LIVE",blacklist:S.bot.autoBlacklist.getStatus(),syncHistory: S.syncHistory,dailyPnlPct:S.bot._dailyPnlPct||0,momentumMult:S.bot.hourMultiplier||1,cryptoPanic:cryptoPanic?.getStatus?.()??null}:{loading:true,instance:LIVE_MODE?"LIVE":"PAPER-LIVE",totalValue:0}));
app.get("/api/health", (_,res)=>res.json({ok:true,instance:LIVE_MODE?"LIVE":"PAPER-LIVE",tick:S.bot?.tick,uptime:process.uptime(),tv:S.bot?.totalValue()}));

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
  if(!S.bot) return res.status(503).json({error:"Bot no iniciado"});
  res.json({
    score: S.bot.confidence.get(),
    label: S.bot.confidence.getLabel(),
    color: S.bot.confidence.getColor(),
    blacklist: S.bot.autoBlacklist.getStatus(),
    winRate: S.bot.recentWinRate(),
    drawdown: S.bot.getState().drawdownPct,
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

  const currentLiveStats = S.bot ? calcSyncStats(S.bot.log, 1) : { winRate:0, avgPnl:0, nTrades:0 };
  const result = evaluateIncomingParams({ params, paperStats, exportedAt:req.body.exportedAt }, S.bot?.optimizer?.getParams()||{}, currentLiveStats, S.syncHistory);
  S.syncHistory = result.syncHistory;

  if (result.adopted && S.bot) {
    Object.assign(S.bot.optimizer.params, result.newParams);
    console.log(`[SYNC] ✅ ${result.bootstrap?"Bootstrap":"Estricto"}: ${result.reason}`);

    save().catch(()=>{});
  } else {
    console.log(`[SYNC] ⏸ ${result.reason}`);

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

  if (!S.bot) return res.json({ adopted:false, reason:"Bot no listo" });

  // Adoptar optimizer params con blending conservador (20% paper, 80% live)
  if (optimizerParams && Object.keys(optimizerParams).length > 0) {
    const current = S.bot.optimizer.getParams();
    const blended = {};
    for (const [k, v] of Object.entries(optimizerParams)) {
      if (typeof v === "number" && typeof current[k] === "number") {
        // Más agresivo si día positivo, conservador si solo hay Q states
    const blend = applyFull ? 0.35 : 0.10;
    blended[k] = +(current[k] * (1-blend) + v * blend).toFixed(4);
      }
    }
    if (Object.keys(blended).length > 0) {
      Object.assign(S.bot.optimizer.params, blended);
      console.log(`[SYNC-DAILY] ✅ Params blended 20% paper — régimen:${regime}`);
    }
  }

  // Registrar en syncHistory
  S.syncHistory.push({ ts:new Date().toISOString(), type:"daily", winRate, avgPnl, nTrades, regime, positive });
  while (S.syncHistory.length > 120) S.syncHistory.shift();
  save().catch(()=>{});

  // Sync diario notification removed\nWR: ${winRate}% | avgPnl: ${avgPnl}% | ${nTrades} ops | Régimen: ${regime}\n✅ Params actualizados (blend 20%)`);
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
  S.CAPITAL_USDT = capitalUSD;
  if (S.bot) {
    // Respetar reserva mínima del 15%
    const reserve = capitalUSD * 0.15;
    const maxOperable = capitalUSD - reserve;
    // Si el bot tiene más cash del capital declarado, limitar
    if (S.bot.cash > capitalUSD) S.bot.cash = capitalUSD;
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

  if(!S.bot) return res.status(503).json({error:"Bot no listo"});
  const { dqnWeights, qTable, paperStats } = req.body;
  if(!dqnWeights && !qTable) return res.status(400).json({error:"Sin datos"});

  const wr = paperStats?.winRate||0;
  const trades = paperStats?.nTrades||0;

  // Solo transferir si paper tiene suficiente experiencia y buen WR
  if(trades < 50) return res.json({adopted:false, reason:`Paper solo tiene ${trades} trades (mínimo 50)`});
  if(wr < 30) return res.json({adopted:false, reason:`WR paper ${wr}% muy bajo para transferir`});

  // Registrar WR del live ANTES de la transferencia para medir impacto después
  const liveSells = (S.bot.log||[]).filter(l=>l.type==="SELL");
  const liveWrBefore = liveSells.length >= 10
    ? Math.round(liveSells.slice(-20).filter(l=>l.pnl>0).length / Math.min(20, liveSells.length) * 100)
    : null;
  S.bot._transferHistory = S.bot._transferHistory || [];
  const transferRecord = {
    ts: new Date().toISOString(),
    paperWR: wr, paperTrades: trades,
    liveWRbefore: liveWrBefore,
    liveWRafter: null,  // se rellena 2h después
    blend: Math.min(0.4, trades/500),
    improved: null,
  };
  S.bot._transferHistory.push(transferRecord);
  if(S.bot._transferHistory.length > 20) S.bot._transferHistory.shift();
  // Ajustar blend según historial de transferencias anteriores
  const goodTransfers = (S.bot._transferHistory||[]).filter(t=>t.improved===true).length;
  const badTransfers  = (S.bot._transferHistory||[]).filter(t=>t.improved===false).length;
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
  if(dqnWeights && S.bot.dqn) {
    try {
      const BLEND = Math.min(0.4, trades/500); // más trades = más confianza en paper
      const blendWeights = (live, paper) => {
        if(!live || !paper || live.length !== paper.length) return live;
        return live.map((v, i) => v * (1-BLEND) + paper[i] * BLEND);
      };
      if(dqnWeights.W1) S.bot.dqn.W1 = blendWeights(S.bot.dqn.W1, dqnWeights.W1);
      if(dqnWeights.W2) S.bot.dqn.W2 = blendWeights(S.bot.dqn.W2, dqnWeights.W2);
      if(dqnWeights.W3) S.bot.dqn.W3 = blendWeights(S.bot.dqn.W3, dqnWeights.W3);
      if(dqnWeights.b1) S.bot.dqn.b1 = blendWeights(S.bot.dqn.b1, dqnWeights.b1);
      if(dqnWeights.b2) S.bot.dqn.b2 = blendWeights(S.bot.dqn.b2, dqnWeights.b2);
      if(dqnWeights.b3) S.bot.dqn.b3 = blendWeights(S.bot.dqn.b3, dqnWeights.b3);
      transferred.push(`DQN (blend ${(BLEND*100).toFixed(0)}%)`);
    } catch(e) { console.warn("[TRANSFER] DQN error:", e.message); }
  }

  // Transferir Q-table (merge: mantener lo de live, añadir estados nuevos del paper)
  if(qTable && S.bot.qLearning?.q) {
    try {
      let newStates = 0;
      for(const [state, actions] of Object.entries(qTable)) {
        if(!S.bot.qLearning.q[state]) {
          S.bot.qLearning.q[state] = actions; // nuevo estado del paper
          newStates++;
        } else {
          // Blend existing states
          for(const [action, val] of Object.entries(actions)) {
            if(S.bot.qLearning.q[state][action] != null) {
              S.bot.qLearning.q[state][action] = S.bot.qLearning.q[state][action]*0.7 + val*0.3;
            } else {
              S.bot.qLearning.q[state][action] = val;
            }
          }
        }
      }
      transferred.push(`Q-table (+${newStates} estados nuevos)`);
    } catch(e) { console.warn("[TRANSFER] Q-table error:", e.message); }
  }

  const msg = `✅ Transfer learning: ${transferred.join(", ")} | paper WR:${wr}% trades:${trades} | blend:${(adaptiveBlend*100).toFixed(0)}%`;
  console.log(`[TRANSFER] ${msg}`);
  // Transfer learning notification removed\n${msg}\n<i>Midiendo impacto en 2h...</i>`);

  // Evaluar impacto 2h después
  setTimeout(() => {
    if(!S.bot) return;
    const afterSells = (S.bot.log||[]).filter(l=>l.type==="SELL");
    const liveWrAfter = afterSells.length >= 10
      ? Math.round(afterSells.slice(-20).filter(l=>l.pnl>0).length / Math.min(20, afterSells.length) * 100)
      : null;
    // Buscar el registro de esta transferencia
    const rec = (S.bot._transferHistory||[]).find(t=>t.liveWRafter===null && t.liveWRbefore!==null);
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
  syncHistory: S.syncHistory,
  threshold: SYNC_THRESHOLD,
  currentParams: S.bot?.optimizer?.getParams(),
}));

(async () => { await initBot(); })();

// ── Guardar ───────────────────────────────────────────────────────────────────
async function save() {
  if(!S.bot) return;
  const s=S.bot.getState();
  s.blacklistData=blacklist.serialize();
  s.optimizerHistory=S.bot.optimizer.history;
  s.trailingHighs=S.bot.trailing.highs;
  s.reentryTs=S.bot.reentryTs;
  s.syncHistory=S.syncHistory;
  if(S.bot.multiAgent)    s.multiAgentData = S.bot.multiAgent.serialize();
  if(S.bot.adaptiveStop)   s.adaptiveStop   = S.bot.adaptiveStop.serialize();
  if(S.bot.adaptiveHours)  s.adaptiveHours  = S.bot.adaptiveHours.serialize();
  if(S.bot.newsLearner)    s.newsLearner    = S.bot.newsLearner.serialize();
  if(S.bot.regimeDetector) s.regimeDetector = S.bot.regimeDetector.serialize();
  if(S.bot._transferHistory) s.transferHistory = S.bot._transferHistory;
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
let lastPriceTs=Date.now();

function connectBinance() {
  const ws=new WebSocket(streamUrl);
  ws.on("open",    ()=>{S.binanceLive=true;console.log("[BINANCE] ✓ Stream en vivo");});
  ws.on("message", raw=>{try{const{data}=JSON.parse(raw);if(data?.s&&data?.c&&S.bot){S.bot.updatePrice(data.s,parseFloat(data.c));lastPriceTs=Date.now();}}catch(e){}});
  ws.on("close",   ()=>{S.binanceLive=false;setTimeout(connectBinance,5000);});
  ws.on("error",   e=>console.error("[BINANCE]",e.message));
}

const SEEDS={BTCUSDC:67000,ETHUSDC:3500,SOLUSDC:180,BNBUSDC:580,AVAXUSDC:38,ADAUSDC:0.45,DOTUSDC:8.5,LINKUSDC:18,UNIUSDC:10,AAVEUSDC:95,XRPUSDC:0.52,LTCUSDC:82};
function simulatePrices(){
  if(!S.bot||Date.now()-lastPriceTs<10000) return;
  PAIRS.forEach(p=>{const last=S.bot.prices[p.symbol]||SEEDS[p.symbol]||100;S.bot.updatePrice(p.symbol,last*(1+0.007*(Math.random()+Math.random()-1)*1.2+0.00004));});
}

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
const ILLIQUID_PAIRS = ["OPUSDC","ARBUSDC","NEARUSDC","APTUSDC","ATOMUSDC","DOTUSDC","POLUSDC","OPUSDT","ARBUSDT","NEARUSDT","APTUSDT","ATOMUSDT","DOTUSDT","SUIUSDT","TONUSDT","TRXUSDT"];
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
    const maxSafe = (S.bot?.totalValue()||S.CAPITAL_USDT) * 0.40;
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
      if(S.bot && Math.abs(realSpent - safe) > 0.01) {
        const drift = realSpent - safe;
        S.bot.cash += drift; // corregir por slippage real
        console.log(`[LIVE] Corrección slippage: ${drift>0?"+":""}${drift.toFixed(3)} USDC`);
      }
      // BUY notification removed\n$${realSpent.toFixed(2)} gastados en ${orders.length} parte(s)\nPrecio medio: $${avgPrice.toFixed(2)}`);
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
      if(S.bot?.portfolio?.[symbol]) {
        const orphanPos = S.bot.portfolio[symbol];
        // Restaurar cash que se gastó en la compra virtual (nunca ejecutada realmente)
        const orphanCost = (orphanPos.qty||0) * (orphanPos.entryPrice||0);
        if(orphanCost > 0) {
          S.bot.cash = (S.bot.cash||0) + orphanCost;
          // Eliminar también el log entry de esta posición huérfana
          S.bot.log = (S.bot.log||[]).filter(l=>!(l.symbol===symbol && l.type==="BUY" && 
            Math.abs(l.price-(orphanPos.entryPrice||0))<0.01));
          console.log(`[LIVE] Posición huérfana ${symbol} eliminada — cash restaurado +$${orphanCost.toFixed(2)}`);
        }
        delete S.bot.portfolio[symbol];
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
      // SELL notification removed\nSELL ${symbol} — qty:${quantity.toFixed(4)}\nOrden: ${order.orderId}`);
    } else {
      console.error(`[LIVE][SELL] ❌ ${symbol}`, JSON.stringify(order));
      // -2010 = insufficient balance → position doesn't exist in Binance
      // Close virtual position to stay in sync
      if(order?.code === -2010 && S.bot?.portfolio?.[symbol]) {
        delete S.bot.portfolio[symbol];
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
    const virtualCapital = S.CAPITAL_USDT; // 100 USD declarados en Railway
    
    if (S.bot) {
      // En LIVE real: siempre usar virtualCapital como referencia de cash libre
      // El cash de la DB puede ser incorrecto si el capital declarado cambió
      // Solo respetamos el estado guardado si es menor (el bot ha perdido dinero)
      if (S.bot.cash > virtualCapital * 1.05) {
        // Cash guardado es mayor que el capital declarado → resetear al declarado
        console.log(`[LIVE] 💼 Cash DB ($${S.bot.cash.toFixed(2)}) > capital declarado ($${virtualCapital.toFixed(2)}) → ajustando`);
        S.bot.cash = virtualCapital;
      } else if (S.bot.cash <= 0) {
        S.bot.cash = virtualCapital;
        console.log(`[LIVE] 💼 Cash cero → asignando capital: $${virtualCapital.toFixed(2)} USDC`);
      } else {
        console.log(`[LIVE] 💼 Capital restaurado: $${S.bot.cash.toFixed(2)} USDC (declarado: $${virtualCapital.toFixed(2)})`);
      }
    }

    // Sanity check: Binance debe tener AL MENOS el cash libre del bot
    if (S.bot && usdtBalance < S.bot.cash * 0.90) {
      console.warn(`[LIVE] ⚠️ Binance tiene $${usdtBalance.toFixed(2)} USDC libre pero bot espera $${S.bot.cash.toFixed(2)}`);
    }

    // Limpiar portfolio huérfano SIEMPRE en modo LIVE al arrancar
    // Un portfolio huérfano tiene posiciones que no existen en Binance real
    if (S.bot && LIVE_MODE) {
      const tv = S.bot.totalValue();
      const posCount = Object.keys(S.bot.portfolio||{}).length;
      if (tv > virtualCapital * 1.1 && posCount > 0) {
        console.warn(`[LIVE] ⚠️ Estado huérfano: totalValue $${tv.toFixed(2)} con ${posCount} posiciones >> capital $${virtualCapital.toFixed(2)} → limpiando`);
        S.bot.portfolio = {};
        S.bot.cash = virtualCapital;
        // Resetear equity para evitar drawdown falso
        S.bot.maxEquity = virtualCapital;
        S.bot.drawdownAlerted = false;
        console.log(`[LIVE] ✅ Portfolio limpiado. Cash = $${virtualCapital.toFixed(2)}`);
        tg.send && tg.send(`🔧 <b>[LIVE]</b> Estado huérfano limpiado al arrancar.\nCapital: <b>$${virtualCapital.toFixed(2)}</b> USDC\nPosiciones anteriores eliminadas (no existían en Binance real)`);
      }
    }

    // Mostrar balance total de Binance (informativo, no lo usamos para operar)
    console.log(`[LIVE] ✅ Balance USDC total en Binance: $${usdtBalance.toFixed(2)} (bot opera solo con $${virtualCapital.toFixed(2)})`);
    const others = balances.filter(b=>b.asset!=="USDC"&&b.asset!=="USDT"&&b.asset!=="BNB"&&parseFloat(b.free)>0.001);
    if (others.length>0) console.log(`[LIVE] Otros activos en Binance: ${others.map(b=>b.asset+":"+parseFloat(b.free).toFixed(4)).join(", ")} (no gestionados por el bot)`);
    
    if (tg?.send) tg.send(`✅ <b>LIVE operativo</b> — Capital: $${S.bot?.cash?.toFixed(2)||virtualCapital} USDC`);

  } catch(e) {
    console.error("[LIVE] ❌ verifyLiveBalance FAILED:", e.message);
    // CRITICAL: no podemos verificar balance real → pausar bot por seguridad
    // No pausar automáticamente - la IP puede causar falsos negativos
    // Solo alertar por Telegram
    tg.send && tg.send("⚠️ <b>[LIVE] Advertencia balance</b>\nNo se pudo verificar balance Binance al arrancar.\nPuede ser IP issue. El bot continúa operando.\nVerifica con /balance");
    console.warn("[LIVE] Advertencia: balance no verificado al arrancar (posible IP issue).");
  }
}

// ── Trading Loop (extraído a trading/loop.js) ────────────────────────────────
const { startLoop } = require("./trading/loop");

// Servidor arranca INMEDIATAMENTE — healthcheck pasa, WS disponible de inmediato
scheduleWeeklyReport(tg, null, "live", null);
scheduleTradeAnalysisReminder(tg, null, "live");

server.listen(PORT,()=>console.log(`\n🎯 CRYPTOBOT LIVE en http://localhost:${PORT} | ${LIVE_MODE?"🔴 LIVE":"📋 PAPER-LIVE"} | Tick: ${TICK_MS}ms\n`));

wss.on("connection", ws=>{
  // Enviar estado inicial
  try {
    if(S.bot) ws.send(JSON.stringify({type:"state",data:{...S.bot.getState(),instance:S.bot.mode,syncHistory: S.syncHistory}}));
    else    ws.send(JSON.stringify({type:"state",data:{loading:true,instance:"LIVE",totalValue:0}}));
  } catch(e) {}
  // Heartbeat: ping cada 25s para evitar que Railway cierre la conexión idle
  const hb = setInterval(()=>{ if(ws.readyState===WebSocket.OPEN) ws.ping(); else clearInterval(hb); }, 25000);
  ws.on("pong", ()=>{});
  ws.on("close", ()=>clearInterval(hb));
});
