// ── BATCH-4 FIX #3: uncaughtException Telegram alert ─────────────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

const handlerIdx = src.indexOf("process.on(\"uncaughtException\"");
assert.ok(handlerIdx >= 0);
const handlerBody = src.slice(handlerIdx, handlerIdx + 800);

describe("BATCH-4 FIX #3 — uncaughtException Telegram alert", () => {
  it("BATCH-4 FIX #3 comment present", () => {
    assert.ok(/BATCH-4 FIX #3/.test(handlerBody));
  });

  it("sends Telegram alert with crash message", () => {
    assert.ok(/tg\.send/.test(handlerBody),
      "must call tg.send");
    assert.ok(/CRASH.*uncaughtException/.test(handlerBody),
      "message must include CRASH + uncaughtException");
  });

  it("Telegram send is before save (early alert)", () => {
    const tgIdx = handlerBody.indexOf("tg.send");
    const saveIdx = handlerBody.indexOf("await save()");
    assert.ok(tgIdx < saveIdx,
      "tg.send must come before await save()");
  });

  it("tg.send is wrapped in try/catch (no block exit)", () => {
    const tgIdx = handlerBody.indexOf("tg.send");
    const beforeTg = handlerBody.slice(Math.max(0, tgIdx - 100), tgIdx);
    assert.ok(/try\s*\{/.test(beforeTg),
      "tg.send must be inside try block");
  });

  it("truncates error message to 300 chars", () => {
    assert.ok(/\.slice\(0,\s*300\)/.test(handlerBody),
      "must truncate message");
  });
});
