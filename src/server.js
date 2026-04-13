// ─── CRYPTOBOT LIVE — SERVER ──────────────────────────────────────────────────
// Instancia real: opera con dinero real o paper controlado.
// Recibe parámetros optimizados del bot PAPER solo si cumplen el umbral.
"use strict";
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

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
const { fetchFearGreed, calcRealtimeFearGreed, fgCalibrator, fetchNewsAlert, fetchLongShortRatio, fetchFundingRate, fetchOpenInterest, fetchTakerVolume, fetchRedditSentiment, fetchLiquidations, fetchBTCDominance, fetchCoinbasePremium, fetchExchangeFlow, fetchBinanceReserve } = require("./feeds");
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
// Fallback: si LIVE_MODE no viene del env, inferir de las API keys
const _lm = process.env.LIVE_MODE;
const LIVE_MODE = _lm !== undefined ? _lm === "true" : (BINANCE_API_KEY !== "" && BINANCE_API_SECRET !== "");
console.log(`[BOOT] LIVE_MODE=${LIVE_MODE} (env=${_lm}) API_KEY=${BINANCE_API_KEY?"SET":"EMPTY"} API_SECRET=${BINANCE_API_SECRET?"SET":"EMPTY"}`);
const SYNC_SECRET        = process.env.SYNC_SECRET || "paper_live_sync_secret";
const BAFIR_URL          = process.env.BAFIR_URL   || "http://localhost:3000";
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

  // Arranque inmediato — el Kelly Gate protege el capital
  if (!saved) {
    console.log(`[LIVE] Primer arranque sin estado guardado — operando inmediatamente`);
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

// ── FIX-A/C/D wiring: callbacks síncronos a placeLiveBuy/Sell ─────────────
// simpleBot._onBuy se dispara INMEDIATAMENTE tras la mutación atómica del
// portfolio (status="pending") y antes de que cualquier otra estrategia cierre
// vela. placeLiveBuy valida el cap global, ejecuta TWAP y reconcilia vía
// applyRealBuyFill. Análogo para _onSell / applyRealSellFill.
// FIX-M1: en paper-live (LIVE_MODE=false) no hay fill real, así que marcamos
// la posición como filled inmediatamente para que no quede stuck en pending.
S.simpleBot._onBuy = (pair, invest, ctx) => {
  if (!LIVE_MODE) {
    const pos = S.simpleBot.portfolio[ctx?.strategyId];
    if (pos && pos.status === "pending") pos.status = "filled";
    return;
  }
  placeLiveBuy(pair, invest, ctx)
    .catch(e => console.error(`[LIVE][onBuy] ${ctx?.strategyId} error:`, e.message));
};
S.simpleBot._onSell = (pair, qty, ctx) => {
  // En paper-live la reconciliación ya la hizo evaluate() (expectedNet acreditado);
  // sin fill real no hay slippage que ajustar, así que no hace nada extra.
  if (!LIVE_MODE) return;
  placeLiveSell(pair, qty, ctx)
    .catch(e => console.error(`[LIVE][onSell] ${ctx?.strategyId} error:`, e.message));
};

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
      const limit = 250;
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
      // Inicializar _curBar con la última vela (bar actual incompleto de Binance)
      // Así la primera vela cierra al cruzar el siguiente período, sin espera
      const lastCandle = S.simpleBot._candles[candleKey].pop();
      if(lastCandle) {
        if(!S.simpleBot._curBar) S.simpleBot._curBar = {};
        S.simpleBot._curBar[candleKey] = lastCandle;
      }
      filled++;
      console.log(`[SIMPLE-PREFILL] ${candleKey}: ${S.simpleBot._candles[candleKey].length} velas + curBar`);
    } catch(e) { console.warn(`[SIMPLE-PREFILL] Error ${api}/${tf}:`, e.message); }
  }
  console.log(`[SIMPLE-PREFILL] ✅ ${filled} pares prefilled`);
}
await prefillSimpleBotCandles();
// Verificar sufijos de pares vs streams de Binance
const streamSymbols = new Set(PAIRS.map(p=>p.symbol));
const simplePairs = [...new Set((S.simpleBot.getState?.()?.strategies||[]).map(s=>s.pair))];
for(const sp of simplePairs){
  if(streamSymbols.has(sp)) console.log(`[SIMPLE][PAIRS] ✓ ${sp} — presente en streams de Binance`);
  else console.warn(`[SIMPLE][PAIRS] ✗ ${sp} — NO está en streams de Binance, no recibirá ticks`);
}

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
  // BAFIR endpoint no longer exists — silenced
}

