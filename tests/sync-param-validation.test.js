// ── BATCH-4 FIX #7: sync param range validation ─────────────────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateParamRanges, evaluateIncomingParams } = require("../src/sync");

describe("BATCH-4 FIX #7 — validateParamRanges", () => {
  it("rejects kellyFraction=10 (max 0.5)", () => {
    const r = validateParamRanges({ kellyFraction: 10 });
    assert.equal(r.ok, false);
    assert.ok(/kellyFraction/.test(r.reason));
  });

  it("rejects positionSizePct=100 (max 30)", () => {
    const r = validateParamRanges({ positionSizePct: 100 });
    assert.equal(r.ok, false);
    assert.ok(/positionSizePct/.test(r.reason));
  });

  it("rejects stopPct=50 (max 10)", () => {
    const r = validateParamRanges({ stopPct: 50 });
    assert.equal(r.ok, false);
  });

  it("rejects targetPct=99 (max 20)", () => {
    const r = validateParamRanges({ targetPct: 99 });
    assert.equal(r.ok, false);
  });

  it("rejects maxPositions=100 (max 10)", () => {
    const r = validateParamRanges({ maxPositions: 100 });
    assert.equal(r.ok, false);
  });

  it("rejects non-number param", () => {
    const r = validateParamRanges({ kellyFraction: "high" });
    assert.equal(r.ok, false);
  });

  it("accepts valid params", () => {
    const r = validateParamRanges({
      kellyFraction: 0.3,
      positionSizePct: 15,
      stopPct: 2,
      targetPct: 4,
      maxPositions: 5,
    });
    assert.equal(r.ok, true);
  });

  it("ignores unknown fields (no reject)", () => {
    const r = validateParamRanges({ unknownField: 999 });
    assert.equal(r.ok, true);
  });

  it("null/undefined params → ok", () => {
    assert.equal(validateParamRanges(null).ok, true);
    assert.equal(validateParamRanges(undefined).ok, true);
  });
});

describe("BATCH-4 FIX #7 — evaluateIncomingParams rejects bad ranges", () => {
  it("rejects params with kellyFraction out of range", () => {
    const result = evaluateIncomingParams(
      { params: { kellyFraction: 10 }, paperStats: { nTrades: 20, winRate: 80, avgPnl: 5 } },
      {},
      { winRate: 50, avgPnl: 1, nTrades: 10 },
      [],
    );
    assert.equal(result.adopted, false);
    assert.ok(/fuera de rango/.test(result.reason));
  });

  it("accepts params within range", () => {
    const result = evaluateIncomingParams(
      { params: { kellyFraction: 0.2 }, paperStats: { nTrades: 20, winRate: 80, avgPnl: 5 } },
      { kellyFraction: 0.1 },
      { winRate: 50, avgPnl: 1, nTrades: 10 },
      [],
    );
    // Might not be adopted (bootstrap check, etc) but NOT rejected for range
    assert.ok(!/fuera de rango/.test(result.reason || ""));
  });
});
