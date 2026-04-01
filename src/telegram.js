// telegram.js — Notificaciones BAFIR LIVE
// Diseñadas para ser claras, concisas y fáciles de leer en móvil
"use strict";

const https = require("https");
const TOKEN   = process.env.TELEGRAM_TOKEN   || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// ── Helpers ───────────────────────────────────────────────────────────────────
const fxRate = () => parseFloat(process.env.FX_RATE||"1.08");
const toEur  = (usd, fx) => (usd / (fx||fxRate())).toFixed(2);
const sign   = n => n >= 0 ? "+" : "";
const coin   = sym => (sym||"").replace("USDC","").replace("USDT","");
const fgEmoji = v => v<15?"😱":v<25?"😨":v<40?"😟":v<55?"😐":v<70?"😊":v<85?"😏":"🤑";
const fgLabel = v => v<15?"Pánico extremo":v<25?"Miedo extremo":v<40?"Miedo":v<55?"Neutral":v<70?"Codicia":v<85?"Codicia alta":"Euforia";

function send(text) {
  if(!TOKEN||!CHAT_ID) return;
  const body = JSON.stringify({chat_id:CHAT_ID, text, parse_mode:"HTML"});
  const req = https.request({
    hostname:"api.telegram.org",
    path:`/bot${TOKEN}/sendMessage`,
    method:"POST",
    headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)},
  }, res => { if(res.statusCode!==200) console.warn("[TG]",res.statusCode); });
  req.on("error", e => console.warn("[TG]",e.message));
  req.write(body); req.end();
}

// ── Divisor visual para secciones ─────────────────────────────────────────────
const HR = "─────────────────────";

// ── Notificaciones de trades ──────────────────────────────────────────────────
function notifyBigWin(trade) {
  const fx = fxRate();
  const c  = coin(trade.symbol);
  const pnl    = trade.pnl||0;
  const pnlAbs = trade.pnlAbs||0;
  const exit   = +(trade.qty*trade.price).toFixed(2);
  const entry  = pnl ? +(exit/(1+pnl/100)).toFixed(2) : exit;
  send(
`💰 <b>GANANCIA — ${c}</b>
${HR}
📈 <b>${sign(pnl)}${pnl.toFixed(2)}%</b>  ·  ${sign(pnlAbs)}$${pnlAbs.toFixed(2)}  ·  ${sign(pnlAbs/fx)}€${toEur(pnlAbs,fx)}

💵 Entró   $${entry}
💵 Salió   $${exit}
📦 Qty     ${(trade.qty||0).toFixed(5)} ${c}
${HR}
⚡ ${trade.reason||"—"}  ·  ${trade.strategy||"—"}`
  );
}

function notifyBigLoss(trade) {
  const fx = fxRate();
  const c  = coin(trade.symbol);
  const pnl    = trade.pnl||0;
  const pnlAbs = trade.pnlAbs||0;
  const exit   = +(trade.qty*trade.price).toFixed(2);
  const entry  = pnl ? +(exit/(1+pnl/100)).toFixed(2) : exit;
  send(
`📉 <b>PÉRDIDA — ${c}</b>
${HR}
🔻 <b>${sign(pnl)}${pnl.toFixed(2)}%</b>  ·  $${Math.abs(pnlAbs).toFixed(2)}  ·  €${toEur(Math.abs(pnlAbs),fx)}

💵 Entró   $${entry}
💵 Salió   $${exit}
${HR}
⚡ ${trade.reason||"—"}
🧠 El bot aprende de esta operación`
  );
}

// ── Circuit breaker ───────────────────────────────────────────────────────────
function notifyCircuitBreaker(drawdown) {
  send(
`⛔ <b>CIRCUIT BREAKER ACTIVADO</b>
${HR}
📉 Pérdida diaria: <b>${(Math.abs(drawdown)*100).toFixed(2)}%</b>
⏸ Bot pausado hasta mañana
Sin nuevas entradas el resto del día`
  );
}

// ── Alertas de mercado ────────────────────────────────────────────────────────
function notifyDefensiveMode(btcDrawdown) {
  send(
`🛡 <b>MODO DEFENSIVO</b>
${HR}
BTC cayó <b>${Math.abs(btcDrawdown).toFixed(1)}%</b> desde el máximo de hoy
🚫 Sin nuevas posiciones hasta que se estabilice`
  );
}

function notifyDefensiveOff() {
  send(`✅ <b>Modo defensivo desactivado</b>\nBTC se estabilizó — operaciones normales`);
}

