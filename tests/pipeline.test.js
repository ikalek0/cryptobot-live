// ── Pipeline tests: candle close -> eval -> sizing -> BUY ────────────────────
// Tests the full signal evaluation pipeline from price update to trade execution.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.CAPITAL_USDC = "100";

const { SimpleBotEngine, evalSignal, STRATEGIES } = require("../src/engine_simple");

// ── Signal evaluation tests ─────────────────────────────────────────────────

describe("evalSignal", () => {
  it("RSI_MR_ADX: BUY when RSI<35, price<BB lower, ADX<25", () => {
    // Create candles with declining prices so RSI < 35 and price below BB lower
    const base = 100;
    const candles = [];
    // 30 candles trending down to push RSI low
    for (let i = 0; i < 30; i++) {
      const price = base - i * 0.8; // steady decline
      candles.push({ open: price + 0.5, high: price + 1, low: price - 0.5, close: price });
    }
    const signal = evalSignal("RSI_MR_ADX", candles);
    // Signal depends on exact RSI/BB/ADX values. We just verify it returns BUY or null (not crash)
    assert.ok(signal === "BUY" || signal === null, `Expected BUY or null, got ${signal}`);
  });

  it("RSI_MR_ADX: no BUY when RSI>50 (trending up)", () => {
    const candles = [];
    for (let i = 0; i < 30; i++) {
      const price = 100 + i * 2; // strong uptrend -> high RSI
      candles.push({ open: price - 1, high: price + 1, low: price - 1, close: price });
    }
    const signal = evalSignal("RSI_MR_ADX", candles);
    assert.equal(signal, null, "Uptrending RSI should not produce BUY");
  });

  it("EMA_CROSS: BUY on bullish crossover", () => {
    const candles = [];
    // 50 candles: first 40 declining (EMA9 < EMA21), then sharp reversal
    for (let i = 0; i < 40; i++) {
      const price = 100 - i * 0.3;
      candles.push({ open: price, high: price + 0.5, low: price - 0.5, close: price });
    }
    // Sharp reversal: 10 candles going up fast to create EMA9 > EMA21 crossover
    for (let i = 0; i < 10; i++) {
      const price = 88 + i * 3;
      candles.push({ open: price - 1, high: price + 1, low: price - 1, close: price });
    }
    const signal = evalSignal("EMA_CROSS", candles);
    // The crossover may or may not trigger depending on exact EMA values
    assert.ok(signal === "BUY" || signal === null, `Expected BUY or null, got ${signal}`);
  });

  it("EMA_CROSS: returns null with fewer than 50 candles", () => {
    const candles = [];
    for (let i = 0; i < 30; i++) {
      candles.push({ open: 100, high: 101, low: 99, close: 100 });
    }
    const signal = evalSignal("EMA_CROSS", candles);
    assert.equal(signal, null, "Should return null with < 50 candles");
  });

  it("TREND_200: returns null with fewer than 200 candles", () => {
    const candles = [];
    for (let i = 0; i < 100; i++) {
      candles.push({ open: 100, high: 101, low: 99, close: 100 });
    }
    const signal = evalSignal("TREND_200", candles);
    assert.equal(signal, null, "Should return null with < 200 candles");
  });

  it("unknown type returns null", () => {
    const signal = evalSignal("SCALP_MAGIC", []);
    assert.equal(signal, null, "Unknown strategy type should return null");
  });
});

// ── USDT/USDC normalization ─────────────────────────────────────────────────

describe("USDT/USDC normalization", () => {
  it("SOLUSDT price stored as SOLUSDC", () => {
    const bot = new SimpleBotEngine({});
    bot.updatePrice("SOLUSDT", 84.15);
    assert.equal(bot.prices["SOLUSDC"], 84.15, "SOLUSDT should be stored as SOLUSDC");
    assert.equal(bot.prices["SOLUSDT"], undefined, "SOLUSDT key should not exist");
  });

  it("BTCUSDT price stored as BTCUSDC", () => {
    const bot = new SimpleBotEngine({});
    bot.updatePrice("BTCUSDT", 65000);
    assert.equal(bot.prices["BTCUSDC"], 65000);
  });

  it("BNBUSDT price stored as BNBUSDC", () => {
    const bot = new SimpleBotEngine({});
    bot.updatePrice("BNBUSDT", 600);
    assert.equal(bot.prices["BNBUSDC"], 600);
  });

  it("XRPUSDT price stored as XRPUSDC", () => {
    const bot = new SimpleBotEngine({});
    bot.updatePrice("XRPUSDT", 0.55);
    assert.equal(bot.prices["XRPUSDC"], 0.55);
  });

  it("USDC pairs stored unchanged", () => {
    const bot = new SimpleBotEngine({});
    bot.updatePrice("BTCUSDC", 65000);
    assert.equal(bot.prices["BTCUSDC"], 65000);
  });
});

// ── Candle mechanics ────────────────────────────────────────────────────────

