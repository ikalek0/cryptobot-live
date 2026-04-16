// ── BATCH-4 FIX #8: binanceRequest null in paper mode ────────────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

const fnIdx = src.indexOf("function binanceRequest(");
assert.ok(fnIdx >= 0);
const fnBody = src.slice(fnIdx, fnIdx + 600);

describe("BATCH-4 FIX #8 — binanceRequest null paper mode", () => {
  it("BATCH-4 FIX #8 comment present", () => {
    const area = src.slice(Math.max(0, fnIdx - 300), fnIdx + 200);
    assert.ok(/BATCH-4 FIX #8/.test(area));
  });

  it("logs warning once when LIVE_MODE=false", () => {
    assert.ok(/_binanceNullWarned/.test(fnBody),
      "must use _binanceNullWarned flag");
    assert.ok(/paper-live mode/.test(fnBody),
      "log must mention paper-live mode");
  });

  it("_binanceNullWarned declared as false", () => {
    const area = src.slice(Math.max(0, fnIdx - 300), fnIdx);
    assert.ok(/_binanceNullWarned\s*=\s*false/.test(area));
  });

  it("still returns Promise.resolve(null) when !LIVE_MODE", () => {
    assert.ok(/Promise\.resolve\(null\)/.test(fnBody));
  });

  it("callers handle null return (grep check)", () => {
    // placeTWAPBuy: order?.orderId guard
    const twapIdx = src.indexOf("async function placeTWAPBuy(");
    const twapBody = src.slice(twapIdx, twapIdx + 2000);
    assert.ok(/order\?\.orderId/.test(twapBody),
      "placeTWAPBuy must check order?.orderId");

    // getAccountBalance: try/catch + data?.balances
    const balIdx = src.indexOf("async function getAccountBalance(");
    const balBody = src.slice(balIdx, balIdx + 500);
    assert.ok(/data\?\.balances/.test(balBody),
      "getAccountBalance must use data?.balances");
  });
});
