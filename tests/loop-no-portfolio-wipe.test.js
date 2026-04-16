// ── BATCH-3 FIX #1 (#11): loop reconciliation no longer wipes portfolio ──
// Antes, si S.bot.cash > S.CAPITAL_USDT * 2, el loop borraba portfolio
// y reseteaba cash. Ahora solo emite un warning (log + telegram).
//
// Estos tests verifican:
//  1) Que el bloque de wipe ya NO existe en loop.js
//  2) Que el bloque de alerta SÍ existe
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "trading", "loop.js"),
  "utf-8",
);

describe("BATCH-3 FIX #1 — loop.js no borra portfolio en reconciliación", () => {
  it("'S.bot.portfolio = {}' no aparece en loop.js", () => {
    assert.ok(!src.includes("S.bot.portfolio = {}"),
      "loop.js no debe asignar S.bot.portfolio a objeto vacío");
  });

  it("'S.bot.portfolio = {}' tampoco con espacios", () => {
    assert.ok(!/S\.bot\.portfolio\s*=\s*\{\}/.test(src),
      "loop.js no debe contener asignación de portfolio a {}");
  });

  it("reconciliación sigue detectando cash > 2x capital (alerta sin wipe)", () => {
    assert.ok(src.includes("CAPITAL_USDT * 2"),
      "debe seguir existiendo el check de cash > 2x capital");
  });

  it("bloque de alerta emite warning + tg.send (no mutación)", () => {
    const idx = src.indexOf("CAPITAL_USDT * 2");
    assert.ok(idx >= 0);
    const win = src.slice(idx, idx + 600);
    assert.ok(/inspección manual/i.test(win),
      "bloque debe contener 'inspección manual'");
    assert.ok(/tg\.send/.test(win),
      "bloque debe enviar telegram");
    // No debe resetear cash ni maxEquity
    assert.ok(!/S\.bot\.cash\s*=\s*S\.CAPITAL_USDT/.test(win),
      "NO debe asignar S.bot.cash en el bloque de alerta");
    assert.ok(!/S\.bot\.maxEquity\s*=/.test(win),
      "NO debe asignar S.bot.maxEquity en el bloque de alerta");
  });

  it("comentario BATCH-3 FIX #1 presente", () => {
    assert.ok(/BATCH-3 FIX #1/.test(src));
  });
});
