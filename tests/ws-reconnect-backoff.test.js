// ── BATCH-3 FIX #9 (#9): connectBinance WS exponential backoff ──────
// Verifica que el WebSocket de Binance usa backoff exponencial con jitter
// en vez de reconexión fija cada 5s.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

const fnStart = src.indexOf("function connectBinance()");
assert.ok(fnStart >= 0, "connectBinance must exist");
const fnBody = src.slice(fnStart, fnStart + 1500);

describe("BATCH-3 FIX #9 — WS exponential backoff", () => {
  it("BATCH-3 FIX #9 comment present", () => {
    const commentArea = src.slice(Math.max(0, fnStart - 500), fnStart + 200);
    assert.ok(/BATCH-3 FIX #9/.test(commentArea));
  });

  it("uses _wsReconnectDelay variable (not hardcoded 5000)", () => {
    assert.ok(/_wsReconnectDelay/.test(fnBody),
      "must use _wsReconnectDelay for backoff tracking");
  });

  it("resets delay on successful open", () => {
    const openIdx = fnBody.indexOf("on(\"open\"") || fnBody.indexOf("on('open'");
    assert.ok(openIdx >= 0, "must have open handler");
    const openBlock = fnBody.slice(openIdx, openIdx + 200);
    assert.ok(/_wsReconnectDelay\s*=\s*0/.test(openBlock),
      "must reset _wsReconnectDelay to 0 on open");
  });

  it("doubles delay on close (exponential)", () => {
    const closeIdx = fnBody.indexOf("on(\"close\"") || fnBody.indexOf("on('close'");
    assert.ok(closeIdx >= 0, "must have close handler");
    const closeBlock = fnBody.slice(closeIdx, closeIdx + 400);
    assert.ok(/_wsReconnectDelay\s*\*\s*2/.test(closeBlock),
      "must double _wsReconnectDelay on close");
  });

  it("caps delay at max (60s)", () => {
    const closeIdx = fnBody.indexOf("on(\"close\"");
    const closeBlock = fnBody.slice(closeIdx, closeIdx + 400);
    assert.ok(/Math\.min/.test(closeBlock),
      "must cap delay with Math.min");
  });

  it("applies jitter (±25%)", () => {
    const closeIdx = fnBody.indexOf("on(\"close\"");
    const closeBlock = fnBody.slice(closeIdx, closeIdx + 400);
    assert.ok(/Math\.random\(\)/.test(closeBlock),
      "must apply jitter via Math.random()");
    assert.ok(/0\.75/.test(closeBlock) || /jitter/.test(closeBlock),
      "jitter should use ±25% range");
  });

  it("has base delay constant", () => {
    const area = src.slice(Math.max(0, fnStart - 300), fnStart);
    assert.ok(/_WS_BASE_DELAY\s*=\s*2000/.test(area),
      "base delay should be 2000ms");
  });

  it("has max delay constant", () => {
    const area = src.slice(Math.max(0, fnStart - 300), fnStart);
    assert.ok(/_WS_MAX_DELAY\s*=\s*60000/.test(area),
      "max delay should be 60000ms (60s)");
  });

  it("no longer uses hardcoded setTimeout(connectBinance, 5000)", () => {
    assert.ok(!/setTimeout\(connectBinance\s*,\s*5000\)/.test(fnBody),
      "must NOT use fixed 5000ms reconnect");
  });

  it("logs reconnection delay", () => {
    assert.ok(/console\.warn.*reconectando/.test(fnBody) || /console\.log.*reconect/.test(fnBody),
      "must log reconnection delay");
  });
});
