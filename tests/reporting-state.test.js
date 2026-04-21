// ── Reporting state zombie-fix regression tests (BUG A, 20 abr 2026) ───────
// Guards contra el patrón S.bot→S.simpleBot leak en la capa de reporting de
// Telegram /semana buildDaily/buildWeekly + loop.js checkCapitalAlert. Defecto
// estructural detectado en la sesión del 20 abril: la capa de reporting leía
// de S.bot.getState() (engine zombie cuyo evaluate() es no-op) en vez de
// S.simpleBot.getState() (engine real).
//
// 12 asserts: 11 originales de la primera iteración (commit a526ecf del branch
// abandonado, re-aplicados sobre el schema de prod f1738633) + 1 nuevo que
// verifica que realizedPnl y totalFees de simpleBot (campos persistidos en
// BUG B fix) ganan sobre los del zombie.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { getReportingState } = require("../src/reporting_state");

// ── Helpers: fake S con bot zombie + simpleBot poblado ─────────────────────

function makeZombieBot() {
  return {
    mode: "PAPER",
    getState: () => ({
      totalValue: 100,
      returnPct: 0,
      winRate: 0,
      log: [],
      portfolio: {},
      cash: 100,
      equity: [],
      marketRegime: "LATERAL",
      fearGreed: 42,
      prices: { BTCUSDC: 65000, BNBUSDC: 580, SOLUSDC: 180 },
      dailyTrades: { count: 0 },
      dailyLimit: 10,
    }),
  };
}

function makeSimpleBotWithTrades() {
  return {
    getState: () => ({
      totalValue: 99.17,
      returnPct: -0.83,
      winRate: 0,
      capa1Cash: 49.50,
      capa2Cash: 40.00,
      portfolio: {
        BNB_1h_RSI: {
          pair: "BNBUSDC", capa: 1, type: "RSI_MR_ADX",
          entryPrice: 580, qty: 0.017, invest: 10,
          openTs: Date.now() - 3600000, status: "filled",
        },
      },
      log: [
        { type: "BUY",  symbol: "BTCUSDC", strategy: "BTC_30m_RSI", price: 65000, invest: 16, ts: Date.now()-7200000 },
        { type: "SELL", symbol: "BTCUSDC", strategy: "BTC_30m_RSI", pnl: -0.83, reason: "STOP", ts: Date.now()-3700000 },
        { type: "BUY",  symbol: "SOLUSDC", strategy: "SOL_1h_EMA", price: 180, invest: 10, ts: Date.now()-1800000 },
        { type: "SELL", symbol: "SOLUSDC", strategy: "SOL_1h_EMA", pnl: -0.83, reason: "STOP", ts: Date.now()-600000 },
      ],
      equity: [{ v: 100, t: Date.now()-7200000 }, { v: 99.17, t: Date.now() }],
      trades: 2,
      tick: 123,
      mode: "SIMPLE_v3_7strategies",
      realizedPnl: -0.32,
      totalFees: 0.032,
    }),
    totalValue: () => 99.17,
  };
}

// ── getReportingState ──────────────────────────────────────────────────────

describe("getReportingState — zombie→simpleBot merge", () => {
  it("devuelve defaults seguros si S está vacío", () => {
    const s = getReportingState({});
    assert.equal(s.totalValue, 0);
    assert.equal(s.returnPct, 0);
    assert.equal(s.winRate, 0);
    assert.deepEqual(s.portfolio, {});
    assert.deepEqual(s.log, []);
    assert.equal(s.trades, 0);
    assert.equal(s.cash, 0);
  });

  it("financial fields vienen de simpleBot, NO del zombie", () => {
    const S = { bot: makeZombieBot(), simpleBot: makeSimpleBotWithTrades() };
    const s = getReportingState(S);
    assert.equal(s.totalValue, 99.17, "totalValue debe venir de simpleBot (99.17), no del zombie (100)");
    assert.equal(s.returnPct, -0.83, "returnPct debe venir de simpleBot (-0.83%), no del zombie (0%)");
    assert.equal(s.trades, 2, "trades debe ser 2 (simpleBot), no 0 (zombie log vacío)");
    assert.ok(s.portfolio.BNB_1h_RSI, "portfolio debe tener la posición de simpleBot, no estar vacío");
    assert.equal(s.log.length, 4, "log debe tener las 4 entries de simpleBot, no el log vacío del zombie");
    assert.equal(s.cash, 89.5, "cash = capa1Cash + capa2Cash (49.5 + 40), no el cash zombie");
  });

  it("context fields (market regime, F&G, prices) vienen del zombie", () => {
    const S = { bot: makeZombieBot(), simpleBot: makeSimpleBotWithTrades() };
    const s = getReportingState(S);
    assert.equal(s.marketRegime, "LATERAL");
    assert.equal(s.fearGreed, 42);
    assert.equal(s.prices.BTCUSDC, 65000);
    assert.equal(s.dailyLimit, 10);
  });

  it("log truncado: se prefiere s.trades (count autoritativo) sobre filter(log)", () => {
    const S = {
      bot: makeZombieBot(),
      simpleBot: {
        getState: () => ({
          totalValue: 120, returnPct: 20, winRate: 60,
          capa1Cash: 60, capa2Cash: 40,
          portfolio: {},
          log: new Array(100).fill({ type: "BUY", symbol: "BTCUSDC", ts: Date.now() }),
          equity: [],
          trades: 250,
          realizedPnl: 20,
          totalFees: 1.5,
        }),
      },
    };
    const s = getReportingState(S);
    assert.equal(s.trades, 250, "trades debe venir de simpleBot.trades (250), no del filter del log truncado (0)");
  });

  it("bot ausente no rompe: solo simpleBot basta", () => {
    const S = { simpleBot: makeSimpleBotWithTrades() };
    const s = getReportingState(S);
    assert.equal(s.totalValue, 99.17);
    assert.equal(s.trades, 2);
  });

  it("simpleBot ausente no rompe: solo bot basta (pre-init state)", () => {
    const S = { bot: makeZombieBot() };
    const s = getReportingState(S);
    assert.equal(s.totalValue, 100);
    assert.equal(s.marketRegime, "LATERAL");
  });

  // ── NUEVO #12 (commit 3): realizedPnl y totalFees también ganan simpleBot ─
  it("realizedPnl y totalFees de simpleBot ganan sobre los del zombie", () => {
    const S = { bot: makeZombieBot(), simpleBot: makeSimpleBotWithTrades() };
    const s = getReportingState(S);
    // Zombie no persiste realizedPnl ni totalFees (no existen en ese esquema),
    // simpleBot sí. El merge debe exponerlos explícitamente para que
    // buildDaily / buildWeekly / /estado puedan mostrar PnL y fees reales.
    assert.equal(s.realizedPnl, -0.32, "realizedPnl debe venir de simpleBot (-0.32)");
    assert.equal(s.totalFees, 0.032, "totalFees debe venir de simpleBot (0.032)");
  });
});

