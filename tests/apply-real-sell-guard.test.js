// ── BATCH-5 FIX #2 + #9: applyRealSellFill guards ────────────────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

describe("BATCH-5 FIX #2 — applyRealSellFill undefined expectedNet guard", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "engine_simple.js"),
    "utf-8",
  );

  it("applyRealSellFill checks typeof expectedNet !== 'number'", () => {
    const idx = src.indexOf("applyRealSellFill(");
    assert.ok(idx >= 0);
    const body = src.slice(idx, idx + 500);
    assert.ok(body.includes('typeof expectedNet !== "number"'),
      "must guard against undefined expectedNet");
  });

  it("returns early without modifying capa cash when expectedNet undefined", () => {
    const idx = src.indexOf("applyRealSellFill(");
    const body = src.slice(idx, idx + 500);
    assert.ok(body.includes("skip reconciliation"),
      "must log skip message");
    assert.ok(body.includes("return"),
      "must return early");
  });

  it("runtime: undefined expectedNet does not modify capa cash", () => {
    const configPath = require.resolve("../src/config");
    const enginePath = require.resolve("../src/engine_simple");
    delete require.cache[configPath];
    delete require.cache[enginePath];
    const { SimpleBotEngine } = require("../src/engine_simple");
    const bot = new SimpleBotEngine();
    const c1Before = bot.capa1Cash;
    const c2Before = bot.capa2Cash;
    bot.applyRealSellFill("TEST", { realGross: 50, capa: 1, expectedNet: undefined, feeEfectivo: 0.001 });
    assert.equal(bot.capa1Cash, c1Before, "capa1Cash must not change");
    bot.applyRealSellFill("TEST", { realGross: 50, capa: 2 });
    assert.equal(bot.capa2Cash, c2Before, "capa2Cash must not change");
    delete require.cache[enginePath];
    delete require.cache[configPath];
  });

  it("runtime: valid expectedNet still reconciles normally", () => {
    const configPath = require.resolve("../src/config");
    const enginePath = require.resolve("../src/engine_simple");
    delete require.cache[configPath];
    delete require.cache[enginePath];
    const { SimpleBotEngine } = require("../src/engine_simple");
    const bot = new SimpleBotEngine();
    const c1Before = bot.capa1Cash;
    // realGross=50 fee=0.001 → realNet=49.95, expectedNet=40 → delta=+9.95
    bot.applyRealSellFill("TEST", { realGross: 50, capa: 1, expectedNet: 40, feeEfectivo: 0.001 });
    assert.ok(Math.abs(bot.capa1Cash - c1Before - 9.95) < 0.01, "capa1Cash should increase by delta");
    delete require.cache[enginePath];
    delete require.cache[configPath];
  });
});

describe("BATCH-5 FIX #9 — feeEfectivo fallback logging", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "engine_simple.js"),
    "utf-8",
  );

  it("logs warning when feeEfectivo not provided", () => {
    const idx = src.indexOf("applyRealSellFill(");
    const body = src.slice(idx, idx + 900);
    assert.ok(body.includes("feeEfectivo not provided"),
      "must warn about missing feeEfectivo");
    assert.ok(body.includes("fallback to FEE"),
      "must indicate fallback");
  });
});
