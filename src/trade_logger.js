// ── Trade Logger — PostgreSQL structured log ──────────────────────────────
//
// A6 — Schema audit (Opus Group-A): la tabla `trade_log` existe ya con 20
// columnas de datos (más id PRIMARY KEY y created_at timestamp, = 22 en
// total). El schema cubre la mayoría de dimensiones que el journal quiere
// analizar post-trade, pero hay gap semántico con respecto a la lista
// exacta del Group-A spec:
//
//   Spec A6 (20 campos):   strategy, regime, ADX, RSI, F&G, UTC hour,
//                          Kelly, MAE, MFE, entryPrice, exitPrice, qty,
//                          capa, duration, fee, feeMode, pnlPct, pnlUsd,
//                          reason, timestamp
//   Actual (20 campos):    bot, symbol, strategy, direction, open_ts,
//                          close_ts, duration_min, entry_price, exit_price,
//                          pnl_pct, invest_usdc, reason, regime, adx,
//                          rsi_at_entry, fear_greed, hour_utc, kelly_rolling,
//                          mae_real, mfe_real
//
//   Overlap (15):  strategy, regime, adx, rsi_at_entry, fear_greed,
//                  hour_utc, kelly_rolling, mae_real, mfe_real,
//                  entry_price, exit_price, duration_min, pnl_pct,
//                  reason, open_ts/close_ts (timestamp equivalente)
//   Extras actuales (no en spec): bot, symbol, direction, invest_usdc
//   Faltan del spec (5):
//     - qty        (cantidad del asset — derivable de invest_usdc/entry_price
//                   pero no explícito)
//     - capa       (1 o 2 — crítico para analytics por capa, actualmente se
//                   pierde tras close)
//     - fee        (USDC pagado de fee — bruto)
//     - fee_mode   ("BNB" vs "USDC" — necesario para reconciliar modo)
//     - pnl_usd    (USDC absoluto — derivable de pnl_pct*invest_usdc pero
//                   muy útil tenerlo pre-calculado para reports)
//
// DECISIÓN A6 (Group-A): NO-OP. Las 5 columnas adicionales son útiles pero
// no críticas pre-LIVE. Añadirlas ahora implica:
//   1) ALTER TABLE trade_log ADD COLUMN qty NUMERIC, capa INTEGER, fee
//      NUMERIC, fee_mode TEXT, pnl_usd NUMERIC
//   2) Ampliar signature de logTrade() para recibir los 5 campos
//   3) Plumbing desde engine_simple.js:_evaluate — capa se pierde tras
//      delete this.portfolio[id], hay que capturarlo antes del logTrade;
//      fee y feeMode vienen del _feePredicted y pueden ser stale si el
//      fill tuvo discrepancia
//   4) Backfill opcional: NULL para trades históricos
//
// RECOMENDACIÓN: aplicar esta migración DESPUÉS de la primera semana
// operando en LIVE_MODE=true con datos reales. Así sabemos qué análisis
// emerge de la primera batch de trades antes de comprometer el schema.
// Un ALTER TABLE ADD COLUMN IF NOT EXISTS es cheap, lo difícil es
// decidir qué se quiere analizar. El gap no bloquea el deploy.
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
