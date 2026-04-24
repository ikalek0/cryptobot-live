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
const { saveState, loadState, deleteState, saveSimpleState, loadSimpleState, getClient: getDbClient } = require("./database");
const { shutdown: bootShutdown } = require("./boot_hardening");
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
const { getReportingState } = require("./reporting_state");
const wsAuth     = require("./ws_auth");
const { SlidingWindowLimiter, extractIp } = require("./rate_limit");
const secrets    = require("./secrets");

const PORT    = process.env.PORT    || 3000;
const TICK_MS = parseInt(process.env.TICK_MS || "10000"); // Más lento = más conservador
// BATCH-5 FIX #4: alerta dev si TICK_MS agresivo (<5s)
if (TICK_MS < 5000) console.warn(`[BOOT] ⚠️  TICK_MS=${TICK_MS}ms (<5000) — frecuencia alta, verificar que es intencional`);

// En LIVE_MODE, el capital real se obtiene de Binance al arrancar
// CAPITAL_USDT es el fallback para modo PAPER-LIVE
const BINANCE_API_KEY    = process.env.BINANCE_API_KEY    || "";
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || "";
// BUG-5: LIVE_MODE DEBE ser explícito en .env — NO inferir de las API keys.
// Antes existía un fallback: si LIVE_MODE no estaba definido, el bot inferia
// LIVE_MODE=true cuando había API keys configuradas. Esto era un footgun
// peligroso: cualquier operador que copiara .env de producción (con keys)
// a un entorno nuevo sin setear LIVE_MODE, arrancaba ejecutando trades
// reales sin consentimiento explícito. Cambiar a fail-closed: si LIVE_MODE
// no está definido, ABORT boot. Si LIVE_MODE=false explícito, PAPER-LIVE.
// Si LIVE_MODE=true explícito, LIVE.
//
// Permitimos bypass sólo en NODE_ENV=test para no romper `node --test`
// (los tests pueden cargar server.js indirectamente vía require-time).
const _lm = process.env.LIVE_MODE;
if (typeof _lm === "undefined" && process.env.NODE_ENV !== "test") {
  const banner = "!".repeat(70);
  console.error(banner);
  console.error("[BOOT] ❌ LIVE_MODE no definido en .env — debe ser 'true' o 'false' explícito");
  console.error("[BOOT] ❌ Ya no se infiere de las API keys (footgun: copiar .env arrancaba LIVE)");
  console.error("[BOOT] ❌ Aborto boot por seguridad. Define LIVE_MODE en .env y reintenta.");
  console.error(banner);
  process.exit(1);
}
const LIVE_MODE = _lm === "true";
console.log(`[BOOT] LIVE_MODE=${LIVE_MODE} (env=${_lm}) API_KEY=${BINANCE_API_KEY?"SET":"EMPTY"} API_SECRET=${BINANCE_API_SECRET?"SET":"EMPTY"}`);
const SYNC_SECRET        = process.env.SYNC_SECRET || "";
// BATCH-5 FIX #6: BAFIR_URL eliminado — sendEquityToBafir no-op removido
// BATCH-3 FIX #8: flag de readiness — false hasta que initBot() termine
let _botReady = false;
// BATCH-1 FIX #8 (#5): eliminado literal "bafir_bot_secret" — BAFIR_SECRET
// y SYNC_SECRET ya no tienen default hardcoded. warnPredictableSecrets los
// valida vía secrets.validateBootSecret() y aborta boot en LIVE_MODE si
// cualquiera cae en empty/predictable/too_short.
const BAFIR_SECRET       = process.env.BAFIR_SECRET || "";
// BATCH-1 FIX #8: warnPredictableSecrets ahora:
//   1) detecta ademas de env vacío, secrets en la lista PREDICTABLE_SECRETS
//      (incluyendo el literal "bafir_bot_secret" que estuvo en git público)
//      y secrets con length<16;
//   2) aborta boot en LIVE_MODE con cualquiera de esos motivos;
//   3) en paper-live sigue logueando warning pero no aborta.
(function warnPredictableSecrets(){
  // BATCH-3 FIX #10: BAFIR_SECRET eliminado de validación boot.
  // sendEquityToBafir() es no-op → BAFIR_SECRET es dead code que bloqueaba
  // LIVE boot sin motivo. Solo validamos secrets que protegen endpoints activos.
  // BATCH-5 FIX #3: añadido WS_SECRET — protege el WebSocket de datos live
  const checks = [
    { name: "SYNC_SECRET",  value: process.env.SYNC_SECRET  },
    { name: "BOT_SECRET",   value: process.env.BOT_SECRET   },
    { name: "WS_SECRET",    value: process.env.WS_SECRET    },
  ];
  const bad = [];
  for (const c of checks) {
    const v = secrets.validateBootSecret(c.value);
    if (!v.ok) bad.push(`${c.name} [${v.reason}]`);
  }
  if(bad.length){
    const banner = "!".repeat(70);
    console.warn(banner);
    console.warn(`[SECURITY] ⚠️  Secrets inválidos o predecibles: ${bad.join(", ")}`);
    console.warn(`[SECURITY] ⚠️  Requisitos: no-empty, no en lista predictable, ≥16 chars`);
    console.warn(`[SECURITY] ⚠️  Endpoints /api/sync/*, /api/shadow/*, /api/set-capital, /api/reset-state BYPASSABLES`);
    console.warn(`[SECURITY] ⚠️  Fix: exportar valores fuertes en .env o PM2 ecosystem`);
    console.warn(banner);
    // C3: fail-closed en LIVE_MODE. Antes solo loguearse — con LIVE_MODE=true
    // un atacante que alcance el puerto puede bypass endpoints críticos.
    // ABORT boot con mensaje claro + guardrail operativo del firewall.
    if (LIVE_MODE) {
      console.error(banner);
      console.error(`[SECURITY] ❌ LIVE_MODE=true con secrets inválidos — ABORT boot.`);
      console.error(`[SECURITY] ❌ Corrige: ${bad.join(", ")}`);
      console.error(`[SECURITY] ❌ Verifica también que ufw status muestra puerto 3001 bloqueado antes de activar LIVE_MODE.`);
      console.error(banner);
      // BATCH-4 FIX #4: intento de alerta Telegram antes de exit.
      // tg aún no está inicializado en boot temprano — usamos https directo.
      const _tgToken = process.env.TELEGRAM_TOKEN || "";
      const _tgChat  = process.env.TELEGRAM_CHAT_ID || "";
      if (_tgToken && _tgChat) {
        try {
          const _body = JSON.stringify({chat_id:_tgChat, text:`[BOOT] ABORT\nSecrets inválidos: ${bad.join(", ")}\nLIVE_MODE=true. Proceso terminando.`, parse_mode:"HTML"});
          const _https = require("https");
          const _req = _https.request({hostname:"api.telegram.org",path:`/bot${_tgToken}/sendMessage`,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(_body)},timeout:3000},()=>{});
          _req.on("error",()=>{});
          _req.write(_body); _req.end();
        } catch {}
        // Esperar 2s para que el mensaje se envíe antes de exit
        const {execSync} = require("child_process");
        try { execSync("sleep 2", {stdio:"ignore"}); } catch {}
      }
      process.exit(1);
    }
  }
})();

// BATCH-1 FIX #8: checker del BOT_SECRET con crypto.timingSafeEqual +
// fail-closed si el env value no es válido. Reemplaza los 5 checks
// inline `secret !== (process.env.BOT_SECRET || "bafir_bot_secret")`.
const checkBotSecret = secrets.makeBotSecretChecker(() => process.env.BOT_SECRET);

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

// P0-conv Fix #4: PG client compartido. Seteado dentro de initBot() tras
// await getDbClient(); consumido por el IIFE externo para pasar el client
// real a scheduleWeeklyReport/scheduleTradeAnalysisReminder (que lo capturan
// en closure). Si queda null, el logging PG degrada silencioso.
let _pgClient = null;

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

// ── PG client para trade_log (P0-conv Fix #4) ─────────────────────────────
// ensureTradeLogTable estaba importado pero nunca invocado; setContext(null,...)
// y scheduleWeekly/TradeAnalysis(tg,null,...) dejaban toda la infra trade_log
// en no-op silencioso aunque DATABASE_URL estuviera configurada. Reutilizamos
// el singleton lazy-connect de database.js (getClient) para evitar un segundo
// pool y respetar el circuit breaker (disablePg) ya presente.
// El _pgClient se setea aquí dentro de initBot(); el IIFE externo llama
// los schedulers tras la resolución de la promesa de initBot, momento en
// el que _pgClient ya está resuelto.
try {
  _pgClient = await getDbClient();
  if(_pgClient) {
    await ensureTradeLogTable(_pgClient);
    console.log("[DB] trade_log table ensured");
  } else {
    console.log("[DB] trade_log: sin cliente PG (DATABASE_URL no config / disabled) — logTrade será no-op");
  }
} catch(e) {
  console.warn("[DB] trade_log init falló:", e.message);
  _pgClient = null;
}

