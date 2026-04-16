// ── BATCH-4 FIX #12: WS silent stream reconnect ─────────────────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

describe("BATCH-4 FIX #12 — WS silent stream reconnect", () => {
  it("BATCH-4 FIX #12 comment present", () => {
    assert.ok(/BATCH-4 FIX #12/.test(src));
  });

  it("_lastWsMessageAt declared and initialized", () => {
    assert.ok(/_lastWsMessageAt\s*=\s*Date\.now\(\)/.test(src),
      "must initialize _lastWsMessageAt");
  });

  it("_currentWs declared", () => {
    assert.ok(/_currentWs\s*=\s*null/.test(src),
      "must declare _currentWs = null");
  });

  it("message handler updates _lastWsMessageAt", () => {
    const fnIdx = src.indexOf("function connectBinance()");
    const fnBody = src.slice(fnIdx, fnIdx + 1500);
    const msgIdx = fnBody.indexOf("on(\"message\"");
    assert.ok(msgIdx >= 0);
    const msgBlock = fnBody.slice(msgIdx, msgIdx + 300);
    assert.ok(/_lastWsMessageAt\s*=\s*Date\.now\(\)/.test(msgBlock),
      "message handler must update _lastWsMessageAt");
  });

  it("open handler resets _lastWsMessageAt", () => {
    const fnIdx = src.indexOf("function connectBinance()");
    const fnBody = src.slice(fnIdx, fnIdx + 1500);
    const openIdx = fnBody.indexOf("on(\"open\"");
    const openBlock = fnBody.slice(openIdx, openIdx + 300);
    assert.ok(/_lastWsMessageAt\s*=\s*Date\.now\(\)/.test(openBlock),
      "open handler must reset _lastWsMessageAt");
  });

  it("silent detection checks >60s without messages", () => {
    const silentIdx = src.indexOf("WS silente >60s");
    assert.ok(silentIdx >= 0);
    const silentBlock = src.slice(Math.max(0, silentIdx - 300), silentIdx + 200);
    assert.ok(/60\s*\*\s*1000/.test(silentBlock),
      "threshold must be 60*1000ms (60s)");
  });

  it("silent detection terminates current WS", () => {
    const silentIdx = src.indexOf("WS silente >60s");
    const afterSilent = src.slice(silentIdx, silentIdx + 400);
    assert.ok(/_currentWs\.terminate\(\)/.test(afterSilent),
      "must terminate _currentWs");
  });

  it("sends Telegram alert on silent reconnect", () => {
    const silentIdx = src.indexOf("WS silente >60s");
    const afterSilent = src.slice(silentIdx, silentIdx + 400);
    assert.ok(/tg\.send/.test(afterSilent),
      "must send Telegram alert");
  });

  it("silent check interval uses .unref()", () => {
    const checkIdx = src.indexOf("_wsSilentCheckInterval");
    assert.ok(checkIdx >= 0);
    const area = src.slice(checkIdx, checkIdx + 600);
    assert.ok(/\.unref\(\)/.test(area),
      "interval must use .unref()");
  });

  it("connectBinance assigns _currentWs", () => {
    const fnIdx = src.indexOf("function connectBinance()");
    const fnBody = src.slice(fnIdx, fnIdx + 200);
    assert.ok(/_currentWs\s*=\s*ws/.test(fnBody),
      "must assign ws to _currentWs");
  });
});
