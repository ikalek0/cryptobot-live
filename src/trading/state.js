// ── Estado global compartido — extraído de server.js ──
// Todas las variables mutables que se comparten entre módulos
// viven aquí como propiedades de un objeto singleton.

const S = {
  bot: null,
  simpleBot: null,
  tgControls: null,
  syncHistory: [],
  liveReady: true,
  CAPITAL_USDT: parseFloat(process.env.CAPITAL_USDT || "100"),
  binanceLive: false,
  wasDefensive: false,
  cbNotified: false,
};

module.exports = S;
