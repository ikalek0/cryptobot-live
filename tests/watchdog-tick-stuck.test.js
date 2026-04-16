// ── BATCH-4 FIX #11: deadlock detection watchdog ─────────────────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "trading", "loop.js"),
  "utf-8",
);

describe("BATCH-4 FIX #11 — watchdog tick stuck", () => {
  it("BATCH-4 FIX #11 comment present", () => {
    assert.ok(/BATCH-4 FIX #11/.test(src));
  });

  it("_lastTickCompletedAt declared and initialized", () => {
    assert.ok(/_lastTickCompletedAt\s*=\s*Date\.now\(\)/.test(src),
      "must initialize _lastTickCompletedAt to Date.now()");
  });

  it("_lastTickCompletedAt updated in finally block", () => {
    const finallyIdx = src.indexOf("finally {");
    assert.ok(finallyIdx >= 0);
    const finallyBlock = src.slice(finallyIdx, finallyIdx + 200);
    assert.ok(/_lastTickCompletedAt\s*=\s*Date\.now\(\)/.test(finallyBlock),
      "must update _lastTickCompletedAt in finally");
  });

  it("watchdog checks every 60s", () => {
    assert.ok(/setInterval.*60\s*\*\s*1000/s.test(src),
      "watchdog must run every 60s");
  });

  it("watchdog exits after 5min stuck", () => {
    const watchIdx = src.indexOf("WATCHDOG");
    assert.ok(watchIdx >= 0);
    const watchBlock = src.slice(Math.max(0, watchIdx - 200), watchIdx + 500);
    assert.ok(/5\s*\*\s*60\s*\*\s*1000/.test(watchBlock),
      "threshold must be 5 minutes");
    assert.ok(/process\.exit\(1\)/.test(watchBlock),
      "must call process.exit(1)");
  });

  it("watchdog uses .unref() to not block exit", () => {
    assert.ok(/\.unref\(\)/.test(src),
      "watchdog interval must use .unref()");
  });

  it("watchdog sends Telegram alert", () => {
    const watchIdx = src.indexOf("WATCHDOG");
    const watchBlock = src.slice(watchIdx, watchIdx + 500);
    assert.ok(/telegramSend/.test(watchBlock),
      "must send Telegram alert");
  });

  it("gives 2s for Telegram before exit", () => {
    const watchIdx = src.indexOf("WATCHDOG");
    const watchBlock = src.slice(watchIdx, watchIdx + 500);
    assert.ok(/setTimeout.*process\.exit.*2000/s.test(watchBlock),
      "must delay exit 2s for Telegram");
  });
});
