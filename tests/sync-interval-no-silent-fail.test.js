// ── BATCH-3 FIX #3 (#4): sync interval no longer silences errors ─────
// Source-check: verifica que el setInterval de sync periódico ya NO
// usa .catch(()=>{}) y SÍ tiene error tracking con telegram alert.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

// Find the sync interval block
const marker = "BATCH-3 FIX #3";
const idx = src.indexOf(marker);

describe("BATCH-3 FIX #3 — sync interval no silent fail", () => {
  it("BATCH-3 FIX #3 comment present", () => {
    assert.ok(idx >= 0);
  });

  const win = src.slice(idx, idx + 2000);

  it("setInterval uses async callback (no fire-and-forget)", () => {
    assert.ok(/setInterval\(async\s*\(\)/.test(win),
      "setInterval callback debe ser async");
  });

  it("try/catch block logs error with count", () => {
    assert.ok(/_syncIntervalFailCount/.test(win),
      "debe trackear fail count");
    assert.ok(/console\.error.*SYNC-INTERVAL/.test(win),
      "debe loguear errores del sync");
  });

  it("5 consecutive failures trigger telegram alert (no spam)", () => {
    assert.ok(/_syncIntervalFailCount\s*===\s*5/.test(win),
      "debe alertar exactamente al 5º fallo");
    assert.ok(/tg\.send/.test(win),
      "debe enviar telegram al 5º fallo");
  });

  it("success resets fail counter", () => {
    assert.ok(/_syncIntervalFailCount\s*=\s*0/.test(win),
      "éxito debe resetear el contador");
  });

  it("recovery after failures is logged", () => {
    assert.ok(/recovered after/.test(win),
      "debe loguear cuando se recupera tras fallos");
  });

  it("old .catch(()=>{}) pattern is gone", () => {
    // The sync interval block should NOT have the old swallow pattern
    assert.ok(!/syncCapitalFromBinance\([^)]*\)\.catch\(\(\)\s*=>\s*\{\}\)/.test(win),
      "NO debe tener .catch(()=>{}) en el sync interval");
  });
});
