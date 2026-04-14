// ─── TELEGRAM FINAL ───────────────────────────────────────────────────────────
"use strict";

const https = require("https");
const TOKEN   = process.env.TELEGRAM_TOKEN   || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

function send(text) {
  if(!TOKEN||!CHAT_ID) return;
  const body=JSON.stringify({chat_id:CHAT_ID,text,parse_mode:"HTML"});
  const req=https.request({hostname:"api.telegram.org",path:`/bot${TOKEN}/sendMessage`,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=>{if(res.statusCode!==200)console.warn("[TG]",res.statusCode);});
  req.on("error",e=>console.warn("[TG]",e.message));
  req.write(body);req.end();
}

// ── Eventos importantes únicamente ───────────────────────────────────────────
function notifyCircuitBreaker(drawdown) { send(`⚡ <b>CIRCUIT BREAKER</b>\nPérdida diaria: <b>${(Math.abs(drawdown)*100).toFixed(2)}%</b>\nBot pausado hasta mañana.`); }
function notifyBigWin(trade)  { send(`💰 <b>GANANCIA IMPORTANTE</b>\n<b>${trade.symbol}</b>  +${trade.pnl}%\nPrecio: $${trade.price}  Comisión: $${trade.fee}`); }
function notifyBigLoss(trade) { send(`📉 <b>PÉRDIDA IMPORTANTE</b>\n<b>${trade.symbol}</b>  ${trade.pnl}%\nRazón: ${trade.reason}`); }
function notifyDefensiveMode(btcDrawdown) { send(`🛡️ <b>MODO DEFENSIVO</b>\nBTC cayó <b>${Math.abs(btcDrawdown)}%</b> desde el máximo de hoy. Sin nuevas posiciones.`); }
function notifyDefensiveOff()  { send(`✅ <b>Modo defensivo desactivado</b> — Bot retoma operaciones.`); }
function notifyBlacklist(sym)  { /* silenciado */ }
function notifyOptimizer(r)    { if(!r?.changes?.length)return; send(`🧠 <b>OPTIMIZADOR</b>\nWR: ${r.winRate}%  avgP&L: ${r.avgPnl}%\nCambios: ${r.changes.join(", ")}`); }
function notifyNightlyReplay(b){ send(`🌙 <b>REPLAY NOCTURNO</b>\nMejor estrategia: EMA ${b.params.emaFast}/${b.params.emaSlow} · Score ${b.params.minScore}\nWR: ${b.winRate}%  avgP&L: ${b.avgPnl}%`); }
function notifyNewsAlert(news) { send(`⚠️ <b>NOTICIA IMPORTANTE</b>\n${news.title}\nPares: ${news.currencies?.join(", ")||"—"}`); }
function notifyFearGreed(val,label) { const e=val<25?"😱":val>75?"🤑":"😐"; send(`${e} <b>Fear & Greed: ${val} — ${label}</b>\n${val<30?"Posible oportunidad de compra":val>75?"Mercado sobrecomprado, precaución":""}`); }
function notifyDailyLimitChange(regime,limit,wr){ send(`📊 <b>Límite diario actualizado</b>\nRégimen: ${regime} | WR reciente: ${wr||"—"}%\nNuevo límite: <b>${limit} operaciones/día</b>`); }

function notifyStartup(mode) {
  send(`🚀 <b>CRYPTOBOT FINAL arrancado</b>\nModo: <b>${mode}</b>\n\n✅ Trailing Stop · Circuit Breaker · Modo Defensivo\n✅ Blacklist · Auto-Optimizer · Horarios óptimos\n✅ Fear & Greed · Alertas noticias · Replay nocturno\n✅ Contrafactual · Score por par · Régimen mercado\n✅ Límite diario dinámico · Comisiones BNB\n✅ PostgreSQL · BAFIR TRADING conectado\n\n/estado /semana /ayuda`);
}

// ── Resúmenes ─────────────────────────────────────────────────────────────────
function buildDaily(state) {
  const tv=state.totalValue||10000,ret=state.returnPct||0;
  const today=new Date().toDateString();
  const ts=(state.log||[]).filter(l=>l.type==="SELL"&&l.ts&&new Date(l.ts).toDateString()===today);
  const wins=ts.filter(l=>l.pnl>0).length,pnl=ts.reduce((s,l)=>s+(l.pnl||0),0),fees=ts.reduce((s,l)=>s+(l.fee||0),0);
  return `${ret>=0?"📈":"📉"} <b>RESUMEN DIARIO</b> — ${new Date().toLocaleDateString("es-ES")}\n\n`+
    `💼 Capital: <b>$${tv.toFixed(2)}</b>  (${ret>=0?"+":""}${ret.toFixed(2)}%)\n`+
    `📋 Hoy: ${ts.length} ops · ${wins}/${ts.length} ganadoras · P&L ${pnl>=0?"+":""}${pnl.toFixed(2)}%\n`+
    `💸 Comisiones: $${fees.toFixed(2)}  |  WR global: ${state.winRate||"—"}%\n`+
    `🌡️ Fear & Greed: ${state.fearGreed||"—"}  |  Régimen: ${state.marketRegime||"—"}\n`+
    `📊 Límite hoy: ${state.dailyTrades?.count||0}/${state.dailyLimit||10} ops\n`+
    `⚙️ Score mín: ${state.optimizerParams?.minScore||65} | EMA ${state.optimizerParams?.emaFast}/${state.optimizerParams?.emaSlow}`;
}
function buildWeekly(state) {
  const tv=state.totalValue||10000,ret=state.returnPct||0;
  const wa=Date.now()-7*24*60*60*1000;
  const ws=(state.log||[]).filter(l=>l.type==="SELL"&&l.ts&&new Date(l.ts).getTime()>wa);
  const wins=ws.filter(l=>l.pnl>0).length,pnl=ws.reduce((s,l)=>s+(l.pnl||0),0),fees=ws.reduce((s,l)=>s+(l.fee||0),0);
  const wr=ws.length?Math.round(wins/ws.length*100):0;
  const sorted=[...ws].sort((a,b)=>b.pnl-a.pnl),best=sorted[0],worst=sorted[sorted.length-1];
  const topPairs=Object.entries(state.pairScores||{}).sort((a,b)=>b[1].score-a[1].score).slice(0,3).map(([s,p])=>`${s}(${p.score})`).join(", ");
  return `${ret>=0?"🏆":"📉"} <b>RESUMEN SEMANAL</b>\n\n`+
    `💼 Capital: <b>$${tv.toFixed(2)}</b>  (${ret>=0?"+":""}${ret.toFixed(2)}%)\n`+
    `📋 ${ws.length} ops · WR ${wr}% · P&L ${pnl>=0?"+":""}${pnl.toFixed(2)}% · Fees $${fees.toFixed(2)}\n`+
    (best?`🥇 Mejor: <b>${best.symbol}</b> +${best.pnl}%\n`:"")+
    (worst?`💀 Peor: <b>${worst.symbol}</b> ${worst.pnl}%\n`:"")+
    `⭐ Top pares: ${topPairs||"—"}\n`+
    `📈 Régimen: ${state.marketRegime||"—"} | Fear&Greed: ${state.fearGreed||"—"}`;
}

function notifyDailySummary(state)  { send(buildDaily(state)); }
function notifyWeeklySummary(state) { send(buildWeekly(state)); }

// ── Comandos Telegram ────────────────────────────────────────────────────────
let lastUpdateId=0;
let paused = false;
function startCommandListener(getState, botControls, initialPaused=false) {
  // F2: restaurar paused desde disco (simpleBot.paused) en boot.
  // Si el bot fue pausado vía /pausa antes de un restart, debe arrancar pausado
  // y notificar al usuario para que sepa que sigue en estado seguro.
  if(initialPaused === true) {
    paused = true;
    // delay el send para que la cola HTTP de Telegram esté lista (poll todavía no arrancó)
    setTimeout(() => {
      send("⚠️ <b>Bot arrancado en estado PAUSADO</b>\nEstado restaurado de disco. Usa /reanudar para reactivar.");
    }, 2000);
    console.log("[TG] BOOT: paused=true restaurado de disco — notificación enviada");
  }
  if(!TOKEN) return { isPaused: () => paused };
  function poll() {
    const req=https.get(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${lastUpdateId+1}&timeout=20`,res=>{
      let d="";res.on("data",c=>d+=c);
      res.on("end",()=>{
        try {
          const json=JSON.parse(d);
          for(const u of(json.result||[])){
            lastUpdateId=u.update_id;
            const text=u.message?.text||"",chatId=u.message?.chat?.id?.toString();
            if(chatId===CHAT_ID){
              const s = getState();

              if(text==="/estado") {
                const tv = s.totalValue||0;
                const ret = s.returnPct||0;
                const wr = s.winRate||0;
                const trades = (s.log||[]).filter(l=>l.type==="SELL").length;
                const simple = botControls?.getSimpleState?.();
                const simpleKellys = simple?.kellyByStrategy||{};
                const firstKelly = Object.values(simpleKellys)[0]||{};
                send(
                  `📊 <b>BAFIR LIVE — Estado actual</b>\n` +
                  `Capital: <b>$${tv.toFixed(2)}</b> (${ret>=0?"+":""}${ret.toFixed(2)}%)\n` +
                  `Win Rate: <b>${wr}%</b> | Trades: ${trades}\n` +
                  `Régimen: ${s.marketRegime||"—"} | F&G: ${s.fearGreed||"—"}\n` +
                  `Posiciones: ${Object.keys(s.portfolio||{}).length} | Pausa: ${paused?"SÍ":"NO"}\n` +
                  `Uptime: ${Math.round(process.uptime()/3600)}h`
                );
              }
              else if(text==="/posiciones") {
                const pos = Object.entries(s.portfolio||{});
                if(!pos.length) { send("📭 Sin posiciones abiertas"); }
                else {
                  const lines = pos.map(([sym,p])=>{
                    const price = s.prices?.[sym]||p.entryPrice;
                    const pnl = ((price-p.entryPrice)/p.entryPrice*100).toFixed(2);
                    const dur = Math.round((Date.now()-(p.openTs||Date.now()))/3600000);
                    return `• <b>${sym}</b> ${pnl>=0?"+":""}${pnl}% (${dur}h) entrada:$${p.entryPrice?.toFixed?.(4)||"—"}`;
                  }).join("\n");
                  send(`📂 <b>Posiciones abiertas (${pos.length})</b>\n${lines}`);
                }
              }
              else if(text==="/estrategias") {
                const simple = botControls?.getSimpleState?.();
                if(!simple?.strategies) { send("⏳ Engine simple arrancando..."); }
                else {
                  const lines = simple.strategies.map(st=>{
                    const k = st.kelly||{};
                    const icon = st.active?"🟡":k.negative?"🔴":"⚪";
                    return `${icon} ${st.pair} ${st.tf} ${st.type}\n   PF:${st.pf} Kelly:${k.kelly||"—"} Velas:${st.candles||0}`;
                  }).join("\n");
                  send(
                    `🤖 <b>7 Estrategias validadas</b>\n` +
                    `Capital Capa1: $${simple.capa1Cash?.toFixed?.(0)||"—"} | Capa2: $${simple.capa2Cash?.toFixed?.(0)||"—"}\n` +
                    `WR global: ${simple.winRate||0}% | Trades: ${simple.trades||0}\n\n${lines}`
                  );
                }
              }
              else if(text==="/kelly") {
                const simple = botControls?.getSimpleState?.();
                if(!simple?.kellyByStrategy) { send("⏳ Calculando Kelly..."); }
                else {
                  const lines = Object.entries(simple.kellyByStrategy).map(([id, k])=>{
                    const icon = k.negative?"🔴":"🟢";
                    return `${icon} <b>${id}</b> kelly=${k.kelly} WR=${k.wr||"—"}% n=${k.n}`;
                  }).join("\n");
                  send(`📐 <b>Kelly Gate por estrategia</b>\n\n${lines}`);
                }
              }
              else if(text==="/sizing") {
                const simple = botControls?.getSimpleState?.();
                if(!simple) { send("⏳ Engine simple arrancando..."); }
                else {
                  const tv = simple.totalValue||100;
                  const lines = (simple.strategies||[]).map(st=>{
                    const k = st.kelly||{};
                    const kellyFrac = Math.max(0.05, Math.min(0.5, k.kelly||0.1));
                    let invest = tv * kellyFrac * 0.5;
                    if(invest > tv*0.30) invest = tv*0.30;
                    const avail = st.capa===1 ? simple.capa1Cash : simple.capa2Cash;
                    if(invest > avail) invest = avail;
                    const skip = invest < 10;
                    const icon = skip?"⛔":st.active?"🟡":"✅";
                    return `${icon} <b>${st.id}</b>\n   Kelly=${kellyFrac.toFixed(3)} → $${invest.toFixed(1)} ${skip?"(< $10 min)":""}`;
                  }).join("\n");
                  send(
                    `💰 <b>Sizing actual</b> (capital: $${tv.toFixed(0)})\n` +
                    `Capa1: $${simple.capa1Cash?.toFixed?.(0)||"—"} | Capa2: $${simple.capa2Cash?.toFixed?.(0)||"—"}\n\n${lines}\n\n` +
                    `Half-Kelly · Cap 30% · Min $10`
                  );
                }
              }
              else if(text==="/health") {
                const uptimeH = Math.round(process.uptime()/3600);
                const uptimeM = Math.round((process.uptime()%3600)/60);
                const mem = process.memoryUsage();
                const heapMB = (mem.heapUsed/1024/1024).toFixed(1);
                const rssMB = (mem.rss/1024/1024).toFixed(1);
                const simple = botControls?.getSimpleState?.();
                const candleStatus = (simple?.strategies||[]).map(st=>{
                  const icon = st.candles >= 50 ? "✅" : "⏳";
                  return `${icon} ${st.id}: ${st.candles} velas`;
                }).join("\n");
                send(
                  `🏥 <b>Health Check</b>\n\n` +
                  `Uptime: ${uptimeH}h ${uptimeM}m\n` +
                  `Memoria: ${heapMB}MB heap / ${rssMB}MB RSS\n` +
                  `Precios activos: ${Object.keys(s.prices||{}).length}\n` +
                  `Tick: #${s.tick||0}\n` +
                  `LIVE_MODE: ${process.env.LIVE_MODE||"false"}\n` +
                  `Pausa: ${paused?"SÍ":"NO"}\n\n` +
                  `<b>Velas por estrategia:</b>\n${candleStatus}`
                );
              }
              else if(text.startsWith("/capital ")) {
                const val = parseFloat(text.split(" ")[1]);
                if(isNaN(val)||val<10) { send("❌ Formato: /capital 110"); }
                else if(botControls?.setCapital) {
                  botControls.setCapital(val);
                  send(`✅ Capital actualizado a $${val} USDC`);
                } else { send("❌ Comando no disponible"); }
              }
              else if(text==="/semana") send(buildWeekly(s));
              else if(text==="/pausa") {
                paused = true;
                if(botControls?.setPaused) botControls.setPaused(true);
                send("⏸ <b>Bot pausado indefinidamente</b>\nNo se abrirán nuevas posiciones\nLos stops siguen activos\nEscribe /reanudar para volver a operar");
              }
              else if(text==="/reanudar") {
                paused = false;
                if(botControls?.setPaused) botControls.setPaused(false);
                send("▶️ <b>Bot reanudado</b>\nOperaciones normales restauradas");
              }
              else if(text==="/ayuda") send(
                `📖 <b>Comandos disponibles:</b>\n\n` +
                `/estado — capital, WR, régimen, uptime\n` +
                `/posiciones — qué está abierto ahora\n` +
                `/estrategias — estado de las 7 estrategias\n` +
                `/kelly — Kelly gate por estrategia\n` +
                `/sizing — sizing actual por estrategia\n` +
                `/health — health check del sistema\n` +
                `/capital [n] — cambiar capital (ej: /capital 110)\n` +
                `/semana — resumen de los últimos 7 días\n` +
                `/pausa — pausar entradas (stops siguen activos)\n` +
                `/reanudar — reanudar operaciones\n` +
                `/ayuda — esta lista`
              );
            }
          }
        } catch(e){}
        setTimeout(poll,1000);
      });
    });
    req.on("error",()=>setTimeout(poll,5000));
    req.setTimeout(25000,()=>{req.destroy();setTimeout(poll,1000);});
  }
  poll();
  console.log("[TG] Comandos: /estado /posiciones /estrategias /kelly /sizing /health /capital /semana /pausa /reanudar /ayuda");
  return { isPaused: () => paused };
}

