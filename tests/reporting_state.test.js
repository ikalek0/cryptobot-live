// ── Reporting state zombie-fix regression tests (abr 2026) ──────────────────
// Guards against the S.bot→S.simpleBot migration leak in the reporting layer.
// Three manifestations of the same defect were found previously (BUG-1 circuit
// breaker, H10-CRITICAL USDC depeg, and the Telegram daily/estado report). The
// common root: capa de reporting lee de S.bot.getState() (engine zombie cuyo
// evaluate() es no-op) en vez de S.simpleBot.getState() (engine real).
//
// Este test simula un S con simpleBot poblado (trades cerrados, pnl negativo,
// equity ≠ 100) y verifica que getReportingState devuelve la verdad del
// simpleBot, NO los defaults congelados del zombie. También comprueba que los
// strings Telegram resultantes (/estado, buildDaily, buildWeekly) reflejen los
// valores reales, no $100.00/+0.00%/Trades:0.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { getReportingState } = require("../src/reporting_state");

// ── Helpers: fake S con bot zombie + simpleBot poblado ──────────────────────

function makeZombieBot() {
  // S.bot zombie: fields como los dejaría engine.js tras boot sin trades.
  // Esto es exactamente el caso que vio el usuario en prod el 20/04/2026.
  return {
    mode: "PAPER",
    getState: () => ({
      // Trading fields congelados (defaults de CryptoBotFinal en boot)
      totalValue: 100,
      returnPct: 0,
      winRate: 0,
      log: [],
      portfolio: {},
      cash: 100,
      equity: [],
      // Context fields que SÍ actualiza S.bot (market data del stream)
      marketRegime: "LATERAL",
      fearGreed: 42,
      prices: { BTCUSDC: 65000, BNBUSDC: 580, SOLUSDC: 180 },
      dailyTrades: { count: 0 },
      dailyLimit: 10,
    }),
  };
}

function makeSimpleBotWithTrades() {
  // simpleBot con 2 trades cerrados en STOP a -0.83% cada uno, una posición
  // abierta, equity real 99.17 (100 * (1 - 2*0.83/100)).
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
    }),
    totalValue: () => 99.17,
  };
}

