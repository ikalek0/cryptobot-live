// ── Reporting state helper (BUG A — 20 abr 2026, re-introducido en commit 3) ──
// S.bot.evaluate() es no-op desde la migración a simpleBot (ver CLAUDE.md +
// engine.js). Su cash / totalValue / log / portfolio / winRate NUNCA reflejan
// trades reales — se quedan congelados en los defaults del boot.
//
// Cualquier capa de reporting (Telegram /semana buildDaily/buildWeekly, alertas
// de capitalAlert en loop.js) que lea esos campos de S.bot.getState() muestra
// "$100 / 0 trades" aunque simpleBot tenga posiciones cerradas y totalValue
// real distinto. Este helper fusiona:
//   - contexto de mercado de S.bot (prices, marketRegime, fearGreed, dailyTrades…)
//   - verdad financiera de S.simpleBot (totalValue, returnPct, winRate, log,
//     portfolio, cash, equity, trades count, realizedPnl, totalFees)
//
// Schema de simpleBot contra el que se adapta (f1738633 + commits b7fafbd/26d4886):
//   getState() expone totalValue, returnPct, winRate, portfolio, log, equity,
//   trades, capa1Cash, capa2Cash, y los campos añadidos en BUG B fix:
//   realizedPnl, totalFees.
"use strict";

function getReportingState(S) {
  const botState = S?.bot?.getState?.() || {};
  const simple  = S?.simpleBot?.getState?.() || {};
  return {
    ...botState,
    totalValue:  simple.totalValue  ?? botState.totalValue  ?? 0,
    returnPct:   simple.returnPct   ?? botState.returnPct   ?? 0,
    winRate:     simple.winRate     ?? botState.winRate     ?? 0,
    portfolio:   simple.portfolio   ?? {},
    log:         simple.log         ?? [],
    equity:      simple.equity      ?? [],
    cash:        (simple.capa1Cash || 0) + (simple.capa2Cash || 0),
    trades:      simple.trades      ?? 0,
    // BUG B campos persistidos añadidos en commit b7fafbd — explícitos en
    // el reporting para que Telegram /semana y buildDaily puedan mostrar
    // PnL acumulado real y fees reales en vez de 0 silencioso.
    realizedPnl: Number.isFinite(simple.realizedPnl) ? simple.realizedPnl : 0,
    totalFees:   Number.isFinite(simple.totalFees)   ? simple.totalFees   : 0,
  };
}

module.exports = { getReportingState };
