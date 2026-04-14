// ─── SECURITY MODULE ─────────────────────────────────────────────────────────
// Todas las medidas de seguridad centralizadas en un módulo
//
// ⚠️  ESTADO (abril 2026): DEAD CODE — ningún módulo hace require('./security').
// server.js reinventa HMAC verification inline (lines 382-392, 418-425) y
// secret checks inline (lines 475, 482, 494, 504) en vez de usar requireHmac().
//
// Endpoints Express NO tienen:
//   - rate limiting (rateLimiter.limit no aplicado a ninguna ruta)
//   - security headers (securityHeaders no montado)
//   - CORS restringido (corsRestricted no montado)
//   - input validation (validateInput sin uso)
//   - sanitization (sanitize/sanitizeBody sin uso)
//
// Acción pendiente (Iñigo): decidir wire-up a server.js o delete completo.
// Mientras tanto, los defectos latentes del módulo están reportados pero NO
// fixes agresivos — sería mover silla de un fuego que no arde.
//
// Bugs latentes conocidos (F15-F18, audit bloque 1.3):
//   - F15 RateLimiter setInterval sin .unref() (keeps process alive)
//   - F16 corsRestricted endsWith() suffix bypass (evilfoo.com passes foo.com check)
//   - F17 _getKey() trusts x-forwarded-for sin trust-proxy config
//   - F18 sanitize() insuficiente para XSS (sólo strip <>, no HTML-escape)
//
"use strict";

const crypto = require("crypto");

// ── RATE LIMITER GENERAL ──────────────────────────────────────────────────────
class RateLimiter {
  constructor() {
    this.store = {}; // { key: { count, firstAttempt, blocked } }
    // Limpiar cada 10 minutos. .unref() para no bloquear process exit
    // (tests limpios + no mantener proceso vivo sólo por el cleanup).
    this._cleanupTimer = setInterval(() => this._cleanup(), 10 * 60 * 1000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }
  stop() { if(this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; } }

  _cleanup() {
    const now = Date.now();
    Object.keys(this.store).forEach(k => {
      const e = this.store[k];
      if (now - e.firstAttempt > 60 * 60 * 1000) delete this.store[k];
    });
  }

  _getKey(req) {
    return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
           req.socket?.remoteAddress || "unknown";
  }

  // Middleware configurable por ruta
  limit(options = {}) {
    const {
      maxAttempts = 60,
      windowMs    = 60 * 1000,     // 1 minuto
      message     = "Demasiadas peticiones. Intenta más tarde.",
      onBlock     = null,          // callback cuando se bloquea
    } = options;

    return (req, res, next) => {
      const key = this._getKey(req);
      const now = Date.now();

      if (!this.store[key]) this.store[key] = { count:0, firstAttempt:now };
      const entry = this.store[key];

      if (now - entry.firstAttempt > windowMs) {
        entry.count = 0; entry.firstAttempt = now; entry.blocked = false;
      }

      entry.count++;

      if (entry.count > maxAttempts) {
        if (!entry.blocked) {
          entry.blocked = true;
          if (onBlock) onBlock(key, entry.count, req.path);
          console.warn(`[SECURITY] Rate limit activado: ${key} → ${req.path} (${entry.count} reqs)`);
        }
        const retryAfter = Math.ceil((entry.firstAttempt + windowMs - now) / 1000);
        res.setHeader("Retry-After", retryAfter);
        return res.status(429).json({ error: message, retryAfter });
      }
      next();
    };
  }
}

const rateLimiter = new RateLimiter();

// ── SECURITY HEADERS (equivalente a Helmet sin dependencia) ───────────────────
function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options",    "nosniff");
  res.setHeader("X-Frame-Options",           "DENY");
  res.setHeader("X-XSS-Protection",          "1; mode=block");
  res.setHeader("Referrer-Policy",           "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy",        "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' wss: ws:;"
  );
  // No cachear rutas de API
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma",        "no-cache");
  }
  next();
}

// ── CORS RESTRINGIDO ──────────────────────────────────────────────────────────
// F16 fix: el match anterior usaba origin.endsWith(o) → "evilexample.com"
// pasaba un filtro "example.com" (classic subdomain-suffix bypass). Ahora exige
// match exacto, o prefijo ".domain" (subdominios legítimos explícitos).
function _matchOrigin(origin, allowed) {
  if (!origin) return false;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    for (const o of allowed) {
      const needle = o.toLowerCase().trim();
      if (!needle) continue;
      // Match exacto del origin completo (con protocolo)
      if (origin.toLowerCase() === needle) return true;
      // Match exacto del hostname
      if (hostname === needle) return true;
      // Match de subdominio legítimo: "foo.example.com" match "example.com"
      // pero "evilexample.com" NO match "example.com"
      if (hostname.endsWith("." + needle)) return true;
    }
  } catch(e) { return false; }
  return false;
}

