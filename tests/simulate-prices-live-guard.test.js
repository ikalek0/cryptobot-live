// ── BATCH-4 FIX #9: simulatePrices LIVE guard ───────────────────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

const fnIdx = src.indexOf("function simulatePrices()");
assert.ok(fnIdx >= 0);
const fnBody = src.slice(fnIdx, fnIdx + 600);

describe("BATCH-4 FIX #9 — simulatePrices LIVE guard", () => {
  it("BATCH-4 FIX #9 comment present", () => {
    const area = src.slice(Math.max(0, fnIdx - 300), fnIdx + 200);
    assert.ok(/BATCH-4 FIX #9/.test(area));
  });

  it("checks LIVE_MODE before generating prices", () => {
    assert.ok(/if\s*\(LIVE_MODE\)/.test(fnBody),
      "must check LIVE_MODE");
  });

  it("returns early in LIVE_MODE", () => {
    const liveIdx = fnBody.indexOf("LIVE_MODE");
    const block = fnBody.slice(liveIdx, liveIdx + 200);
    assert.ok(/return;/.test(block),
      "must return early in LIVE_MODE");
  });

  it("logs warning once in LIVE mode", () => {
    assert.ok(/_simPriceWarnedLive/.test(fnBody),
      "must use one-time warning flag");
    assert.ok(/no permite precios fake/.test(fnBody),
      "warning must mention no fake prices");
  });

  it("still generates prices when !LIVE_MODE", () => {
    assert.ok(/PAIRS\.forEach/.test(fnBody),
      "must still have PAIRS.forEach for paper mode");
    assert.ok(/updatePrice/.test(fnBody),
      "must still call updatePrice for paper mode");
  });
});