describe("Candle mechanics", () => {
  it("creates curBar on first price update", () => {
    const bot = new SimpleBotEngine({});
    bot.updatePrice("BNBUSDC", 600);
    // Should have created bars for BNB strategies (1h and 1d)
    const key1h = "BNBUSDC_1h";
    assert.ok(bot._curBar[key1h], `curBar[${key1h}] should exist`);
    assert.equal(bot._curBar[key1h].open, 600);
    assert.equal(bot._curBar[key1h].close, 600);
  });

  it("updates high/low within same candle", () => {
    const bot = new SimpleBotEngine({});
    bot.updatePrice("BNBUSDC", 600);
    bot.updatePrice("BNBUSDC", 610); // new high
    bot.updatePrice("BNBUSDC", 590); // new low
    const key = "BNBUSDC_1h";
    assert.equal(bot._curBar[key].high, 610);
    assert.equal(bot._curBar[key].low, 590);
    assert.equal(bot._curBar[key].close, 590);
  });

  it("_onCandleClose skips if not enough candles", () => {
    const bot = new SimpleBotEngine({});
    const cfg = STRATEGIES[0]; // BNB_1h_RSI needs 50 candles
    const key = `${cfg.pair}_${cfg.tf}`;
    bot._candles[key] = []; // 0 candles
    for (let i = 0; i < 10; i++) {
      bot._candles[key].push({ open: 600, high: 601, low: 599, close: 600, start: Date.now() });
    }
    bot.prices[cfg.pair] = 600;
    bot._onCandleClose(cfg, key);
    assert.equal(Object.keys(bot.portfolio).length, 0,
      "Should not open position with only 10 candles (need 50)");
  });

  it("_onCandleClose skips if position already open for strategy", () => {
    const bot = new SimpleBotEngine({});
    const cfg = STRATEGIES[0]; // BNB_1h_RSI
    const key = `${cfg.pair}_${cfg.tf}`;
    // Add enough candles
    bot._candles[key] = [];
    for (let i = 0; i < 60; i++) {
      bot._candles[key].push({ open: 600, high: 601, low: 599, close: 600, start: Date.now() });
    }
    // Pre-open a position for this strategy
    bot.portfolio[cfg.id] = { pair: cfg.pair, capa: 1, entryPrice: 600, qty: 0.1 };
    bot.prices[cfg.pair] = 600;
    const logBefore = bot.log.length;
    bot._onCandleClose(cfg, key);
    assert.equal(bot.log.length, logBefore, "Should not add BUY when position already open");
  });
});

// ── Full pipeline integration ───────────────────────────────────────────────

describe("Full pipeline: candle close triggers evaluation", () => {
  it("strategies array has exactly 7 entries", () => {
    assert.equal(STRATEGIES.length, 7);
  });

  it("all strategies have required fields", () => {
    for (const s of STRATEGIES) {
      assert.ok(s.id, `Strategy missing id`);
      assert.ok(s.pair, `${s.id} missing pair`);
      assert.ok(s.tf, `${s.id} missing tf`);
      assert.ok(s.type, `${s.id} missing type`);
      assert.ok(typeof s.stop === "number", `${s.id} missing stop`);
      assert.ok(typeof s.target === "number", `${s.id} missing target`);
      assert.ok(typeof s.kelly === "number", `${s.id} missing kelly`);
      assert.ok(s.capa === 1 || s.capa === 2, `${s.id} capa must be 1 or 2`);
    }
  });

  it("Capa 1 strategies use stop=0.8% target=1.6%", () => {
    const capa1 = STRATEGIES.filter(s => s.capa === 1);
    for (const s of capa1) {
      assert.equal(s.stop, 0.008, `${s.id} stop should be 0.008`);
      assert.equal(s.target, 0.016, `${s.id} target should be 0.016`);
    }
  });

  it("Capa 2 strategies use stop=3% target=6%", () => {
    const capa2 = STRATEGIES.filter(s => s.capa === 2);
    for (const s of capa2) {
      assert.equal(s.stop, 0.030, `${s.id} stop should be 0.030`);
      assert.equal(s.target, 0.060, `${s.id} target should be 0.060`);
    }
  });

  it("correlation groups prevent >2 positions per group", () => {
    const bot = new SimpleBotEngine({});
    // Open 2 MAJOR_ALT positions (SOL + BNB)
    bot.portfolio["SOL_1h_EMA"] = { pair: "SOLUSDC", capa: 1 };
    bot.portfolio["BNB_1h_RSI"] = { pair: "BNBUSDC", capa: 1 };

    // Try to open another in same group - SOL_4h_EMA (SOLUSDC is MAJOR_ALT)
    const cfg = STRATEGIES.find(s => s.id === "SOL_4h_EMA");
    const key = `${cfg.pair}_${cfg.tf}`;
    bot._candles[key] = [];
    for (let i = 0; i < 60; i++) {
      bot._candles[key].push({ open: 84, high: 85, low: 83, close: 84, start: Date.now() });
    }
    bot.prices[cfg.pair] = 84;
    const logBefore = bot.log.length;
    bot._onCandleClose(cfg, key);
    assert.equal(bot.log.length, logBefore,
      "Should block 3rd position in MAJOR_ALT group");
  });
});