function notifyBlacklist(sym) {
  send(`🚫 <b>${coin(sym)} bloqueado 4h</b>\n4 pérdidas consecutivas → cooldown automático`);
}

function notifyNewsAlert(news) {
  send(
`📰 <b>NOTICIA IMPORTANTE</b>
${HR}
${news.title}
${HR}
💱 Pares afectados: ${news.currencies?.join(", ")||"—"}`
  );
}

function notifyFearGreed(val, label) {
  const e = fgEmoji(val);
  const context = val<20
    ? "Históricamente buen momento de compra a largo plazo"
    : val>80
    ? "Mercado sobrecomprado — precaución con nuevas entradas"
    : "";
  send(`${e} <b>Fear & Greed: ${val}/100</b>\n${fgLabel(val)}\n${context}`);
}

function notifyOptimizer(r) {
  if(!r?.changes?.length) return;
  send(
`🧠 <b>OPTIMIZADOR — parámetros ajustados</b>
${HR}
WR reciente: ${r.winRate}%  ·  avgP&L: ${r.avgPnl}%
${HR}
${r.changes.map(c=>`• ${c}`).join("\n")}`
  );
}

function notifyNightlyReplay(b) {
  send(
`🌙 <b>REPLAY NOCTURNO completado</b>
${HR}
Mejor configuración encontrada:
• EMA ${b.params.emaFast}/${b.params.emaSlow}
• Score mínimo: ${b.params.minScore}
• WR: ${b.winRate}%  avgP&L: ${b.avgPnl}%`
  );
}

function notifyDailyLimitChange(regime, limit, wr) {
  send(`📊 <b>Límite diario → ${limit} ops/día</b>\nRégimen: ${regime}  ·  WR reciente: ${wr||"—"}%`);
}

function notifyMomentumBoost(mult, pnlPct) {
  send(
`🚀 <b>MOMENTUM ACTIVADO</b>
${HR}
P&L hoy: <b>+${pnlPct.toFixed(1)}%</b>
Posiciones: <b>×${mult.toFixed(1)}</b> del tamaño normal
El bot es más agresivo en días ganadores`
  );
}

function notifyMomentumDefensive(pnlPct) {
  send(
`🛡 <b>MODO CAUTELOSO</b>
P&L hoy: ${pnlPct.toFixed(1)}%
Posiciones reducidas a ×0.7`
  );
}

function notifyCryptoPanicAlert(pairs, global_) {
  if(global_)
    send(`🚨 <b>CRYPTOPANIC — ALERTA GLOBAL</b>\nNoticias negativas detectadas\nPositions reducidas al 30%`);
  else if(pairs.length)
    send(`⚠️ <b>CRYPTOPANIC — ${pairs.join(", ")}</b>\nNoticias negativas en estos pares\nPositions reducidas al 50%`);
}

function notifyMaxDrawdown(alert) {
  send(
`🚨 <b>ALERTA DRAWDOWN MÁXIMO</b>
${HR}
📉 Caída desde máximo: <b>${alert.drawdownPct}%</b>
📊 Máximo histórico:   $${alert.maxEquity}
💰 Valor actual:        $${alert.currentEquity}
${HR}
Revisa la estrategia manualmente`
  );
}

function notifyRiskLearningUpdate(changes) {
  if(!changes?.length) return;
  send(
`🧠 <b>RISK LEARNING — ajuste automático</b>
${HR}
${changes.map(c=>`• <b>${c.rule}</b>: ${c.from} → ${c.to}\n  (${c.reason})`).join("\n")}
${HR}
El bot ajustó sus reglas de riesgo`
  );
}

function notifyPaperExport(stats, params) {
  send(
`📤 <b>PAPER → LIVE — sincronización</b>
${HR}
WR (7d): ${stats.winRate}%  ·  ${stats.nTrades} ops
EMA ${params.emaFast}/${params.emaSlow}  ·  Score ${params.minScore}
${HR}
El LIVE evaluará si adoptar estos parámetros`
  );
}

// ── Startup ───────────────────────────────────────────────────────────────────
function testTelegram() {
  if(!TOKEN||!CHAT_ID) {
    console.warn("[TG] ⚠️  Sin TOKEN o CHAT_ID — notificaciones desactivadas");
    return;
  }
  send("✅ <b>BAFIR LIVE</b> — Bot arrancado, Telegram conectado");
  console.log("[TG] Test enviado a chat_id:", CHAT_ID.slice(0,4)+"***");
}

