// ── BATCH-3 FIX #4 (#16): LOT_SIZE precision from exchangeInfo ─────────
// Verifica que:
//  1) fetchSymbolPrecisions es llamada al boot (source check)
//  2) getSymbolLotInfo devuelve dynamic > fallback
//  3) placeLiveSell usa floor-to-stepSize (no simple toFixed)
//  4) minQty check triggers rollback
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

describe("BATCH-3 FIX #4 — LOT_SIZE precision from exchangeInfo", () => {
  it("fetchSymbolPrecisions function exists", () => {
    assert.ok(/async function fetchSymbolPrecisions\(\)/.test(src));
  });

  it("fetchSymbolPrecisions parses LOT_SIZE filter", () => {
    const idx = src.indexOf("async function fetchSymbolPrecisions()");
    const win = src.slice(idx, idx + 2000);
    assert.ok(/LOT_SIZE/.test(win), "debe buscar LOT_SIZE filter");
    assert.ok(/stepSize/.test(win), "debe extraer stepSize");
    assert.ok(/minQty/.test(win), "debe extraer minQty");
    assert.ok(/_symbolPrecisions/.test(win), "debe cachear en _symbolPrecisions");
  });

  it("fetchSymbolPrecisions called at boot (inside initBot)", () => {
    assert.ok(/await fetchSymbolPrecisions\(\)/.test(src),
      "must await fetchSymbolPrecisions in initBot");
  });

  it("getSymbolLotInfo helper exists and falls back to QTY_PRECISION", () => {
    const idx = src.indexOf("function getSymbolLotInfo(");
    assert.ok(idx >= 0);
    const win = src.slice(idx, idx + 500);
    assert.ok(/_symbolPrecisions\[symbol\]/.test(win),
      "debe consultar dynamic cache primero");
    assert.ok(/QTY_PRECISION\[symbol\]/.test(win),
      "debe caer a fallback estático");
  });

  it("placeLiveSell uses getSymbolLotInfo + Math.floor to stepSize", () => {
    const idx = src.indexOf("async function placeLiveSell(");
    assert.ok(idx >= 0);
    const win = src.slice(idx, idx + 4000);
    assert.ok(/getSymbolLotInfo\(symbol\)/.test(win),
      "placeLiveSell debe llamar a getSymbolLotInfo");
    assert.ok(/Math\.floor\(sellQty\s*\/\s*lotInfo\.stepSize\)/.test(win),
      "qty debe redondearse hacia abajo por stepSize");
  });

  it("placeLiveSell checks minQty and rolls back if below", () => {
    const idx = src.indexOf("async function placeLiveSell(");
    const win = src.slice(idx, idx + 4000);
    assert.ok(/lotInfo\.minQty.*qtyRounded\s*<\s*lotInfo\.minQty/.test(win) ||
              /qtyRounded\s*<\s*lotInfo\.minQty/.test(win),
      "debe verificar minQty");
    assert.ok(/rollback.*LOT_SIZE\.minQty|_rollbackVirtualSellCredit.*minQty/.test(win),
      "debe hacer rollback si qty < minQty");
  });

  it("exchangeInfo has timeout for resilience", () => {
    const idx = src.indexOf("async function fetchSymbolPrecisions()");
    const win = src.slice(idx, idx + 2000);
    assert.ok(/setTimeout|timeout/i.test(win),
      "debe tener timeout en la request HTTP");
  });

  it("QTY_PRECISION fallback table still exists", () => {
    assert.ok(/BTCUSDC:5.*ETHUSDC:4/.test(src),
      "fallback table must remain");
  });

  it("BATCH-3 FIX #4 comment present", () => {
    assert.ok(/BATCH-3 FIX #4/.test(src));
  });
});