// ── Programar resúmenes ───────────────────────────────────────────────────────
function scheduleReports(getState) {
  function msUntil(h,m=0){const now=new Date(),next=new Date();next.setHours(h,m,0,0);if(next<=now)next.setDate(next.getDate()+1);return next-now;}
  function msUntilSunday(){const now=new Date(),next=new Date();const d=(7-now.getDay())%7||7;next.setDate(now.getDate()+d);next.setHours(20,0,0,0);return next-now;}
  setTimeout(()=>{notifyDailySummary(getState());setInterval(()=>notifyDailySummary(getState()),24*60*60*1000);},msUntil(20));
  setTimeout(()=>{notifyWeeklySummary(getState());setInterval(()=>notifyWeeklySummary(getState()),7*24*60*60*1000);},msUntilSunday());
  console.log(`[TG] Diario en ${Math.round(msUntil(20)/60000)}min | Semanal en ${Math.round(msUntilSunday()/3600000)}h`);
}

module.exports = {
  notifyCircuitBreaker,notifyBigWin,notifyBigLoss,
  notifyDefensiveMode,notifyDefensiveOff,notifyBlacklist,
  notifyOptimizer,notifyNightlyReplay,notifyNewsAlert,
  notifyFearGreed,notifyDailyLimitChange,notifyStartup,
  notifyDailySummary,notifyWeeklySummary,
  scheduleReports,startCommandListener,
};