function notifyStartup(mode) {
  send(
`🤖 <b>BAFIR LIVE arrancado</b>
${HR}
Modo: <b>${mode}</b>

✅ DQN · MultiAgent · PER
✅ Kelly · Trailing · Circuit Breaker
✅ Fear&Greed RT · L/S ratio · OI
✅ Transfer learning · Darwin
✅ Stop adaptativo · Horas adaptativas
${HR}
/estado  /mercado  /posiciones
/log  /walkforward  /ayuda`
  );
}

// ── Resúmenes ─────────────────────────────────────────────────────────────────
function buildDaily(state) {
  const fx   = state.fxRate||fxRate();
  const tv   = state.totalValue||100;
  const ret  = state.returnPct||0;
  const INIT = parseFloat(process.env.CAPITAL_USDC||process.env.CAPITAL_USDT||"100");
  const totalPnl    = +(tv - INIT).toFixed(2);
  const totalPnlEur = toEur(totalPnl, fx);
  const today       = new Date().toDateString();
  const todayTrades = (state.log||[]).filter(l=>l.type==="SELL"&&new Date(l.ts).toDateString()===today);
  const wins     = todayTrades.filter(l=>l.pnl>0).length;
  const wr       = todayTrades.length ? Math.round(wins/todayTrades.length*100) : 0;
  const dayPnl   = todayTrades.reduce((s,l)=>s+(l.pnlAbs||0),0);
  const fees     = todayTrades.reduce((s,l)=>s+(l.fee||0),0);
  const best     = [...todayTrades].sort((a,b)=>b.pnl-a.pnl)[0];
  const worst    = [...todayTrades].sort((a,b)=>a.pnl-b.pnl)[0];
  const openPos  = Object.keys(state.portfolio||{}).length;
  const fg       = state.fearGreed||50;
  const regime   = state.marketRegime||"—";
  const regIcon  = regime==="BULL"?"📈":regime==="BEAR"?"📉":"➡️";

  return (
`${ret>=0?"📈":"📉"} <b>Resumen — ${new Date().toLocaleDateString("es-ES",{weekday:"short",day:"numeric",month:"short"})}</b>
${HR}
💼 Capital:   <b>$${tv.toFixed(2)}</b> / <b>€${toEur(tv,fx)}</b>
${sign(totalPnl)}${totalPnl>=0?"📈":"📉"} Total:    ${sign(totalPnl)}$${totalPnl} / €${totalPnlEur} (${sign(ret)}${ret.toFixed(2)}%)
${HR}
<b>📅 HOY</b>
• Operaciones:  ${todayTrades.length}  (${wins} ganadoras · WR ${wr}%)
• P&L del día:  ${sign(dayPnl)}$${dayPnl.toFixed(2)} / ${sign(dayPnl/fx)}€${toEur(dayPnl,fx)}
• Comisiones:   $${fees.toFixed(2)}
${best&&best.pnl>0 ? `• 🥇 Mejor:  ${coin(best.symbol)} ${sign(best.pnl)}${best.pnl.toFixed(2)}%\n` : ""}${worst&&worst.pnl<0 ? `• 💀 Peor:   ${coin(worst.symbol)} ${worst.pnl.toFixed(2)}%\n` : ""}${openPos>0 ? `• 📂 Abiertas: ${openPos} posición(es)\n` : ""}${HR}
<b>🌡️ MERCADO</b>
• ${fgEmoji(fg)} F&G: ${fg}/100 — ${fgLabel(fg)}
• ${regIcon} Régimen: ${regime}
• L/S: ${state.longShortRatio?.ratio||"—"}  ·  Funding: ${state.fundingRate?.rate||"—"}%`
  );
}

