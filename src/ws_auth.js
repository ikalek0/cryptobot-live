// ── BATCH-1 FIX #6 (H2): WebSocket authentication ──────────────────────
// Módulo puro — verifyClient factory + helpers para crypto.timingSafeEqual.
// Usado por src/server.js al crear el WebSocketServer.
//
// Contexto: hasta ahora el WebSocket del dashboard aceptaba cualquier
// conexión sin auth. La hebra ws difunde estado interno del bot
// (portfolio, trades, ledger) a todos los clientes conectados vía
// broadcast(). Sin gate, cualquier cliente en la red puede escuchar
// operativa en tiempo real.
//
// Threat model que cerramos:
//   - Lectura no autorizada de estado del bot por alguien con acceso
//     al puerto (misma LAN, túneles SSH reversos, misconfiguración de
//     firewall, contenedores vecinos).
//   - En el futuro cuando bot_secret esté saneado (FIX #8), este gate
//     se alinea con el resto de auth del sistema.
//
// Diseño:
//   - Token esperado = process.env.WS_SECRET || process.env.BOT_SECRET
//   - Si el token esperado está vacío → fail-open (dev mode), con warning
//     al arrancar. Esto permite npm test y desarrollo local sin setear
//     env vars adicionales.
//   - Si hay token esperado → verifyClient exige que el query string
//     incluya ?token=<valor> y lo compara con crypto.timingSafeEqual
//     para evitar timing attacks.
//   - La comparación se hace por LONGITUD primero (fail-fast si difieren)
//     porque timingSafeEqual crashea con buffers de distinto tamaño.
//     OJO: esto filtra longitud, pero dado que el token esperado es
//     secreto, un atacante no puede enumerar longitudes realistas.
"use strict";

const crypto = require("crypto");

// Compara dos strings en tiempo constante. Guard obligatorio de longitud:
// crypto.timingSafeEqual lanza si los buffers difieren en tamaño.
function timingSafeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (_e) {
    return false;
  }
}

// Extrae ?token=... del request.url. Devuelve "" si no hay query o no
// hay token. URLSearchParams auto-decodifica URI.
function extractToken(reqUrl) {
  if (typeof reqUrl !== "string") return "";
  const qIdx = reqUrl.indexOf("?");
  if (qIdx < 0) return "";
  const params = new URLSearchParams(reqUrl.slice(qIdx + 1));
  return params.get("token") || "";
}

// Factory: devuelve un verifyClient(info) compatible con `ws`.
// `getToken` es una función que devuelve el token esperado (leído
// de env en cada call) — esto permite actualizar WS_SECRET sin
// reiniciar el proceso si en algún momento hiciera falta, y hace
// los tests triviales porque la fixture puede mutar el closure.
function makeVerifyClient(getToken) {
  if (typeof getToken !== "function")
    throw new TypeError("makeVerifyClient: getToken must be a function");
  return function verifyClient(info) {
    const expected = getToken();
    // Fail-open: sin secret configurado → dev mode → accept all.
    if (!expected) return true;
    // Fail-closed: con secret → requiere token válido.
    if (!info || !info.req) return false;
    const provided = extractToken(info.req.url);
    return timingSafeCompare(provided, expected);
  };
}

module.exports = {
  timingSafeCompare,
  extractToken,
  makeVerifyClient,
};