// ── SimpleBotEngine — 7 estrategias validadas ──────────────────────────
try {
  const savedSimple = await loadSimpleState().catch(()=>null);
  S.simpleBot = new SimpleBotEngine(savedSimple || {});
  console.log("[SIMPLE] 7 estrategias inicializadas (Capa1+Capa2)");
  S.simpleBot.setContext(_pgClient, "live", S.bot?.marketRegime||"UNKNOWN", S.bot?.fearGreed||50);
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
// ── C4: inyectar binanceReadOnlyRequest en el simpleBot para que
// _cleanupStalePending pueda verificar con Binance antes de hacer rollback.
// Sin esto (tests, o LIVE_MODE=false sin keys), _cleanupStalePending cae al
// comportamiento original de rollback inmediato.
if (typeof binanceReadOnlyRequest === "function") {
  S.simpleBot._binanceReadOnlyRequest = binanceReadOnlyRequest;
}

// A5: inyectar tg.send para que _checkDrawdownAlerts pueda notificar
// umbrales de drawdown + circuit breaker. Análogo a _binanceReadOnlyRequest
// arriba. Wrapper try/catch para blindar contra tg no listo (lo envuelve
// telegram.send mismo, pero doble guard no hace daño).
if (S.simpleBot && typeof S.simpleBot.setTelegramSend === "function") {
  S.simpleBot.setTelegramSend((msg) => {
    try { tg.send && tg.send(msg); } catch {}
  });
}

// BATCH-4 FIX #10: wrap _onBuy in try/catch with rollback defense-in-depth
S.simpleBot._onBuy = (pair, invest, ctx) => {
  try {
  // ── C1 defense in depth: rollback si pausa detectada aquí ──────────────
  const paused = (S.simpleBot?.paused === true) || !!(S.tgControls && S.tgControls.isPaused && S.tgControls.isPaused());
  if (paused) {
    const pos = S.simpleBot?.portfolio?.[ctx?.strategyId];
    if (pos && pos.status === "pending") {
      const refund = (typeof pos._investWithFee === "number")
        ? pos._investWithFee
        : (pos.invest || 0) * (1 + 0.001);
      if (pos.capa === 1) S.simpleBot.capa1Cash += refund;
      else                S.simpleBot.capa2Cash += refund;
      delete S.simpleBot.portfolio[ctx.strategyId];
      console.log(`[LIVE][onBuy][PAUSE-ROLLBACK] ${ctx?.strategyId} reserva devuelta ($${refund.toFixed(2)} → capa${pos.capa})`);
    } else {
      console.log(`[LIVE][onBuy][PAUSE] ${ctx?.strategyId} bloqueado — bot pausado (sin reserva que rollback)`);
    }
    return;
  }
  if (!LIVE_MODE) {
    const pos = S.simpleBot.portfolio[ctx?.strategyId];
    if (pos && pos.status === "pending") pos.status = "filled";
    return;
  }
  placeLiveBuy(pair, invest, ctx)
    .catch(e => {
      console.error(`[LIVE][onBuy] ${ctx?.strategyId} error:`, e.message);
      const pos = S.simpleBot?.portfolio?.[ctx?.strategyId];
      if (pos && pos.status === "pending") {
        const refund = (typeof pos._investWithFee === "number")
          ? pos._investWithFee
          : (pos.invest || 0) * (1 + 0.001);
        if (pos.capa === 1) S.simpleBot.capa1Cash += refund;
        else                S.simpleBot.capa2Cash += refund;
        delete S.simpleBot.portfolio[ctx.strategyId];
        console.error(`[onBuy] rollback defense-in-depth: ${ctx.strategyId} refund=$${refund.toFixed(2)}`);
      }
    });
  } catch(e) {
    console.error("[onBuy] sync error:", e.message);
    const pos = S.simpleBot?.portfolio?.[ctx?.strategyId];
    if (pos && pos.status === "pending") {
      const refund = (typeof pos._investWithFee === "number")
        ? pos._investWithFee
        : (pos.invest || 0) * (1 + 0.001);
      if (pos.capa === 1) S.simpleBot.capa1Cash += refund;
      else                S.simpleBot.capa2Cash += refund;
      delete S.simpleBot.portfolio[ctx.strategyId];
      console.error(`[onBuy] rollback sync: ${ctx.strategyId} refund=$${refund.toFixed(2)}`);
    }
  }
};
S.simpleBot._onSell = (pair, qty, ctx) => {
  // En paper-live la reconciliación ya la hizo evaluate() (expectedNet acreditado);
  // sin fill real no hay slippage que ajustar, así que no hace nada extra.
  if (!LIVE_MODE) return;
  placeLiveSell(pair, qty, ctx)
    .catch(e => console.error(`[LIVE][onSell] ${ctx?.strategyId} error:`, e.message));
};

// ── Prefill velas históricas de Binance para simpleBot ──────────────────
// F32 note: `key:USDC` asume que simpleBot mapea todas las strategies a pares
// USDC (convención actual post-F1). Si una strategy futura usa otro quote
// (BUSD, FDUSD, EUR...) debe actualizarse este PAIRS_TF o el prefill se salta
// silenciosamente.
async function prefillSimpleBotCandles() {
  // Fetch USDT pairs (more liquid) and store as USDC keys (what engine_simple expects)
  // F30: duplicate BTCUSDT/30m eliminado — el seen Set ya lo deduplicaba, pero
  // era copy-paste confuso (BTC_30m_RSI y BTC_30m_EMA comparten la misma vela).
  const PAIRS_TF = [
    {api:"BNBUSDT",  key:"BNBUSDC",  tf:"1h"},
    {api:"SOLUSDT",  key:"SOLUSDC",  tf:"1h"},
    {api:"BTCUSDT",  key:"BTCUSDC",  tf:"30m"},
    {api:"XRPUSDT",  key:"XRPUSDC",  tf:"4h"},
    {api:"SOLUSDT",  key:"SOLUSDC",  tf:"4h"},
    {api:"BNBUSDT",  key:"BNBUSDC",  tf:"1d"},
  ];
  const seen = new Set();
  let filled = 0;
  // F31: fetch hardening — timeout 8s via AbortSignal + retry exponencial x3
  // + validación de HTTP status. Antes: fetch() sin signal + sin res.ok check;
  // un network blip en boot provocaba 30min-24h de warmup (hasta acumular
  // CANDLE_MIN velas desde el stream live). Ahora: intentamos 3 veces con
  // backoff 1s/2s/4s, y logeamos error final para que ops pueda diagnosticar.
  async function fetchKlinesWithRetry(api, tf, limit) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${api}&interval=${tf}&limit=${limit}`;
    const backoffs = [1000, 2000, 4000];
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status}`);
          if (res.status === 429 || res.status === 418) {
            // rate-limited — respect Retry-After if present
            const ra = parseInt(res.headers.get("retry-after") || "0", 10);
            if (ra > 0) await new Promise(r => setTimeout(r, Math.min(ra * 1000, 30000)));
          }
        } else {
          const klines = await res.json();
          if (Array.isArray(klines)) return klines;
          lastErr = new Error("response is not an array");
        }
      } catch (e) {
        lastErr = e;
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, backoffs[attempt]));
    }
    throw lastErr || new Error("unknown fetch error");
  }

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
      const klines = await fetchKlinesWithRetry(api, tf, limit);
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
    } catch(e) {
      // F31: warn ruidoso en vez de silencioso — ops necesita ver el fallo
      console.warn(`[SIMPLE-PREFILL] ⚠️ ${api}/${tf} falló tras 3 intentos: ${e.message}`);
    }
  }
  console.log(`[SIMPLE-PREFILL] ✅ ${filled}/${seen.size} pares prefilled`);
}
await prefillSimpleBotCandles();
// BATCH-3 FIX #4: cache LOT_SIZE/stepSize from exchangeInfo at boot
await fetchSymbolPrecisions();
// ── T0: primer sync de capital contra Binance ────────────────────────────
// Si no hay API keys, modo legacy (capitalEfectivo = declarado).
// Si hay keys y el sync falla, el simpleBot quedará pausado 5min (gate en
// _onCandleClose). No abortamos el boot — el bot queda listo pero no compra.
if (BINANCE_API_KEY && BINANCE_API_SECRET) {
  try {
    const r = await S.simpleBot.syncCapitalFromBinance(_capitalSyncDeps());
    if (!r.ok) console.warn("[SIMPLE][CAPITAL-SYNC] primer sync falló — BUYs pausados hasta próximo intento (5min)");
  } catch(e) {
    console.warn("[SIMPLE][CAPITAL-SYNC] primer sync excepción:", e.message);
  }
} else {
  console.log("[SIMPLE][CAPITAL-SYNC] sin API keys — modo legacy, capitalEfectivo = declarado");
}

// ── A7: validación de invariante al boot (Opus M17) ──────────────────
// Tras el primer sync (o su ausencia), verificamos que el ledger virtual
// post-restart no exceda el capital efectivo. Si excede: CORRUPCIÓN —
// pausar BUYs indefinidamente y alertar. Corre independiente de LIVE_MODE
// porque es check puro de estado interno del simpleBot.
if (S.simpleBot && typeof S.simpleBot.validateBootInvariant === "function") {
  try {
    const inv = S.simpleBot.validateBootInvariant();
    if (inv.skipped) {
      console.log(`[BOOT][INVARIANT] ⏭ skipped: ${inv.reason}`);
    } else if (!inv.ok) {
      console.error(`[BOOT][INVARIANT] ❌ VIOLATED: ${inv.reason}`);
    }
  } catch(e) {
    console.warn("[BOOT][INVARIANT] check lanzó:", e.message);
  }
}
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
  // BUG A fix (20 abr 2026, commit 3): callback usa getReportingState(S)
  // para que totalValue/returnPct/winRate/log/portfolio/cash/trades/
  // realizedPnl/totalFees vengan de S.simpleBot (fuente real) en vez de
  // S.bot (zombie no-op). Contexto de mercado (marketRegime, fearGreed,
  // prices, dailyTrades) sigue viniendo de S.bot via el spread interno
  // del helper. Consumido por /estado, /posiciones, /semana→buildWeekly,
  // buildDaily si alguien vuelve a enganchar scheduleReports.
  () => ({
    ...getReportingState(S),
    instance:S.bot.mode,
    syncHistory: S.syncHistory,
    dailyPnlPct:S.bot._dailyPnlPct||0,
    momentumMult:S.bot.hourMultiplier||1,
    cryptoPanic:cryptoPanic.getStatus(),
  }),
  {
    getBalance:    getAccountBalance,
    // F2: source of truth for paused = simpleBot.paused (persisted on disk).
    // setPaused mirrors to S.bot._pausedByTelegram (consumed by loop.js) AND
    // force-flushes simpleState para evitar perder el toggle si PM2 reinicia
    // antes del próximo tick de save (cada 6 ticks ~60s).
    setPaused:     (v) => {
      if(S.bot) S.bot._pausedByTelegram=v;
      if(S.simpleBot) S.simpleBot.paused = v === true;
      if(S.simpleBot?.saveState) {
        saveSimpleState(S.simpleBot.saveState()).catch(e=>console.warn("[TG] save paused:", e.message));
      }
    },
    getSimpleState: () => S.simpleBot?.getState() || null,
    setCapital:    (v) => {
      // BATCH-1 FIX #9 (#2): delega en setCapitalEverywhere para propagar
      // a simpleBot._capitalDeclarado y respetar invest comprometido.
      // Tarea B (20 abr 2026): nueva semántica preserva realizedPnl.
      try {
        setCapitalEverywhere(Number(v));
      } catch (e) {
        console.warn("[TG] setCapital rechazado:", e.message);
        throw e;
      }
    },
    // Tarea B (20 abr 2026): nuevo comando /reset-contable — hard reset.
    resetAccounting: () => {
      try { return resetAccounting(); }
      catch (e) { console.warn("[TG] resetAccounting rechazado:", e.message); throw e; }
    },
  },
  // F2: initialPaused — boot con paused restaurado de disco
  S.simpleBot?.paused === true
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
    placeLiveBuy, placeLiveSell, getAccountBalance,
    marketGuard, blacklist, cryptoPanic, clientManager,
    LIVE_MODE, TICK_MS, SYNC_THRESHOLD,
    getLiveStartTime: () => liveStartTime,
    // C2: expose stream liveness check + telegram sink to trading/loop.js.
    // lastPriceTs vive en este módulo (ver connectBinance); el loop necesita
    // consultarlo para decidir si propagar precios al simpleBot (sin esto,
    // simulatePrices acabaría alimentando velas fabricadas al engine).
    isPriceStreamLive: () => (Date.now() - lastPriceTs) < 10000,
    getMsSinceLastTick: () => (Date.now() - lastPriceTs),
    telegramSend: (msg) => { try { tg.send && tg.send(msg); } catch {} },
  });

  // ── BATCH-3 FIX #3 (#4): sync interval con error tracking ────────────
  // Antes: .catch(()=>{}) silenciaba TODO error del sync periódico. Si
  // Binance API fallaba permanentemente, sync fallaba cada 5min sin que
  // nadie se enterase. Ahora: contador de fallos consecutivos + log +
  // alerta telegram al 5º fallo consecutivo (sin spam posterior).
  if (BINANCE_API_KEY && BINANCE_API_SECRET) {
    let _syncIntervalFailCount = 0;
    setInterval(async () => {
      if (!S.simpleBot || typeof S.simpleBot.syncCapitalFromBinance !== "function") return;
      try {
        const result = await S.simpleBot.syncCapitalFromBinance(_capitalSyncDeps());
        if (result?.ok === false) {
          _syncIntervalFailCount++;
          console.warn(`[SYNC-INTERVAL] not ok (count=${_syncIntervalFailCount}): ${result?.reason || "unknown"}`);
        } else {
          if (_syncIntervalFailCount > 0) {
            console.log(`[SYNC-INTERVAL] recovered after ${_syncIntervalFailCount} failures`);
          }
          _syncIntervalFailCount = 0;
        }
      } catch (e) {
        _syncIntervalFailCount++;
        console.error(`[SYNC-INTERVAL] error (count=${_syncIntervalFailCount}): ${e.message}`);
        if (_syncIntervalFailCount === 5) {
          try { tg.send && tg.send(`⚠️ <b>[SYNC]</b> 5 fallos consecutivos\n${e.message}\nSync broken — inspeccionar.`); } catch {}
        }
      }
    }, 5 * 60 * 1000);
  }
}

