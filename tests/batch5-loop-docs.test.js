// ── BATCH-5 FIX #5,#7 — loop.js documentation + dead code ────────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "trading", "loop.js"),
  "utf-8",
);

describe("BATCH-5 FIX #5 — _sessionStartTs documentation", () => {
  it("_sessionStartTs has descriptive comment", () => {
    const idx = src.indexOf("_sessionStartTs");
    assert.ok(idx >= 0);
    const area = src.slice(Math.max(0, idx - 200), idx + 100);
    assert.ok(area.includes("BATCH-5 FIX #5"),
      "must have BATCH-5 FIX #5 marker");
    assert.ok(area.includes("P&L") || area.includes("sesión"),
      "comment must explain purpose (P&L or session)");
  });
});

describe("BATCH-5 FIX #6 — sendEquityToBafir removed from loop.js", () => {
  it("sendEquityToBafir not in deps destructure", () => {
    const depsIdx = src.indexOf("const {");
    assert.ok(depsIdx >= 0);
    const depsBlock = src.slice(depsIdx, depsIdx + 500);
    assert.ok(!depsBlock.includes("sendEquityToBafir"),
      "deps must not include sendEquityToBafir");
  });

  it("no active sendEquityToBafir call in tick body", () => {
    const noComments = src
      .split("\n")
      .map(line => {
        const idx = line.indexOf("//");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    assert.ok(!noComments.includes("sendEquityToBafir("),
      "no active call to sendEquityToBafir");
  });
});

describe("BATCH-5 FIX #7 — simulatePrices documentation", () => {
  it("simulatePrices call has documentation comment", () => {
    assert.ok(src.includes("BATCH-5 FIX #7"),
      "must have BATCH-5 FIX #7 marker");
    const idx = src.indexOf("BATCH-5 FIX #7");
    const area = src.slice(idx, idx + 300);
    assert.ok(area.includes("simulatePrices()"),
      "BATCH-5 FIX #7 block must be near simulatePrices() call");
    assert.ok(area.includes("random-walk") || area.includes("health"),
      "comment must explain simulatePrices purpose");
  });
});
