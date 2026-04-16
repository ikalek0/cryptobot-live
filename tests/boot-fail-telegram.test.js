// ── BATCH-4 FIX #4: boot fail-closed Telegram alert ──────────────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

const fnIdx = src.indexOf("function warnPredictableSecrets");
assert.ok(fnIdx >= 0);
const fnBody = src.slice(fnIdx, fnIdx + 3000);

describe("BATCH-4 FIX #4 — boot fail-closed Telegram alert", () => {
  it("BATCH-4 FIX #4 comment present", () => {
    assert.ok(/BATCH-4 FIX #4/.test(fnBody));
  });

  it("sends Telegram via https before exit", () => {
    assert.ok(/api\.telegram\.org/.test(fnBody),
      "must use Telegram API directly");
    assert.ok(/sendMessage/.test(fnBody),
      "must call sendMessage endpoint");
  });

  it("uses TELEGRAM_TOKEN and TELEGRAM_CHAT_ID from env", () => {
    assert.ok(/TELEGRAM_TOKEN/.test(fnBody),
      "must read TELEGRAM_TOKEN");
    assert.ok(/TELEGRAM_CHAT_ID/.test(fnBody),
      "must read TELEGRAM_CHAT_ID");
  });

  it("skips Telegram if token/chat not set", () => {
    assert.ok(/if \(_tgToken && _tgChat\)/.test(fnBody),
      "must guard with token+chat check");
  });

  it("has timeout to prevent blocking forever", () => {
    assert.ok(/timeout.*3000|sleep 2/.test(fnBody),
      "must have timeout or sleep to prevent infinite block");
  });

  it("Telegram attempt wrapped in try/catch", () => {
    const tgIdx = fnBody.indexOf("api.telegram.org");
    const before = fnBody.slice(Math.max(0, tgIdx - 500), tgIdx);
    assert.ok(/try\s*\{/.test(before),
      "Telegram request must be in try block");
  });

  it("process.exit(1) still called after Telegram attempt", () => {
    const tgIdx = fnBody.indexOf("api.telegram.org");
    const after = fnBody.slice(tgIdx, tgIdx + 600);
    assert.ok(/process\.exit\(1\)/.test(after),
      "process.exit(1) must follow Telegram attempt");
  });
});
