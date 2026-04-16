// ── Trading Loop — extraído de server.js ─────────────────────────────────────
// Contiene el setInterval principal y toda la lógica del tick.
// Recibe dependencias de server.js via startLoop(deps).
"use strict";

const S = require("./state");
const tg = require("../telegram");
const { fetchFearGreed, calcRealtimeFearGreed, fgCalibrator, fetchLongShortRatio, fetchFundingRate, fetchOpenInterest, fetchLiquidations, fetchBTCDominance, fetchCoinbasePremium, fetchExchangeFlow, fetchBinanceReserve, fetchRedditSentiment } = require("../feeds");
const { getTradingScore } = require("../market");
const { runIntradayWalkForward } = require("../backtest");
const { saveSimpleState } = require("../database");

let ticks = 0;

function startLoop(deps) {
  const {
    connectBinance, simulatePrices, broadcast, save,
    placeLiveBuy, placeLiveSell, getAccountBalance, sendEquityToBafir,
    marketGuard, blacklist, cryptoPanic, clientManager,
    LIVE_MODE, TICK_MS, SYNC_THRESHOLD,
    getLiveStartTime,
    // C2: stream liveness check inyectado desde server.js (lastPriceTs
    // vive allí, asociado al WS de Binance). Si falta, asumimos stream
    // viva — backwards-compat con callers legacy.
    isPriceStreamLive,
    getMsSinceLastTick,
    telegramSend,
  } = deps;

  connectBinance();
  let _tickRunning = false;
  const _sessionStartTs = Date.now(); // track session start for P&L
  // ── C2: tracking del estado de stream-dead para el gate de >30s ────────
  // _streamDeadSince se setea la primera vez que detectamos stream muerta
  // y se limpia cuando vuelve. Si pasa >30s consecutivos sin ticks, pausamos
  // BUYs vía simpleBot._streamDeadPausedUntil + enviamos alerta Telegram.
  // El throttle de la alerta evita spam si la pausa se renueva cada tick.
  let _streamDeadSince = 0;
  let _lastStreamDeadAlertTs = 0;

// ── Capital Alert: aviso de añadir capital cuando condiciones son óptimas ───
// F27: persistimos timestamps en S.bot para sobrevivir PM2 restart. Antes, las
// variables vivían sólo en closure del módulo → cada boot reiniciaba a 0 →
// `now - 0 > 86400000` siempre cierto → cualquier condición "BULL || WR>=42"
// disparaba alerta inmediatamente después de restart. Spam garantizado.
// S.bot se serializa via save() cada 6 ticks, así que los timestamps viajan
// con state.json / DB.
function _getLastCapAlertTs() { return (S.bot && S.bot._lastCapAlertTs) || 0; }
function _setLastCapAlertTs(v) { if (S.bot) S.bot._lastCapAlertTs = v; }
function _getPrevRegime()      { return S.bot && S.bot._prevCapAlertRegime; }
function _setPrevRegime(v)     { if (S.bot) S.bot._prevCapAlertRegime = v; }

function checkCapitalAlert(s) {
  if(!s||s.loading) return;
  const now = Date.now();
  const wr = s.recentWinRate||0;
  const regime = s.marketRegime;
  const dd = s.drawdownPct||0;
  const tv = s.totalValue||0;
  const prevRegime = _getPrevRegime();
  const regimeToBull = regime==="BULL" && prevRegime!=="BULL";
  _setPrevRegime(regime);
  const lastTs = _getLastCapAlertTs();
  const shouldAlert = (regimeToBull || wr>=42) && dd<5 && (now-lastTs)>86400000;
  if(!shouldAlert) return;
  _setLastCapAlertTs(now);
  const add = tv<150?100:tv<400?200:tv<800?500:1000;
  const why = regimeToBull?"🐂 MERCADO CAMBIA A BULL — momentum favorable":`📈 WR ${wr}% sostenido — sistema rentable`;
  tg.send && tg.send([
    "🚨🚨🚨 ALERTA DE CAPITAL 🚨🚨🚨",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",why,"",
    `💼 Capital: $${tv.toFixed(2)} | WR: ${wr}% | DD: ${dd.toFixed(1)}%`,
    `📊 Régimen: ${regime} | F&G: ${s.fearGreed||"?"}`,
    "",
    `💡 ACCIÓN: Añadir $${add} USDC en Binance`,
    `   Capital nuevo estimado: $${(tv+add).toFixed(0)}`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "Máx 1 alerta/día. El bot sigue operando igual sin acción.",
  ].join("\n"));
}

let lastFearGreedCheck = 0;

setInterval(async()=>{
    if(!S.bot) return;
    if(_tickRunning){ console.warn("[LIVE] Tick overlap - saltando"); return; }
    _tickRunning = true;
    try {
    simulatePrices();

    // ── C2: Feed current prices to simple engine SOLO si stream real ─────
    // simulatePrices() puede escribir random-walk desde SEEDS hardcoded
    // cuando el WS de Binance lleva >=10s sin emitir. Propagar eso al
    // simpleBot construiría velas OHLC con datos falsos y dispararía
    // señales BUY sobre ruido puro. S.bot (zombie, evaluate es no-op)
    // puede recibir los precios fabricados sin consecuencias — sólo el
    // simpleBot necesita este guard.
    const streamLive = typeof isPriceStreamLive === "function" ? isPriceStreamLive() : true;
    if(S.simpleBot && S.bot.prices && streamLive) {
      for(const [sym,price] of Object.entries(S.bot.prices)) {
        S.simpleBot.updatePrice(sym, price);
      }
    }
    // ── C2: tracking stream-dead > 30s → pausar BUYs vía _streamDeadPausedUntil ──
    if (!streamLive) {
      if (_streamDeadSince === 0) _streamDeadSince = Date.now();
      const deadMs = Date.now() - _streamDeadSince;
      if (deadMs > 30 * 1000 && S.simpleBot) {
        // Renovar la pausa para bloquear BUYs 60s más. Mientras la stream
        // siga muerta, cada tick la extiende.
        S.simpleBot._streamDeadPausedUntil = Date.now() + 60 * 1000;
        // Alerta Telegram con throttle de 10min para evitar spam.
        if (Date.now() - _lastStreamDeadAlertTs > 10 * 60 * 1000) {
          _lastStreamDeadAlertTs = Date.now();
          const msSince = typeof getMsSinceLastTick === "function" ? getMsSinceLastTick() : 0;
          try {
            (typeof telegramSend === "function") && telegramSend(
              `⚠️ <b>[LIVE] STREAM-DEAD</b>\nWebSocket Binance sin ticks ${Math.round(msSince/1000)}s\nBUYs pausados hasta que vuelvan.`
            );
          } catch {}
          console.warn(`[LIVE][STREAM-DEAD] WS sin ticks ${Math.round(msSince/1000)}s — simpleBot BUYs pausados 60s`);
        }
      }
    } else if (_streamDeadSince !== 0) {
      // Stream recuperada — limpiar tracker (la pausa ya expirará por timeout natural).
      console.log(`[LIVE][STREAM-LIVE] WS recuperado tras ${Math.round((Date.now()-_streamDeadSince)/1000)}s`);
      _streamDeadSince = 0;
    }

    const marketState=marketGuard.update(S.bot.prices["BTCUSDC"]);
    if(marketState?.defensive&&!S.wasDefensive){

      S.wasDefensive=true;
      // Record defensive mode decision for learning
      if(S.bot) S.bot.riskLearning?.recordDecision("DEFENSIVE_MODE","BTCUSDC",S.bot.prices?.["BTCUSDC"]||0,"block_entry",{drawdown:marketState.btcDrawdown});
    }
    if(!marketState?.defensive&&S.wasDefensive){S.wasDefensive=false;}

    S.bot.marketDefensive=marketGuard.isDefensive();
    S.bot.hourMultiplier=getTradingScore().score;
    S.bot.blacklist=blacklist;

    // ── MOMENTUM BOOST: días muy buenos → aumentar tamaño de posiciones ────────
    // Calcula P&L del día actual desde trades cerrados hoy EN ESTA SESIÓN
    const todayStart = new Date(); todayStart.setUTCHours(0,0,0,0);
    const todaySells = S.bot.log.filter(l => {
      if (l.type !== "SELL" || !l.pnl) return false;
      return l.ts >= todayStart.getTime() && l.ts >= _sessionStartTs;
    });
    const todayPnlPct = todaySells.reduce((s,l)=>s+(l.pnl||0),0);
    S.bot._dailyPnlPct = todayPnlPct;

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
    if (todayPnlPct >= 7)  S.bot._dailyLimitBoost = Math.round(todayPnlPct / 5);
    else                   S.bot._dailyLimitBoost = 0;

    // CryptoPanic: si hay noticias negativas, reducir tamaño global
    const cpGlobalMult = cryptoPanic.globalDefensive ? 0.3 : 1.0;
    S.bot._newsMultiplier = cpGlobalMult;
    S.bot._cryptoPanicStatus = cryptoPanic.getStatus();
    // Pasar el multiplicador de noticias al engine para usarlo por par
    // Record CryptoPanic global state for learning
    if (cryptoPanic.globalDefensive && !S.bot._wasGlobalDefensive) {
      // Just became defensive — record decision for each open position
      for (const sym of Object.keys(S.bot.portfolio||{})) {
        S.bot.riskLearning?.recordDecision("CRYPTOPANIC_GLOBAL", sym, S.bot.prices[sym]||0, "reduce_size", {global:true});
      }
    }
    S.bot._wasGlobalDefensive = cryptoPanic.globalDefensive;
    // F28: S.bot._cryptoPanicFn eliminado — closure creada cada tick sin consumers.
    // Si se revive cryptoPanic.start(), el consumer directo es cpGlobalMult (línea 115).

    S.bot.hourMultiplier = getTradingScore().score * momentumMult * cpGlobalMult;

    // Alertas Telegram momentum
    const prevMomentumLevel = S.bot._prevMomentumLevel || 1.0;
    // Momentum boost notification removed

    S.bot._prevMomentumLevel = momentumMult;

    // CryptoPanic state tracking (notifications disabled)
    const prevCpGlobal = S.bot._prevCpGlobal || false;
    const prevCpPairs = S.bot._prevCpPairs || [];
    S.bot._prevCpGlobal = cryptoPanic.globalDefensive;
    S.bot._prevCpPairs = [...cryptoPanic.defensivePairs];

    // ── Aplicar parámetros aprendidos a los subsistemas ──────────────────────
    // Notificar si RiskLearning actualizó parámetros
    if (S.bot._rlChanges?.changes?.length && tg.notifyRiskLearningUpdate) {
      tg.notifyRiskLearningUpdate(S.bot._rlChanges.changes);
      S.bot._rlChanges = null;
    }
    if (S.bot.riskLearning) {
      // CryptoPanic: ajustar umbral global y expiración
      cryptoPanic._learnedGlobalThreshold = S.bot.riskLearning.get("cpGlobalThreshold", 5);
      cryptoPanic._learnedExpiryHours     = S.bot.riskLearning.get("cpExpiryHours", 2);
      // TrailingStop: ajustar activación mínima
      if (S.bot.trailing) S.bot.trailing._learnedTrailingMin = S.bot.riskLearning.get("trailingMinPct", 2) / 100;
    }

    if (momentumMult !== 1.0 && ticks % 30 === 0) {
      console.log(`[LIVE] Momentum x${momentumMult} | CryptoPanic x${cpGlobalMult} | P&L hoy: +${todayPnlPct.toFixed(1)}%`);
    }

    // No operar hasta que pase 1 hora desde el arranque
    if (!S.liveReady) {
      const remaining = Math.ceil((getLiveStartTime() - Date.now()) / 60000);
      broadcast({ type:"tick", data:{ ...S.bot.getState(), instance:process.env.LIVE_MODE==="true"?"LIVE":"PAPER-LIVE", binanceLive: S.binanceLive, liveReady:false, liveReadyIn:remaining } });
      if(ticks%6===0) save().catch(e=>console.error("[SAVE]",e));
      ticks++;
      return;
    }

    if(S.tgControls?.isPaused()) S.bot._pausedByTelegram=true; else S.bot._pausedByTelegram=false;
    let signals=[],newTrades=[],circuitBreaker=null,optimizerResult=null,drawdownAlert=null,dailyLimit=50,dailyUsed=0;
    try {
      ({signals,newTrades,circuitBreaker,optimizerResult,drawdownAlert,dailyLimit,dailyUsed}=S.bot.evaluate());
      // evaluate() es no-op: devuelve signals=[], newTrades=[] pero actualiza régimen y equity
      if(S.bot.tick%60===0){try{checkCapitalAlert(S.bot.getState());}catch(e){}}
    } catch(evalErr) {
      console.error("[LIVE] bot.evaluate() error:", evalErr.message);
      console.error(evalErr.stack?.split("\n").slice(0,3).join("\n"));
      ticks++;
      return; // skip this tick, don't crash
    }
    ticks++;

    // ── Simple engine signals → real orders ──────────────────────────────
    // FIX-A/C/D: la ejecución real ahora se dispara SÍNCRONAMENTE vía los
    // callbacks S.simpleBot._onBuy / _onSell (wired en server.js). Esto elimina
    // el race del dispatcher basado en log.filter y garantiza que:
    //   - placeLiveBuy ve el portfolio ya mutado con status="pending" (ctx.strategyId)
    //   - applyRealBuyFill / applyRealSellFill pueden reconciliar contra la reserva
    //
    // BATCH-1 FIX #3 (bug #10): evaluate() debe ejecutarse SIEMPRE, incluso
    // cuando el usuario pausa el bot con /pausa. evaluate() sólo procesa
    // stops/targets/time-stops de posiciones YA ABIERTAS — no crea nuevas.
    // La creación de nuevas posiciones está gobernada por _onCandleClose
    // que tiene su propio pause gate en engine_simple.js:484
    // (`if (this.paused === true) return;`).
    //
    // Bug previo: si el usuario pausaba durante una crisis, el bot no podía
    // vender sus posiciones. Un stop-loss a -3% nunca disparaba porque
    // evaluate() se saltaba y el precio seguía cayendo. El /pausa debe
    // bloquear NUEVAS entradas, no atrapar las existentes.
    if(S.simpleBot) {
      // C4: evaluate() es ahora async (cleanupStalePending puede hacer
      // GET myTrades antes del rollback). El try/catch del tick completo
      // captura excepciones para que no maten el loop.
      await S.simpleBot.evaluate();
      // Save simple state every 6 ticks — persistencia debe continuar
      // aunque el bot esté pausado (sino los stops ejecutados durante la
      // pausa se perderían en el próximo restart).
      if(ticks%6===0) {
        S.simpleBot.saveState && saveSimpleState(S.simpleBot.saveState()).catch(()=>{});
      }
      // Auto-alerts every 60 ticks (~10min)
      if(ticks%60===0) {
        tg.checkAlerts?.(() => S.simpleBot?.getState?.());
      }
    }

    // F29 DEAD PATH: newTrades viene de S.bot.evaluate() (engine.js zombie) que
    // devuelve siempre []. El loop nunca itera. FIX-A/B/C/D movió el ordering
    // real a callbacks síncronos en server.js:109-124 (S.simpleBot._onBuy/_onSell
    // → placeLiveBuy/placeLiveSell). Se mantiene por si Phase H revive engine.js
    // con alguna estrategia adicional, pero lector nuevo debe saber que esto
    // no se ejecuta en el paper-live actual.
    for(const trade of newTrades){
      if(trade.type==="SELL"){
        const liveCfg=global._alertConfig||{winPct:3,lossPct:3};

        // Explicabilidad: notificar trades significativos con explicación

        if(trade.pnl<0){blacklist.recordLoss(trade.symbol);}
        else blacklist.recordWin(trade.symbol);
      }
      // ── ÓRDENES REALES BINANCE ─────────────────────────────────────────────
      if(LIVE_MODE){
        // No usamos await aquí — las órdenes se procesan en background
        // para no bloquear el tick loop (TWAP puede tardar 60s)
        if(trade.type==="BUY") {
          placeLiveBuy(trade.symbol, trade.qty*trade.price).catch(e=>console.error("[ORDER] BUY error:",e.message));
          // Copy trade to clients (proporcionalmente a su capital)
          clientManager.copyBuy(trade.symbol, trade.qty*trade.price, S.bot.totalValue())
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

    if(circuitBreaker?.triggered&&!S.cbNotified){tg.notifyCircuitBreaker(circuitBreaker.drawdown);S.cbNotified=true;}
    if(!circuitBreaker?.triggered)S.cbNotified=false;
    if(drawdownAlert?.triggered)tg.notifyMaxDrawdown(drawdownAlert);
    // F26: línea duplicada eliminada (`if(!circuitBreaker?.triggered) S.cbNotified=false;`)


    // Real-time F&G — actualizar cada tick
    if(S.bot && S.bot.history) {
      const rtFG = calcRealtimeFearGreed(S.bot, {
        longShortRatio: S.bot.longShortRatio,
        fundingRate: S.bot.fundingRate,
        openInterest: S.bot.openInterest,
        redditSentiment: S.bot.redditSentiment,
        officialFearGreed: S.bot._officialFearGreed || S.bot.fearGreed,
      });
      S.bot.fearGreedRealtime = rtFG;
      S.bot.fearGreed = rtFG.value;
      S.bot.fearGreedSource = rtFG.source;
    }

    if(Date.now()-lastFearGreedCheck>1800000){
      lastFearGreedCheck=Date.now();
      fetchFearGreed().then(fg=>{
        try {
          S.bot._officialFearGreed=fg.value; S.bot.fearGreed=fg.value;
          if(S.bot.fearGreedRealtime?.scores && fg.source !== "fallback" && fgCalibrator?.recordObservation) {
            fgCalibrator.recordObservation(S.bot.fearGreedRealtime.scores, S.bot.fearGreedRealtime.synthetic, fg.value);
          }
          S.bot.fearGreedPublished=fg.publishedAt; S.bot.fearGreedSource=fg.source||"unknown";
          console.log(`[F&G] ${fg.value} (${fg.source||"?"}) · ${fg.publishedAt?.slice(0,16)||"?"}`);
        } catch(e) { console.warn("[F&G] calibration error:", e.message); }
      }).catch(e=>console.warn("[F&G] fetch failed:", e.message));
      // Market data for Telegram /mercado command
      fetchLongShortRatio("BTCUSDT").then(ls=>{S.bot.longShortRatio=ls;}).catch(()=>{});
      fetchFundingRate("BTCUSDT").then(fr=>{S.bot.fundingRate=fr;}).catch(()=>{});
      fetchOpenInterest("BTCUSDT").then(oi=>{S.bot.openInterest=oi;}).catch(()=>{});
      fetchLiquidations().then(liq=>{if(liq) S.bot.liquidations=liq;}).catch(()=>{});
      fetchBTCDominance().then(dom=>{if(dom) S.bot.btcDominance=dom;}).catch(()=>{});
      fetchCoinbasePremium().then(cp=>{if(cp){S.bot.coinbasePremium=cp;
        if(cp.signal==="INSTITUTIONAL_BUY") console.log(`[CB-PREMIUM] 🏦 Institucionales USA comprando: ${cp.premium.toFixed(3)}%`);
        if(cp.signal==="INSTITUTIONAL_SELL") console.log(`[CB-PREMIUM] 🏦 Institucionales USA vendiendo: ${cp.premium.toFixed(3)}%`);
      }}).catch(()=>{});
      fetchExchangeFlow().then(ef=>{if(ef) S.bot.exchangeFlow=ef;}).catch(()=>{});
      fetchBinanceReserve().then(br=>{if(br) S.bot.binanceReserve=br;}).catch(()=>{});
      if(Date.now()-(S.bot._lastRedditFetch||0)>7200000){
        S.bot._lastRedditFetch=Date.now();
        fetchRedditSentiment().then(rs=>{S.bot.redditSentiment=rs;}).catch(()=>{});
      }
    }



    // Enviar equity a BAFIR
    if(ticks%60===0) sendEquityToBafir(S.bot.totalValue());
    // WF intradía cada 30min en live (sin API, usa historial en RAM)
    if(ticks%180===0 && ticks>0) {
      try {
        const wf = runIntradayWalkForward(S.bot);
        if(wf) {
          S.bot._intradayWF = wf;
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
        if(!balances||!S.bot) return;
        const realUSDC = parseFloat((balances.find(b=>b.asset==="USDC")||{}).free||0);
        const virtualFree = S.bot.cash;
        const openPositions = Object.keys(S.bot.portfolio||{}).length;

        if(virtualFree > S.CAPITAL_USDT * 2) {
          // BATCH-3 FIX #1 (#11): ANTES este bloque borraba portfolio y
          // reseteaba cash del engine zombie. Borrar portfolio sin verificar
          // Binance es peligroso — si alguna vez el zombie engine se
          // reactivara, perdería estado. Ahora solo alerta.
          console.warn(`[RECONCILE] cash virtual $${virtualFree.toFixed(2)} >> capital $${S.CAPITAL_USDT} — inspección manual`);
          try {
            tg.send && tg.send(`⚠️ <b>[RECONCILE]</b> drift\ncash virtual $${virtualFree.toFixed(2)} >> capital $${S.CAPITAL_USDT}\nInspeccionar (zombie engine).`);
          } catch {}
        } else if(realUSDC < 1 && openPositions === 0 && virtualFree > 10) {
          // Puede ser problema de IP (API key restringida) o falta de fondos
          // Solo avisar, no pausar automáticamente (la IP puede causar $0 falso)
          S.bot._reconcileZeroCount = (S.bot._reconcileZeroCount||0) + 1;
          if(S.bot._reconcileZeroCount === 1) {
            console.warn(`[RECONCILE] ⚠️ Binance USDC=$0 pero virtual=$${virtualFree.toFixed(2)} — puede ser restricción de IP`);
            // periodic $0 warning removed //\nPuede ser restricción de IP en API key.\nEl bot continúa operando. Si persiste más de 30min, verifica en Binance.`);
          }
        } else {
          const drift = realUSDC - virtualFree;
          if(Math.abs(drift) > 2 && Math.abs(drift) < 15) {
            console.warn(`[RECONCILE] Drift: real=$${realUSDC.toFixed(2)} virtual=$${virtualFree.toFixed(2)} diff=${drift>0?"+":""}${drift.toFixed(2)}`);
            // DISABLED [iñigo cap estricto]: S.bot.cash += drift * 0.1; (drift hacia balance real Binance violaba cap virtual)
          }
        }
      }).catch(()=>{});
    }

    // Guardar
    if(ticks%6===0) save().catch(e=>console.error("[SAVE]",e));

    broadcast({
      type:"tick",
      data:{
        ...S.bot.getState(),signals,newTrades,circuitBreaker,optimizerResult,
        binanceLive: S.binanceLive,instance:process.env.LIVE_MODE==="true"?"LIVE":"PAPER-LIVE",
        marketDefensive:marketGuard.isDefensive(),
        tradingHour:getTradingScore(),
        blacklistStatus:blacklist.getStatus(),
        fearGreed:S.bot.fearGreed,marketRegime:S.bot.marketRegime,
        dailyLimit,dailyUsed,
        dailyPnlPct:S.bot._dailyPnlPct||0,
        momentumMult:S.bot.hourMultiplier,
        cryptoPanic:S.bot._cryptoPanicStatus||null,
        riskLearning:S.bot._rlChanges||null,
        riskLearningStats:S.bot.riskLearning?.getStats()||{},
        syncHistory:S.syncHistory.slice(-7),
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

module.exports = { startLoop };
