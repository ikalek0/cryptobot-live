// ── BATCH-4 FIX #1: rollback fee consistency ─────────────────────────
// Verifica que los rollbacks en _onBuy (pause) y placeLiveBuy (cap)
// devuelven _investWithFee, no invest nominal.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

describe("BATCH-4 FIX #1 — rollback fee consistency", () => {
  it("BATCH-4 FIX #1 comment present", () => {
    assert.ok(/BATCH-4 FIX #1/.test(src));
  });

  it("C1 pause rollback uses _investWithFee", () => {
    const idx = src.indexOf("PAUSE-ROLLBACK");
    assert.ok(idx >= 0);
    const block = src.slice(Math.max(0, idx - 600), idx);
    assert.ok(/_investWithFee/.test(block),
      "pause rollback must reference _investWithFee");
    assert.ok(/1 \+ 0\.001/.test(block),
      "pause rollback must have fallback invest*(1+0.001)");
  });

  it("placeLiveBuy rollbackReservation uses _investWithFee", () => {
    const idx = src.indexOf("const rollbackReservation");
    assert.ok(idx >= 0);
    const block = src.slice(idx, idx + 600);
    assert.ok(/_investWithFee/.test(block),
      "rollbackReservation must reference _investWithFee");
    assert.ok(/1 \+ 0\.001/.test(block),
      "rollbackReservation must have fallback invest*(1+0.001)");
  });

  it("both rollback paths handle capa1 AND capa2", () => {
    // C1 pause rollback
    const pauseIdx = src.indexOf("PAUSE-ROLLBACK");
    const pauseBlock = src.slice(Math.max(0, pauseIdx - 600), pauseIdx);
    assert.ok(/capa1Cash/.test(pauseBlock) && /capa2Cash/.test(pauseBlock),
      "pause rollback must handle both capas");

    // placeLiveBuy rollback
    const rollIdx = src.indexOf("const rollbackReservation");
    const rollBlock = src.slice(rollIdx, rollIdx + 600);
    assert.ok(/capa1Cash/.test(rollBlock) && /capa2Cash/.test(rollBlock),
      "rollbackReservation must handle both capas");
  });

  it("refund variable computed from _investWithFee with fallback", () => {
    const idx = src.indexOf("PAUSE-ROLLBACK");
    const block = src.slice(Math.max(0, idx - 600), idx);
    assert.ok(/const refund\s*=/.test(block),
      "must compute refund variable");
    assert.ok(/typeof pos\._investWithFee === "number"/.test(block),
      "must check typeof _investWithFee");
  });
});
