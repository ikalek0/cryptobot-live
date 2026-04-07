// ── Weekly Report — Telegram cada domingo 00:00 UTC ───────────────────────
"use strict";
const { getWeeklyStats } = require("./trade_logger");

function scheduleWeeklyReport(tg, db, bot, extraFn) {
  function msToNextSunday() {
    const now = new Date();
    const day = now.getUTCDay(); // 0=Sun
    const daysUntil = day === 0 ? 7 : 7 - day;
    const nextSun = new Date(now);
    nextSun.setUTCDate(now.getUTCDate() + daysUntil);
    nextSun.setUTCHours(0, 0, 0, 0);
    return nextSun - now;
  }

  async function sendReport() {
    try {
      const since = Date.now() - 7*24*3600*1000;
      const stats = await getWeeklyStats(db, bot, since);
      const extra = extraFn ? await extraFn() : null;

      if(!stats?.length && !extra) {
        tg.send && tg.send(`📊 <b>[${bot.toUpperCase()}] Informe semanal</b>\nSin operaciones esta semana.`);
        return;
      }

      let msg = `📊 <b>[${bot.toUpperCase()}] Informe semanal</b>\n`;
      msg += `<i>${new Date().toISOString().slice(0,10)}</i>\n\n`;

      if(stats?.length) {
        msg += `<b>Por estrategia:</b>\n`;
        for(const s of stats) {
          const icon = s.pf >= 1.2 ? "✅" : s.pf >= 1.0 ? "⚠️" : "❌";
          msg += `${icon} <b>${s.strategy||"General"}</b>\n`;
          msg += `   Trades: ${s.trades} | WR: ${s.wr_pct}% | PF: ${s.pf||"—"}\n`;
          msg += `   Mejor: +${parseFloat(s.best||0).toFixed(2)}% | Peor: ${parseFloat(s.worst||0).toFixed(2)}%\n`;
          if(s.avg_min) msg += `   Duración media: ${Math.round(s.avg_min/60)}h\n`;
        }
      }

      if(extra) msg += `\n${extra}`;

      tg.send && tg.send(msg);
      console.log(`[WEEKLY] Informe enviado para ${bot}`);
    } catch(e) {
      console.warn("[WEEKLY] Error:", e.message);
    }
    // Schedule next week
    setTimeout(sendReport, msToNextSunday());
  }

  // Schedule first report
  const ms = msToNextSunday();
  console.log(`[WEEKLY] Próximo informe en ${Math.round(ms/3600000)}h (domingo 00:00 UTC)`);
  setTimeout(sendReport, ms);
}

// ── Trade analysis reminder (Opus 4: revisar perdedores cada 3-4 días) ────
function scheduleTradeAnalysisReminder(tg, db, bot) {
  async function sendReminder() {
    try {
      const since = Date.now() - 4*24*3600*1000;
      const { getWeeklyStats } = require("./trade_logger");
      const stats = await getWeeklyStats(db, bot, since);
      if(!stats?.length) return;

      const totalTrades = stats.reduce((s,r)=>s+(+r.trades||0),0);
      const losers = stats.reduce((s,r)=>{
        const t=+r.trades||0, wr=+r.wr_pct||0;
        return s+Math.round(t*(1-wr/100));
      },0);

      if(losers < 3) return; // not enough to analyze

      let msg = `🔍 <b>[${bot.toUpperCase()}] Análisis de perdedores</b>
`;
      msg += `Últimos 4 días: ${totalTrades} trades, ~${losers} perdedores

`;
      msg += `<b>Preguntas clave:</b>
`;
      msg += `• ¿Pierden siempre a la misma hora UTC?
`;
      msg += `• ¿Pierden siempre en el mismo par?
`;
      msg += `• ¿Pierden con F&G en algún rango específico?
`;
      msg += `• ¿Hay algún régimen (BULL/BEAR/LATERAL) donde pierden más?

`;
      msg += `<i>Revisa el log en PostgreSQL:
`;
      msg += `SELECT * FROM trade_log WHERE bot='${bot}' AND pnl_pct<0 ORDER BY created_at DESC LIMIT 20;</i>`;

      tg.send && tg.send(msg);
    } catch(e) { console.warn("[REMINDER]", e.message); }

    // Repeat every 3.5 days
    setTimeout(sendReminder, 3.5*24*3600*1000);
  }

  // First reminder after 3.5 days
  setTimeout(sendReminder, 3.5*24*3600*1000);
  console.log("[REMINDER] Recordatorio análisis perdedores programado cada 3.5 días");
}

module.exports = { scheduleWeeklyReport, scheduleTradeAnalysisReminder };
