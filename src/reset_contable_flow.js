// ── /reset-contable two-step confirm flow (20 abr 2026) ──────────────────
// Máquina de estados pura para la confirmación de /reset-contable vía Telegram.
// Requisitos:
//   - primer mensaje "/reset-contable" arma un timer de 60s y muestra los
//     valores actuales (realizedPnl, totalFees, peakTv) para que el user los
//     revise antes de confirmar.
//   - segundo mensaje "/reset-contable CONFIRMAR" (case-sensitive, mayúsculas
//     exactas) dentro de los 60s ejecuta el reset.
//   - "/reset-contable CONFIRMAR" con el timer expirado o no armado pide
//     rearmar primero.
//   - cualquier otro texto devuelve acción IGNORE (el dispatcher del caller
//     decide qué hacer con ella — en telegram.js el listener solo entra aquí
//     cuando el texto coincide con uno de los dos literales).
//
// Se extrae como módulo aparte para poder testear los 4 escenarios del flow
// sin montar un servidor Telegram completo.
"use strict";

const ARMED_WINDOW_MS = 60 * 1000;
const ARM_TEXT     = "/reset-contable";
const CONFIRM_TEXT = "/reset-contable CONFIRMAR";

function handleResetContableInput({ text, now, armedUntil }) {
  if (text === ARM_TEXT) {
    return {
      action: "ARM",
      newArmedUntil: now + ARMED_WINDOW_MS,
    };
  }
  if (text === CONFIRM_TEXT) {
    const armed = Number(armedUntil) || 0;
    if (armed > 0 && now <= armed) {
      return { action: "EXECUTE", newArmedUntil: 0 };
    }
    return { action: "EXPIRED", newArmedUntil: 0 };
  }
  return { action: "IGNORE", newArmedUntil: Number(armedUntil) || 0 };
}

module.exports = {
  handleResetContableInput,
  ARMED_WINDOW_MS,
  ARM_TEXT,
  CONFIRM_TEXT,
};
