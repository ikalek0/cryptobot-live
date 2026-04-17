// ── BATCH-1 HIGH-3: Binance signed request client ───────────────────────
// Módulo extraído de src/server.js. Pure HTTP client — no lee env vars, no
// accede a estado global. server.js le pasa apiKey/apiSecret en cada call.
//
// Responsabilidades:
//  - Firma HMAC-SHA256 estándar de Binance
//  - recvWindow=10000 añadido automáticamente (Binance default 5000 es
//    demasiado agresivo con NTP drift o red congestionada)
//  - Retry con backoff (500ms, 1500ms, 2500ms) para errores transientes:
//      -1003 (rate limit exceeded)
//      -1021 (timestamp outside recvWindow)
//      ECONNRESET / ETIMEDOUT / EAI_AGAIN / Timeout (red)
//  - Parseo de response.code<0 — lanza Error con el code.msg
//
// Bug previo de server.js: binanceRequest resolvía el body JSON incluso si
// contenía `{code: -2010, msg: "insufficient balance"}`. El caller (placeLiveBuy)
// continuaba asumiendo éxito, pasaba undefined a applyRealBuyFill, y el
// ledger quedaba incoherente. Ahora lanzamos Error antes de devolver.
//
// Testabilidad: setHttpOnce(fn) permite monkey-patchar la capa HTTP
// en tests para simular respuestas / errores sin conectar a Binance.
"use strict";

const crypto = require("crypto");
const https  = require("https");

// Capa HTTP inyectable (por defecto hits api.binance.com con 8s timeout).
// Tests llaman setHttpOnce(fakeFn) para interceptar.
let _httpOnce = function (options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`JSON parse fail: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
};

function setHttpOnce(fn) {
  if (typeof fn !== "function") throw new TypeError("setHttpOnce requires a function");
  _httpOnce = fn;
}

function resetHttpOnce() {
  _httpOnce = function (options) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, res => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => {
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error(`JSON parse fail: ${e.message}`)); }
        });
      });
      req.on("error", reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
      req.end();
    });
  };
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Errores que consideramos retryables.
function isRetryableError(err) {
  if (!err) return false;
  const msg = err.message || "";
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|Timeout/i.test(msg)) return true;
  if (/-1003|-1021/.test(msg)) return true;
  return false;
}

// Calcula el delay del backoff para un intento dado (0-indexed).
// 0 → 500ms, 1 → 1500ms (crece lineal)
function _backoffMs(attempt) {
  return 500 * (attempt + 1) + 500;
}

// Request firmado con retry. Opciones:
//   method, path (sin /api/v3/ prefix), params, apiKey, apiSecret
//   readOnly (bool, default false) — si true: solo GET, exige keys
//   maxRetries (default 2 → 3 intentos totales)

async function publicRequest(method, endpoint, params = {}) {
  const base = (process.env.BINANCE_BASE_URL || 'https://api.binance.com').replace(/\/+$/, '');
  const qs = new URLSearchParams(params).toString();
  const url = base + '/api/v3/' + String(endpoint).replace(/^\/+/, '') + (qs ? '?' + qs : '');
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: (method || 'GET').toUpperCase(), timeout: 10000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (res.statusCode >= 400) {
            const e = new Error('Binance public ' + res.statusCode + ': ' + (j.msg || d));
            e.code = j.code; e.status = res.statusCode;
            return reject(e);
          }
          resolve(j);
        } catch (e) { reject(new Error('parse: ' + e.message + ' :: ' + d.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Binance public timeout')));
    req.end();
  });
}

async function signedRequest({
  method,
  path,
  params = {},
  apiKey,
  apiSecret,
  readOnly = false,
  maxRetries = 2,
}) {
  if (readOnly) {
    if (!apiKey || !apiSecret)
      throw new Error("Binance API keys missing");
    if (method !== "GET")
      throw new Error("read-only: only GET allowed");
  }

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ts  = Date.now();
    // HIGH-3 (1): recvWindow=10000
    const all = { ...params, recvWindow: 10000, timestamp: ts };
    const qs  = new URLSearchParams(all).toString();
    const sig = crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");
    const fullPath = `/api/v3/${path}?${qs}&signature=${sig}`;

    try {
      const parsed = await _httpOnce({
        hostname: "api.binance.com",
        path: fullPath,
        method,
        headers: { "X-MBX-APIKEY": apiKey },
      });

      // HIGH-3 (3): parsear code<0 incluso para write requests.
      // Binance devuelve {code: -2010, msg: "Account has insufficient balance"}
      // con status HTTP 400. El JSON.parse tenía éxito, el caller asumía OK.
      if (parsed && typeof parsed.code === "number" && parsed.code < 0) {
        const err = new Error(`Binance error ${parsed.code}: ${parsed.msg}`);
        err.binanceCode = parsed.code;
        if (parsed.code === -1003 || parsed.code === -1021) {
          lastErr = err;
          if (attempt < maxRetries) {
            const backoff = _backoffMs(attempt);
            console.warn(`[BINANCE] ${path} retry ${attempt+1}/${maxRetries} tras ${backoff}ms: ${err.message}`);
            await _sleep(backoff);
            continue;
          }
        }
        throw err;
      }
      return parsed;
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries && isRetryableError(e)) {
        const backoff = _backoffMs(attempt);
        console.warn(`[BINANCE] ${path} transient error, retry ${attempt+1}/${maxRetries} tras ${backoff}ms: ${e.message}`);
        await _sleep(backoff);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("signedRequest: no attempts executed");
}

module.exports = {
  signedRequest,
  isRetryableError,
  // Exportados para tests
  setHttpOnce,
  resetHttpOnce,
  _backoffMs, publicRequest };
