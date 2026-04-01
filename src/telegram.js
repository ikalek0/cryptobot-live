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
function notifyCircuitBreaker(drawdown) { send(`🎯 ⚡ <b>[LIVE] CIRCUIT BREAKER</b>\nPérdida diaria: <b>${(Math.abs(drawdown)*100).toFixed(2)}%</b>\nBot pausado hasta mañana.`); }
function notifyBigWin(trade)  {
  const fx=1.08;
  const pnlAbs=trade.pnlAbs||0;
  const pnlEur=(pnlAbs/fx).toFixed(2);
  const exitVal=(trade.qty*trade.price).toFixed(2);
  const entryVal=(trade.qty*trade.price/(1+trade.pnl/100)).toFixed(2);
  const coin=(trade.symbol||"").replace("USDC","");
  send(`💰 <b>[LIVE] GANANCIA — ${coin}</b>\n\n`+
    `+${trade.pnl.toFixed(2)}% (+$${pnlAbs.toFixed(2)} / +€${pnlEur})\n`+
    `Entró $${entryVal} → Salió $${exitVal}\n`+
    `Razón: ${trade.reason||"—"} · Estrategia: ${trade.strategy||"—"}\n`+
    `Qty: ${(trade.qty||0).toFixed(5)} ${coin}`);
}
function notifyBigLoss(trade) {
  const fx=1.08;
  const pnlAbs=trade.pnlAbs||0;
  const pnlEur=(pnlAbs/fx).toFixed(2);
  const exitVal=(trade.qty*trade.price).toFixed(2);
  const entryVal=(trade.qty*trade.price/(1+(trade.pnl||0)/100)).toFixed(2);
  const coin=(trade.symbol||"").replace("USDC","");
  send(`📉 <b>[LIVE] PÉRDIDA — ${coin}</b>\n\n`+
    `${trade.pnl.toFixed(2)}% ($${pnlAbs.toFixed(2)} / €${pnlEur})\n`+
    `Entró $${entryVal} → Salió $${exitVal}\n`+
    `Razón: ${trade.reason||"—"} · El bot ha aprendido de esta operación`);
}
function notifyDefensiveMode(btcDrawdown) { send(`🎯 🛡️ <b>[LIVE] MODO DEFENSIVO</b>\nBTC cayó <b>${Math.abs(btcDrawdown)}%</b> desde el máximo de hoy. Sin nuevas posiciones.`); }
function notifyDefensiveOff()  { send(`🎯 ✅ <b>[LIVE] Modo defensivo desactivado</b> — Bot retoma operaciones.`); }
function notifyBlacklist(sym)  { send(`🎯 🚫 <b>[LIVE] ${sym} bloqueado 4h</b> — 4 pérdidas consecutivas.`); }
function notifyOptimizer(r)    { if(!r?.changes?.length)return; send(`🎯 🧠 <b>[LIVE] OPTIMIZADOR</b>\nWR: ${r.winRate}%  avgP&L: ${r.avgPnl}%\nCambios: ${r.changes.join(", ")}`); }
function notifyNightlyReplay(b){ send(`🎯 🌙 <b>[LIVE] REPLAY NOCTURNO</b>\nMejor estrategia: EMA ${b.params.emaFast}/${b.params.emaSlow} · Score ${b.params.minScore}\nWR: ${b.winRate}%  avgP&L: ${b.avgPnl}%`); }
function notifyNewsAlert(news) { send(`🎯 ⚠️ <b>[LIVE] NOTICIA IMPORTANTE</b>\n${news.title}\nPares: ${news.currencies?.join(", ")||"—"}`); }
function notifyFearGreed(val,label) { const e=val<25?"😱":val>75?"🤑":"😐"; send(`${e} <b>Fear & Greed: ${val} — ${label}</b>\n${val<30?"Posible oportunidad de compra":val>75?"Mercado sobrecomprado, precaución":""}`); }
function notifyDailyLimitChange(regime,limit,wr){ send(`🎯 📊 <b>[LIVE] Límite diario actualizado</b>\nRégimen: ${regime} | WR reciente: ${wr||"—"}%\nNuevo límite: <b>${limit} operaciones/día</b>`); }

function testTelegram() {
  if(!TOKEN||!CHAT_ID) {
    console.warn("[TG] ⚠️  TELEGRAM_TOKEN o TELEGRAM_CHAT_ID no configurados — notificaciones desactivadas");
    return;
  }
  send("🎯 [LIVE] Bot arrancado y Telegram conectado ✅");
  console.log("[TG] Test enviado a chat_id:", CHAT_ID.slice(0,4)+"***");
}

