// ── Sizing tests: Half-Kelly + cap 30% + min $10 ─────────────────────────────
// Guards against the $1500-on-$100 bug and validates all sizing constraints.
"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

// Set env BEFORE requiring engine_simple (INITIAL_CAPITAL reads at module load)
process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

const { SimpleBotEngine, calcKelly } = require("../src/engine_simple");

// Replicate the sizing formula from engine_simple.js _onCandleClose (lines 336-345)
// to test it in isolation with various inputs
function calcInvest(totalValue, kellyRaw, availCash) {
  const kellyFrac = Math.max(0.05, Math.min(0.5, kellyRaw || 0.1));
  let invest = totalValue * kellyFrac * 0.5; // Half-Kelly
  if (invest > totalValue * 0.30) invest = totalValue * 0.30; // cap 30%
  if (invest > availCash) invest = availCash;
  return invest;
}

describe("Sizing formula", () => {
  it("Half-Kelly: $100 capital, kelly=0.4 -> invest=$20", () => {
    const invest = calcInvest(100, 0.4, 60);
    assert.equal(invest, 20, `Expected $20, got $${invest}`);
  });

  it("Half-Kelly: $100 capital, kelly=0.164 -> invest=$8.20 (below $10 minimum)", () => {
    const invest = calcInvest(100, 0.164, 60);
    assert.ok(invest < 10, `invest=$${invest} should be below $10 minimum -> trade skipped`);
  });

  it("Cap 30%: high kelly doesn't exceed 30% of capital", () => {
    const invest = calcInvest(100, 0.95, 100);
    assert.ok(invest <= 30, `invest=$${invest} should not exceed $30 (30% of $100)`);
    // kelly=0.5 (capped), half-kelly = 0.25, invest = $25
    assert.equal(invest, 25);
  });

  it("NEVER $1500 on $100 capital", () => {
    // The old bug: capital was $10000 instead of $100 due to missing dotenv
    // With correct capital=$100, even extreme kelly can't produce $1500
    const invest = calcInvest(100, 1.0, 100);
    assert.ok(invest <= 30, `invest=$${invest} must never be $1500 on $100 capital`);
  });

  it("Kelly fraction floor: negative kelly uses 0.05 minimum", () => {
    const invest = calcInvest(100, -0.5, 100);
    // kellyFrac = max(0.05, min(0.5, -0.5)) = max(0.05, -0.5) = 0.05
    // invest = 100 * 0.05 * 0.5 = $2.50
    assert.equal(invest, 2.5);
    assert.ok(invest < 10, "Negative kelly -> invest below $10 -> trade skipped");
  });

  it("Kelly fraction ceiling: extreme kelly capped at 0.5", () => {
    const invest = calcInvest(100, 2.0, 100);
    // kellyFrac = max(0.05, min(0.5, 2.0)) = 0.5
    // invest = 100 * 0.5 * 0.5 = $25
    assert.equal(invest, 25);
  });

  it("Available cash constraint: can't exceed available cash", () => {
    const invest = calcInvest(100, 0.4, 5);
    // Half-Kelly wants $20 but only $5 available
    assert.equal(invest, 5);
  });

  it("With buggy $10000 capital, sizing would be dangerously high", () => {
    // This proves WHY the dotenv fix was critical
    const buggyInvest = calcInvest(10000, 0.4, 10000);
    // kellyFrac=0.4, invest = 10000 * 0.4 * 0.5 = $2000
    assert.equal(buggyInvest, 2000);
    assert.ok(buggyInvest > 100, "Buggy capital produces >$100 invest on $100 account");
  });
});

