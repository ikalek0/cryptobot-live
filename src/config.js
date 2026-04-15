"use strict";
// ── A8: Single source of truth para variables de entorno críticas ─────────
// Antes: engine_simple.js:22 y trading/state.js:12 leían CAPITAL_USDC/USDT del
// env independientemente, con la misma cadena literal duplicada. Si uno se
// refactorizaba sin el otro, S.CAPITAL_USDT y INITIAL_CAPITAL podían diverger
// con la lectura del env en momentos distintos del import.
//
// Ahora: toda la configuración crítica vive aquí. Se lee una vez al import y
// se freeza el objeto para prevenir mutación accidental. Los tests que
// manipulan process.env antes del require siguen funcionando porque delete
// require.cache desencadena una relectura del env en la siguiente carga.
//
// Campos dinámicos (los que cambian en runtime tipo S.CAPITAL_USDT via
// /api/set-capital) NO se exponen aquí — quedan en los módulos que los
// mutan. Este config.js es solo para VALORES DE ARRANQUE derivados del env.
require("dotenv").config();

const CAPITAL = parseFloat(
  process.env.CAPITAL_USDC || process.env.CAPITAL_USDT || "100"
);

module.exports = Object.freeze({
  CAPITAL,
  LIVE_MODE: process.env.LIVE_MODE === "true",
  TICK_MS: parseInt(process.env.TICK_MS || "10000", 10),
  PORT: parseInt(process.env.PORT || "3001", 10),
  BINANCE_API_KEY: process.env.BINANCE_API_KEY || "",
  BINANCE_API_SECRET: process.env.BINANCE_API_SECRET || "",
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  BOT_SECRET: process.env.BOT_SECRET || "",
  SYNC_SECRET: process.env.SYNC_SECRET || "",
  BAFIR_SECRET: process.env.BAFIR_SECRET || "",
  FX_RATE: parseFloat(process.env.FX_RATE || "1"),
  DATABASE_URL: process.env.DATABASE_URL || "",
});
