// ── Estado global compartido — extraído de server.js ──
// Todas las variables mutables que se comparten entre módulos
// viven aquí como propiedades de un objeto singleton.

// F24: fallback chain consistente con engine.js / engine_simple.js.
// Antes: sólo `CAPITAL_USDT || "100"`. Si operator seguía la convención
// moderna (sólo CAPITAL_USDC en .env), S.CAPITAL_USDT caía a 100 aunque
// simpleBot operara con otra cifra. loop.js reconciliación usa S.CAPITAL_USDT
// como threshold (`virtualFree > S.CAPITAL_USDT * 2`) → con mismatch,
// destruía portfolio en caliente. CLAUDE.md:101 y safety.test.js:43
// documentan el orden canónico.
//
// A8: el parse vive ahora en src/config.js (single source of truth). Aquí
// sólo se importa. F24 sigue siendo válido: config.CAPITAL usa exactamente
// la misma fallback chain (CAPITAL_USDC → CAPITAL_USDT → "100").
const { CAPITAL: _capital } = require("../config");

const S = {
  bot: null,
  simpleBot: null,
  tgControls: null,
  syncHistory: [],
  // F25 note: liveReady era parte del startup delay de 1h, abandonado en
  // server.js:82-87 ("operando inmediatamente — el Kelly Gate protege el
  // capital"). Se mantiene true por compat con loop.js:162 (gate check
  // siempre pass-through) pero es vestigial. Phase H puede eliminarlo junto
  // con LIVE_START_DELAY_MS / getLiveStartTime en server.js.
  liveReady: true,
  CAPITAL_USDT: _capital,
  binanceLive: false,
  wasDefensive: false,
  cbNotified: false,
};

module.exports = S;
