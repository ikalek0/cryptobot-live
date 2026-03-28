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
function notifyBlacklist(sym)  { send(`🚫 <b>${sym} bloqueado 24h</b> — 3 pérdidas consecutivas.`); }
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

// ── Comandos Telegram completos ───────────────────────────────────────────────
let lastUpdateId=0;
function startCommandListener(getState, botControls={}) {
  if(!TOKEN) return;
  
  function buildHelp(mode) {
    return "📖 <b>Comandos BAFIR " + mode + "</b>\n\n" +
      "<b>Info:</b>\n/estado /semana /posiciones /log\n/noticias /momentum /aprendizaje /riesgo\n\n" +
      "<b>Control:</b>\n/pausa — pausar nuevas entradas\n/reanudar — reanudar\n/modo — configuración actual\n" +
      (mode.includes("LIVE") ? "/balance — balance Binance real" : "");
  }

  function buildPositions(state) {
    const entries = Object.entries(state.portfolio||{});
    if (!entries.length) return "📭 <b>Sin posiciones abiertas</b>";
    const lines = entries.map(([sym,pos]) => {
      const cp=(state.prices||{})[sym]||pos.entryPrice;
      const pnl=((cp-pos.entryPrice)/pos.entryPrice*100).toFixed(2);
      const e=pnl>=2?"🟢":pnl>=0?"🟡":pnl>=-2?"🟠":"🔴";
      return e+" <b>"+sym.replace("USDT","")+"</b> "+(pnl>=0?"+":"")+pnl+"% · Stop $"+pos.stopLoss+" · "+pos.strategy;
    });
    return "📊 <b>Posiciones abiertas ("+entries.length+")</b>\n"+lines.join("\n");
  }

  function buildLog10(state) {
    const sells=(state.log||[]).filter(l=>l.type==="SELL").slice(0,10);
    if(!sells.length) return "📭 Sin operaciones aún";
    return "📋 <b>Últimas ops</b>\n"+sells.map(t=>{
      const p=(t.pnl||0).toFixed(2),e=t.pnl>=2?"💰":t.pnl>=0?"✅":"❌";
      const h=t.ts?new Date(t.ts).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"}):"";
      return e+" "+t.symbol.replace("USDT","")+" "+(t.pnl>=0?"+":"")+p+"% · "+t.reason+" "+h;
    }).join("\n");
  }

  function buildMomentum(state) {
    const dp=state.dailyPnlPct||0, m=state.momentumMult||1;
    const lvl=dp<0?"🛡 Defensivo":dp<3?"— Normal":dp<7?"🚀 Boosted ×"+m.toFixed(1):dp<12?"🚀🚀 Fuerte ×"+m.toFixed(1):"🔥🔥 Máximo ×"+m.toFixed(1);
    const ts=(state.log||[]).filter(l=>l.type==="SELL"&&l.ts&&new Date(l.ts).toDateString()===new Date().toDateString());
    return "⚡ <b>Momentum hoy</b>\nP&L: <b>"+(dp>=0?"+":"")+dp.toFixed(2)+"%</b>\n"+lvl+"\nOps: "+ts.length+" ("+ts.filter(l=>l.pnl>0).length+" ganadoras)";
  }

  function buildLearning(state) {
    const t=(state.log||[]).filter(l=>l.type==="SELL").length;
    const ph=t<100?"Fase 1 (exploración)":t<500?"Fase 2 (refinamiento)":"Fase 3 (optimizado)";
    return "🧠 <b>Aprendizaje</b>\n"+ph+"\nTrades: "+t+"\nWR: "+(state.winRate||0)+"%\nRégimen: "+(state.marketRegime||"—");
  }

  function buildRisk(state) {
    const p=state.optimizerParams||{};
    return "⚙️ <b>Parámetros</b>\nScore min: "+p.minScore+"\nEMA: "+p.emaFast+"/"+p.emaSlow+"\nRSI oversold: "+p.rsiOversold+"\nATR: "+p.atrMult;
  }

  let paused=false;

  function poll() {
    const req=https.get("https://api.telegram.org/bot"+TOKEN+"/getUpdates?offset="+(lastUpdateId+1)+"&timeout=20",res=>{
      let d="";res.on("data",c=>d+=c);
      res.on("end",()=>{
        try {
          const json=JSON.parse(d);
          for(const u of(json.result||[])){
            lastUpdateId=u.update_id;
            const text=(u.message?.text||"").trim();
            const chatId=u.message?.chat?.id?.toString();
            if(chatId!==CHAT_ID){continue;}
            const state=getState();
            const mode=state.instance||state.mode||"BOT";
            if(text==="/estado")       send(buildDaily(state));
            else if(text==="/semana")  send(buildWeekly(state));
            else if(text==="/posiciones") send(buildPositions(state));
            else if(text==="/log")     send(buildLog10(state));
            else if(text==="/momentum")send(buildMomentum(state));
            else if(text==="/aprendizaje")send(buildLearning(state));
            else if(text==="/riesgo")  send(buildRisk(state));
            else if(text==="/pausa"){
              paused=true;
              if(botControls.setPaused) botControls.setPaused(true);
              send("⏸ <b>Bot pausado</b>\nNo se abrirán nuevas posiciones. Stops activos.");
            }
            else if(text==="/reanudar"){
              paused=false;
              if(botControls.setPaused) botControls.setPaused(false);
              send("▶️ <b>Bot reanudado</b>\nOperaciones normales restauradas.");
            }
            else if(text==="/modo"){
              const cp=state.cryptoPanic||{};
              send("⚙️ <b>Modo: "+mode+"</b>\nRégimen: "+(state.marketRegime||"—")+"\nDefensivo: "+(state.marketDefensive?"SÍ":"NO")+"\nCP: "+(cp.globalDefensive?"🚨 ALERTA":"✅ OK")+"\n×"+(state.momentumMult||1).toFixed(2)+"\nPausado: "+(paused?"SÍ":"NO"));
            }
            else if(text==="/noticias"){
              const cp=state.cryptoPanic||{};
              send("📰 <b>CryptoPanic</b>\n"+(cp.globalDefensive?"🚨 DEFENSIVO GLOBAL":"✅ Normal")+"\nPares: "+((cp.defensivePairs||[]).map(p=>p.replace("USDT","")).join(",")||"ninguno")+"\nCheck: "+(cp.lastCheck?new Date(cp.lastCheck).toLocaleTimeString("es-ES"):"—"));
            }
            else if(text==="/balance" && botControls.getBalance){
              botControls.getBalance().then(bal=>{
                if(!bal||!bal.length){send("❌ Sin conexión Binance real");return;}
                send("💰 <b>Balance</b>\n"+bal.filter(b=>parseFloat(b.free)>0.001).map(b=>b.asset+": "+parseFloat(b.free).toFixed(4)).join("\n"));
              }).catch(()=>send("❌ Error balance"));
            }
            else if(text==="/ayuda") send(buildHelp(mode));
          }
        } catch(e){}
        setTimeout(poll,1000);
      });
    });
    req.on("error",()=>setTimeout(poll,5000));
    req.setTimeout(25000,()=>{req.destroy();setTimeout(poll,1000);});
  }
  poll();
  console.log("[TG] Comandos: /estado /posiciones /log /pausa /reanudar /momentum /noticias /riesgo /aprendizaje /ayuda");
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