// ── /estado rendering — zombie regression ──────────────────────────────────

describe("Telegram /estado rendering — zombie regression", () => {
  it("muestra capital/trades reales de simpleBot, NO $100.00/Trades:0", () => {
    const S = { bot: makeZombieBot(), simpleBot: makeSimpleBotWithTrades() };
    const s = getReportingState(S);
    const tv = s.totalValue||0;
    const ret = s.returnPct||0;
    const wr = s.winRate||0;
    const trades = s.trades ?? (s.log||[]).filter(l=>l.type==="SELL").length;
    const positions = Object.keys(s.portfolio||{}).length;

    const line1 = `Capital: $${tv.toFixed(2)} (${ret>=0?"+":""}${ret.toFixed(2)}%)`;
    const line2 = `Win Rate: ${wr}% | Trades: ${trades}`;
    const line3 = `Posiciones: ${positions}`;

    assert.notEqual(line1, "Capital: $100.00 (+0.00%)",
      "No debe mostrar el string zombie que vio el usuario en prod");
    assert.ok(!/Trades: 0$/.test(line2),
      "No debe mostrar Trades: 0 cuando simpleBot tiene 2 SELLs");

    assert.equal(line1, "Capital: $99.17 (-0.83%)");
    assert.equal(line2, "Win Rate: 0% | Trades: 2");
    assert.equal(line3, "Posiciones: 1");
  });
});

// ── buildDaily rendering — zombie regression ──────────────────────────────

describe("Telegram buildDaily — zombie regression", () => {
  it("capital+pnl diario reflejan simpleBot, no el zombie congelado", () => {
    const S = { bot: makeZombieBot(), simpleBot: makeSimpleBotWithTrades() };
    const state = getReportingState(S);

    // Copia verbatim de telegram.js:buildDaily
    const tv = state.totalValue ?? 0, ret = state.returnPct ?? 0;
    const today = new Date().toDateString();
    const ts = (state.log||[]).filter(l=>l.type==="SELL"&&l.ts&&new Date(l.ts).toDateString()===today);
    const wins = ts.filter(l=>l.pnl>0).length;
    const pnl = ts.reduce((s,l)=>s+(l.pnl||0),0);

    assert.equal(tv, 99.17);
    assert.equal(ret, -0.83);
    assert.equal(ts.length, 2, "debe contar los 2 SELLs de simpleBot (BTCUSDC + SOLUSDC)");
    assert.equal(wins, 0);
    assert.ok(Math.abs(pnl - (-1.66)) < 0.001, `P&L diario = -1.66% (2 × -0.83%), got ${pnl}`);
  });
});

// ── Source audit: ninguna capa de reporting debe leer S.bot directo ───────

describe("reporting layer source-code audit", () => {
  const SRC = path.resolve(__dirname, "..", "src");

  it("telegram.js no importa ./trading/state directamente", () => {
    const content = fs.readFileSync(path.join(SRC, "telegram.js"), "utf-8");
    assert.ok(!/require\(["'][^"']*trading\/state["']\)/.test(content),
      "telegram.js no debe importar trading/state — la capa de reporting recibe el state por callback");
  });

  it("server.js wiring del startCommandListener usa getReportingState", () => {
    const content = fs.readFileSync(path.join(SRC, "server.js"), "utf-8");
    const m = content.match(/tg\.startCommandListener\(\s*(?:\/\/[^\n]*\n\s*)*\(\s*\)\s*=>\s*\(\{[\s\S]*?\}\)/);
    assert.ok(m, "debe existir el callback getState para startCommandListener");
    assert.ok(/getReportingState\(/.test(m[0]),
      "el callback debe usar getReportingState (zombie-fix). Si lees S.bot.getState() ahí, revives el bug.");
  });

  it("loop.js checkCapitalAlert recibe estado mergeado", () => {
    const content = fs.readFileSync(path.join(SRC, "trading", "loop.js"), "utf-8");
    const lines = content.split("\n");
    const invocations = [];
    for (const l of lines) {
      if (/checkCapitalAlert\(/.test(l) && !/function\s+checkCapitalAlert/.test(l)) {
        invocations.push(l.trim());
      }
    }
    assert.ok(invocations.length > 0, "debe existir al menos una invocación de checkCapitalAlert");
    for (const call of invocations) {
      assert.ok(/getReportingState\(/.test(call),
        `checkCapitalAlert debe recibir getReportingState(S), pero encontré: ${call}`);
    }
  });
});
