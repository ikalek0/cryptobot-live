// ── BATCH-5 FIX #3,#4,#6 — server.js source checks ───────────────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

describe("BATCH-5 FIX #3 — WS_SECRET in warnPredictableSecrets", () => {
  it("warnPredictableSecrets checks array includes WS_SECRET", () => {
    const idx = src.indexOf("function warnPredictableSecrets");
    assert.ok(idx >= 0);
    const win = src.slice(idx, idx + 1500);
    assert.ok(win.includes('"WS_SECRET"'),
      "checks array must include WS_SECRET");
    assert.ok(win.includes("process.env.WS_SECRET"),
      "must read WS_SECRET from env");
  });

  it("WS_SECRET check is alongside SYNC_SECRET and BOT_SECRET", () => {
    const idx = src.indexOf("function warnPredictableSecrets");
    const win = src.slice(idx, idx + 1500);
    assert.ok(win.includes('"SYNC_SECRET"'), "must check SYNC_SECRET");
    assert.ok(win.includes('"BOT_SECRET"'), "must check BOT_SECRET");
    assert.ok(win.includes('"WS_SECRET"'), "must check WS_SECRET");
  });
});

describe("BATCH-5 FIX #4 — TICK_MS dev warning", () => {
  it("warns when TICK_MS < 5000", () => {
    assert.ok(src.includes("TICK_MS < 5000"),
      "must check TICK_MS < 5000");
  });

  it("warning includes the actual TICK_MS value", () => {
    const idx = src.indexOf("TICK_MS < 5000");
    const win = src.slice(idx, idx + 200);
    assert.ok(win.includes("TICK_MS="),
      "warning must log the actual value");
  });
});

describe("BATCH-5 FIX #6 — sendEquityToBafir dead code removal", () => {
  it("sendEquityToBafir function no longer exists", () => {
    assert.ok(!src.includes("function sendEquityToBafir"),
      "sendEquityToBafir function must be removed");
  });

  it("BAFIR_URL no longer declared as active code", () => {
    const noComments = src
      .split("\n")
      .map(line => {
        const idx = line.indexOf("//");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    assert.ok(!noComments.includes('const BAFIR_URL'),
      "BAFIR_URL must be removed");
  });

  it("startLoop deps do not include sendEquityToBafir", () => {
    const idx = src.indexOf("startLoop(");
    assert.ok(idx >= 0);
    const win = src.slice(idx, idx + 400);
    assert.ok(!win.includes("sendEquityToBafir"),
      "startLoop call must not pass sendEquityToBafir");
  });
});