// ── getReportingState ───────────────────────────────────────────────────────

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
    // Zombie dice totalValue=100, simpleBot dice 99.17 — debe ganar simpleBot
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
    // Estos los actualiza S.bot desde streams/feeds — simpleBot no los duplica
    assert.equal(s.marketRegime, "LATERAL");
    assert.equal(s.fearGreed, 42);
    assert.equal(s.prices.BTCUSDC, 65000);
    assert.equal(s.dailyLimit, 10);
  });

  it("log truncado: se prefiere s.trades (count autoritativo) sobre filter(log)", () => {
    // simpleBot.getState devuelve log.slice(-100). Si ha habido >100 trades, el
    // filter SELL del log truncado undercounta. trades es el count absoluto.
    const S = {
      bot: makeZombieBot(),
      simpleBot: {
        getState: () => ({
          totalValue: 120,
          returnPct: 20,
          winRate: 60,
          capa1Cash: 60, capa2Cash: 40,
          portfolio: {},
          log: new Array(100).fill({ type: "BUY", symbol: "BTCUSDC", ts: Date.now() }), // 100 BUYs, 0 SELLs truncado
          equity: [],
          trades: 250, // total real de SELLs histórico
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
    // Sin simpleBot, caen al zombie — es el comportamiento aceptable en
    // pre-init (antes de que simpleBot se cree en initBot).
    assert.equal(s.totalValue, 100);
    assert.equal(s.marketRegime, "LATERAL");
  });
});

// ── Integration-ish: el mensaje /estado construido con el state mergeado ────

describe("Telegram /estado rendering — zombie regression", () => {
  it("muestra capital/trades reales de simpleBot, NO $100.00/Trades:0", () => {
    const S = { bot: makeZombieBot(), simpleBot: makeSimpleBotWithTrades() };
    const s = getReportingState(S);
    // Replicamos la lógica de telegram.js:/estado para el render
    const tv = s.totalValue||0;
    const ret = s.returnPct||0;
    const wr = s.winRate||0;
    const trades = s.trades ?? (s.log||[]).filter(l=>l.type==="SELL").length;
    const positions = Object.keys(s.portfolio||{}).length;

    const line1 = `Capital: $${tv.toFixed(2)} (${ret>=0?"+":""}${ret.toFixed(2)}%)`;
    const line2 = `Win Rate: ${wr}% | Trades: ${trades}`;
    const line3 = `Posiciones: ${positions}`;

    // Verificamos que el bug reportado por el usuario NO aparece:
    assert.notEqual(line1, "Capital: $100.00 (+0.00%)",
      "No debe mostrar el string zombie que vio el usuario en prod");
    assert.ok(!/Trades: 0$/.test(line2),
      "No debe mostrar Trades: 0 cuando simpleBot tiene 2 SELLs");

    // Y lo que SÍ debe aparecer:
    assert.equal(line1, "Capital: $99.17 (-0.83%)");
    assert.equal(line2, "Win Rate: 0% | Trades: 2");
    assert.equal(line3, "Posiciones: 1");
  });
});

// ── Telegram buildDaily / buildWeekly rendering ─────────────────────────────
// Exigimos que los reportes diario y semanal reflejen el state del simpleBot
// tras el merge. No importamos el módulo telegram directamente (tiene side
// effects de poll al boot); re-implementamos las ramas relevantes de buildDaily
// sobre el state mergeado, igual que haría send(buildDaily(state)).

describe("Telegram buildDaily — zombie regression", () => {
  it("capital+pnl diario reflejan simpleBot, no el zombie congelado", () => {
    const S = { bot: makeZombieBot(), simpleBot: makeSimpleBotWithTrades() };
    const state = getReportingState(S);

    // Copia verbatim de telegram.js:buildDaily (líneas 38-48)
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

// ── Source audit: Telegram no debe leer trading state de S.bot directo ─────
// Meta-test estructural para detectar futuras regresiones. Cualquier PR que
// añada una lectura de S.bot.totalValue/cash/portfolio/log/winRate directamente
// desde dentro de telegram.js o del callback de startCommandListener revive
// el patrón zombie.
describe("reporting layer source-code audit", () => {
  const SRC = path.resolve(__dirname, "..", "src");

  it("telegram.js no importa ./trading/state directamente (debe recibir state via getState)", () => {
    const content = fs.readFileSync(path.join(SRC, "telegram.js"), "utf-8");
    assert.ok(!/require\(["'][^"']*trading\/state["']\)/.test(content),
      "telegram.js no debe importar trading/state — la capa de reporting recibe el state por callback");
  });

  it("server.js wiring del startCommandListener usa getReportingState (no S.bot.getState directo)", () => {
    const content = fs.readFileSync(path.join(SRC, "server.js"), "utf-8");
    // Buscar el bloque que define el getState callback de startCommandListener
    const m = content.match(/tg\.startCommandListener\(\s*\(\s*\)\s*=>\s*\(\{[\s\S]*?\}\)/);
    assert.ok(m, "debe existir el callback getState para startCommandListener");
    assert.ok(/getReportingState\(/.test(m[0]),
      "el callback debe usar getReportingState (zombie-fix). Si lees S.bot.getState() ahí, revives el bug.");
  });

  it("loop.js checkCapitalAlert recibe estado mergeado (no S.bot.getState directo)", () => {
    const content = fs.readFileSync(path.join(SRC, "trading", "loop.js"), "utf-8");
    // Ignorar la definición `function checkCapitalAlert(s) {` — solo chequear
    // invocaciones (llamadas desde el tick loop).
    const callSites = (content.match(/checkCapitalAlert\([^)]+\)/g) || [])
      .filter(c => !/function\s+checkCapitalAlert/.test(c));
    const invocations = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
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