function corsRestricted(allowedOrigins = []) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    // En desarrollo permitir localhost
    const isDev = process.env.NODE_ENV !== "production";
    if (isDev || !origin || allowedOrigins.length === 0 ||
        _matchOrigin(origin, allowedOrigins)) {
      if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    } else {
      console.warn(`[SECURITY] CORS bloqueado: ${origin}`);
      return res.status(403).json({ error: "Origen no permitido" });
    }
    res.setHeader("Access-Control-Allow-Methods",  "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers",  "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials","true");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

// ── INPUT VALIDATION ─────────────────────────────────────────────────────────
function validateInput(schema) {
  return (req, res, next) => {
    for (const [field, rules] of Object.entries(schema)) {
      const val = req.body[field];
      if (rules.required && (val === undefined || val === null || val === "")) {
        return res.status(400).json({ error: `Campo requerido: ${field}` });
      }
      if (val !== undefined) {
        if (rules.type === "number" && isNaN(+val)) {
          return res.status(400).json({ error: `${field} debe ser un número` });
        }
        if (rules.type === "string" && typeof val !== "string") {
          return res.status(400).json({ error: `${field} debe ser texto` });
        }
        if (rules.maxLength && String(val).length > rules.maxLength) {
          return res.status(400).json({ error: `${field} demasiado largo (máx ${rules.maxLength})` });
        }
        if (rules.min !== undefined && +val < rules.min) {
          return res.status(400).json({ error: `${field} mínimo: ${rules.min}` });
        }
        if (rules.max !== undefined && +val > rules.max) {
          return res.status(400).json({ error: `${field} máximo: ${rules.max}` });
        }
      }
    }
    next();
  };
}

// ── HMAC SIGNATURE para sync paper→live ──────────────────────────────────────
function signPayload(payload, secret) {
  const str = typeof payload === "string" ? payload : JSON.stringify(payload);
  return crypto.createHmac("sha256", secret).update(str).digest("hex");
}

function verifySignature(payload, signature, secret) {
  const expected = signPayload(payload, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch(e) { return false; }
}

// Middleware para verificar firma HMAC en el sync
function requireHmac(secret) {
  return (req, res, next) => {
    const sig = req.headers["x-signature"];
    if (!sig) return res.status(401).json({ error:"Firma requerida" });
    const body = JSON.stringify(req.body);
    if (!verifySignature(body, sig, secret)) {
      console.warn("[SECURITY] Firma HMAC inválida — posible intento de manipulación");
      return res.status(401).json({ error:"Firma inválida" });
    }
    next();
  };
}

// ── LOG DE SEGURIDAD ──────────────────────────────────────────────────────────
function securityLogger(req, res, next) {
  const ip       = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress;
  const start    = Date.now();
  const original = res.end.bind(res);

  res.end = function(...args) {
    const ms = Date.now() - start;
    // Log peticiones sospechosas (errores 4xx en rutas de API)
    if (req.path.startsWith("/api/") && res.statusCode >= 400) {
      console.warn(`[SECURITY] ${res.statusCode} ${req.method} ${req.path} — IP: ${ip} — ${ms}ms`);
    }
    original(...args);
  };
  next();
}

// ── SANITIZAR STRINGS (prevenir injection) ────────────────────────────────────
function sanitize(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/[<>]/g, "")        // XSS básico
    .replace(/[\x00-\x1F]/g, "") // caracteres de control
    .trim()
    .slice(0, 500);              // truncar
}

function sanitizeBody(fields) {
  return (req, res, next) => {
    if (req.body) {
      fields.forEach(f => {
        if (req.body[f] && typeof req.body[f] === "string") {
          req.body[f] = sanitize(req.body[f]);
        }
      });
    }
    next();
  };
}

module.exports = {
  rateLimiter,
  securityHeaders,
  corsRestricted,
  validateInput,
  signPayload,
  verifySignature,
  requireHmac,
  securityLogger,
  sanitize,
  sanitizeBody,
};