function buildWeekly(state) {
  const fx   = state.fxRate||fxRate();
  const tv   = state.totalValue||100;
  const ret  = state.returnPct||0;
  const weekAgo = Date.now() - 7*24*3600*1000;
  const ws   = (state.log||[]).filter(l=>l.type==="SELL"&&new Date(l.ts).getTime()>weekAgo);
  const wins = ws.filter(l=>l.pnl>0).length;
  const wr   = ws.length ? Math.round(wins/ws.length*100) : 0;
  const pnl  = ws.reduce((s,l)=>s+(l.pnlAbs||0),0);
  const fees = ws.reduce((s,l)=>s+(l.fee||0),0);
  const best  = [...ws].sort((a,b)=>b.pnl-a.pnl)[0];
  const worst = [...ws].sort((a,b)=>a.pnl-b.pnl)[0];
  const topPairs = Object.entries(state.pairScores||{})
    .sort((a,b)=>b[1].score-a[1].score).slice(0,3)
    .map(([s,p])=>`${coin(s)}(${p.score})`).join(" · ");

  return (
`${ret>=0?"🏆":"📉"} <b>Resumen semanal</b>
${HR}
💼 Capital:  <b>$${tv.toFixed(2)}</b> / €${toEur(tv,fx)}
📈 Retorno:  ${sign(ret)}${ret.toFixed(2)}%
${HR}
<b>📊 SEMANA</b>
• Operaciones:  ${ws.length}  (WR ${wr}%)
• P&L total:    ${sign(pnl)}$${pnl.toFixed(2)} / €${toEur(pnl,fx)}
• Comisiones:   $${fees.toFixed(2)}
${best ? `• 🥇 Mejor:  ${coin(best.symbol)} ${sign(best.pnl)}${best.pnl.toFixed(2)}%\n` : ""}${worst ? `• 💀 Peor:   ${coin(worst.symbol)} ${worst.pnl.toFixed(2)}%\n` : ""}${HR}
⭐ Top pares: ${topPairs||"—"}
🌡️ F&G: ${state.fearGreed||"—"}  ·  Régimen: ${state.marketRegime||"—"}`
  );
}

