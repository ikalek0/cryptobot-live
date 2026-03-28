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

// ── Comando /estado ───────────────────────────────────────────────────────────
let lastUpdateId=0;
function startCommandListener(getState) {
  if(!TOKEN) return;
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
              if(text.startsWith("/estado")) send(buildDaily(getState()));
              if(text.startsWith("/semana")) send(buildWeekly(getState()));
              if(text.startsWith("/ayuda"))  send(`📖 <b>Comandos:</b>\n/estado — resumen ahora\n/semana — resumen semanal\n/ayuda — esta lista`);
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
  console.log("[TG] Escuchando: /estado /semana /ayuda");
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
