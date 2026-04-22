-- ═══════════════════════════════════════════════════════════════════════════
-- cryptobot-live · PostgreSQL schema init (22 abr 2026)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Idempotente. CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Safe de re-ejecutar sin perder datos.
--
-- El bot también crea estas tablas automáticamente al boot (bot_state en
-- src/database.js:142 y trade_log en src/trade_logger.js:52), pero
-- aplicarlas aquí permite provisionar la DB antes de arrancar el bot
-- y tener los indexes desde el minuto cero (el bot no crea indexes).
--
-- Ejecutar como:
--   PGPASSWORD=<pass> psql -h localhost -U cryptobot -d cryptobot_live \
--     -f scripts/init-trade-log-schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── bot_state ──────────────────────────────────────────────────────────────
-- Key/value para persistir estado del bot (key='live_main' del zombie S.bot,
-- key='simple_state' del simpleBot con 30+ campos serializados).
CREATE TABLE IF NOT EXISTS bot_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ts    TIMESTAMP DEFAULT NOW()
);

-- ── trade_log ──────────────────────────────────────────────────────────────
-- Log estructurado de SELL closes para analytics post-trade.
-- Schema idéntico al que crea ensureTradeLogTable en src/trade_logger.js:52-67.
-- Gap A6 documentado en trade_logger.js (qty, capa, fee, fee_mode, pnl_usd
-- faltan del spec — decisión NO-OP pre-LIVE).
CREATE TABLE IF NOT EXISTS trade_log (
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
);

-- ── Indexes ────────────────────────────────────────────────────────────────
-- bot_state.key ya es PRIMARY KEY → no necesita index extra.
--
-- trade_log queries del código:
--  · getWeeklyStats (trade_logger.js:85) filtra WHERE bot=$1 AND created_at>=$2,
--    agrupa por strategy → index compuesto (bot, created_at DESC) cubre el
--    WHERE + ORDER y (strategy) cubre el GROUP BY.
--  · Queries ad-hoc forense frecuentes filtran por symbol (par).
CREATE INDEX IF NOT EXISTS idx_trade_log_bot_created
  ON trade_log (bot, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_log_strategy
  ON trade_log (strategy);

CREATE INDEX IF NOT EXISTS idx_trade_log_symbol
  ON trade_log (symbol);
