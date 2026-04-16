// ── BATCH-3 FIX #10 (#10): BAFIR_SECRET dead code ────────────────────
// sendEquityToBafir() es no-op → BAFIR_SECRET no se usa para nada.
// Eliminado de validación boot para no bloquear LIVE_MODE sin motivo.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

describe("BATCH-3 FIX #10 — BAFIR_SECRET dead code", () => {
  it("BATCH-3 FIX #10 comment present", () => {
    assert.ok(/BATCH-3 FIX #10/.test(src));
  });

  it("sendEquityToBafir fully removed (BATCH-5 FIX #6)", () => {
    assert.ok(!src.includes("function sendEquityToBafir"),
      "sendEquityToBafir must be fully removed, not just no-op");
  });

  it("BAFIR_SECRET const still declared (not removed)", () => {
    assert.ok(/const BAFIR_SECRET/.test(src),
      "BAFIR_SECRET const should still exist for potential future use");
  });

  it("BAFIR_SECRET NOT in warnPredictableSecrets checks", () => {
    const fnIdx = src.indexOf("function warnPredictableSecrets");
    assert.ok(fnIdx >= 0);
    const fnBody = src.slice(fnIdx, fnIdx + 1200);
    // Extract the checks array
    const checksIdx = fnBody.indexOf("const checks");
    const checksBlock = fnBody.slice(checksIdx, checksIdx + 300);
    assert.ok(!/BAFIR_SECRET/.test(checksBlock),
      "BAFIR_SECRET must NOT be in the checks array (dead code)");
  });

  it("SYNC_SECRET still validated at boot", () => {
    const fnIdx = src.indexOf("function warnPredictableSecrets");
    const fnBody = src.slice(fnIdx, fnIdx + 1200);
    const checksIdx = fnBody.indexOf("const checks");
    const checksBlock = fnBody.slice(checksIdx, checksIdx + 300);
    assert.ok(/SYNC_SECRET/.test(checksBlock),
      "SYNC_SECRET must still be validated");
  });

  it("BOT_SECRET still validated at boot", () => {
    const fnIdx = src.indexOf("function warnPredictableSecrets");
    const fnBody = src.slice(fnIdx, fnIdx + 1200);
    const checksIdx = fnBody.indexOf("const checks");
    const checksBlock = fnBody.slice(checksIdx, checksIdx + 300);
    assert.ok(/BOT_SECRET/.test(checksBlock),
      "BOT_SECRET must still be validated");
  });

  it("BAFIR_SECRET is not used for any auth header or authorization", () => {
    // Remove declaration line and comments, then check if BAFIR_SECRET
    // is used in any functional code
    const lines = src.split("\n");
    const functionalUses = lines.filter(l => {
      if (/^\s*\/\//.test(l)) return false; // comment line
      if (/const BAFIR_SECRET/.test(l)) return false; // declaration
      if (/name:\s*"BAFIR_SECRET"/.test(l)) return false; // old checks entry (should be gone)
      return /BAFIR_SECRET/.test(l);
    });
    assert.equal(functionalUses.length, 0,
      `BAFIR_SECRET should have zero functional uses, found: ${functionalUses.join(" | ")}`);
  });
});