// ── Notificaciones sync paper→live ────────────────────────────────────────────
function notifyPaperExport(stats, params) {
  send(`📤 <b>PAPER → LIVE exportando parámetros</b>\nWR 7d: ${stats.winRate}% | ${stats.nTrades} ops\nEMA ${params.emaFast}/${params.emaSlow} | Score ${params.minScore}\nEl LIVE evaluará si los adopta.`);
}
module.exports.notifyPaperExport = notifyPaperExport;

function notifyMaxDrawdown(alert) {
  send(`🚨 <b>ALERTA DRAWDOWN MÁXIMO</b>\nPérdida desde máximo: <b>${alert.drawdownPct}%</b>\nMáximo histórico: $${alert.maxEquity}\nValor actual: $${alert.currentEquity}\nRevisa la estrategia manualmente.`);
}
module.exports.notifyMaxDrawdown = notifyMaxDrawdown;

// ── Explicabilidad de trades ───────────────────────────────────────────────────
function explainTrade(trade, regime, patternWinRate) {
  const sym = trade.symbol?.replace("USDT","") || "—";
  const action = trade.type === "BUY" ? "Compré" : "Vendí";
  const reasons = [];

  if (trade.type === "BUY") {
    if (trade.score >= 75)       reasons.push(`señal muy fuerte (score ${trade.score})`);
    else if (trade.score >= 60)  reasons.push(`señal moderada (score ${trade.score})`);
    if (regime === "BULL")       reasons.push("mercado alcista");
    if (regime === "LATERAL")    reasons.push("rebote en soporte Bollinger");
    if (regime === "BEAR")       reasons.push("rebote extremo en sobreventa");
    if (patternWinRate >= 65)    reasons.push(`patrón con ${patternWinRate}% win rate histórico`);
    if (trade.strategy === "ENSEMBLE") reasons.push("consenso de múltiples estrategias");
  } else {
    const r = trade.reason || "";
    if (r.includes("STOP"))      reasons.push("stop loss alcanzado");
    else if (r.includes("TRAILING")) reasons.push(`trailing stop activado (+${trade.pnl?.toFixed(1)||0}% capturado)`);
    else if (r.includes("MR"))   reasons.push("objetivo de mean reversion alcanzado");
    else if (r.includes("BEAR")) reasons.push("mercado bajista, salida preventiva");
    else                         reasons.push("señal de venta del modelo");
  }

  const explanation = `${action} <b>${sym}</b>: ${reasons.join(", ")}.`;
  return explanation;
}