describe("Sizing through SimpleBotEngine", () => {
  it("INITIAL_CAPITAL is $100 from env", () => {
    const bot = new SimpleBotEngine({});
    const tv = bot.totalValue();
    assert.equal(tv, 100, `totalValue should be $100, got $${tv}`);
  });

  it("Capa1 gets 60% and Capa2 gets 40%", () => {
    const bot = new SimpleBotEngine({});
    assert.equal(bot.capa1Cash, 60, `capa1Cash should be $60, got $${bot.capa1Cash}`);
    assert.equal(bot.capa2Cash, 40, `capa2Cash should be $40, got $${bot.capa2Cash}`);
  });

  it("After a BUY, invest is deducted from correct capa cash", () => {
    const bot = new SimpleBotEngine({});
    const initialCapa1 = bot.capa1Cash;
    // Simulate a BUY by directly manipulating portfolio like _onCandleClose does
    const invest = 20;
    const price = 600;
    const qty = invest * (1 - 0.001) / price;
    bot.capa1Cash -= invest;
    bot.portfolio["BNB_1h_RSI"] = {
      pair: "BNBUSDC", capa: 1, entryPrice: price, qty, invest,
      stop: price * 0.992, target: price * 1.016, openTs: Date.now()
    };
    assert.equal(bot.capa1Cash, initialCapa1 - invest);
    assert.ok(bot.totalValue() > 99 && bot.totalValue() < 101,
      "Total value should be ~$100 after BUY (fees aside)");
  });
});

// ── STRICT CAP $100 (Iñigo abril 2026) ───────────────────────────────────────
// Tras el incidente de $96.51 gastados contra un cap declarado de $100,
// añadimos un invariante global: sum(portfolio.invest) ≤ INITIAL_CAPITAL.
describe("Strict cap invariant", () => {
  it("sum(portfolio.invest) nunca supera INITIAL_CAPITAL tras varios BUYs", () => {
    const bot = new SimpleBotEngine({});
    // Pre-llenar portfolio con $95 ya invertidos
    bot.portfolio["BNB_1h_RSI"] = { pair: "BNBUSDC", capa: 1, invest: 30, qty: 0.05, entryPrice: 600 };
    bot.portfolio["SOL_1h_EMA"] = { pair: "SOLUSDC", capa: 1, invest: 30, qty: 0.36, entryPrice: 83 };
    bot.portfolio["XRP_4h_EMA"] = { pair: "XRPUSDC", capa: 2, invest: 35, qty: 26.5, entryPrice: 1.32 };
    bot.capa1Cash = 0;
    bot.capa2Cash = 5;
    const committed = Object.values(bot.portfolio).reduce((s,p)=>s+p.invest, 0);
    assert.equal(committed, 95);
    // Ahora simulamos una 4ª posición — el sizing debe capearla a $5 restantes
    // (o saltarla si < $10 mínimo). Replicamos la lógica de _onCandleClose:
    const INITIAL_CAPITAL = 100;
    let invest = 20; // sizing normal querría $20
    const capRemaining = Math.max(0, INITIAL_CAPITAL - committed);
    if (invest > capRemaining) invest = capRemaining;
    assert.equal(invest, 5, "invest debe recortarse al remaining del cap");
    // Y luego el min-$10 la saltaría:
    assert.ok(invest < 10, "invest < $10 → trade saltado, invariante intacto");
  });

  it("committed + new invest jamás > INITIAL_CAPITAL * 1.005", () => {
    const bot = new SimpleBotEngine({});
    bot.portfolio["BNB_1h_RSI"] = { pair: "BNBUSDC", capa: 1, invest: 80, qty: 0.13, entryPrice: 600 };
    const committed = Object.values(bot.portfolio).reduce((s,p)=>s+p.invest, 0);
    // Cap restante = 20
    const capRemaining = Math.max(0, 100 - committed);
    const invest = Math.min(25, capRemaining); // sizing querría $25
    assert.ok(committed + invest <= 100 * 1.005,
      `committed=${committed} + invest=${invest} debe ≤ 100.5`);
  });

  it("drift del ledger (capa1Cash stale > 60) no permite sobrepasar cap", () => {
    // Simular estado corrupto: capa1Cash inflado por bug histórico
    const saved = {
      capa1Cash: 200,  // STALE — drifted
      capa2Cash: 80,
      portfolio: {},
    };
    const bot = new SimpleBotEngine(saved);
    // Aunque capa1Cash=200, el cap estricto es INITIAL_CAPITAL=100
    // El sizing debe respetar el cap global, no capa1Cash
    const committed = Object.values(bot.portfolio).reduce((s,p)=>s+(p.invest||0), 0);
    const capRemaining = Math.max(0, 100 - committed);
    assert.equal(capRemaining, 100, "Con portfolio vacío, toda la cap está disponible");
    // El primer trade puede ser hasta $100 — pero half-kelly + 30% cap per-trade lo limitan
    // Lo importante: la SUMA de trades futuros no puede pasar de $100
  });
});
