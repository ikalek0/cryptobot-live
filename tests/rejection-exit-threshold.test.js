// ── BATCH-4 FIX #2: unhandledRejection exit threshold ────────────────
// >20 rejections en 60s → process.exit(1) para evitar estado degradado.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

const handlerIdx = src.indexOf("process.on(\"unhandledRejection\"");
assert.ok(handlerIdx >= 0, "unhandledRejection handler must exist");
const handlerBody = src.slice(handlerIdx, handlerIdx + 1500);

describe("BATCH-4 FIX #2 — unhandledRejection exit threshold", () => {
  it("BATCH-4 FIX #2 comment present", () => {
    const area = src.slice(Math.max(0, handlerIdx - 300), handlerIdx + 300);
    assert.ok(/BATCH-4 FIX #2/.test(area));
  });

  it("_rejectionWindow array declared", () => {
    const area = src.slice(Math.max(0, handlerIdx - 300), handlerIdx);
    assert.ok(/_rejectionWindow\s*=\s*\[\]/.test(area),
      "must declare _rejectionWindow as empty array");
  });

  it("pushes timestamps to _rejectionWindow", () => {
    assert.ok(/_rejectionWindow\.push\(/.test(handlerBody),
      "must push to _rejectionWindow");
  });

  it("filters window to last 60s", () => {
    assert.ok(/60000/.test(handlerBody),
      "must filter by 60000ms (60s)");
    assert.ok(/_rejectionWindow\s*=\s*_rejectionWindow\.filter/.test(handlerBody),
      "must reassign filtered window");
  });

  it("exits when >20 rejections in window", () => {
    assert.ok(/_rejectionWindow\.length\s*>\s*20/.test(handlerBody),
      "threshold must be >20");
    assert.ok(/process\.exit\(1\)/.test(handlerBody),
      "must call process.exit(1)");
  });

  it("saves state before exit", () => {
    const exitIdx = handlerBody.indexOf("_rejectionWindow.length > 20");
    const exitBlock = handlerBody.slice(exitIdx, exitIdx + 400);
    assert.ok(/await save\(\)/.test(exitBlock),
      "must save state before exit");
  });
});