function notifyTradeWithExplanation(trade, regime, patternWinRate) {
  if (!trade || trade.type !== "SELL") return; // solo notificar ventas cerradas
  const pnl = trade.pnl || 0;
  if (Math.abs(pnl) < 1) return; // solo trades significativos
  const emoji = pnl >= 3 ? "💰" : pnl >= 0 ? "✅" : pnl >= -3 ? "⚠️" : "📉";
  const explanation = explainTrade(trade, regime, patternWinRate);
  send(
    `${emoji} <b>${trade.symbol?.replace("USDT","")} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%</b>\n` +
    `${explanation}\n` +
    `Precio salida: $${trade.price} · ${trade.reason}`
  );
}

module.exports.notifyTradeWithExplanation = notifyTradeWithExplanation;
module.exports.explainTrade = explainTrade;
module.exports.send = send;

function notifyMomentumBoost(mult, pnlPct) {
  send(`🚀 <b>MOMENTUM ACTIVADO</b>\nP&L hoy: <b>+${pnlPct.toFixed(1)}%</b>\nTamaño posiciones: <b>×${mult.toFixed(1)}</b>\nEl bot aumenta apuestas en días ganadores.`);
}
function notifyMomentumDefensive(pnlPct) {
  send(`🛡 <b>MODO DEFENSIVO</b>\nP&L hoy: <b>${pnlPct.toFixed(1)}%</b>\nTamaño posiciones reducido a ×0.7`);
}
function notifyCryptoPanicAlert(pairs, global_) {
  if (global_) send(`🚨 <b>CRYPTOPANIC — ALERTA GLOBAL</b>\nNoticias negativas detectadas. Posiciones reducidas al 30%.`);
  else if (pairs.length) send(`⚠️ <b>CRYPTOPANIC — ${pairs.join(", ")}</b>\nNoticias negativas. Posiciones en estos pares reducidas al 50%.`);
}
module.exports.notifyMomentumBoost = notifyMomentumBoost;
module.exports.notifyMomentumDefensive = notifyMomentumDefensive;
module.exports.notifyCryptoPanicAlert = notifyCryptoPanicAlert;