const blacklist   = new Blacklist(4, 4); // Live: 4 pérdidas → 4h ban (no perder oportunidades)
const marketGuard = new MarketGuard();
const cryptoPanic = new CryptoPanicDefense();
// cryptoPanic.start() — disabled: rate-limited, not critical for trading

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

// Reset state — borrar estado guardado para empezar limpio
app.post("/api/reset-state", async (req, res) => {
  try {
    await deleteState();
    await saveSimpleState({});
    console.log("[RESET] Estado borrado — reiniciar PM2 para empezar limpio");
    res.json({ ok: true, message: "State deleted. Restart PM2 to apply." });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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
        note: "These are the server egress IPs for outbound HTTPS requests",
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
  // Engine viejo modules — se serializan para no perder estado entre restarts
  // pero no afectan trading (evaluate() es no-op)
  if(S.bot.adaptiveStop)   s.adaptiveStop   = S.bot.adaptiveStop.serialize();
  if(S.bot.adaptiveHours)  s.adaptiveHours  = S.bot.adaptiveHours.serialize();
  if(S.bot.regimeDetector) s.regimeDetector = S.bot.regimeDetector.serialize();
  await saveState(s);
}
process.on("SIGTERM",async()=>{await save();process.exit(0);});
process.on("SIGINT", async()=>{await save();process.exit(0);});

// ── Capturar errores no manejados — FIX-M5: persistir + morir limpiamente ───
// Antes de M5 este handler solo logueaba y seguía, lo que dejaba el proceso
// con estado posiblemente corrupto (p.ej. portfolio mid-mutation). Ahora:
// 1. persistimos state vía save() (capa1/capa2, portfolio, stratTrades, curBar…),
// 2. también guardamos simpleBot.saveState() para que el ledger virtual no pierda
//    el tick parcial cuando PM2 reinicie el proceso,
// 3. exit(1) para que PM2 levante una instancia limpia.
process.on("uncaughtException", async (err) => {
  console.error("[CRASH] uncaughtException:", err?.message||err);
  console.error(err?.stack);
  try { await save(); } catch(e) { console.error("[CRASH-SAVE]", e.message); }
  try {
    if(S.simpleBot?.saveState) await saveSimpleState(S.simpleBot.saveState());
  } catch(e) { console.error("[CRASH-SIMPLE-SAVE]", e.message); }
  process.exit(1);
});
process.on("unhandledRejection", async (reason) => {
  console.error("[CRASH] unhandledRejection:", reason?.message||reason);
  // Menos agresivo que uncaughtException: muchas unhandled rejections vienen de
  // fetches opcionales (F&G, news, etc). Solo persistimos por seguridad, sin exit.
  try { await save(); } catch(e) {}
  try {
    if(S.simpleBot?.saveState) await saveSimpleState(S.simpleBot.saveState());
  } catch(e) {}
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
// están configuradas en .env. Sin keys → opera en modo simulado.
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

async function placeLiveBuy(symbol, usdtAmount, ctx) {
  // ctx = {strategyId, capa, expectedPrice} — pasado por el callback _onBuy de simpleBot.
  // Con FIX-A, simpleBot ya reservó optimísticamente cash y creó portfolio[strategyId]
  // con status="pending" ANTES de disparar este callback. Este handler debe:
  //   1. Validar cap global (FIX-C) — si rechaza, rollback de la reserva en simpleBot.
  //   2. Ejecutar TWAP y capturar fills reales.
  //   3. Reconciliar drift vs expected via simpleBot.applyRealBuyFill.
  const rollbackReservation = () => {
    if (S.simpleBot && ctx?.strategyId && S.simpleBot.portfolio[ctx.strategyId]) {
      const pos = S.simpleBot.portfolio[ctx.strategyId];
      if (pos.status === "pending") {
        if (pos.capa === 1) S.simpleBot.capa1Cash += pos.invest;
        else                S.simpleBot.capa2Cash += pos.invest;
        delete S.simpleBot.portfolio[ctx.strategyId];
        console.log(`[LIVE][ROLLBACK] ${ctx.strategyId} reserva devuelta ($${pos.invest.toFixed(2)} → capa${pos.capa})`);
      }
    }
  };
  try {
    if (!LIVE_MODE) return null;

    // ── FIX-C: Cap global committed+new — rechazo con rollback ───────────────
    // Protección contra race entre simpleBot._onCandleClose (FIX-A, usa invest
    // nominal) y la ejecución real de varios BUYs en el mismo tick.
    const cap = (S.CAPITAL_USDT || 100) * 1.005;
    const committed = Object.entries(S.simpleBot?.portfolio || {})
      // Excluir la propia estrategia — su invest ya está dentro del portfolio
      // (FIX-A lo insertó sync) y no debe contarse como "ya comprometido".
      .filter(([id]) => id !== ctx?.strategyId)
      .reduce((s, [,p]) => s + (p.invest || 0), 0);
    if (committed + usdtAmount > cap) {
      console.error(`[LIVE][CAP] ❌ ${symbol} committed+new=$${(committed+usdtAmount).toFixed(2)} > cap=$${cap.toFixed(2)} — RECHAZADA`);
      tg.send && tg.send(`⚠️ <b>[LIVE] CAP EXCEDIDO</b>\n${symbol} rechazada\ncommitted+new=$${(committed+usdtAmount).toFixed(2)} > cap=$${cap.toFixed(2)}`);
      rollbackReservation();
      return null;
    }

    // Sanity pre-ejecución: si safe<5, no enviamos nada y rollback.
    const maxSafe = cap; // FIX-C se encarga del cap; no re-aplicamos 40%
    const safe = Math.min(usdtAmount, maxSafe);
    if (safe < 5) {
      console.log(`[LIVE][BUY] ${symbol} importe muy pequeño ($${safe}), omitido`);
      rollbackReservation();
      return null;
    }

    const orders = await placeTWAPBuy(symbol, safe);
    if(orders?.length) {
      // Capturar fills reales para reconciliación slippage (FIX-A closing loop)
      const fills = orders.flatMap(o=>o.fills||[]);
      const realSpent = fills.reduce((s,f)=>s+parseFloat(f.price)*parseFloat(f.qty),0) || safe;
      const realQty = fills.reduce((s,f)=>s+parseFloat(f.qty),0);
      const avgPrice = realQty>0 ? realSpent/realQty : safe;
      console.log(`[LIVE][BUY] Real: gastado $${realSpent.toFixed(2)} @ avg $${avgPrice.toFixed(2)}`);
      // Reconciliar con simpleBot (marca pending→filled, ajusta drift en capa correcta)
      if (S.simpleBot && ctx?.strategyId) {
        try { S.simpleBot.applyRealBuyFill(ctx.strategyId, {realSpent, realQty}); }
        catch(e) { console.error(`[LIVE][RECONCILE-BUY] ${ctx.strategyId}:`, e.message); }
      }
    } else {
      // Orden no ejecutada (sin fills) → rollback reserva
      console.warn(`[LIVE][BUY] ${symbol} sin fills — rollback reserva`);
      rollbackReservation();
    }
    return orders?.[0]||null;
  } catch(e) {
    console.error(`[LIVE][BUY] Error ${symbol}:`, e.message);
    rollbackReservation();
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

async function placeLiveSell(symbol, quantity, ctx) {
  // ctx = {strategyId, capa, expectedNet, expectedGross, reason} pasado por _onSell.
  // simpleBot.evaluate() ya acreditó expectedNet a la capa virtual; este handler
  // reconcilia el delta slippage vía applyRealSellFill(strategyId, {realGross, capa, expectedNet}).
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
          // [DISABLED 2026-04-12] orphan cash inflation: mismo defecto que L607 — escribe a S.bot zombie. Solo el delete del portfolio es seguro.
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
      // FIX-D: capturar fills reales y reconciliar vía applyRealSellFill
      try {
        const fills = order.fills || [];
        const realGross = fills.reduce((s,f)=>s+parseFloat(f.price)*parseFloat(f.qty),0);
        if (S.simpleBot && ctx?.strategyId && realGross > 0) {
          S.simpleBot.applyRealSellFill(ctx.strategyId, {
            realGross,
            capa: ctx.capa,
            expectedNet: ctx.expectedNet,
          });
        }
      } catch(e) { console.error(`[LIVE][RECONCILE-SELL] ${ctx?.strategyId}:`, e.message); }
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
    const virtualCapital = S.CAPITAL_USDT; // 100 USD declarados en .env
    
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

server.listen(PORT,()=>console.log(`\n🎯 CRYPTOBOT LIVE en http://localhost:${PORT} | ${LIVE_MODE?"🎯 LIVE":"📋 PAPER-LIVE"} | Tick: ${TICK_MS}ms\n`));

wss.on("connection", ws=>{
  // Enviar estado inicial
  try {
    if(S.bot) ws.send(JSON.stringify({type:"state",data:{...S.bot.getState(),instance:S.bot.mode,syncHistory: S.syncHistory}}));
    else    ws.send(JSON.stringify({type:"state",data:{loading:true,instance:"LIVE",totalValue:0}}));
  } catch(e) {}
  // Heartbeat: ping cada 25s para mantener la conexión WebSocket activa
  const hb = setInterval(()=>{ if(ws.readyState===WebSocket.OPEN) ws.ping(); else clearInterval(hb); }, 25000);
  ws.on("pong", ()=>{});
  ws.on("close", ()=>clearInterval(hb));
});
