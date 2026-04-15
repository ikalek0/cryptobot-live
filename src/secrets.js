// ── BATCH-1 FIX #8 (#5): BOT_SECRET hardening ──────────────────────────
// Helper puro para comparar secrets en tiempo constante + boot guard
// contra secrets predecibles. Reemplaza el patrón inline `secret !==
// (process.env.BOT_SECRET || "bafir_bot_secret")` que tenía tres
// problemas:
//
//   1) El literal "bafir_bot_secret" está en git público (claude/
//      cryptobot-live). Cualquiera con acceso al repo sabe el secret
//      default, puede disparar /api/set-capital, /api/reset-state,
//      /api/shadow/*, /api/sync/* contra el puerto del bot sin más.
//   2) Comparación con `!==` es timing-sensitive (microsegundos, pero
//      explotable con ruido bajo y réplica controlada). timingSafeEqual
//      elimina el leak.
//   3) warnPredictableSecrets avisaba SOLO cuando el env var estaba
//      vacío. No detectaba el caso de un admin que copia el default
//      hardcoded en .env (pensando que eso "arregla" el warning).
//
// Diseño:
//   - PREDICTABLE_SECRETS: set de strings triviales que NUNCA deben
//     aceptarse, incluso si se setean en env.
//   - validateBootSecret: evalúa env value. Motivos de rechazo:
//     empty, predictable, too_short (<16 chars).
//   - makeBotSecretChecker: factory que devuelve un checker(provided).
//     Fail-closed: si el env value no es válido, el checker SIEMPRE
//     devuelve false — ni siquiera con el "bafir_bot_secret" literal.
//   - timingSafeCompare: mismo helper que src/ws_auth.js (duplicado
//     intencional para no acoplar módulos independientes).
"use strict";

const crypto = require("crypto");

// Secrets que NUNCA son aceptables, independientemente de cómo lleguen.
// Lower-cased para comparación case-insensitive.
const PREDICTABLE_SECRETS = new Set([
  "bafir_bot_secret",
  "paper_live_sync_secret",
  "changeme",
  "change_me",
  "changeme!",
  "secret",
  "password",
  "passw0rd",
  "admin",
  "admin123",
  "default",
  "test",
  "test123",
  "letmein",
  "qwerty",
  "12345",
  "123456",
  "bot_secret",
  "api_key",
]);

function timingSafeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (_e) {
    return false;
  }
}

function isPredictableSecret(s) {
  if (typeof s !== "string") return false;
  return PREDICTABLE_SECRETS.has(s.toLowerCase().trim());
}

// Devuelve { ok, reason } — reason ∈ {undefined, "empty", "predictable", "too_short"}.
// Longitud mínima 16 chars porque valores más cortos son brute-forceables
// en pocos minutos con un rate limiter laxo. 16 chars alfanuméricos ~ 95 bits.
function validateBootSecret(envValue) {
  if (!envValue) return { ok: false, reason: "empty" };
  if (isPredictableSecret(envValue)) return { ok: false, reason: "predictable" };
  if (envValue.length < 16) return { ok: false, reason: "too_short" };
  return { ok: true };
}

// Factory del checker. Uso:
//   const checkBotSecret = makeBotSecretChecker(() => process.env.BOT_SECRET);
//   if (!checkBotSecret(req.body.secret)) return onAuthFailure(req, res);
//
// El closure evalúa process.env en cada call (permite cambios en runtime
// si en algún momento hiciera falta — tests dependen de esto).
function makeBotSecretChecker(getEnvValue) {
  if (typeof getEnvValue !== "function")
    throw new TypeError("makeBotSecretChecker: getEnvValue must be a function");
  return function checkBotSecret(provided) {
    if (typeof provided !== "string") return false;
    const envValue = getEnvValue();
    const v = validateBootSecret(envValue);
    if (!v.ok) return false; // fail-closed: env mal configurado
    return timingSafeCompare(provided, envValue);
  };
}

module.exports = {
  PREDICTABLE_SECRETS,
  timingSafeCompare,
  isPredictableSecret,
  validateBootSecret,
  makeBotSecretChecker,
};
