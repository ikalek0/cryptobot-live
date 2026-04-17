// ── BATCH-4 FIX #5: sync error H7 Math.max ───────────────────────────
// Error path in syncCapitalFromBinance must not shorten an existing
// longer pause (e.g. H7 constructor set 10min, sync fails at T+1s).
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const engineSrc = fs.readFileSync(
  path.join(__dirname, "..", "src", "engine_simple.js"),
  "utf-8",
);

const fnIdx = engineSrc.indexOf("async syncCapitalFromBinance(");
assert.ok(fnIdx >= 0);
const fnBody = engineSrc.slice(fnIdx, fnIdx + 15000);

describe("BATCH-4 FIX #5 — sync error H7 Math.max", () => {
  it("BATCH-4 FIX #5 comment present", () => {
    assert.ok(/BATCH-4 FIX #5/.test(fnBody));
  });

  it("error path uses Math.max for _capitalSyncPausedUntil", () => {
    const catchIdx = fnBody.indexOf("catch (err)");
    assert.ok(catchIdx >= 0);
    const catchBlock = fnBody.slice(catchIdx, catchIdx + 1200);
    assert.ok(/Math\.max/.test(catchBlock),
      "catch must use Math.max to preserve longer pause");
  });

  it("Math.max compares against existing _capitalSyncPausedUntil", () => {
    const catchIdx = fnBody.indexOf("catch (err)");
    const catchBlock = fnBody.slice(catchIdx, catchIdx + 1200);
    assert.ok(/this\._capitalSyncPausedUntil \|\| 0/.test(catchBlock),
      "must compare against current _capitalSyncPausedUntil || 0");
  });

  it("still uses 5min pause for normal case", () => {
    const catchIdx = fnBody.indexOf("catch (err)");
    const catchBlock = fnBody.slice(catchIdx, catchIdx + 1200);
    assert.ok(/5\s*\*\s*60\s*\*\s*1000/.test(catchBlock),
      "must still add 5min pause");
  });
});

// Functional test
const { SimpleBotEngine } = require("../src/engine_simple");

process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

describe("BATCH-4 FIX #5 — functional: Math.max preserves longer pause", () => {
  it("H7 10min pause not shortened by sync error at T+1s", async () => {
    const eng = new SimpleBotEngine({});
    // Simulate H7 fail-closed: 10min pause from constructor
    const h7Pause = Date.now() + 10 * 60 * 1000;
    eng._capitalSyncPausedUntil = h7Pause;

    // Sync fails (mock returns error)
    const deps = {
      binanceReadOnlyRequest: async () => { throw new Error("network down"); },
      binancePublicRequest: async () => { throw new Error("network down"); },
    };
    await eng.syncCapitalFromBinance(deps);

    // Pause should still be >= h7Pause (not Date.now() + 5min)
    assert.ok(eng._capitalSyncPausedUntil >= h7Pause,
      `pause ${eng._capitalSyncPausedUntil} should be >= H7 ${h7Pause}`);
  });

  it("without prior pause, sync error sets 5min", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;

    const deps = {
      binanceReadOnlyRequest: async () => { throw new Error("network down"); },
      binancePublicRequest: async () => { throw new Error("network down"); },
    };
    const before = Date.now();
    await eng.syncCapitalFromBinance(deps);

    const expected5min = before + 5 * 60 * 1000;
    assert.ok(eng._capitalSyncPausedUntil >= expected5min - 1000,
      "without prior pause, should set ~5min from now");
  });
});