// Historial de sincronizaciones recibidas del PAPER

// BATCH-5 FIX #6: sendEquityToBafir eliminado — BAFIR endpoint no existe

const blacklist   = new Blacklist(4, 4); // Live: 4 pérdidas → 4h ban (no perder oportunidades)
const marketGuard = new MarketGuard();
const cryptoPanic = new CryptoPanicDefense();
// cryptoPanic.start() — disabled: rate-limited, not critical for trading

const app    = express();
const server = http.createServer(app);

// ── BATCH-1 FIX #6 (H2): WebSocket authentication ─────────────────────
// El WebSocket difunde estado del bot (portfolio, ledger, trades) a
// todos los clientes conectados. Antes NO validaba nada: cualquier
// cliente en la red/puerto podía conectar y escuchar. Gate añadido vía
// verifyClient + crypto.timingSafeEqual (ver src/ws_auth.js). Cuando
// WS_SECRET (o BOT_SECRET como fallback) está seteado, toda conexión
// debe incluir ?token=<valor> en la URL. Fail-open sólo si el env var
// está vacío (dev/test).
const _getWsToken = () => process.env.WS_SECRET || process.env.BOT_SECRET || "";
if (!_getWsToken()) {
  console.warn("[BOOT] ⚠️  WS_SECRET y BOT_SECRET vacíos — WebSocket acepta conexiones sin auth (dev mode). En producción setear WS_SECRET.");
}
const wss    = new WebSocketServer({
  server,
  verifyClient: wsAuth.makeVerifyClient(_getWsToken),
});

// BATCH-1 FIX #6: index.html recibe el token vía injection server-side
// en un <script> antes de </head>. El cliente lee window.__WS_TOKEN__
// y lo añade al query string de la URL del WebSocket. De este modo el
// token nunca se hardcodea en el HTML estático.
function serveIndex(req, res) {
  const fs = require("fs");
  const file = path.join(__dirname, "../public/index.html");
  fs.readFile(file, "utf-8", (err, html) => {
    if (err) {
      res.status(500).send("index read error");
      return;
    }
    const token = _getWsToken();
    const inject = `<script>window.__WS_TOKEN__=${JSON.stringify(token)};</script>`;
    const out = html.includes("</head>")
      ? html.replace("</head>", `${inject}</head>`)
      : inject + html;
    res.set("Cache-Control", "no-store").type("html").send(out);
  });
}
app.get("/", serveIndex);
app.get("/index.html", serveIndex);
app.use(express.static(path.join(__dirname,"../public")));
// BATCH-4 FIX #6: capture raw body for HMAC verification on /api/sync/*
app.use(express.json({
  verify: (req, _res, buf) => {
    if (req.url && req.url.startsWith("/api/sync")) {
      req.rawBody = buf;
    }
  },
}));

// ── BATCH-1 FIX #7 (HIGH-4): rate limiting ────────────────────────────
// Dos limiters separados:
//   - mutationLimiter: 10 requests / 60s por IP en endpoints mutantes.
//     Evita floods y brute-force de bajo ritmo que atraviesen el auth
//     check en una sola ráfaga.
//   - authLimiter:     5 auth failures / 15min por IP. Cuando una
//     request mutante falla el check de BOT_SECRET, la route llama
//     onAuthFailure(req,res) que registra el fallo Y devuelve 429 si
//     la IP ya está bloqueada. De este modo el 429 tiene prioridad
//     sobre el 401, enseñando al atacante menos info sobre el estado
//     del secret.
const rateLimiter     = new SlidingWindowLimiter();
const mutationLimiter = rateLimiter.middleware({
  max: 10,
  windowMs: 60_000,
  bucket: "mut",
  onBlock: (key) => console.warn(`[RATE-LIMIT] 429 ${key}`),
});
// Helper llamado dentro de las routes tras detectar BOT_SECRET inválido.
// Devuelve true si la route DEBE retornar tras esta llamada (porque ya
// respondió con 429 o 401); false sólo si el caller aún tiene que
// responder (no ocurre actualmente — siempre retornamos desde aquí).
function onAuthFailure(req, res) {
  const key = `auth:${extractIp(req)}`;
  const r = rateLimiter.checkAndHit(key, 5, 15 * 60 * 1000);
  if (!r.ok) {
    const retryAfterSec = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({ error: "Too many auth failures", retryAfterSec });
    console.warn(`[RATE-LIMIT] 429 ${key} (auth block)`);
    return true;
  }
  res.status(401).json({ error: "No autorizado" });
  return true;
}

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

// ── Endpoint compacto orientado a watchdog/invariantes ─────────────────
// Devuelve el estado real del SimpleBotEngine (no el zombie ledger de S.bot),
// incluyendo el invariante del cap estricto $100 para alertas externas.
//
// A10 OPERATIONAL SECURITY NOTE: el endpoint expone el estado de pausa
// (`paused` = simpleBot mirror via /pausa Telegram, `tgControlsPaused` =
// flag del listener de Telegram) para que un watchdog externo pueda
// verificar si el bot está operando sin tener que consultar Telegram.
// También se expone `capitalSyncPausedUntil` en raíz para detectar el
// circuit breaker de drawdown (A5: `Infinity` cuando el CB de DD15% se
// dispara). La distinción entre `paused` y `tgControlsPaused` importa
// porque son fuentes de verdad distintas — la primera es el flag
// persistido en disco (source of truth post-F2), la segunda es el
// in-memory del listener de Telegram.
app.get("/api/simpleBot/state", (_,res) => {
  const sb = S.simpleBot;
  if (!sb) return res.status(503).json({ loading: true, instance: LIVE_MODE?"LIVE":"PAPER-LIVE" });
  // BUG-4: sentinel numérico para pausa indefinida. Antes se devolvía `null`
  // cuando _capitalSyncPausedUntil=Infinity (CB A5 o boot invariant A7 tripped),
  // pero un watchdog externo puede interpretar null como "no pausado" o
  // "dato ausente" silenciosamente y no detectar el trip. Con el sentinel
  // FAR_FUTURE (año 2286), `Date.now() < pausedUntil` sigue siendo true
  // indefinidamente, y el watchdog puede detectarlo explícitamente con
  // `pausedUntil >= FAR_FUTURE` o `ddCircuitBreakerTripped === true`.
  const FAR_FUTURE = 9999999999999; // ~año 2286, sentinel para pausa indefinida
  const _capSync = Number.isFinite(sb._capitalSyncPausedUntil)
    ? (sb._capitalSyncPausedUntil || 0)
    : FAR_FUTURE;
  const s          = sb.getState();
  const committed  = Object.values(sb.portfolio||{}).reduce((a,p)=>a+(p.invest||0), 0);
  const capa1Cash  = sb.capa1Cash || 0;
  const capa2Cash  = sb.capa2Cash || 0;
  const totalLedger = capa1Cash + capa2Cash + committed;
  const cap        = S.CAPITAL_USDT;
  const tv         = s.totalValue || 0;
  // A10: distinguir pausa "simpleBot.paused" (persistida, vía /pausa
  // Telegram) de "tgControlsPaused" (in-memory del listener). Un watchdog
  // externo puede alertar si alguna de las dos está true.
  const paused          = sb.paused === true;
  const tgControlsPaused = !!(S.tgControls && typeof S.tgControls.isPaused === "function" && S.tgControls.isPaused());
  // M14: drawdownPct viene del engine (contra peak histórico, no contra
  // cap declarado). Antes este endpoint recalculaba drawdown = (cap-tv)/cap
  // lo que reportaba 86% con capital real $14 sin haber perdido nada.
  res.json({
    instance:     LIVE_MODE ? "LIVE" : "PAPER-LIVE",
    mode:         s.mode,
    tick:         s.tick,
    cap:          cap,
    totalValue:   +tv.toFixed(4),
    capa1Cash:    +capa1Cash.toFixed(4),
    capa2Cash:    +capa2Cash.toFixed(4),
    committed:    +committed.toFixed(4),
    totalLedger:  +totalLedger.toFixed(4),
    capViolation: totalLedger > cap * 1.005,
    drawdownPct:  s.drawdownPct,
    peakTv:       s.peakTv,
    baseline:     s.baseline,
    openPositions: Object.keys(sb.portfolio||{}).length,
    portfolio:    sb.portfolio || {},
    trades:       s.trades,
    winRate:      s.winRate,
    returnPct:    s.returnPct,
    // ── A10: pause flags para watchdog externo ────────────────────────
    paused,
    tgControlsPaused,
    // ── T0: capital dinámico ──────────────────────────────────────────
    // Tarea B (20 abr 2026): efectivo=real en LIVE (sin cap min()). Ver
    // syncCapitalFromBinance. Sigue siendo min(declarado, real) conceptualmente
    // sólo en display antiguo; el engine calcula con efectivo=real en LIVE.
    capitalDeclarado: sb._capitalDeclarado,
    capitalReal:      sb._capitalReal,
    capitalEfectivo:  sb._capitalEfectivo,
    usdcLibre:        sb._usdcLibre,
    valorPosiciones:  sb._valorPosiciones,
    // ── BUG B: contabilidad explícita de PnL (20 abr 2026) ─────────────
    // realizedPnl = $ netos acumulados (SELL.expectedNet − BUY.cashDebit) desde boot
    // o desde último /reset-contable. totalFees = $ fees USDC equivalentes acumulados.
    realizedPnl:      +Number(sb.realizedPnl || 0).toFixed(6),
    totalFees:        +Number(sb.totalFees || 0).toFixed(6),
    // BUG-4: alias en raíz para watchdogs que no quieran navegar capitalSync.
    // Ahora usa sentinel FAR_FUTURE en vez de null para distinguir
    // "pausado indefinidamente" (CB tripped) de "dato ausente". Los flags
    // ddCircuitBreakerTripped y bootInvariantViolated dan visibilidad
    // explícita del motivo de la pausa indefinida.
    capitalSyncPausedUntil: _capSync,
    ddCircuitBreakerTripped: sb._ddCircuitBreakerTripped === true,
    bootInvariantViolated:   sb._bootInvariantViolated === true,
    capitalSync: {
      lastTs:      sb._lastCapitalSyncTs || 0,
      ok:          sb._lastCapitalSyncOk !== false,
      failCount:   sb._capitalSyncFailCount || 0,
      pausedUntil: _capSync,
      pausedNow:   Date.now() < (sb._capitalSyncPausedUntil || 0),
    },
    // ── T0-FEE: fee mode + BNB balance ────────────────────────────────
    bnbFeeEnabled: sb._bnbFeeEnabled === true,
    bnbBalance:    +(sb._bnbBalance || 0).toFixed(8),
    bnbLowAlert:   (sb._bnbBalance || 0) < 0.005,
    lastFeeMode:   sb._lastFeeMode || null,
    // BUG-P: exponer log para que el dashboard / watchdogs externos puedan
    // mostrar el historial reciente de trades. slice(-200) acota tamaño
    // del payload (sb.log puede crecer ilimitado en bots de larga vida).
    log: Array.isArray(sb.log) ? sb.log.slice(-200) : [],
  });
});
app.get("/api/state",  (_,res)=>res.json(S.bot?{...S.bot.getState(),instance:LIVE_MODE?"LIVE":"PAPER-LIVE",blacklist:S.bot.autoBlacklist.getStatus(),syncHistory: S.syncHistory,dailyPnlPct:S.bot._dailyPnlPct||0,momentumMult:S.bot.hourMultiplier||1,cryptoPanic:cryptoPanic?.getStatus?.()??null}:{loading:true,instance:LIVE_MODE?"LIVE":"PAPER-LIVE",totalValue:0}));
// BATCH-3 FIX #8: /api/health devuelve 503 hasta que initBot complete
app.get("/api/health", (_,res)=>{
  if (!_botReady) return res.status(503).json({ok:false,ready:false,instance:LIVE_MODE?"LIVE":"PAPER-LIVE",uptime:process.uptime()});
  res.json({ok:true,ready:true,instance:LIVE_MODE?"LIVE":"PAPER-LIVE",tick:S.bot?.tick,uptime:process.uptime(),tv:S.bot?.totalValue()});
});