// ── Comandos del usuario ──────────────────────────────────────────────────────
let lastUpdateId = 0;
let _pauseTimer = null;
function startCommandListener(getState, botControls={}) {
  if(!TOKEN) return;

  function buildPositions(state) {
    const entries = Object.entries(state.portfolio||{});
    if(!entries.length) return `📭 <b>Sin posiciones abiertas</b>\n${HR}\nEl bot está esperando oportunidad`;
    const fx = state.fxRate||fxRate();
    const lines = entries.map(([sym,pos]) => {
      const cp  = (state.prices||{})[sym]||pos.entryPrice;
      const pnl = ((cp-pos.entryPrice)/pos.entryPrice*100);
      const pnlAbs = +(pos.qty*(cp-pos.entryPrice)).toFixed(2);
      const inv = +(pos.qty*pos.entryPrice).toFixed(2);
      const now = +(pos.qty*cp).toFixed(2);
      const e   = pnl>=2?"🟢":pnl>=0?"🟡":pnl>=-2?"🟠":"🔴";
      return (
`${e} <b>${coin(sym)}</b>  ${sign(pnl)}${pnl.toFixed(2)}%  (${sign(pnlAbs)}$${pnlAbs.toFixed(2)} / €${toEur(pnlAbs,fx)})
  Entró $${inv} → Ahora $${now}
  Stop $${pos.stopLoss}  ·  ${pos.strategy||"—"}`
      );
    });
    return `📊 <b>Posiciones abiertas (${entries.length})</b>\n${HR}\n`+lines.join(`\n${HR}\n`);
  }

  function buildLog10(state) {
    const sells = (state.log||[]).filter(l=>l.type==="SELL").slice(0,10);
    if(!sells.length) return `📭 <b>Sin operaciones aún</b>`;
    const fx = state.fxRate||fxRate();
    const lines = sells.map(t => {
      const pnl    = t.pnl||0;
      const exit   = +(t.qty*t.price).toFixed(2);
      const entry  = pnl ? +(exit/(1+pnl/100)).toFixed(2) : exit;
      const pnlAbs = t.pnlAbs!=null ? t.pnlAbs : +(exit-entry).toFixed(2);
      const e      = pnl>=2?"💰":pnl>=0?"✅":"❌";
      const hora   = t.ts ? new Date(t.ts).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"}) : "";
      return (
`${e} <b>${coin(t.symbol)}</b>  ${sign(pnl)}${pnl.toFixed(2)}%  (${sign(pnlAbs)}$${Math.abs(pnlAbs).toFixed(2)} / €${toEur(Math.abs(pnlAbs),fx)})
  $${entry} → $${exit}  ·  ${t.reason||"—"}  ${hora}`
      );
    });
    return `📋 <b>Últimas operaciones</b>\n${HR}\n`+lines.join(`\n${HR}\n`);
  }

  function buildMercado(state) {
    const fg  = state.fearGreed||50;
    const reg = state.marketRegime||"LATERAL";
    const ls  = state.longShortRatio||{ratio:"—",signal:"NEUTRAL"};
    const fr  = state.fundingRate||{rate:"—"};
    const oi  = state.openInterest||{trend:"STABLE"};
    const rd  = state.redditSentiment||{score:50,signal:"NEUTRAL"};
    const regExp = reg==="BULL"
      ? "Tendencia alcista. Posiciones más grandes, deja correr ganancias."
      : reg==="BEAR"
      ? "Mercado bajando. Solo rebotes extremos. Stops muy ajustados."
      : "Sin dirección. Compra en soportes, vende en resistencias (mean reversion).";
    const lsNum = parseFloat(ls.ratio)||1;
    const lsExp = lsNum>1.8
      ? "Muchos apalancados al alza → riesgo de cascada de liquidaciones"
      : lsNum<0.8
      ? "Mayoría cortos → posible short squeeze si sube"
      : "Balance normal entre largos y cortos";
    return (
`🌍 <b>Estado del mercado</b>  ${new Date().toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"})}
${HR}
${fgEmoji(fg)} <b>Fear & Greed: ${fg}/100</b>
${fgLabel(fg)}${fg<20?"\n📌 Históricamente: buen momento de compra":fg>80?"\n⚠️ Mercado sobrecomprado":""}
${HR}
${reg==="BULL"?"📈":reg==="BEAR"?"📉":"➡️"} <b>Régimen: ${reg}</b>
${regExp}
${HR}
⚖️ <b>Long/Short: ${ls.ratio}</b>
${lsExp}
${HR}
💸 <b>Funding BTC: ${fr.rate}%</b>
${parseFloat(fr.rate)>0.05?"Largos pagan a cortos — sobrecomprado en futuros":parseFloat(fr.rate)<-0.02?"Cortos pagan a largos — posible rebote":"Funding neutral"}
${HR}
📊 <b>Open Interest: ${oi.trend}</b>
${oi.trend==="GROWING"?"Dinero nuevo entrando — tendencia fuerte":oi.trend==="DECLINING"?"Posiciones cerrándose — posible fin de tendencia":"OI estable"}
${HR}
💬 <b>Reddit: ${rd.score}/100 — ${rd.signal}</b>`
    );
  }

  function buildMomentum(state) {
    const dp = state.dailyPnlPct||0;
    const m  = state.momentumMult||1;
    const ts = (state.log||[]).filter(l=>l.type==="SELL"&&new Date(l.ts).toDateString()===new Date().toDateString());
    const lvl = dp<0?"🛡 Cauteloso":dp<3?"⚖️ Normal":dp<7?`🚀 Boosted ×${m.toFixed(1)}`:dp<12?`🚀🚀 Fuerte ×${m.toFixed(1)}`:`🔥 Máximo ×${m.toFixed(1)}`;
    return (
`⚡ <b>Momentum hoy</b>
${HR}
P&L: <b>${sign(dp)}${dp.toFixed(2)}%</b>
${lvl}
${HR}
Operaciones: ${ts.length}  (${ts.filter(l=>l.pnl>0).length} ganadoras)`
    );
  }

  function buildLearning(state) {
    const sells=(state.log||[]).filter(l=>l.type==="SELL");
    const t=sells.length;
    const ph=t<50?"🌱 Fase 1 — explorando":t<200?"📈 Fase 2 — refinando":"🏆 Fase 3 — optimizado";
    const recentWR=t>=10?Math.round(sells.slice(-20).filter(l=>l.pnl>0).length/Math.min(20,t)*100):null;
    const adStop=state.adaptiveStopStats||{};
    const adH=state.adaptiveHoursStats||{};
    const fgCal=state.fearGreedRealtime?.calibration||{};
    const wf=state.walkForwardIntra;
    const xfer=(state.transferHistory||[]).filter(x=>x.improved!=null);
    return `🧠 <b>[LIVE] Aprendizaje</b>\n\n`+
      `${ph}\n`+
      `Trades: <b>${t}</b> | WR reciente: <b>${recentWR!=null?recentWR+"%":"—"}</b> | WR global: ${state.winRate||"—"}%\n\n`+
      `<b>Sistemas adaptados:</b>\n`+
      `🎯 Stop: ${adStop.learnedPairs||0} pares calibrados\n`+
      `⏰ Horas: ${adH.totalObservations||0} observaciones\n`+
      `😱 F&G: ${fgCal.observations||0} obs (RMSE ${fgCal.rmse||"—"})\n`+
      `📊 WF intradía: ${wf?wf.verdict:"pendiente ~30min"}\n`+
      (xfer.length?`🔄 Transfer: ${xfer.filter(x=>x.improved).length}/${xfer.length} mejoraron`:"🔄 Transfer: sin datos aún");
  }

  function buildRisk(state) {
    const p=state.optimizerParams||{};
    const adStop=state.adaptiveStopStats||{};
    return `⚙️ <b>[LIVE] Parámetros</b>\n\n`+
      `Score mín: ${p.minScore||65} | EMA: ${p.emaFast||13}/${p.emaSlow||21}\n`+
      `RSI oversold: ${p.rsiOversold||35} | ATR: ${p.atrMult||2}\n`+
      `Momentum: ×${(state.momentumMult||1).toFixed(1)}\n\n`+
      `<b>Adaptativos:</b>\n`+
      `Stop medio: ${adStop.avgStop?((adStop.avgStop*100).toFixed(2)+"%"):"aprendiendo..."}\n`+
      `Régimen: ${state.marketRegime||"—"} (${state.regimeDetectorStats?.observations||0} obs calibradas)`;
  }

  function buildWalkForward(state) {
    const wf = state.walkForwardIntra;
    if(!wf) return "⏳ WF intradía aún no calculado\nEspera ~30 min desde el arranque";
    const lines = Object.entries(wf.symbols||{}).slice(0,6)
      .map(([s,r])=>`${r.robust?"✅":"⚠️"} ${coin(s)}: train ${r.trainWR}% → test ${r.testWR}% (×${r.ratio})`);
    return (
`📊 <b>Walk-Forward intradía</b>
${HR}
${lines.join("\n")}
${HR}
Global: <b>${wf.verdict}</b>
Ratio: ${wf.avgRatio}  ·  ${wf.robustCount}/${wf.totalSymbols} robustos`
    );
  }

  let paused = false;

  function poll() {
    const req = https.get(
      `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${lastUpdateId+1}&timeout=20`,
      res => {
        let d = ""; res.on("data",c=>d+=c);
        res.on("end", () => {
          try {
            const json = JSON.parse(d);
            for(const u of (json.result||[])) {
              lastUpdateId = u.update_id;
              const text   = (u.message?.text||"").trim();
              const chatId = u.message?.chat?.id?.toString();
              if(chatId !== CHAT_ID) continue;
              const state = getState();
              const mode  = state.instance||state.mode||"BOT";

              if     (text==="/estado")      send(buildDaily(state));
              else if(text==="/mercado")     send(buildMercado(state));
              else if(text==="/posiciones")  send(buildPositions(state));
              else if(text==="/log")         send(buildLog10(state));
              else if(text==="/semana")      send(buildWeekly(state));
              else if(text==="/momentum")    send(buildMomentum(state));
              else if(text==="/aprendizaje") send(buildLearning(state));
              else if(text==="/riesgo")      send(buildRisk(state));
              else if(text==="/walkforward") send(buildWalkForward(state));
              else if(text==="/pausa") {
                paused = true;
                if(botControls.setPaused) botControls.setPaused(true);
                send(`⏸ <b>Bot pausado</b>\n${HR}\nNo se abrirán nuevas posiciones\nLos stops siguen activos\nAuto-reanuda en 6h`);
                // Auto-resume after 6h
                if(_pauseTimer) clearTimeout(_pauseTimer);
                _pauseTimer = setTimeout(() => {
                  paused = false;
                  if(botControls.setPaused) botControls.setPaused(false);
                  _pauseTimer = null;
                  send("🔄 <b>[LIVE] Auto-reanudado</b>\nLa pausa de 6h expiró — bot operando de nuevo.");
                }, 6 * 60 * 60 * 1000);
              }
              else if(text==="/reanudar") {
                paused = false;
                if(botControls.setPaused) botControls.setPaused(false);
                send(`▶️ <b>Bot reanudado</b>\nOperaciones normales restauradas`);
              }
              else if(text==="/modo") {
                send(
`⚙️ <b>Estado del bot</b>
${HR}
Modo:      ${mode}
Régimen:   ${state.marketRegime||"—"}
F&G:       ${state.fearGreed||"—"}/100
Defensivo: ${state.marketDefensive?"SÍ ⚠️":"NO ✅"}
Pausado:   ${paused?"SÍ ⏸":"NO ▶️"}
Momentum:  ×${(state.momentumMult||1).toFixed(2)}`
                );
              }
              else if(text==="/noticias") {
                const cp = state.cryptoPanic||{};
                send(
`📰 <b>CryptoPanic</b>
${HR}
Estado: ${cp.globalDefensive?"🚨 DEFENSIVO GLOBAL":"✅ Normal"}
Pares bloqueados: ${(cp.defensivePairs||[]).map(p=>coin(p)).join(", ")||"ninguno"}
Última revisión: ${cp.lastCheck?new Date(cp.lastCheck).toLocaleTimeString("es-ES"):"—"}`
                );
              }
              else if(text==="/balance" && botControls.getBalance) {
                botControls.getBalance().then(bal => {
                  if(!bal?.length) { send("❌ Sin conexión Binance"); return; }
                  const lines = bal.filter(b=>parseFloat(b.free)>0.001)
                    .map(b=>`• ${b.asset}: ${parseFloat(b.free).toFixed(4)}`);
                  send(`💰 <b>Balance Binance</b>\n${HR}\n${lines.join("\n")}`);
                }).catch(()=>send("❌ Error al obtener balance"));
              }


              else if(text==="/condiciones") {
                const s = state; // state comes from getState() - already available
                if(!s || s.loading) return send("❌ Bot no iniciado aún");
                const regime = s.marketRegime || "UNKNOWN";
                const fg = s.fearGreed || 50;
                const wr = s.recentWinRate ?? null;
                const nOpen = Object.keys(s.portfolio||{}).length;
                const maxPos = regime==="BEAR" ? 1 : 2;
                const cash = s.cash || 0;
                const tv = s.totalValue || 0;
                const availCash = Math.max(0, cash - tv*0.15);
                const minScore = s.optimizerParams?.minScore || 70;
                const regimeMin = regime==="BULL" ? minScore-5 :
                                  regime==="BEAR" ? 82 :
                                  regime==="LATERAL" ? Math.max(58, minScore-8) :
                                  minScore;
                const fearAdj = regime==="LATERAL"
                  ? (fg<25?1.3:fg<35?1.15:fg>75?0.7:1.0)
                  : (fg<25?0.8:fg>80?0.6:1.0);
                const dailyUsed = s.dailyUsed || s.dailyTrades?.count || 0;
                const dailyLimit = s.dailyLimit || 9;
                const blockers = [];
                if(paused)                       blockers.push("⏸ Bot pausado por Telegram");
                if(s.marketDefensive)           blockers.push("🛡 Modo defensivo activo");
                if(nOpen >= maxPos)             blockers.push(`📊 Posiciones llenas (${nOpen}/${maxPos})`);
                if(availCash < tv*0.05)         blockers.push(`💸 Sin cash ($${availCash.toFixed(2)})`);
                if(s.circuitBreaker?.triggered) blockers.push("🚨 Circuit breaker activo");
                if(dailyUsed >= dailyLimit)     blockers.push(`📅 Límite diario (${dailyUsed}/${dailyLimit} ops)`);
                const ok = blockers.length===0;
                send([
                  `${ok?"✅":"🔴"} <b>Condiciones para operar</b>`,
                  HR,
                  `📍 Régimen: <b>${regime}</b> | F&G: <b>${fg}</b>`,
                  `🎯 Score mín: <b>${regimeMin}</b> | fearAdj: <b>×${fearAdj.toFixed(2)}</b>`,
                  `💼 Posiciones: <b>${nOpen}/${maxPos}</b> | Cash libre: <b>$${availCash.toFixed(2)}</b>`,
                  `📈 Ops hoy: <b>${dailyUsed}/${dailyLimit}</b> | WR: <b>${wr!=null?wr+"%":"—"}</b>`,
                  HR,
                  ok
                    ? `✅ <b>Listo para operar</b> — esperando señal ≥${regimeMin}`
                    : `🚫 <b>Bloqueadores:</b>\n`+blockers.map(b=>`  • ${b}`).join("\n"),
                ].join("\n"));
              }
              else if(text==="/ayuda") {
                send(
`🤖 <b>[LIVE] Comandos disponibles</b>

📊 <b>Estado</b>
/estado — resumen del día en €/$
/mercado — análisis del mercado ahora mismo
/posiciones — qué tiene abierto el bot
/log — últimas 10 operaciones
/condiciones — ver si el bot puede entrar ahora

📈 <b>Análisis</b>
/semana — resumen de los últimos 7 días
/walkforward — ¿el modelo está funcionando bien?
/aprendizaje — qué ha aprendido el bot
/momentum — ritmo actual
/riesgo — parámetros y configuración

⚡ <b>Control</b>
/pausa — parar nuevas compras
/reanudar — reactivar
/balance — ver USDC real en Binance`);
              }
            }
          } catch(e) {}
          setTimeout(poll, 1000);
        });
      }
    );
    req.on("error", () => setTimeout(poll, 5000));
    req.setTimeout(25000, () => { req.destroy(); setTimeout(poll, 1000); });
  }

  poll();
  console.log("[TG] Comandos listos: /estado /mercado /posiciones /log /pausa /reanudar /ayuda");
  return { isPaused: () => paused };
}

