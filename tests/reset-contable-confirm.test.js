// ── /reset-contable two-step confirmation flow (20 abr 2026) ──────────────
// Testea la máquina pura handleResetContableInput de src/reset_contable_flow.js.
// Casos: disparo inicial arma timer, confirmación correcta en ventana ejecuta,
// confirmación con texto incorrecto no ejecuta, confirmación tras 60s expira.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  handleResetContableInput,
  ARMED_WINDOW_MS,
  ARM_TEXT,
  CONFIRM_TEXT,
} = require("../src/reset_contable_flow");

describe("/reset-contable confirmation flow — máquina de estados", () => {
  it("primer disparo '/reset-contable' arma timer 60s", () => {
    const now = 1000000;
    const r = handleResetContableInput({ text: ARM_TEXT, now, armedUntil: 0 });
    assert.equal(r.action, "ARM");
    assert.equal(r.newArmedUntil, now + ARMED_WINDOW_MS);
  });

  it("confirmación dentro de 60s ejecuta", () => {
    const now0 = 1000000;
    const arm = handleResetContableInput({ text: ARM_TEXT, now: now0, armedUntil: 0 });
    const now1 = now0 + 30 * 1000; // 30s después, dentro de ventana
    const r = handleResetContableInput({ text: CONFIRM_TEXT, now: now1, armedUntil: arm.newArmedUntil });
    assert.equal(r.action, "EXECUTE");
    assert.equal(r.newArmedUntil, 0, "armed clear tras execute");
  });

  it("confirmación justo en el borde (exactamente 60s) ejecuta (<=)", () => {
    const now0 = 1000000;
    const arm = handleResetContableInput({ text: ARM_TEXT, now: now0, armedUntil: 0 });
    const now1 = arm.newArmedUntil; // exactamente en el borde
    const r = handleResetContableInput({ text: CONFIRM_TEXT, now: now1, armedUntil: arm.newArmedUntil });
    assert.equal(r.action, "EXECUTE", "borde exacto cuenta como dentro de ventana");
  });

  it("confirmación a los 60.001s expira → pide rearmar", () => {
    const now0 = 1000000;
    const arm = handleResetContableInput({ text: ARM_TEXT, now: now0, armedUntil: 0 });
    const now1 = arm.newArmedUntil + 1; // 1ms pasado
    const r = handleResetContableInput({ text: CONFIRM_TEXT, now: now1, armedUntil: arm.newArmedUntil });
    assert.equal(r.action, "EXPIRED");
    assert.equal(r.newArmedUntil, 0);
  });

  it("confirmación sin armar previo expira", () => {
    const r = handleResetContableInput({ text: CONFIRM_TEXT, now: 1000000, armedUntil: 0 });
    assert.equal(r.action, "EXPIRED");
  });

  it("texto de confirmación case-sensitive: 'confirmar' minúsculas NO ejecuta", () => {
    const now0 = 1000000;
    const arm = handleResetContableInput({ text: ARM_TEXT, now: now0, armedUntil: 0 });
    const r = handleResetContableInput({
      text: "/reset-contable confirmar",
      now: now0 + 10000,
      armedUntil: arm.newArmedUntil,
    });
    assert.equal(r.action, "IGNORE", "minúsculas ignoradas, el armed persiste para la confirmación correcta");
    assert.equal(r.newArmedUntil, arm.newArmedUntil, "armed timer preservado");
  });

  it("texto de confirmación parcial '/reset-contable CONFIRM' (sin AR final) NO ejecuta", () => {
    const now0 = 1000000;
    const arm = handleResetContableInput({ text: ARM_TEXT, now: now0, armedUntil: 0 });
    const r = handleResetContableInput({
      text: "/reset-contable CONFIRM",
      now: now0 + 10000,
      armedUntil: arm.newArmedUntil,
    });
    assert.equal(r.action, "IGNORE");
    assert.equal(r.newArmedUntil, arm.newArmedUntil);
  });

  it("re-ARM después de EXPIRED funciona normalmente", () => {
    const now0 = 1000000;
    // Primer ARM
    const arm1 = handleResetContableInput({ text: ARM_TEXT, now: now0, armedUntil: 0 });
    // EXPIRE (reset implícito vía el caller al ver EXPIRED)
    const exp = handleResetContableInput({ text: CONFIRM_TEXT, now: arm1.newArmedUntil + 5000, armedUntil: arm1.newArmedUntil });
    assert.equal(exp.action, "EXPIRED");
    // Segundo ARM limpio
    const arm2 = handleResetContableInput({ text: ARM_TEXT, now: now0 + 120000, armedUntil: exp.newArmedUntil });
    assert.equal(arm2.action, "ARM");
    // Confirmación dentro del segundo ARM ejecuta
    const r = handleResetContableInput({ text: CONFIRM_TEXT, now: now0 + 120000 + 10000, armedUntil: arm2.newArmedUntil });
    assert.equal(r.action, "EXECUTE");
  });

  it("textos no relacionados devuelven IGNORE sin tocar armedUntil", () => {
    const r1 = handleResetContableInput({ text: "/estado", now: 1000, armedUntil: 5000 });
    assert.equal(r1.action, "IGNORE");
    assert.equal(r1.newArmedUntil, 5000);
    const r2 = handleResetContableInput({ text: "random text", now: 1000, armedUntil: 0 });
    assert.equal(r2.action, "IGNORE");
    assert.equal(r2.newArmedUntil, 0);
  });
});
