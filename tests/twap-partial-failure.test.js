// ── BATCH-3 FIX #5 (#17): TWAP partial failure handling ──────────────
// Source-check: verifica que placeTWAPBuy ya NO silencia errores
// de partes intermedias y SÍ alerta de fill parcial via telegram.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

const fnStart = src.indexOf("async function placeTWAPBuy(");
assert.ok(fnStart >= 0, "placeTWAPBuy must exist");
const fnBody = src.slice(fnStart, fnStart + 3000);

describe("BATCH-3 FIX #5 — TWAP partial failure handling", () => {
  it("BATCH-3 FIX #5 comment present", () => {
    // Comment is right before the function
    const commentArea = src.slice(Math.max(0, fnStart - 500), fnStart + 200);
    assert.ok(/BATCH-3 FIX #5/.test(commentArea));
  });

  it("tracks failures in array", () => {
    assert.ok(/const failures\s*=\s*\[\]/.test(fnBody),
      "debe inicializar array de failures");
    assert.ok(/failures\.push\(/.test(fnBody),
      "debe acumular failures");
  });

  it("alerts on partial fill (orders > 0 AND failures > 0)", () => {
    assert.ok(/failures\.length\s*>\s*0\s*&&\s*orders\.length\s*>\s*0/.test(fnBody),
      "debe detectar fill parcial");
    assert.ok(/tg\.send/.test(fnBody),
      "debe enviar telegram en fill parcial");
    assert.ok(/Fill parcial/.test(fnBody),
      "mensaje debe contener 'Fill parcial'");
  });

  it("logs each individual part error", () => {
    assert.ok(/console\.error.*TWAP.*BUY.*error/.test(fnBody),
      "debe loguear cada error de parte");
  });

  it("shows sizing porcentaje in alert", () => {
    assert.ok(/Sizing efectivo/.test(fnBody),
      "debe mostrar sizing efectivo en %");
  });

  it("accepts strategyId in options for alert context", () => {
    assert.ok(/strategyId/.test(fnBody),
      "debe aceptar strategyId para tracking");
  });

  it("TWAP loop catch pushes to failures", () => {
    // Find the for loop's catch block (not the balance check catch)
    // The for loop catch is after binanceRequest and pushes to failures
    const forIdx = fnBody.indexOf("for (let i = 0");
    assert.ok(forIdx >= 0, "for loop must exist");
    const forBody = fnBody.slice(forIdx, forIdx + 1000);
    assert.ok(/failures\.push/.test(forBody),
      "catch inside for loop must push to failures");
  });

  it("placeLiveBuy passes strategyId to placeTWAPBuy", () => {
    // Check the call site
    const callIdx = src.indexOf("placeTWAPBuy(symbol, safe");
    assert.ok(callIdx >= 0, "call to placeTWAPBuy must exist");
    const callLine = src.slice(callIdx, callIdx + 200);
    assert.ok(/strategyId/.test(callLine),
      "call must pass strategyId");
  });
});
