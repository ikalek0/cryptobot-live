// ── BATCH-3 FIX #8 (#8): initBot async + health readiness ───────────
// server.listen MUST run after initBot completes (not at module level).
// /api/health returns 503 before _botReady, 200 after.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

describe("BATCH-3 FIX #8 — initBot async + health readiness", () => {
  it("BATCH-3 FIX #8 comment present", () => {
    assert.ok(/BATCH-3 FIX #8/.test(src));
  });

  it("_botReady flag declared as false", () => {
    assert.ok(/let _botReady\s*=\s*false/.test(src),
      "_botReady must start as false");
  });

  it("_botReady set to true after initBot", () => {
    // Find the IIFE with initBot
    const iifeIdx = src.indexOf("await initBot()");
    assert.ok(iifeIdx >= 0, "await initBot() must exist");
    const afterInit = src.slice(iifeIdx, iifeIdx + 200);
    assert.ok(/_botReady\s*=\s*true/.test(afterInit),
      "_botReady = true must follow await initBot()");
  });

  it("server.listen is inside the IIFE (after initBot), not at module level", () => {
    // Find the async IIFE containing initBot
    const iifeIdx = src.indexOf("await initBot()");
    const iifeBlock = src.slice(iifeIdx, iifeIdx + 500);
    assert.ok(/server\.listen\(PORT/.test(iifeBlock),
      "server.listen must be inside the IIFE after initBot");
  });

  it("no standalone server.listen at module level", () => {
    // The old pattern: server.listen at module top-level (outside any function)
    // After fix, the only server.listen should be inside the IIFE
    const lines = src.split("\n");
    let moduleLevelListen = false;
    for (const line of lines) {
      // Skip lines inside the IIFE (they'll be indented)
      if (/^server\.listen\(/.test(line.trim()) && !/^\s{2,}/.test(line)) {
        moduleLevelListen = true;
      }
    }
    // Just check there's no second server.listen
    const matches = src.match(/server\.listen\(PORT/g);
    assert.equal(matches?.length, 1,
      "exactly one server.listen call should exist");
  });

  it("initBot failure calls process.exit(1)", () => {
    const iifeIdx = src.indexOf("await initBot()");
    // The IIFE has try { await initBot(); ... server.listen ... } catch { exit(1) }
    // Need enough window to cover the full try block + catch
    const iifeBlock = src.slice(iifeIdx, iifeIdx + 800);
    assert.ok(/catch\s*\(\s*e\s*\)\s*\{[\s\S]*?process\.exit\(1\)/.test(iifeBlock),
      "catch after initBot must call process.exit(1)");
  });

  it("/api/health returns 503 when not ready", () => {
    const healthIdx = src.indexOf("/api/health");
    assert.ok(healthIdx >= 0);
    const healthBlock = src.slice(healthIdx, healthIdx + 500);
    assert.ok(/503/.test(healthBlock),
      "/api/health must return 503 status");
    assert.ok(/_botReady/.test(healthBlock),
      "/api/health must check _botReady");
  });

  it("/api/health includes ready:false before bot is ready", () => {
    const healthIdx = src.indexOf("/api/health");
    const healthBlock = src.slice(healthIdx, healthIdx + 500);
    assert.ok(/ready:\s*false/.test(healthBlock),
      "must return ready:false when not ready");
    assert.ok(/ready:\s*true/.test(healthBlock),
      "must return ready:true when ready");
  });

  it("scheduleWeeklyReport is inside the IIFE (after initBot)", () => {
    const iifeIdx = src.indexOf("await initBot()");
    const iifeBlock = src.slice(iifeIdx, iifeIdx + 500);
    assert.ok(/scheduleWeeklyReport/.test(iifeBlock),
      "scheduleWeeklyReport must be inside IIFE");
  });

  it("scheduleTradeAnalysisReminder is inside the IIFE (after initBot)", () => {
    const iifeIdx = src.indexOf("await initBot()");
    const iifeBlock = src.slice(iifeIdx, iifeIdx + 500);
    assert.ok(/scheduleTradeAnalysisReminder/.test(iifeBlock),
      "scheduleTradeAnalysisReminder must be inside IIFE");
  });
});
