// ── BATCH-1 FIX #7 (HIGH-4): in-memory rate limiter ────────────────────
// Sliding-window rate limiter sin dependencias externas. Reemplaza al
// `src/security.js` viejo (dead code — nadie lo requería y sufría de
// F15 setInterval sin .unref, F17 x-forwarded-for trust issue, F18
// sanitize insuficiente). Aquí implementamos SÓLO lo que el bot necesita:
// rate limiting en endpoints mutantes del server.js.
//
// Threat model cerrado:
//   - Brute force del BOT_SECRET en /api/set-capital, /api/reset-state,
//     /api/shadow/* etc. Sin rate limit, un atacante con RTT bajo puede
//     probar ~100k secrets/min desde la misma IP.
//   - DoS por spam de /api/reset-state vacío (aunque rechaza con 401,
//     cada call despierta los handlers de auth y consume CPU/log).
//
// Diseño:
//   - Bucket `{key → [timestamps]}`. Sliding window: al cada check
//     filtramos timestamps más viejos que `windowMs` y comparamos el
//     conteo fresco con `max`.
//   - dos buckets separados por IP:
//       "mut:<ip>"  → 10 requests / 60s (aplicado como middleware)
//       "auth:<ip>" →  5 failures / 15min (hit MANUAL tras fallo de auth)
//   - cleanup interval con .unref() para que los tests terminen y el
//     proceso pueda morir sin residuo.
//   - IP extraction: req.socket.remoteAddress SIEMPRE. NO confiamos en
//     x-forwarded-for por defecto (el bot corre directo en Hetzner, no
//     detrás de un reverse proxy). Si en el futuro hay proxy, set
//     TRUST_PROXY=true y la lógica lee la primera IP del xff header.
//
// Expuesto:
//   SlidingWindowLimiter  — clase con check/hit/checkAndHit/middleware
//   extractIp(req)        — helper exportado para tests y routes manuales
"use strict";

// Ventana grande por defecto para cleanup (más larga que cualquier
// windowMs real — si no, los entries se borrarían mientras el window
// todavía está activo).
const MAX_KNOWN_WINDOW_MS = 15 * 60 * 1000;

function extractIp(req) {
  if (!req) return "unknown";
  // Con TRUST_PROXY=true, aceptamos la primera IP de x-forwarded-for.
  // Sin eso, req.socket.remoteAddress es imposible de spoofear desde el
  // cliente (la TCP handshake ya está establecida con esa IP).
  if (process.env.TRUST_PROXY === "true") {
    const xff = req.headers && req.headers["x-forwarded-for"];
    if (xff) {
      const first = String(xff).split(",")[0].trim();
      if (first) return first;
    }
  }
  return (req.socket && req.socket.remoteAddress) || req.ip || "unknown";
}

class SlidingWindowLimiter {
  constructor() {
    /** @type {Map<string, number[]>} */
    this.buckets = new Map();
    // .unref() para no mantener el proceso vivo sólo por el cleanup.
    // Esto es crítico para que `node --test` termine sin colgarse.
    this._cleanupTimer = setInterval(() => this._cleanup(), 60_000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  stop() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  clear() {
    this.buckets.clear();
  }

  // Limpia entries más viejas que la ventana máxima conocida.
  // Si un key queda con zero timestamps → se elimina.
  _cleanup(now = Date.now()) {
    for (const [k, ts] of this.buckets) {
      const fresh = ts.filter(t => now - t < MAX_KNOWN_WINDOW_MS);
      if (fresh.length === 0) this.buckets.delete(k);
      else this.buckets.set(k, fresh);
    }
  }

  // Sólo consulta: devuelve { ok, count, retryAfterMs } sin mutar.
  check(key, max, windowMs, now = Date.now()) {
    const all = this.buckets.get(key) || [];
    const fresh = all.filter(t => now - t < windowMs);
    const ok = fresh.length < max;
    const retryAfterMs = ok ? 0 : windowMs - (now - fresh[0]);
    return { ok, count: fresh.length, retryAfterMs };
  }

  // Registra un hit — también filtra el window.
  hit(key, windowMs, now = Date.now()) {
    const all = this.buckets.get(key) || [];
    const fresh = all.filter(t => now - t < windowMs);
    fresh.push(now);
    this.buckets.set(key, fresh);
    return fresh.length;
  }

  // Atómico: si ok, hit; devuelve el resultado del check PRE-hit.
  checkAndHit(key, max, windowMs, now = Date.now()) {
    const r = this.check(key, max, windowMs, now);
    if (r.ok) this.hit(key, windowMs, now);
    return r;
  }

  // Middleware Express. max/windowMs/bucket fijos por instancia.
  // bucket: string para separar distintos tipos de rate limit por IP.
  middleware({ max, windowMs, bucket = "mut", onBlock }) {
    if (typeof max !== "number" || max <= 0)
      throw new TypeError("middleware: max must be a positive number");
    if (typeof windowMs !== "number" || windowMs <= 0)
      throw new TypeError("middleware: windowMs must be a positive number");
    return (req, res, next) => {
      const key = `${bucket}:${extractIp(req)}`;
      const r = this.checkAndHit(key, max, windowMs);
      if (!r.ok) {
        if (typeof onBlock === "function") {
          try { onBlock(key, req); } catch (_) {}
        }
        const retryAfterSec = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
        res.setHeader("Retry-After", String(retryAfterSec));
        return res.status(429).json({
          error: "Too many requests",
          retryAfterSec,
        });
      }
      next();
    };
  }
}

module.exports = {
  SlidingWindowLimiter,
  extractIp,
  MAX_KNOWN_WINDOW_MS,
};