function notifyStartup(mode) {
  send(`🎯 <b>🎯 LIVE BOT arrancado</b>\nModo: <b>${mode}</b>\n\n✅ Trailing Stop · Circuit Breaker · Modo Defensivo\n✅ Blacklist · Auto-Optimizer · Horarios óptimos\n✅ Fear & Greed · Alertas noticias · Replay nocturno\n✅ Contrafactual · Score por par · Régimen mercado\n✅ Límite diario dinámico · Comisiones BNB\n✅ PostgreSQL · BAFIR TRADING conectado\n\n/estado /semana /ayuda`);
}

// ── Resúmenes ─────────────────────────────────────────────────────────────────
function buildDaily(state) {
  const tv=state.totalValue||100, ret=state.returnPct||0;
  const fx=state.fxRate||1.08;
  const tvEur=(tv/fx).toFixed(2);
  const today=new Date().toDateString();
  const ts=(state.log||[]).filter(l=>l.type==="SELL"&&l.ts&&new Date(l.ts).toDateString()===today);
  const wins=ts.filter(l=>l.pnl>0).length;
  const fees=ts.reduce((s,l)=>s+(l.fee||0),0);
  const pnlAbsDay=ts.reduce((s,l)=>s+(l.pnlAbs||0),0);
  const pnlEurDay=(pnlAbsDay/fx).toFixed(2);
  const INITIAL=parseFloat(process.env.CAPITAL_USDC||process.env.CAPITAL_USDT||"100");
  const pnlAbsTotal=+(tv-INITIAL).toFixed(2);
  const pnlEurTotal=(pnlAbsTotal/fx).toFixed(2);
  const fg=state.fearGreed||50;
  const fgLabel=fg<15?"😱 PÁNICO EXTREMO":fg<25?"😨 Miedo extremo":fg<40?"😟 Miedo":fg<55?"😐 Neutral":fg<70?"🙂 Codicia":fg<85?"😏 Codicia alta":"🤑 EUFORIA";
  const regimeLabel=state.marketRegime==="BULL"?"📈 Alcista":state.marketRegime==="BEAR"?"📉 Bajista":"➡️ Lateral";
  const bestToday=ts.filter(l=>l.pnl>0).sort((a,b)=>b.pnl-a.pnl)[0];
  const worstToday=ts.filter(l=>l.pnl<0).sort((a,b)=>a.pnl-b.pnl)[0];
  const wr=ts.length?Math.round(wins/ts.length*100):0;
  const openPos=Object.keys(state.portfolio||{}).length;
  return `🎯 ${ret>=0?"📈":"📉"} <b>[LIVE] Resumen del ${new Date().toLocaleDateString("es-ES",{weekday:"long",day:"numeric",month:"long"})}</b>\n\n`+
    `💼 <b>Capital: $${tv.toFixed(2)} / €${tvEur}</b>\n`+
    `${pnlAbsTotal>=0?"📈":"📉"} Desde inicio: ${pnlAbsTotal>=0?"+":""}$${pnlAbsTotal} / ${pnlEurTotal>=0?"+":""}€${pnlEurTotal} (${ret>=0?"+":""}${ret.toFixed(2)}%)\n\n`+
    `<b>HOY:</b>\n`+
    `• ${ts.length} operaciones · ${wins} ganadoras · WR ${wr}%\n`+
    `• P&L: ${pnlAbsDay>=0?"+":""}$${pnlAbsDay.toFixed(2)} / ${pnlEurDay>=0?"+":""}€${pnlEurDay}\n`+
    (bestToday?`• Mejor: ${bestToday.symbol?.replace("USDC","")} +${bestToday.pnl.toFixed(2)}%\n`:"")+
    (worstToday?`• Peor: ${worstToday.symbol?.replace("USDC","")} ${worstToday.pnl.toFixed(2)}%\n`:"")+
    `• Comisiones: $${fees.toFixed(2)}\n`+
    (openPos>0?`• ${openPos} posición(es) abiertas ahora\n`:"")+
    `\n<b>MERCADO:</b>\n`+
    `• ${fgLabel} (${fg}/100)\n`+
    `• ${regimeLabel}\n`+
    `• Long/Short: ${state.longShortRatio?.ratio||"—"} (${state.longShortRatio?.signal||"—"})\n`+
    `• Funding BTC: ${state.fundingRate?.rate||"—"}%`;
}
function buildWeekly(state) {
  const tv=state.totalValue||10000,ret=state.returnPct||0;
  const wa=Date.now()-7*24*60*60*1000;
  const ws=(state.log||[]).filter(l=>l.type==="SELL"&&l.ts&&new Date(l.ts).getTime()>wa);
  const wins=ws.filter(l=>l.pnl>0).length,pnl=ws.reduce((s,l)=>s+(l.pnl||0),0),fees=ws.reduce((s,l)=>s+(l.fee||0),0);
  const wr=ws.length?Math.round(wins/ws.length*100):0;
  const sorted=[...ws].sort((a,b)=>b.pnl-a.pnl),best=sorted[0],worst=sorted[sorted.length-1];
  const topPairs=Object.entries(state.pairScores||{}).sort((a,b)=>b[1].score-a[1].score).slice(0,3).map(([s,p])=>`${s}(${p.score})`).join(", ");
  return `🎯 ${ret>=0?"🏆":"📉"} <b>[LIVE] RESUMEN SEMANAL</b>\n\n`+
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
      "<b>Info:</b>\n/estado /mercado /posiciones /log\n/semana /noticias /momentum /aprendizaje /riesgo\n\n" +
      "<b>Control:</b>\n/pausa — pausar nuevas entradas\n/reanudar — reanudar\n/modo — configuración actual\n" +
      (mode.includes("LIVE") ? "/balance — balance Binance real" : "");
  }

  function buildPositions(state) {
    const entries = Object.entries(state.portfolio||{});
    if (!entries.length) return "📭 <b>[LIVE] Sin posiciones abiertas</b>";
    const fx = state.fxRate||1.08;
    const lines = entries.map(([sym,pos]) => {
      const cp=(state.prices||{})[sym]||pos.entryPrice;
      const pnl=((cp-pos.entryPrice)/pos.entryPrice*100).toFixed(2);
      const pnlAbs=+(pos.qty*(cp-pos.entryPrice)).toFixed(2);
      const pnlEur=+(pnlAbs/fx).toFixed(2);
      const invested=+(pos.qty*pos.entryPrice).toFixed(2);
      const current=+(pos.qty*cp).toFixed(2);
      const coin=sym.replace("USDC","").replace("USDT","");
      const e=pnl>=2?"🟢":pnl>=0?"🟡":pnl>=-2?"🟠":"🔴";
      return e+" <b>"+coin+"</b> "+(pnl>=0?"+":"")+pnl+"%"
        +" ("+(pnlAbs>=0?"+":"")+pnlAbs+"$ / "+(pnlEur>=0?"+":"")+pnlEur+"€)"
        +"\n   Entró $"+invested+" → Ahora $"+current
        +" · "+pos.qty.toFixed(4)+" "+coin
        +"\n   Stop $"+pos.stopLoss+" · "+pos.strategy;
    });
    return "📊 <b>[LIVE] Posiciones abiertas ("+entries.length+")</b>\n\n"+lines.join("\n\n");
  }

  function buildLog10(state) {
    const sells=(state.log||[]).filter(l=>l.type==="SELL").slice(0,10);
    if(!sells.length) return "📭 <b>[LIVE]</b> Sin operaciones aún";
    const fx = state.fxRate||1.08;
    return "📋 <b>[LIVE] Últimas 10 operaciones</b>\n\n"+sells.map(t=>{
      const pnl=t.pnl||0, p=pnl.toFixed(2);
      const e=pnl>=2?"💰":pnl>=0?"✅":"❌";
      const h=t.ts?new Date(t.ts).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"}):"";
      const exitVal=+(t.qty*t.price).toFixed(2);
      const entryVal=pnl!==0?+(exitVal/(1+pnl/100)).toFixed(2):exitVal;
      const pnlAbs=t.pnlAbs!=null?t.pnlAbs:+(exitVal-entryVal).toFixed(2);
      const pnlEur=+(pnlAbs/fx).toFixed(2);
      const coin=(t.symbol||"").replace("USDC","").replace("USDT","");
      return e+" <b>"+coin+"</b> "+(pnl>=0?"+":"")+p+"%"
        +" ("+(pnlAbs>=0?"+":"")+pnlAbs+"$ / "+(pnlEur>=0?"+":"")+pnlEur+"€)"
        +"\n   $"+entryVal+" → $"+exitVal+" · "+t.reason+" "+h;
    }).join("\n\n");
  }

  function buildMercado(state) {
  const fg=state.fearGreed||50;
  const fgLabel=fg<15?"😱 PÁNICO EXTREMO":fg<25?"😨 Miedo extremo":fg<40?"😟 Miedo":fg<55?"😐 Neutral":fg<70?"🙂 Codicia":fg<85?"😏 Codicia alta":"🤑 EUFORIA";
  const regime=state.marketRegime||"LATERAL";
  const regimeExp=regime==="BULL"?"El mercado está en tendencia alcista. El bot opera con posiciones más grandes y deja correr las ganancias.":
    regime==="BEAR"?"El mercado está bajando. El bot es muy selectivo y solo entra en rebotes extremos.":
    "Mercado sin dirección clara. El bot opera con mean reversion: compra mínimos y vende en la banda media.";
  const ls=state.longShortRatio||{ratio:"—",signal:"NEUTRAL"};
  const lsExp=ls.ratio>1.8?"Hay muchos traders apostando al alza (apalancados). Si el precio cae, habrá liquidaciones en cadena.":
    ls.ratio<0.8?"Mayoría apostando a la baja. Posible short squeeze si sube el precio.":
    "Balance razonable entre largos y cortos.";
  const fr=state.fundingRate||{rate:"—",signal:"NEUTRAL"};
  const frExp=parseFloat(fr.rate)>0.05?"Funding positivo alto: los largos pagan a los cortos. Mercado sobrecomprado en futuros.":
    parseFloat(fr.rate)<-0.02?"Funding negativo: cortos pagan a largos. Posible oportunidad de rebote.":
    "Funding neutral.";
  const oi=state.openInterest||{change:0,trend:"STABLE"};
  const oiExp=oi.trend==="GROWING"?"El Open Interest crece: dinero nuevo entrando al mercado. Señal de tendencia fuerte.":
    oi.trend==="DECLINING"?"OI cayendo: posiciones cerrándose, posible fin de tendencia.":
    "Open Interest estable.";
  const reddit=state.redditSentiment||{score:50,signal:"NEUTRAL",postCount:0};
  const rdtExp=reddit.signal==="BULLISH"?"Sentimiento positivo en redes sociales. La comunidad crypto está optimista.":
    reddit.signal==="BEARISH"?"Sentimiento negativo en redes. Miedo generalizado en la comunidad.":
    "Sentimiento neutral en redes sociales.";
  return `🌍 <b>[LIVE] Estado del mercado</b> — ${new Date().toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"})}\n\n`+
    `<b>Fear &amp; Greed: ${fg}/100 — ${fgLabel}</b>\n`+
    `<i>Cuando está por debajo de 20, históricamente es buen momento de compra a largo plazo.</i>\n\n`+
    `<b>Régimen: ${regime}</b>\n<i>${regimeExp}</i>\n\n`+
    `<b>Long/Short ratio: ${ls.ratio}</b>\n<i>${lsExp}</i>\n\n`+
    `<b>Funding rate BTC: ${fr.rate}%</b>\n<i>${frExp}</i>\n\n`+
    `<b>Open Interest: ${oi.change>0?"+":""}${oi.change}% (${oi.trend})</b>\n<i>${oiExp}</i>\n\n`+
    `<b>Reddit sentiment: ${reddit.score}/100 — ${reddit.signal}</b>\n<i>${rdtExp}</i>`;
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
            else if(text==="/walkforward") {
              const wf = state.walkForwardIntra;
              if(!wf) { send("⏳ WF intradía aún no calculado. Espera ~30 min."); }
              else {
                const lines = Object.entries(wf.symbols||{}).slice(0,6).map(([s,r])=>`${r.robust?"✅":"⚠️"} ${s.replace("USDC","")}: train ${r.trainWR}% → test ${r.testWR}% (ratio ${r.ratio})`).join("\n");
                send(`📊 <b>[LIVE] Walk-Forward intradía</b>\n\n${lines}\n\n<b>Global: ${wf.verdict}</b>\nRatio medio: ${wf.avgRatio}\n${wf.robustCount}/${wf.totalSymbols} pares robustos`);
              }
            }
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
module.exports.testTelegram = testTelegram;
module.exports.send = send;