// ── Resúmenes programados ─────────────────────────────────────────────────────
function scheduleReports(getState) {
  function msUntil(h,m=0) {
    const now=new Date(), next=new Date();
    next.setHours(h,m,0,0);
    if(next<=now) next.setDate(next.getDate()+1);
    return next-now;
  }
  function msUntilSunday() {
    const now=new Date(), next=new Date();
    const d=(7-now.getDay())%7||7;
    next.setDate(now.getDate()+d);
    next.setHours(20,0,0,0);
    return next-now;
  }
  setTimeout(()=>{ notifyDailySummary(getState()); setInterval(()=>notifyDailySummary(getState()), 24*3600*1000); }, msUntil(20));
  setTimeout(()=>{ notifyWeeklySummary(getState()); setInterval(()=>notifyWeeklySummary(getState()), 7*24*3600*1000); }, msUntilSunday());
  console.log(`[TG] Diario en ${Math.round(msUntil(20)/60000)}min | Semanal en ${Math.round(msUntilSunday()/3600000)}h`);
}

function notifyDailySummary(state)  { send(buildDaily(state)); }
function notifyWeeklySummary(state) { send(buildWeekly(state)); }

// ── Explicabilidad ────────────────────────────────────────────────────────────
function explainTrade(trade, regime, patternWinRate) {
  const c = coin(trade.symbol);
  const reasons = [];
  if(trade.type==="BUY") {
    if(trade.score>=75)       reasons.push(`señal fuerte (score ${trade.score})`);
    if(regime==="BULL")       reasons.push("mercado alcista");
    if(regime==="LATERAL")    reasons.push("rebote en soporte Bollinger");
    if(regime==="BEAR")       reasons.push("rebote en sobreventa extrema");
    if(patternWinRate>=65)    reasons.push(`patrón con ${patternWinRate}% WR histórico`);
  } else {
    const r = trade.reason||"";
    if(r.includes("STOP"))    reasons.push("stop loss alcanzado");
    else if(r.includes("TRAILING")) reasons.push(`trailing stop (+${trade.pnl?.toFixed(1)||0}%)`);
    else if(r.includes("MR")) reasons.push("objetivo mean reversion");
    else reasons.push("señal de venta");
  }
  return `${trade.type==="BUY"?"Compré":"Vendí"} <b>${c}</b>: ${reasons.join(", ")}`;
}

