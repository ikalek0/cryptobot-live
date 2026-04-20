// ── Reporting state helper — zombie engine fix (abr 2026) ────────────────────
// S.bot.evaluate() es no-op (engine.js:458-463, CLAUDE.md) desde la migración
// a simpleBot. Su cash / totalValue / log / portfolio / winRate NUNCA reflejan
// trades reales — se quedan congelados en los defaults del init.
//
// Cualquier capa de reporting (Telegram, BAFIR, alertas) que lea esos campos
// de S.bot.getState() muestra $100 / Trades:0 aunque simpleBot tenga posiciones
// abiertas y trades cerrados. Este helper fusiona:
//   - contexto de mercado de S.bot (prices, marketRegime, fearGreed, dailyTrades…)
//   - verdad financiera de S.simpleBot (totalValue, returnPct, winRate, log,
//     portfolio, cash, equity, trades count)
//
// Tercera manifestación del mismo defecto estructural (ver BUG-1 circuit
// breaker, H10-CRITICAL USDC depeg). Unificar la fuente evita que el patrón
// reaparezca en futuros endpoints de reporting.
"use strict";

function getReportingState(S) {
  const botState = S?.bot?.getState?.() || {};
  const simple  = S?.simpleBot?.getState?.() || {};
  return {
    ...botState,
    totalValue: simple.totalValue ?? botState.totalValue ?? 0,
    returnPct:  simple.returnPct  ?? botState.returnPct  ?? 0,
    winRate:    simple.winRate    ?? botState.winRate    ?? 0,
    portfolio:  simple.portfolio  ?? {},
    log:        simple.log        ?? [],
    equity:     simple.equity     ?? [],
    cash:       (simple.capa1Cash || 0) + (simple.capa2Cash || 0),
    trades:     simple.trades     ?? 0,
  };
}

module.exports = { getReportingState };