// Reset state — borrar estado guardado para empezar limpio
// C3: auth obligatoria. Sin esto, cualquiera que alcance el puerto 3001
// puede borrar state.json + simpleState vía POST vacío → seed Kelly gates
// positivos, olvidar posiciones reales abiertas. Usa el mismo patrón que
// /api/set-capital (BOT_SECRET).
app.post("/api/reset-state", mutationLimiter, async (req, res) => {
  const { secret } = req.body || {};
  if (!checkBotSecret(secret))
    return onAuthFailure(req, res);
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
// C3: solo disponible en paper-live (debug). En LIVE exponer la IP del
// servidor es info de reconocimiento útil para un atacante.
app.get("/api/myip", (req,res)=>{
  if (LIVE_MODE) return res.status(404).json({error:"not available in LIVE"});
  const https2=require("https");
  https2.get("https://api.ipify.org?format=json", r=>{
    let d=""; r.on("data",c=>d+=c);
    r.on("end",()=>{ try{ res.json(JSON.parse(d)); }catch{ res.json({ip:"error"}); } });
  }).on("error",()=>res.json({ip:"error"}));
});

// Check EGRESS IP (what external services like Binance actually see)
// C3: solo disponible en paper-live (debug).
app.get("/api/myip-egress", (req,res)=>{
  if (LIVE_MODE) return res.status(404).json({error:"not available in LIVE"});
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
  // ── Cleanup BUG D (20 abr 2026): drawdown leído del simpleBot ─────────
  // Antes: S.bot.getState().drawdownPct, que se calcula sobre this.maxEquity
  // del engine zombie cuyo totalValue() está congelado en INITIAL_CAPITAL.
  // Ahora: del simpleBot (fuente de verdad), con fallback al zombie 0.
  const simpleDD = (typeof S.simpleBot?.getState === "function")
    ? Number(S.simpleBot.getState().drawdownPct || 0)
    : 0;
  res.json({
    score: S.bot.confidence.get(),
    label: S.bot.confidence.getLabel(),
    color: S.bot.confidence.getColor(),
    blacklist: S.bot.autoBlacklist.getStatus(),
    winRate: S.bot.recentWinRate(),
    drawdown: simpleDD,
  });
});
// Reset endpoint eliminado por seguridad — no exponer esta funcionalidad

// ── ENDPOINT: recibir parámetros del PAPER ────────────────────────────────────
app.post("/api/sync/params", mutationLimiter, (req,res) => {
  // BATCH-4 FIX #6: HMAC sobre raw body (no re-stringificación frágil)
  const sig  = req.headers["x-signature"];
  if (!sig) { onAuthFailure(req, res); return; }
  if (!req.rawBody) return res.status(400).json({error:"Missing body"});
  const expected = require("crypto").createHmac("sha256", SYNC_SECRET).update(req.rawBody).digest("hex");
  try {
    if (!require("crypto").timingSafeEqual(Buffer.from(sig,"hex"), Buffer.from(expected,"hex"))) {
      console.warn("[SYNC] Firma inválida — posible ataque");
      onAuthFailure(req, res); return;
    }
  } catch(e) { onAuthFailure(req, res); return; }

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
app.post("/api/sync/daily", mutationLimiter, (req,res) => {
  // BATCH-4 FIX #6: HMAC sobre raw body (no re-stringificación)
  const sig  = req.headers["x-signature"];
  if (!sig) { onAuthFailure(req, res); return; }
  if (!req.rawBody) return res.status(400).json({error:"Missing body"});
  const expected = require("crypto").createHmac("sha256", SYNC_SECRET).update(req.rawBody).digest("hex");
  try {
    if (!require("crypto").timingSafeEqual(Buffer.from(sig,"hex"), Buffer.from(expected,"hex"))) {
      onAuthFailure(req, res); return;
    }
  } catch(e) { onAuthFailure(req, res); return; }

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
app.post("/api/shadow/entry", mutationLimiter, (req,res) => {
  const {secret, symbol, entryPrice, strategy, regime, stateKey} = req.body;
  if(!checkBotSecret(secret)) return onAuthFailure(req, res);
  shadow.shadowEntry(symbol, entryPrice, strategy, regime, stateKey);
  res.json({ok:true, adopted: shadow.shouldExecute(strategy, regime), confidence: shadow.getConfidence(strategy, regime)});
});

app.post("/api/shadow/exit", mutationLimiter, (req,res) => {
  const {secret, symbol, exitPrice, pnl} = req.body;
  if(!checkBotSecret(secret)) return onAuthFailure(req, res);
  shadow.shadowExit(symbol, exitPrice, pnl);
  res.json({ok:true, stats: shadow.getStats()});
});

app.get("/api/shadow/status", (req,res) => {
  res.json(shadow.getStats());
});

// ── Alert config from Bafir ────────────────────────────────────────────────────
app.post("/api/set-alert-config", mutationLimiter, (req,res) => {
  const {secret, alertConfig} = req.body;
  if(!checkBotSecret(secret)) return onAuthFailure(req, res);
  if(alertConfig) {
    global._alertConfig = alertConfig;
    console.log(`[ALERT-CFG] Win: ${alertConfig.winPct}% Loss: ${alertConfig.lossPct}%`);
  }
  res.json({ok:true});
});

app.post("/api/set-capital", mutationLimiter, async (req,res) => {
  const { secret, capitalUSD } = req.body || {};
  if (!checkBotSecret(secret))
    return onAuthFailure(req, res);
  // BATCH-1 FIX #9 (#2): input validation + propagación a simpleBot.
  // Antes este endpoint solo tocaba S.CAPITAL_USDT y S.bot.cash (zombie),
  // nunca simpleBot._capitalDeclarado — el pipeline real seguía operando
  // con INITIAL_CAPITAL. setCapitalEverywhere hace ambos + respeta invest.
  const n = Number(capitalUSD);
  if (!Number.isFinite(n) || n <= 0) {
    return res.status(400).json({ error: "Capital inválido" });
  }
  if (n > 1e6) {
    return res.status(400).json({ error: "Capital sanity check failed (>$1M)" });
  }
  try {
    // BUG-J: await saved antes del 200 — garantiza que el cambio de capital
    // esté persistido en disco/PG antes de responder al cliente. Si PM2 mata
    // el proceso justo después del 200, el estado ya está safe.
    const r = setCapitalEverywhere(n);
    await r.saved;
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({
    ok: true,
    capitalUSD: n,
    reserve: +(n * 0.15).toFixed(2),
    maxOperable: +(n * 0.85).toFixed(2),
  });
});

// ── Tarea B (20 abr 2026): /api/reset-accounting ────────────────────────
// Reset contable duro. Opuesto semántico de /api/set-capital (que preserva
// realizedPnl). Ver setResetContable() arriba. Guard: rechaza si hay
// posiciones abiertas. Requiere BOT_SECRET y pasa por mutationLimiter.
app.post("/api/reset-accounting", mutationLimiter, async (req,res) => {
  const { secret } = req.body || {};
  if (!checkBotSecret(secret)) return onAuthFailure(req, res);
  try {
    // BUG-J: await saved antes del 200. Ver nota en /api/set-capital.
    const r = resetAccounting();
    await r.saved;
    res.json({ ok: true, reset: r.before });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// ── Historial de sincronizaciones ─────────────────────────────────────────────

app.get("/api/sync/history", (_,res) => res.json({
  syncHistory: S.syncHistory,
  threshold: SYNC_THRESHOLD,
  currentParams: S.bot?.optimizer?.getParams(),
}));

// BATCH-3 FIX #8: server.listen bloqueado hasta que initBot() termine.
// Antes: initBot() en IIFE fire-and-forget, listen al nivel de módulo.
// Ahora: listen DENTRO del IIFE, tras await initBot(). Si initBot falla → exit(1).
(async () => {
  try {
    await initBot();
    _botReady = true;
    // BATCH-3 FIX #8: solo arranca servidor DESPUÉS de initBot exitoso.
    // P0-conv Fix #4: pasar _pgClient real (resuelto dentro de initBot)
    // para que los weekly/trade reports consulten trade_log.
    scheduleWeeklyReport(tg, _pgClient, "live", null);
    scheduleTradeAnalysisReminder(tg, _pgClient, "live");
    server.listen(PORT, () => console.log(`\n🎯 CRYPTOBOT LIVE en http://localhost:${PORT} | ${LIVE_MODE?"🎯 LIVE":"📋 PAPER-LIVE"} | Tick: ${TICK_MS}ms\n`));
  } catch (e) {
    console.error("[BOOT] initBot falló, abortando:", e?.message || e);
    process.exit(1);
  }
})();

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
// BUG-I: antes, SIGTERM/SIGINT solo persistía S.bot (engine zombie) vía save();
// S.simpleBot quedaba fuera → restart limpio podía perder hasta 60s de
// realizedPnl, cambios de /capital, /reset-contable o fills recientes.
// El patrón ya existía en uncaughtException (L1080-1094); la función shutdown
// en src/boot_hardening.js lo replica para SIGTERM/SIGINT con try/catch
// independientes para cada save.
process.on("SIGTERM", () => bootShutdown("SIGTERM", { save, saveSimpleState, simpleBot: S.simpleBot }));
process.on("SIGINT",  () => bootShutdown("SIGINT",  { save, saveSimpleState, simpleBot: S.simpleBot }));

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
  // BATCH-4 FIX #3: alerta Telegram ANTES de exit
  try {
    if (typeof tg !== "undefined" && tg && typeof tg.send === "function") {
      tg.send(`🚨 <b>[CRASH] uncaughtException</b>\n<code>${String(err?.message || err).slice(0, 300)}</code>\nProceso terminando.`);
    }
  } catch {}
  try { await save(); } catch(e) { console.error("[CRASH-SAVE]", e.message); }
  try {
    if(S.simpleBot?.saveState) await saveSimpleState(S.simpleBot.saveState());
  } catch(e) { console.error("[CRASH-SIMPLE-SAVE]", e.message); }
  process.exit(1);
});
// FIX-M10: throttle de persistencia en unhandledRejection.
// Un rate-limit en Binance o feeds opcionales puede disparar 100+ rejections/min.
// Sin throttle: 100+ writes a disco/DB por minuto → desgaste SSD + posible
// bottleneck I/O. Con throttle de 30s: logging siempre, persistencia como mucho
// cada 30s (suficiente para recovery tras crash sin matar el disco).
//
// A9: enhance con Telegram notification. Antes este handler solo loggeaba y
// persistía silenciosamente — ops no veía nada en Telegram y podía pasarse
// horas sin enterarse de una promise rejection recurrente (network blip,
// API key inválida, bug de código). Ahora envía un mensaje resumido con
// stack trunco. El envío es try/catch porque `tg` puede no estar listo
// (rejection durante el propio boot antes de initBot) — en ese caso sólo
// queda el console.error, que siempre funciona. El throttle de save NO se
// aplica al Telegram send porque queremos visibilidad inmediata de cada
// rejection única; si hay storm, el rate limit del propio telegram.send
// (400ms entre mensajes) absorbe el burst sin tirar el handler.
let _lastRejectionSave = 0;
const REJECTION_SAVE_THROTTLE_MS = 30 * 1000;
// BATCH-4 FIX #2: exit threshold — >20 rejections en 60s = estado degradado persistente
let _rejectionWindow = [];
process.on("unhandledRejection", async (reason) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  console.error("[CRASH] unhandledRejection:", reason?.message||reason);
  try {
    if (typeof tg !== "undefined" && tg && typeof tg.send === "function") {
      tg.send(`🚨 <b>[LIVE] UNHANDLED REJECTION</b>\n<code>${msg.slice(0, 500)}</code>\n\nProceso continúa. Revisar logs PM2.`);
    }
  } catch {}
  // BATCH-4 FIX #2: conteo en ventana de 60s
  const now = Date.now();
  _rejectionWindow.push(now);
  _rejectionWindow = _rejectionWindow.filter(t => now - t < 60000);
  if (_rejectionWindow.length > 20) {
    console.error(`[CRASH] >20 rejections en 60s — estado degradado persistente, exit`);
    try { await save(); } catch(e) {}
    try {
      if(S.simpleBot?.saveState) await saveSimpleState(S.simpleBot.saveState());
    } catch(e) {}
    process.exit(1);
  }
  if (now - _lastRejectionSave < REJECTION_SAVE_THROTTLE_MS) return;
  _lastRejectionSave = now;
  try { await save(); } catch(e) {}
  try {
    if(S.simpleBot?.saveState) await saveSimpleState(S.simpleBot.saveState());
  } catch(e) {}
});

// ── Binance WebSocket ─────────────────────────────────────────────────────────
const symbols   = PAIRS.map(p=>p.symbol.toLowerCase());
const streamUrl = `wss://stream.binance.com:9443/stream?streams=${symbols.map(s=>`${s}@miniTicker`).join("/")}`;
let lastPriceTs=Date.now();

// BATCH-3 FIX #9: exponential backoff + jitter en reconexión WS.
let _wsReconnectDelay = 0;
const _WS_BASE_DELAY  = 2000;
const _WS_MAX_DELAY   = 60000;
// BATCH-4 FIX #12: track last WS message for silent stream detection
let _lastWsMessageAt = Date.now();
let _currentWs = null;

function connectBinance() {
  const ws=new WebSocket(streamUrl);
  _currentWs = ws;
  ws.on("open", ()=>{
    S.binanceLive=true;
    _wsReconnectDelay=0;
    _lastWsMessageAt = Date.now(); // BATCH-4 FIX #12: reset on connect
    console.log("[BINANCE] ✓ Stream en vivo");
  });
  ws.on("message", raw=>{
    _lastWsMessageAt = Date.now(); // BATCH-4 FIX #12
    try{const{data}=JSON.parse(raw);if(data?.s&&data?.c&&S.bot){S.bot.updatePrice(data.s,parseFloat(data.c));lastPriceTs=Date.now();}}catch(e){}
  });
  ws.on("close", ()=>{
    S.binanceLive=false;
    _currentWs = null;
    _wsReconnectDelay = _wsReconnectDelay === 0 ? _WS_BASE_DELAY : Math.min(_wsReconnectDelay * 2, _WS_MAX_DELAY);
    const jitter = _wsReconnectDelay * (0.75 + Math.random() * 0.5);
    console.warn(`[BINANCE] WS cerrado, reconectando en ${Math.round(jitter/1000)}s`);
    setTimeout(connectBinance, jitter);
  });
  ws.on("error", e=>console.error("[BINANCE]",e.message));
}

// BATCH-4 FIX #12: detect silent WS (connected but no messages) and force reconnect
const _wsSilentCheckInterval = setInterval(() => {
  if (S.binanceLive && _currentWs && Date.now() - _lastWsMessageAt > 60 * 1000) {
    console.warn("[BINANCE] WS silente >60s — forzando reconnect");
    try {
      tg.send && tg.send("[BINANCE] WS silente >60s — reconnect forzado");
    } catch {}
    try { _currentWs.terminate(); } catch {}
  }
}, 30 * 1000);
_wsSilentCheckInterval.unref();

const SEEDS={BTCUSDC:67000,ETHUSDC:3500,SOLUSDC:180,BNBUSDC:580,AVAXUSDC:38,ADAUSDC:0.45,DOTUSDC:8.5,LINKUSDC:18,UNIUSDC:10,AAVEUSDC:95,XRPUSDC:0.52,LTCUSDC:82};
// BATCH-4 FIX #9: en LIVE_MODE, nunca generar precios fake
let _simPriceWarnedLive = false;
function simulatePrices(){
  if(!S.bot||Date.now()-lastPriceTs<10000) return;
  if (LIVE_MODE) {
    if (!_simPriceWarnedLive) {
      console.warn("[LIVE] simulatePrices skipped — LIVE_MODE no permite precios fake");
      _simPriceWarnedLive = true;
    }
    return;
  }
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

// ── BATCH-1 HIGH-3: binanceRequest robustness ───────────────────────────
// Los helpers signed y retry están en src/binance_client.js (módulo puro,
// testable en aislamiento). Aquí creamos las cierres (closures) sobre la
// config actual del proceso (LIVE_MODE, API keys).
const binanceClient = require("./binance_client");

// BATCH-4 FIX #8: log una vez cuando LIVE_MODE=false retorna null
let _binanceNullWarned = false;
function binanceRequest(method, path, params = {}) {
  if (!LIVE_MODE) {
    if (!_binanceNullWarned) {
      console.log("[BINANCE] LIVE_MODE=false — binanceRequest retorna null (paper-live mode)");
      _binanceNullWarned = true;
    }
    return Promise.resolve(null);
  }
  return binanceClient.signedRequest({
    method, path, params,
    apiKey: BINANCE_API_KEY,
    apiSecret: BINANCE_API_SECRET,
    readOnly: false,
  });
}

// ── T0: read-only request helper — ignora LIVE_MODE ────────────────────────
// Sólo GET, sólo para sincronización de capital / auditoría. Nunca toca
// fondos. Falla explícito si no hay API keys (para que syncCapitalFromBinance
// pueda pausar BUYs en vez de operar con datos stale).
function binanceReadOnlyRequest(method, path, params = {}) {
  return binanceClient.signedRequest({
    method, path, params,
    apiKey: BINANCE_API_KEY,
    apiSecret: BINANCE_API_SECRET,
    readOnly: true,
  });
}

// Helper inyectado a simpleBot.syncCapitalFromBinance para desacoplar
// el motor de la capa de red (tests pueden mockearlo).
function _capitalSyncDeps() {
  return {
    binanceReadOnlyRequest,
    binancePublicRequest: (m, p, q) => require("./binance_client").publicRequest(m, p, q),
    telegramSend: (msg) => { try { tg.send && tg.send(msg); } catch {} },
    // BUG B fix (20 abr 2026): propagar LIVE_MODE para que syncCapitalFromBinance
    // haga short-circuit en PAPER-LIVE. Sin esta flag el sync corría igualmente
    // si había API keys y reseteaba capas cada 5 min, borrando realizedPnl virtual.
    liveMode: LIVE_MODE,
  };
}

// ── BATCH-1 FIX #9 (#2) + Tarea B (20 abr 2026): setCapitalEverywhere ────
//
// SEMÁNTICA DE /capital (20 abr 2026 — redefinida):
//   "/capital V" = "el usuario ha depositado/retirado dinero hasta dejar
//   el baseline declarado en V". NO es un reset contable.
//   - _capitalDeclarado = V (nuevo baseline).
//   - realizedPnl se PRESERVA (el histórico sigue válido, solo ha cambiado
//     el baseline contable).
//   - capa1/capa2 redistribuidas como (V + realizedPnl) * split - committed
//     para que el PnL acumulado siga reflejado en las capas.
//   - peakTv NO se toca (sigue siendo el high-water mark histórico).
//   - ddAlert* y ddCircuitBreakerTripped NO se resetean (el DD relativo al
//     peak sigue siendo válido).
//   - Guard: rechaza si hay posiciones abiertas (consistencia con el guard
//     de tg.js que ya hacía esto desde el Telegram).
//
// Para el caso "quiero reset contable desde cero" existe setResetContable()
// (expuesto como /reset-contable y /api/reset-accounting). Ese sí hace:
//   realizedPnl=0, peakTv=null, ddAlert*=false, ddCircuitBreakerTripped=false.
//
// Las dos semánticas están separadas a propósito para evitar la ambigüedad
// previa donde /capital hacía reset silencioso del PnL histórico.
function setCapitalEverywhere(newCap) {
  if (typeof newCap !== "number" || !Number.isFinite(newCap) || newCap <= 0) {
    throw new Error("capital must be a finite number > 0");
  }
  if (newCap > 1e6) {
    throw new Error("capital sanity check failed (>$1M)");
  }
  // Tarea B: rechazar si hay posiciones abiertas. El guard ya existía en el
  // comando /capital de Telegram (tg.js:216-223) pero NO en el endpoint HTTP
  // /api/set-capital — este check centraliza la guarda para ambos paths.
  if (S.simpleBot && S.simpleBot.portfolio) {
    const openCount = Object.keys(S.simpleBot.portfolio).length;
    if (openCount > 0) {
      throw new Error(`cannot change capital with ${openCount} open position(s) — close them first`);
    }
  }
  S.CAPITAL_USDT = newCap;
  if (S.bot) {
    if (typeof S.bot.cash === "number" && S.bot.cash > newCap) S.bot.cash = newCap;
  }
  if (S.simpleBot) {
    S.simpleBot._capitalDeclarado = newCap;
    // Tarea B: preservar realizedPnl al redistribuir.
    // operational = newCap + realizedPnl = lo que el bot tiene disponible.
    // Redistribución 60/40 del operational. committed=0 porque acabamos
    // de rechazar open positions arriba.
    const rp = Number.isFinite(S.simpleBot.realizedPnl) ? S.simpleBot.realizedPnl : 0;
    const operational = Math.max(0, newCap + rp);
    S.simpleBot.capa1Cash = operational * 0.60;
    S.simpleBot.capa2Cash = operational * 0.40;
    // Sync inmediato en LIVE; en PAPER skip (guard interno devuelve early).
    if (typeof S.simpleBot.syncCapitalFromBinance === "function") {
      Promise.resolve(S.simpleBot.syncCapitalFromBinance(_capitalSyncDeps()))
        .catch(e => console.warn("[SET-CAPITAL] sync failed:", e && e.message));
    }
  }
  console.log(`[SET-CAPITAL] Capital declarado = $${newCap.toFixed(2)} (realizedPnl preservado)`);
  // BUG-J: persistir inmediato antes del return. Patrón {ok, ...datos, saved:
  // Promise} en vez de async function porque telegram.js:222-228 captura
  // throws síncronos de validación con try/catch sync; convertir a async
  // rompería ese flujo (el throw iría a la Promise y el send("❌") no
  // dispararía). El HTTP handler debe hacer `await r.saved` antes del res.json.
  // El try/catch interno evita unhandledRejection si PG/disco falla — el
  // save fail loggea pero no tumba la response.
  const saved = (async () => {
    try {
      if (S.simpleBot && typeof S.simpleBot.saveState === "function") {
        await saveSimpleState(S.simpleBot.saveState());
      }
    } catch (e) {
      console.warn("[SET-CAPITAL] save failed:", e && e.message ? e.message : String(e));
    }
  })();
  return { ok: true, capital: newCap, realizedPnlPreserved: true, saved };
}

// ── Tarea B (20 abr 2026): reset contable duro ─────────────────────────
// Opuesto semántico de setCapitalEverywhere. No cambia _capitalDeclarado,
// solo borra el histórico contable:
//   - realizedPnl = 0 (cualquier PnL acumulado se archiva mentalmente — sigue
//     vivo en stratTrades/trade_log/PostgreSQL para forense; lo que cambia es
//     que NO aparece en el ledger vivo del bot).
//   - totalFees = 0
//   - peakTv = null (el próximo getState lo re-inicializa a totalValue actual).
//   - ddAlert3/5/10 = false, ddCircuitBreakerTripped = false (un reset
//     contable implica "empezar de cero" así que las alertas/CB del ciclo
//     anterior ya no aplican).
// Guard: rechaza si hay posiciones abiertas.
function resetAccounting() {
  if (!S.simpleBot) throw new Error("simpleBot not initialized");
  const openCount = Object.keys(S.simpleBot.portfolio || {}).length;
  if (openCount > 0) {
    throw new Error(`cannot reset accounting with ${openCount} open position(s) — close them first`);
  }
  const before = {
    realizedPnl: S.simpleBot.realizedPnl || 0,
    totalFees:   S.simpleBot.totalFees   || 0,
    peakTv:      S.simpleBot._peakTv,
  };
  S.simpleBot.realizedPnl = 0;
  S.simpleBot.totalFees   = 0;
  S.simpleBot._peakTv     = null;
  S.simpleBot._ddAlert3   = false;
  S.simpleBot._ddAlert5   = false;
  S.simpleBot._ddAlert10  = false;
  S.simpleBot._ddCircuitBreakerTripped = false;
  // Redistribuir capas sobre el _capitalDeclarado actual sin PnL histórico.
  // BUG-L: ?? en vez de || para consistencia con BUG-H. Con || un
  // _capitalDeclarado=0 legítimo caería al default 100 silenciosamente.
  const cap = S.simpleBot._capitalDeclarado ?? 100;
  S.simpleBot.capa1Cash = cap * 0.60;
  S.simpleBot.capa2Cash = cap * 0.40;
  console.log(`[RESET-ACCOUNTING] realizedPnl ${before.realizedPnl.toFixed(4)}→0 · totalFees ${before.totalFees.toFixed(4)}→0 · peakTv ${before.peakTv}→null · CB reset`);
  // BUG-J: persistir inmediato antes del return. Patrón {ok, ...datos, saved:
  // Promise} en vez de async function porque telegram.js:264 captura el
  // resultado síncrono y usa `r.before` directamente; convertir a async
  // rompería ese flujo. El HTTP handler debe hacer `await r.saved` antes del
  // res.json. El try/catch interno evita unhandledRejection si el save falla.
  const saved = (async () => {
    try {
      if (S.simpleBot && typeof S.simpleBot.saveState === "function") {
        await saveSimpleState(S.simpleBot.saveState());
      }
    } catch (e) {
      console.warn("[RESET-ACCOUNTING] save failed:", e && e.message ? e.message : String(e));
    }
  })();
  return { ok: true, before, saved };
}

// ── TWAP: divide orden en partes para reducir slippage ───────────────────────
// Pares ilíquidos (ARB, OP, NEAR, APT) → 3 partes con 30s entre ellas
// Pares principales (BTC, ETH, SOL, BNB) → 1 sola orden (alta liquidez)
const ILLIQUID_PAIRS = ["OPUSDC","ARBUSDC","NEARUSDC","APTUSDC","ATOMUSDC","DOTUSDC","POLUSDC","OPUSDT","ARBUSDT","NEARUSDT","APTUSDT","ATOMUSDT","DOTUSDT","SUIUSDT","TONUSDT","TRXUSDT"];
const TWAP_PARTS     = { illiquid: 3, liquid: 1 };
const TWAP_DELAY_MS  = 30000; // 30s entre partes

async function sleep_ms(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ── BATCH-3 FIX #5 (#17): TWAP partial failure handling ───────────────
// Antes: si una parte intermedia fallaba, el loop seguía intentando las
// demás sin alertar. Si 1 de 3 falló, el operador no se enteraba; el
// sizing efectivo era 66% del esperado sin tracking.
// Ahora: se acumulan failures[], se loguea cada error, y si hay fill
// parcial (>0 OK, >0 fail) se envía telegram con desglose.
async function placeTWAPBuy(symbol, usdtAmount, { strategyId } = {}) {
  // SAFETY: verificar que Binance tiene suficiente USDC antes de ordenar
  try {
    const balances = await getAccountBalance();
    const usdcBal = balances ? parseFloat((balances.find(b => b.asset === "USDC") || {}).free || 0) : 0;
    if (usdcBal < usdtAmount * 0.95) {
      console.error(`[TWAP] SAFETY: Binance $${usdcBal.toFixed(2)} USDC < necesario $${usdtAmount.toFixed(2)} — cancelada`);
      try { tg.send && tg.send(`⚠️ <b>[LIVE] ORDEN CANCELADA</b>\nBalance USDC insuficiente: $${usdcBal.toFixed(2)}\nNecesario: $${usdtAmount.toFixed(2)}`); } catch {}
      return [];
    }
  } catch (e) { console.warn("[TWAP] No se pudo verificar balance:", e.message); }

  const isIlliquid = ILLIQUID_PAIRS.includes(symbol);
  const parts = isIlliquid ? TWAP_PARTS.illiquid : TWAP_PARTS.liquid;
  const partSize = +(usdtAmount / parts).toFixed(2);
  const orders = [];
  const failures = [];

  for (let i = 0; i < parts; i++) {
    try {
      const order = await binanceRequest("POST", "order", {
        symbol, side: "BUY", type: "MARKET", quoteOrderQty: partSize.toFixed(2),
      });
      if (order?.orderId) {
        orders.push(order);
        const avgPrice = order.fills?.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) /
                         (order.fills?.reduce((s, f) => s + parseFloat(f.qty), 0) || 1);
        console.log(`[TWAP][BUY] ${i + 1}/${parts} ${symbol} $${partSize} @ ~$${avgPrice.toFixed(2)} → ${order.orderId}`);
      } else {
        failures.push({ part: i + 1, reason: `no orderId (code=${order?.code})` });
        console.error(`[TWAP][BUY] ${i + 1}/${parts} ${symbol} no orderId: ${JSON.stringify(order).slice(0, 200)}`);
      }
      if (i < parts - 1 && order?.orderId) await sleep_ms(TWAP_DELAY_MS);
    } catch (e) {
      failures.push({ part: i + 1, reason: e.message });
      console.error(`[TWAP][BUY] ${i + 1}/${parts} ${symbol} error: ${e.message}`);
    }
  }
  // Alert on partial fill (some OK, some failed)
  if (failures.length > 0 && orders.length > 0) {
    const msg = [
      `⚠️ <b>[TWAP] Fill parcial</b> ${symbol}`,
      strategyId ? `Estrategia: ${strategyId}` : "",
      `OK: ${orders.length}/${parts}`,
      `Errores: ${failures.map(f => `parte ${f.part}: ${f.reason}`).join(" | ")}`,
      `Sizing efectivo: ${((orders.length / parts) * 100).toFixed(0)}%`,
    ].filter(Boolean).join("\n");
    console.warn(msg);
    try { tg.send && tg.send(msg); } catch {}
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
  // BATCH-4 FIX #1: rollback devuelve _investWithFee (no invest nominal)
  const rollbackReservation = () => {
    if (S.simpleBot && ctx?.strategyId && S.simpleBot.portfolio[ctx.strategyId]) {
      const pos = S.simpleBot.portfolio[ctx.strategyId];
      if (pos.status === "pending") {
        const refund = (typeof pos._investWithFee === "number")
          ? pos._investWithFee
          : (pos.invest || 0) * (1 + 0.001);
        if (pos.capa === 1) S.simpleBot.capa1Cash += refund;
        else                S.simpleBot.capa2Cash += refund;
        delete S.simpleBot.portfolio[ctx.strategyId];
        console.log(`[LIVE][ROLLBACK] ${ctx.strategyId} reserva devuelta ($${refund.toFixed(2)} → capa${pos.capa})`);
      }
    }
  };
  try {
    if (!LIVE_MODE) return null;

    // ── FIX-M8: Rechazar llamadas legacy sin contexto de estrategia ─────────
    // FIX-A inserta portfolio[strategyId] con status="pending" ANTES de disparar
    // el callback, y el filter de committed más abajo usa ctx.strategyId para
    // excluirse del conteo. Sin ctx.strategyId:
    //   1. rollbackReservation() no puede limpiar la reserva fantasma.
    //   2. El filter `id !== undefined` siempre es true → committed incluye
    //      posiciones que son self, el cap check se vuelve ruidoso.
    //   3. applyRealBuyFill no tiene target — el fill se pierde en el vacío.
    // Cualquier caller válido pasa ctx desde _onBuy. Rechazar el resto.
    if (!ctx?.strategyId) {
      console.error(`[LIVE][BUY] ❌ ${symbol} llamada sin ctx.strategyId — rechazada (FIX-M8 legacy guard)`);
      tg.send && tg.send(`⚠️ <b>[LIVE] BUG</b>\nplaceLiveBuy llamada legacy sin ctx\n${symbol} $${usdtAmount} — rechazada`);
      return null;
    }

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

    const orders = await placeTWAPBuy(symbol, safe, { strategyId: ctx?.strategyId });
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
      // ── T0: re-sync capital post-fill, encadenado a T0-FEE check ────────
      // Cadena: sync refresca this._bnbBalance → _checkFeeDiscrepancy("BUY")
      // compara el delta real de BNB contra pos._feePredicted que el engine
      // adjuntó a la posición en _onCandleClose. Solo log+telegram, no mueve
      // dinero (la única fuente de verdad para BNB es Binance vía el sync).
      if (S.simpleBot && typeof S.simpleBot.syncCapitalFromBinance === "function") {
        // BUG C (20 abr 2026): pasar qtyTraded = realQty (BNB comprado si es
        // par BNB*) al fee check, para que ajuste bnbDelta por el flujo
        // del par y no dispare falso positivo "BNB no bajó".
        const _qtyForCheck = realQty;
        S.simpleBot.syncCapitalFromBinance(_capitalSyncDeps())
          .then(() => {
            try {
              const pos  = S.simpleBot.portfolio?.[ctx.strategyId];
              const pred = pos?._feePredicted;
              if (pred && typeof S.simpleBot._checkFeeDiscrepancy === "function") {
                S.simpleBot._checkFeeDiscrepancy(
                  ctx.strategyId, "BUY", pred,
                  (msg) => { try { tg.send && tg.send(msg); } catch {} },
                  { qtyTraded: _qtyForCheck }
                );
              }
            } catch(e) { console.error(`[LIVE][FEE-CHECK-BUY] ${ctx.strategyId}:`, e.message); }
          })
          .catch(()=>{});
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
// BATCH-3 FIX #4 (#16): LOT_SIZE precisions from exchangeInfo ──────────
// Fallback estático: usado si exchangeInfo no se pudo cachear al boot.
const QTY_PRECISION = {
  BTCUSDC:5, ETHUSDC:4, BNBUSDC:3, SOLUSDC:2, XRPUSDC:1,
  ADAUSDC:1, DOTUSDC:2, LINKUSDC:2, LTCUSDC:3, AVAXUSDC:2,
  POLUSDC:1, UNIUSDC:2, AAVEUSDC:3, ATOMUSDC:2, NEARUSDC:1,
  ARBUSDC:1, OPUSDC:1, APTUSDC:2,
};

// Dinámico: cacheado al boot via fetchSymbolPrecisions(). Si Binance
// cambia stepSize para un par, el bot lo ve sin editar código.
let _symbolPrecisions = {};

async function fetchSymbolPrecisions() {
  const https2 = require("https");
  try {
    const data = await new Promise((resolve, reject) => {
      const req = https2.get("https://api.binance.com/api/v3/exchangeInfo", res => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      });
      req.on("error", reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    });
    if (!data?.symbols) throw new Error("invalid exchangeInfo response");
    for (const s of data.symbols) {
      const lotFilter = (s.filters || []).find(f => f.filterType === "LOT_SIZE");
      if (lotFilter) {
        const step = parseFloat(lotFilter.stepSize);
        const precision = step > 0 ? Math.max(0, Math.round(-Math.log10(step))) : 0;
        _symbolPrecisions[s.symbol] = {
          precision,
          stepSize: step,
          minQty: parseFloat(lotFilter.minQty || 0),
        };
      }
    }
    console.log(`[BOOT] exchangeInfo cached: ${Object.keys(_symbolPrecisions).length} symbols`);
  } catch (e) {
    console.warn(`[BOOT] exchangeInfo fail: ${e.message} — using fallback QTY_PRECISION`);
  }
}

// Helper: get precision + stepSize + minQty for a symbol
function getSymbolLotInfo(symbol) {
  const dyn = _symbolPrecisions[symbol];
  if (dyn) return dyn;
  const prec = QTY_PRECISION[symbol] || 4;
  return { precision: prec, stepSize: Math.pow(10, -prec), minQty: 0 };
}

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
      // ── BATCH-1 FIX #5 (H1) ────────────────────────────────────────────
      // simpleBot.evaluate() ya acreditó expectedNet a capa1Cash/capa2Cash
      // ANTES de llamar _onSell → placeLiveSell. Si aquí devolvemos null
      // sin rollback, el cash queda fantasma: capa1Cash contiene el crédito
      // de una venta que nunca ocurrió (no había balance en Binance).
      // Efecto: el bot autoriza BUYs basándose en cash inflado hasta el
      // próximo sync periódico (5min), potencialmente operando con
      // capital que no existe.
      //
      // El path de error más abajo (orderId null + catch(e)) ya tiene este
      // rollback — pero el short-circuit de sellQty<=0 saltaba por encima
      // del llamado. Ahora lo añadimos explícitamente.
      _rollbackVirtualSellCredit(symbol, ctx,
        `sellQty<=0 — sin balance real en Binance (quantity=${quantity}, realQty=${realQty})`);
      return null;
    }
    // BATCH-3 FIX #4 (#16): LOT_SIZE-aware qty rounding.
    // Floor to stepSize (never round up → -1013 from Binance).
    const lotInfo = getSymbolLotInfo(symbol);
    const qtyRounded = lotInfo.stepSize > 0
      ? Math.floor(sellQty / lotInfo.stepSize) * lotInfo.stepSize
      : sellQty;
    if (lotInfo.minQty > 0 && qtyRounded < lotInfo.minQty) {
      console.warn(`[LIVE][SELL] ${symbol} qty ${qtyRounded} < minQty ${lotInfo.minQty} — rollback`);
      _rollbackVirtualSellCredit(symbol, ctx, `qty < LOT_SIZE.minQty (${qtyRounded} < ${lotInfo.minQty})`);
      return null;
    }
    const qtyStr = qtyRounded.toFixed(lotInfo.precision);
    const order = await binanceRequest("POST", "order", {
      symbol, side:"SELL", type:"MARKET", quantity: qtyStr
    });
    if (order?.orderId) {
      console.log(`[LIVE][SELL] ✅ ${symbol} qty:${quantity} → orderId:${order.orderId}`);
      // FIX-D: capturar fills reales y reconciliar vía applyRealSellFill
      try {
        const fills = order.fills || [];
        const realGross = fills.reduce((s,f)=>s+parseFloat(f.price)*parseFloat(f.qty),0);
        // T0-FEE: propagar el FEE_efectivo predicho en _onCandleClose/evaluate
        // para que la reconciliación use 0% en modo BNB vs 0.1% en modo USDC.
        const feeEfectivo = ctx?._feePredicted?.FEE_efectivo;
        if (S.simpleBot && ctx?.strategyId && realGross > 0) {
          S.simpleBot.applyRealSellFill(ctx.strategyId, {
            realGross,
            capa: ctx.capa,
            expectedNet: ctx.expectedNet,
            feeEfectivo,
          });
        }
        // ── T0: re-sync capital post-fill, encadenado a T0-FEE check ──────
        if (S.simpleBot && typeof S.simpleBot.syncCapitalFromBinance === "function") {
          // BUG C (20 abr 2026): pasar qtyTraded = sum fills qty real (BNB
          // vendido si es par BNB*) al fee check. Para no-BNB pairs el
          // ajuste es inerte (qty se ignora en check interno).
          const _realSoldQty = (order.fills || []).reduce((s,f)=>s+parseFloat(f.qty||0),0);
          S.simpleBot.syncCapitalFromBinance(_capitalSyncDeps())
            .then(() => {
              try {
                const pred = ctx?._feePredicted;
                if (pred && typeof S.simpleBot._checkFeeDiscrepancy === "function") {
                  S.simpleBot._checkFeeDiscrepancy(
                    ctx.strategyId, "SELL", pred,
                    (msg) => { try { tg.send && tg.send(msg); } catch {} },
                    { qtyTraded: _realSoldQty }
                  );
                }
              } catch(e) { console.error(`[LIVE][FEE-CHECK-SELL] ${ctx?.strategyId}:`, e.message); }
            })
            .catch(()=>{});
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
      // H9: rollback del crédito virtual (evaluate ya acreditó expectedNet antes
      // del _onSell callback). Sin esto el simpleBot queda con cash fantasma
      // hasta el próximo sync periódico de 5min.
      _rollbackVirtualSellCredit(symbol, ctx, `orderId null (code ${order?.code||"?"} ${order?.msg||""})`);
    }
    return order;
  } catch(e) {
    console.error(`[LIVE][SELL] Error ${symbol}:`, e.message);
    // H9: mismo rollback para el path de excepción (timeout, network, -2010
    // que venga como throw). Si no se rollback, el simpleBot autoriza BUYs
    // basándose en cash inflado durante la ventana hasta el próximo sync.
    _rollbackVirtualSellCredit(symbol, ctx, e.message);
    return null;
  }
}

// ── H9: helper de rollback para placeLiveSell falla ──────────────────────
// simpleBot.evaluate() acredita expectedNet a capa1Cash/capa2Cash y borra
// portfolio[id] ANTES de llamar _onSell → placeLiveSell. Si la orden real
// falla, ese crédito virtual debe revertirse o el cash fantasma permite
// autorizar BUYs que no existen en Binance.
//
// Estrategia:
// 1. Decrementar capa cash por ctx.expectedNet (reverse del crédito).
// 2. Forzar syncCapitalFromBinance inmediato — la sincronización con el
//    balance real de Binance es la única fuente de verdad definitiva.
// 3. Alerta Telegram CRITICAL para que el operador sepa que una venta
//    falló y revise manualmente.
//
// NO se intenta reinsertar la posición: el engine ya la borró y no
// tenemos datos completos (MAE/MFE/etc). El sync reconcilia contra la
// realidad del balance Binance.
function _rollbackVirtualSellCredit(symbol, ctx, errReason) {
  if (!S.simpleBot || !ctx?.strategyId || typeof ctx?.expectedNet !== "number") {
    console.warn(`[LIVE][SELL-ROLLBACK] ${symbol} ctx incompleto, skip rollback (strategyId=${ctx?.strategyId} expectedNet=${ctx?.expectedNet})`);
    return;
  }
  const capa = ctx.capa || 1;
  if (capa === 1) S.simpleBot.capa1Cash -= ctx.expectedNet;
  else            S.simpleBot.capa2Cash -= ctx.expectedNet;
  console.error(`[LIVE][SELL-ROLLBACK] ${ctx.strategyId} capa${capa} -= $${ctx.expectedNet.toFixed(2)} (reason: ${errReason})`);

  if (typeof S.simpleBot.syncCapitalFromBinance === "function") {
    S.simpleBot.syncCapitalFromBinance(_capitalSyncDeps())
      .then((r) => {
        console.log(`[LIVE][SELL-ROLLBACK] ${ctx.strategyId} sync post-rollback ok=${r?.ok}`);
      })
      .catch(() => {});
  }
  try {
    tg.send && tg.send(`🚨 <b>[LIVE] SELL falló</b>\n${symbol} (${ctx.strategyId})\nError: ${errReason}\nLedger: -$${ctx.expectedNet.toFixed(2)} capa${capa} + sync forzado.\nRevisa posición en Binance manualmente.`);
  } catch {}
}

async function getAccountBalance() {
  try {
    const data = await binanceRequest("GET", "account", {});
    const balances = (data?.balances||[]).filter(b => parseFloat(b.free) > 0);
    return balances;
  } catch(e) { return null; }
}

// Verificar balance real al arrancar si LIVE_MODE
// ── BATCH-3 FIX #2 (#3): verifyLiveBalance fail-closed ─────────────────
// Antes: si Binance no respondía, logueaba warning y seguía; si
// detectaba "huérfanos", borraba portfolio zombie. Ahora:
//   A) LIVE_MODE sin API keys → ABORT boot (exit 1)
//   B) getAccountBalance retorna null → pausa 10min, NO tocar portfolio
//   C) Reconciliación simpleBot↔Binance: detecta orphans, alerta, pausa
//      30min. NUNCA borra automáticamente. Operador decide.
//   D) Zombie engine (S.bot) portfolio: log-only, sin wipe.
async function verifyLiveBalance() {
  if (!LIVE_MODE) return;
  // A) fail-closed: LIVE sin API keys es inoperable
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    console.error("[BOOT] ❌ LIVE_MODE=true sin API keys — ABORT");
    try { tg.send && tg.send("[BOOT] API KEYS MISSING — LIVE_MODE=true sin keys. Abort."); } catch {}
    process.exit(1);
  }
  try {
    console.log("[LIVE] API Binance configurada — verificando balance real...");
    const balances = await getAccountBalance();
    // B) Binance unreachable → pausa, NO tocar nada
    if (!balances) {
      console.error("[BOOT] Balance no verificable — NO tocar portfolio, pausar 10min");
      if (S.simpleBot) S.simpleBot._capitalSyncPausedUntil = Date.now() + 10 * 60 * 1000;
      try { tg.send && tg.send("[BOOT] Binance unreachable\nBUYs pausados 10min."); } catch {}
      return;
    }
    const usdt = balances.find(b => b.asset === "USDC") || balances.find(b => b.asset === "USDT");
    const usdtBalance = parseFloat(usdt?.free || 0);
    console.log(`[LIVE] Balance USDC real: $${usdtBalance.toFixed(2)}`);

    const virtualCapital = S.CAPITAL_USDT;

    // Zombie engine (S.bot) cash adjustment — informational only
    if (S.bot) {
      if (S.bot.cash > virtualCapital * 1.05) {
        console.log(`[LIVE] Cash DB ($${S.bot.cash.toFixed(2)}) > capital declarado ($${virtualCapital.toFixed(2)}) — ajustando`);
        S.bot.cash = virtualCapital;
      } else if (S.bot.cash <= 0) {
        S.bot.cash = virtualCapital;
        console.log(`[LIVE] Cash cero — asignando capital: $${virtualCapital.toFixed(2)} USDC`);
      } else {
        console.log(`[LIVE] Capital restaurado: $${S.bot.cash.toFixed(2)} USDC (declarado: $${virtualCapital.toFixed(2)})`);
      }
    }

    // Sanity check: Binance balance vs bot cash
    if (S.bot && usdtBalance < S.bot.cash * 0.90) {
      console.warn(`[LIVE] Binance tiene $${usdtBalance.toFixed(2)} USDC libre pero bot espera $${S.bot.cash.toFixed(2)}`);
    }

    // D) Zombie engine portfolio: log, NUNCA borrar
    if (S.bot && LIVE_MODE) {
      const tv = S.bot.totalValue();
      const posCount = Object.keys(S.bot.portfolio || {}).length;
      if (tv > virtualCapital * 1.1 && posCount > 0) {
        console.warn(`[LIVE] Estado huérfano en zombie engine: totalValue $${tv.toFixed(2)} con ${posCount} pos >> capital $${virtualCapital.toFixed(2)} — log-only`);
        try { tg.send && tg.send(`⚠️ <b>[LIVE]</b> Zombie engine drift\ntotalValue $${tv.toFixed(2)} con ${posCount} posiciones\nCapital declarado $${virtualCapital.toFixed(2)}\nInspeccionar manualmente.`); } catch {}
      }
    }

    // C) Reconciliación simpleBot ↔ Binance post-restart
    if (S.simpleBot && balances) {
      const orphansReales = [];
      const orphansVirtuales = [];
      const managedAssets = new Set(
        Object.values(S.simpleBot.portfolio || {})
          .map(p => (p.pair || "").replace(/USDC$|USDT$/, ""))
          .filter(Boolean)
      );
      for (const bal of balances) {
        if (["USDC", "USDT", "BNB"].includes(bal.asset)) continue;
        const qty = parseFloat(bal.free || 0);
        if (qty > 0.0001 && !managedAssets.has(bal.asset)) {
          orphansReales.push({ asset: bal.asset, qty });
        }
      }
      for (const [id, pos] of Object.entries(S.simpleBot.portfolio || {})) {
        // BUG-K: skip pending — tienen pos.qty reservada optimísticamente pero
        // el fill aún está en vuelo en Binance (realQty=0) → falso positivo
        // al restart que pausaba 30min. Mismo patrón que BUG-D una capa arriba.
        if (pos.status !== "filled") continue;
        const asset = (pos.pair || "").replace(/USDC$|USDT$/, "");
        const bal = balances.find(b => b.asset === asset);
        const realQty = bal ? parseFloat(bal.free || 0) : 0;
        if (realQty < (pos.qty || 0) * 0.9) {
          orphansVirtuales.push({ id, pair: pos.pair, expected: pos.qty, real: realQty });
        }
      }
      if (orphansReales.length || orphansVirtuales.length) {
        const msg = [
          "[BOOT] Reconciliación simpleBot vs Binance",
          orphansReales.length
            ? `Assets reales huérfanos: ${orphansReales.map(o => `${o.qty.toFixed(4)} ${o.asset}`).join(", ")}`
            : "",
          orphansVirtuales.length
            ? `Posiciones virtuales huérfanas: ${orphansVirtuales.map(o => `${o.id} (esp=${o.expected}, real=${o.real})`).join(", ")}`
            : "",
          "BUYs pausados 30min. Inspecciona y usa /api/reset-state si procede.",
        ].filter(Boolean).join("\n");
        console.warn(msg);
        try { tg.send && tg.send(msg); } catch {}
        S.simpleBot._capitalSyncPausedUntil = Date.now() + 30 * 60 * 1000;
      }
    }

    // Informational
    console.log(`[LIVE] Balance USDC total en Binance: $${usdtBalance.toFixed(2)} (bot opera solo con $${virtualCapital.toFixed(2)})`);
    const others = balances.filter(b => b.asset !== "USDC" && b.asset !== "USDT" && b.asset !== "BNB" && parseFloat(b.free) > 0.001);
    if (others.length > 0) console.log(`[LIVE] Otros activos: ${others.map(b => b.asset + ":" + parseFloat(b.free).toFixed(4)).join(", ")} (no gestionados)`);
    if (tg?.send) tg.send(`✅ <b>LIVE operativo</b> — Capital: $${S.bot?.cash?.toFixed(2) || virtualCapital} USDC`);

  } catch (e) {
    console.error("[LIVE] verifyLiveBalance FAILED:", e.message);
    // Fail-closed: pausa 10min, NO seguir como si nada
    if (S.simpleBot) S.simpleBot._capitalSyncPausedUntil = Date.now() + 10 * 60 * 1000;
    try { tg.send && tg.send(`⚠️ <b>[BOOT] Balance fail</b>\n${e.message}\nBUYs pausados 10min.`); } catch {}
    console.warn("[LIVE] BUYs pausados 10min por balance no verificable.");
  }
}

// ── Trading Loop (extraído a trading/loop.js) ────────────────────────────────
const { startLoop } = require("./trading/loop");

// BATCH-3 FIX #8: server.listen movido al IIFE (ver línea ~903).
// scheduleWeeklyReport y scheduleTradeAnalysisReminder también se mueven allí.

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