function notifyTradeWithExplanation(trade, regime, patternWinRate) {
  if(!trade || trade.type!=="SELL" || Math.abs(trade.pnl||0)<1) return;
  const pnl = trade.pnl||0;
  const e   = pnl>=3?"💰":pnl>=0?"✅":pnl>=-3?"⚠️":"📉";
  send(
`${e} <b>${coin(trade.symbol)} ${sign(pnl)}${pnl.toFixed(2)}%</b>
${explainTrade(trade, regime, patternWinRate)}
Precio: $${trade.price}  ·  ${trade.reason||"—"}`
  );
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  send,
  notifyBigWin, notifyBigLoss,
  notifyCircuitBreaker, notifyMaxDrawdown,
  notifyDefensiveMode, notifyDefensiveOff,
  notifyBlacklist, notifyNewsAlert,
  notifyFearGreed, notifyOptimizer,
  notifyNightlyReplay, notifyDailyLimitChange,
  notifyMomentumBoost, notifyMomentumDefensive,
  notifyCryptoPanicAlert, notifyRiskLearningUpdate,
  notifyPaperExport, notifyTradeWithExplanation, explainTrade,
  notifyStartup, testTelegram,
  notifyDailySummary, notifyWeeklySummary,
  scheduleReports, startCommandListener,
};
