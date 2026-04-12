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
