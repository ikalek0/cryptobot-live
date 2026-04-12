// ── Kelly Gate tests: calcKelly blocking/allowing correctly ───────────────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.CAPITAL_USDC = "100";

const { calcKelly, SimpleBotEngine } = require("../src/engine_simple");

// Helper: generate N trades with given win rate
function makeTrades(n, winRate, winPnl = 1.6, lossPnl = -0.8) {
  const wins = Math.round(n * winRate);
  const trades = [];
  for (let i = 0; i < n; i++) {
    trades.push({ pnl: i < wins ? winPnl : lossPnl, ts: Date.now() - (n - i) * 1000 });
  }
  return trades;
}

describe("calcKelly", () => {
  it("returns kelly=-1 with fewer than 20 trades (insufficient data)", () => {
    const result = calcKelly(makeTrades(10, 0.6));
    assert.equal(result.kelly, -1);
    assert.equal(result.negative, true);
    assert.equal(result.wr, null);
    assert.equal(result.n, 10);
  });

  it("returns kelly=-1 with 19 trades (edge case)", () => {
    const result = calcKelly(makeTrades(19, 0.6));
    assert.equal(result.kelly, -1);
    assert.equal(result.n, 19);
  });

  it("positive kelly with 58% WR (BNB_1h_RSI backtest WR)", () => {
    const result = calcKelly(makeTrades(20, 0.58));
    assert.ok(result.kelly > 0, `kelly=${result.kelly} should be positive`);
    assert.equal(result.negative, false);
    assert.ok(result.wr >= 55 && result.wr <= 65, `WR=${result.wr} should be ~60%`);
  });

  it("negative kelly with 30% WR -> gate blocks", () => {
    const result = calcKelly(makeTrades(20, 0.30));
    assert.ok(result.kelly < 0, `kelly=${result.kelly} should be negative`);
    assert.equal(result.negative, true);
  });

  it("uses rolling window of 30 trades", () => {
    // 50 trades total, calcKelly uses .slice(-30) -> last 30
    const trades = [
      ...makeTrades(20, 0.90), // first 20: great (ignored if >30 total)
      ...makeTrades(30, 0.25), // last 30: terrible
    ];
    const result = calcKelly(trades, 30);
    assert.ok(result.kelly < 0, "Last 30 trades are bad -> negative kelly");
    assert.equal(result.n, 30, "Window should use 30 trades");
  });

  it("50% WR with R=2 (win=2x loss) -> positive kelly", () => {
    // W=0.5, R=2 -> kelly = 0.5 - (0.5)/2 = 0.25
    const result = calcKelly(makeTrades(20, 0.50, 1.6, -0.8));
    assert.ok(result.kelly > 0, `kelly=${result.kelly} should be positive with R=2`);
  });

  it("50% WR with R=1 (win=loss) -> kelly=0", () => {
    // W=0.5, R=1 -> kelly = 0.5 - 0.5/1 = 0
    const result = calcKelly(makeTrades(20, 0.50, 1.0, -1.0));
    assert.equal(result.kelly, 0, "50% WR with R=1 should give kelly=0");
  });

  it("100% WR -> high positive kelly", () => {
    const result = calcKelly(makeTrades(20, 1.0));
    assert.ok(result.kelly > 0.5, `kelly=${result.kelly} should be very positive`);
    assert.equal(result.wr, 100);
  });

  it("0% WR -> negative kelly", () => {
    const result = calcKelly(makeTrades(20, 0.0));
    assert.ok(result.kelly < 0, `kelly=${result.kelly} should be negative`);
    assert.equal(result.wr, 0);
  });
});

describe("Kelly Gate integration in SimpleBotEngine", () => {
  it("seeds backtested trades for all 7 strategies", () => {
    const bot = new SimpleBotEngine({});
    const expectedStrategies = [
      "BNB_1h_RSI", "SOL_1h_EMA", "BTC_30m_RSI", "BTC_30m_EMA",
      "XRP_4h_EMA", "SOL_4h_EMA", "BNB_1d_T200"
    ];
    for (const id of expectedStrategies) {
      const trades = bot._stratTrades[id];
      assert.ok(trades && trades.length >= 20,
        `${id} should have >= 20 seeded trades, got ${trades?.length}`);
      const k = calcKelly(trades);
      assert.ok(k.kelly > 0, `${id} seeded kelly=${k.kelly} should be positive`);
    }
  });

  it("seeded trades are NOT overwritten when real trades exist", () => {
    const saved = {
      stratTrades: {
        "BNB_1h_RSI": makeTrades(25, 0.60), // 25 real trades
      }
    };
    const bot = new SimpleBotEngine(saved);
    assert.equal(bot._stratTrades["BNB_1h_RSI"].length, 25,
      "Should keep real trades, not overseed");
  });

  it("gate blocks when kelly is negative and n >= 10", () => {
    // The gate condition: kelly.negative && kelly.n >= 10
    const badTrades = makeTrades(20, 0.25);
    const result = calcKelly(badTrades);
    assert.equal(result.negative, true);
    assert.ok(result.n >= 10);
    // This means _onCandleClose would return early
  });

  it("gate allows when kelly is negative but n < 10", () => {
    const result = calcKelly(makeTrades(5, 0.0));
    // n=5 < 20 so calcKelly returns kelly=-1, negative=true, n=5
    assert.equal(result.negative, true);
    assert.equal(result.n, 5);
    // But n < 10, so gate does NOT block (kelly.negative && kelly.n >= 10 -> false)
  });
});
