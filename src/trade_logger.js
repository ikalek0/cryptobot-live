// ── Trade Logger — PostgreSQL structured log ──────────────────────────────
"use strict";

async function ensureTradeLogTable(db) {
  if(!db) return;
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS trade_log (
      id SERIAL PRIMARY KEY,
      bot TEXT NOT NULL,
      symbol TEXT, strategy TEXT, direction TEXT DEFAULT 'long',
      open_ts BIGINT, close_ts BIGINT, duration_min INTEGER,
      entry_price NUMERIC, exit_price NUMERIC,
      pnl_pct NUMERIC, invest_usdc NUMERIC, reason TEXT,
      regime TEXT, adx NUMERIC, rsi_at_entry NUMERIC,
      fear_greed INTEGER, hour_utc INTEGER,
      kelly_rolling NUMERIC, mae_real NUMERIC, mfe_real NUMERIC,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  } catch(e) { console.warn("[TRADE_LOG] ensureTable:", e.message); }
}

async function logTrade(db, e) {
  if(!db) return;
  try {
    const dur = e.openTs&&e.closeTs ? Math.round((e.closeTs-e.openTs)/60000) : null;
    await db.query(`INSERT INTO trade_log
      (bot,symbol,strategy,direction,open_ts,close_ts,duration_min,
       entry_price,exit_price,pnl_pct,invest_usdc,reason,regime,
       adx,rsi_at_entry,fear_greed,hour_utc,kelly_rolling,mae_real,mfe_real)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [e.bot,e.symbol,e.strategy,e.direction||'long',e.openTs,e.closeTs,dur,
       e.entryPrice,e.exitPrice,e.pnlPct,e.investUsdc,e.reason,e.regime,
       e.adx,e.rsiAtEntry,e.fearGreed,e.hourUtc,e.kellyRolling,e.maeReal,e.mfeReal]);
  } catch(e2) { console.warn("[TRADE_LOG] logTrade:", e2.message); }
}

async function getWeeklyStats(db, bot, since) {
  if(!db) return null;
  try {
    const r = await db.query(`
      SELECT strategy, COUNT(*) as trades,
        ROUND(AVG(CASE WHEN pnl_pct>0 THEN 1.0 ELSE 0 END)*100,1) as wr_pct,
        ROUND(AVG(pnl_pct),3) as avg_pnl,
        ROUND(SUM(CASE WHEN pnl_pct>0 THEN pnl_pct ELSE 0 END)/
          NULLIF(ABS(SUM(CASE WHEN pnl_pct<0 THEN pnl_pct ELSE 0 END)),0),2) as pf,
        MAX(pnl_pct) as best, MIN(pnl_pct) as worst,
        ROUND(AVG(duration_min)) as avg_min
      FROM trade_log WHERE bot=$1 AND created_at>=$2
      GROUP BY strategy ORDER BY pf DESC NULLS LAST`,
    [bot, new Date(since).toISOString()]);
    return r.rows;
  } catch(e) { return null; }
}

module.exports = { ensureTradeLogTable, logTrade, getWeeklyStats };
