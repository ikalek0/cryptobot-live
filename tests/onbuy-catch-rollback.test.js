// ── BATCH-4 FIX #10: _onBuy catch rollback defense-in-depth ─────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

const fnIdx = src.indexOf("S.simpleBot._onBuy = (pair, invest, ctx)");
assert.ok(fnIdx >= 0);
const fnBody = src.slice(fnIdx, fnIdx + 2500);

describe("BATCH-4 FIX #10 — _onBuy catch rollback", () => {
  it("BATCH-4 FIX #10 comment present", () => {
    const area = src.slice(Math.max(0, fnIdx - 200), fnIdx + 200);
    assert.ok(/BATCH-4 FIX #10/.test(area));
  });

  it("outer try/catch wraps entire _onBuy body", () => {
    assert.ok(/try\s*\{/.test(fnBody),
      "must have outer try block");
    assert.ok(/\}\s*catch\s*\(e\)\s*\{/.test(fnBody),
      "must have outer catch block");
  });

  it("sync catch does rollback if pending", () => {
    const catchIdx = fnBody.lastIndexOf("catch(e)");
    assert.ok(catchIdx >= 0);
    const catchBlock = fnBody.slice(catchIdx, catchIdx + 700);
    assert.ok(/rollback sync/.test(catchBlock),
      "sync catch must log rollback sync");
    assert.ok(/pos\.status === "pending"/.test(catchBlock),
      "must check pending status");
  });

  it("async .catch also does rollback if pending", () => {
    const asyncCatchIdx = fnBody.indexOf(".catch(e =>");
    assert.ok(asyncCatchIdx >= 0, "must have .catch on placeLiveBuy");
    const asyncBlock = fnBody.slice(asyncCatchIdx, asyncCatchIdx + 800);
    assert.ok(/rollback defense-in-depth/.test(asyncBlock),
      "async catch must log defense-in-depth rollback");
    assert.ok(/pos\.status === "pending"/.test(asyncBlock),
      "async catch must check pending status");
  });

  it("both rollback paths use _investWithFee", () => {
    const matches = fnBody.match(/_investWithFee/g);
    // Should appear in: pause rollback + async catch + sync catch = at least 3
    assert.ok(matches && matches.length >= 3,
      `_investWithFee should appear >= 3 times, found ${matches?.length}`);
  });
});