function notifyRiskLearningUpdate(changes) {
  if (!changes?.length) return;
  const lines = changes.map(c => `  <b>${c.rule}</b>: ${c.from}→${c.to} (${c.reason})`).join("\n");
  send(`🧠 <b>RISK LEARNING — Parámetros ajustados</b>\n${lines}\n\nEl bot ha aprendido que sus reglas de riesgo necesitaban ajuste.`);
}
module.exports.notifyRiskLearningUpdate = notifyRiskLearningUpdate;

// ── Alertas automáticas ─────────────────────────────────────────────────────
// Llamar checkAlerts() cada ~60 ticks desde el loop principal
const _alertState = {
  capitalHistory: [],      // [{v, t}] — snapshots cada 10min
  lastCapitalAlertTs: 0,   // max 1 alerta por hora
  positionAlertedAt: {},   // {strategyId: timestamp} — max 1 por posición por día
};

function checkAlerts(getSimpleState) {
  const simple = getSimpleState?.();
  if(!simple) return;
  const now = Date.now();
  const tv = simple.totalValue||0;

  // ── Capital drop alert: >5% en 1 hora ─────────────────────────────────
  _alertState.capitalHistory.push({v:tv, t:now});
  // Mantener solo ultima hora
  _alertState.capitalHistory = _alertState.capitalHistory.filter(h => now - h.t < 3600000);
  if(_alertState.capitalHistory.length >= 2) {
    const oldest = _alertState.capitalHistory[0];
    const dropPct = (oldest.v - tv) / oldest.v * 100;
    if(dropPct >= 5 && now - _alertState.lastCapitalAlertTs > 3600000) {
      _alertState.lastCapitalAlertTs = now;
      send(
        `🚨 <b>ALERTA: Capital cayó ${dropPct.toFixed(1)}% en 1h</b>\n` +
        `Hace 1h: $${oldest.v.toFixed(2)} → Ahora: $${tv.toFixed(2)}\n` +
        `Revisa posiciones o usa /pausa si es necesario.`
      );
    }
  }

  // ── Position age alert: >24h warning, >44h time-stop inminente ────────
  for(const [id, pos] of Object.entries(simple.portfolio||{})) {
    const ageH = (now - (pos.openTs||now)) / 3600000;
    const lastAlert = _alertState.positionAlertedAt[id] || 0;
    if(ageH >= 44 && now - lastAlert > 4*3600000) {
      _alertState.positionAlertedAt[id] = now;
      const pnl = pos.entryPrice ? ((simple.prices?.[pos.pair]||pos.entryPrice) - pos.entryPrice) / pos.entryPrice * 100 : 0;
      send(
        `⏰ <b>TIME STOP INMINENTE</b>\n` +
        `<b>${pos.pair}</b> (${id}) abierta hace ${Math.round(ageH)}h\n` +
        `P&L actual: ${pnl>=0?"+":""}${pnl.toFixed(2)}%\n` +
        `Se cerrará automáticamente a las 48h.`
      );
    } else if(ageH >= 24 && now - lastAlert > 12*3600000) {
      _alertState.positionAlertedAt[id] = now;
      const pnl = pos.entryPrice ? ((simple.prices?.[pos.pair]||pos.entryPrice) - pos.entryPrice) / pos.entryPrice * 100 : 0;
      send(
        `⚠️ <b>Posición abierta >24h</b>\n` +
        `<b>${pos.pair}</b> (${id}) — ${Math.round(ageH)}h\n` +
        `P&L actual: ${pnl>=0?"+":""}${pnl.toFixed(2)}%\n` +
        `Time stop a las 48h.`
      );
    }
  }
  // Limpiar alertas de posiciones cerradas
  for(const id of Object.keys(_alertState.positionAlertedAt)) {
    if(!simple.portfolio?.[id]) delete _alertState.positionAlertedAt[id];
  }
}
module.exports.checkAlerts = checkAlerts;
