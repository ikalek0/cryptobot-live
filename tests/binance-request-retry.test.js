// ── BATCH-1 HIGH-3: binanceRequest recvWindow + retry + code<0 ─────────
// src/binance_client.js extrae la lógica de signed request desde server.js.
// Tests verifican:
//
//  1) recvWindow=10000 se añade automáticamente a todos los signed requests
//  2) Retry con backoff (500ms, 1500ms) para errores transientes
//  3) Retry en -1003 (rate limit) y -1021 (timestamp out of window)
//  4) Retry en errores de red (ECONNRESET, ETIMEDOUT, Timeout)
//  5) NO retry en errores permanentes (-2010 insufficient balance, etc.)
//  6) code<0 en response se convierte en Error (antes resolvía con el body)
//  7) readOnly + method != GET → reject
//  8) readOnly + api keys vacías → reject con "API keys missing"
//
// La capa HTTP se monkey-patcha con setHttpOnce(fakeFn).
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const BC = require("../src/binance_client");

// Helper: genera un fake que devuelve una lista de respuestas pre-programadas
// en orden. Cada respuesta es `{ ret: obj }` (resolve) o `{ err: Error }`.
function makeSequenceFake(sequence) {
  let idx = 0;
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const step = sequence[Math.min(idx, sequence.length - 1)];
    idx++;
    if (step.err) throw step.err;
    return step.ret;
  };
  fn.calls = calls;
  fn.getCallCount = () => idx;
  return fn;
}

describe("BATCH-1 HIGH-3 — binance_client signedRequest", () => {
  beforeEach(() => {
    BC.resetHttpOnce();
  });

  afterEach(() => {
    BC.resetHttpOnce();
  });

  describe("recvWindow y signing", () => {
    it("añade recvWindow=10000 al query string", async () => {
      const fake = makeSequenceFake([{ ret: { ok: true } }]);
      BC.setHttpOnce(fake);
      await BC.signedRequest({
        method: "GET", path: "account", params: { a: 1 },
        apiKey: "k", apiSecret: "s",
      });
      assert.equal(fake.calls.length, 1);
      const fullPath = fake.calls[0].path;
      assert.ok(fullPath.includes("recvWindow=10000"),
        `path debe incluir recvWindow=10000, got: ${fullPath}`);
      assert.ok(fullPath.includes("timestamp="),
        "path debe incluir timestamp");
      assert.ok(fullPath.includes("signature="),
        "path debe incluir signature");
    });

    it("añade X-MBX-APIKEY header", async () => {
      const fake = makeSequenceFake([{ ret: { ok: true } }]);
      BC.setHttpOnce(fake);
      await BC.signedRequest({
        method: "GET", path: "account", params: {},
        apiKey: "myKey", apiSecret: "mySecret",
      });
      assert.equal(fake.calls[0].headers["X-MBX-APIKEY"], "myKey");
    });

    it("path prefijado con /api/v3/", async () => {
      const fake = makeSequenceFake([{ ret: { ok: true } }]);
      BC.setHttpOnce(fake);
      await BC.signedRequest({
        method: "GET", path: "ticker/price", params: { symbol: "BTCUSDT" },
        apiKey: "k", apiSecret: "s",
      });
      assert.ok(fake.calls[0].path.startsWith("/api/v3/ticker/price"));
    });
  });

  describe("retry en errores transientes", () => {
    it("ECONNRESET → retry (éxito en 2º intento)", async () => {
      const fake = makeSequenceFake([
        { err: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }) },
        { ret: { ok: true } },
      ]);
      BC.setHttpOnce(fake);
      const r = await BC.signedRequest({
        method: "GET", path: "account", params: {},
        apiKey: "k", apiSecret: "s",
      });
      assert.deepEqual(r, { ok: true });
      assert.equal(fake.getCallCount(), 2, "2 intentos total (1 fallo + 1 éxito)");
    });

    it("Timeout → retry", async () => {
      const fake = makeSequenceFake([
        { err: new Error("Timeout") },
        { err: new Error("Timeout") },
        { ret: { v: 42 } },
      ]);
      BC.setHttpOnce(fake);
      const r = await BC.signedRequest({
        method: "GET", path: "account", params: {},
        apiKey: "k", apiSecret: "s",
      });
      assert.deepEqual(r, { v: 42 });
      assert.equal(fake.getCallCount(), 3);
    });

    it("-1003 rate limit → retry y escala el backoff", async () => {
      const fake = makeSequenceFake([
        { ret: { code: -1003, msg: "Too many requests" } },
        { ret: { ok: true, data: "recovered" } },
      ]);
      BC.setHttpOnce(fake);
      const t0 = Date.now();
      const r = await BC.signedRequest({
        method: "GET", path: "order", params: { symbol: "BTCUSDT" },
        apiKey: "k", apiSecret: "s",
      });
      const elapsed = Date.now() - t0;
      assert.deepEqual(r, { ok: true, data: "recovered" });
      // Backoff ≥ 1000ms (500ms primer intento * (0+1) + 500ms)
      assert.ok(elapsed >= 900, `backoff debe ser ~1s, got ${elapsed}ms`);
    });

    it("-1021 timestamp out of window → retry", async () => {
      const fake = makeSequenceFake([
        { ret: { code: -1021, msg: "Timestamp for this request is outside of the recvWindow" } },
        { ret: { ok: true } },
      ]);
      BC.setHttpOnce(fake);
      const r = await BC.signedRequest({
        method: "GET", path: "account", params: {},
        apiKey: "k", apiSecret: "s",
      });
      assert.deepEqual(r, { ok: true });
    });

    it("3 fallos consecutivos → lanza el último error", async () => {
      const fake = makeSequenceFake([
        { err: new Error("Timeout") },
        { err: new Error("Timeout") },
        { err: new Error("Timeout") },
      ]);
      BC.setHttpOnce(fake);
      await assert.rejects(
        BC.signedRequest({
          method: "GET", path: "account", params: {},
          apiKey: "k", apiSecret: "s",
        }),
        /Timeout/,
      );
      assert.equal(fake.getCallCount(), 3,
        "maxRetries=2 → 3 intentos totales");
    });
  });

  describe("errores permanentes — NO retry", () => {
    it("-2010 insufficient balance → throw inmediato", async () => {
      const fake = makeSequenceFake([
        { ret: { code: -2010, msg: "Account has insufficient balance" } },
      ]);
      BC.setHttpOnce(fake);
      let caught;
      try {
        await BC.signedRequest({
          method: "POST", path: "order", params: { symbol: "BTCUSDT" },
          apiKey: "k", apiSecret: "s",
        });
      } catch (e) { caught = e; }
      assert.ok(caught, "debe lanzar");
      assert.ok(/-2010/.test(caught.message), "message incluye -2010");
      assert.equal(caught.binanceCode, -2010);
      assert.equal(fake.getCallCount(), 1, "NO retry en -2010");
    });

    it("-1013 filter failure → throw inmediato", async () => {
      const fake = makeSequenceFake([
        { ret: { code: -1013, msg: "Filter failure: LOT_SIZE" } },
      ]);
      BC.setHttpOnce(fake);
      await assert.rejects(
        BC.signedRequest({
          method: "POST", path: "order", params: {},
          apiKey: "k", apiSecret: "s",
        }),
        /-1013/,
      );
      assert.equal(fake.getCallCount(), 1);
    });

    it("código > 0 (no error de Binance) → devuelve el body tal cual", async () => {
      const fake = makeSequenceFake([
        { ret: { symbol: "BTCUSDT", price: "50000", code: 0 } },
      ]);
      BC.setHttpOnce(fake);
      const r = await BC.signedRequest({
        method: "GET", path: "ticker/price", params: {},
        apiKey: "k", apiSecret: "s",
      });
      // code === 0 no es <0 → pasa
      assert.equal(r.price, "50000");
    });
  });

  describe("readOnly mode", () => {
    it("readOnly + method != GET → reject con 'only GET allowed'", async () => {
      await assert.rejects(
        BC.signedRequest({
          method: "POST", path: "order", params: {},
          apiKey: "k", apiSecret: "s",
          readOnly: true,
        }),
        /only GET allowed/,
      );
    });

    it("readOnly + apiKey vacía → reject con 'API keys missing'", async () => {
      await assert.rejects(
        BC.signedRequest({
          method: "GET", path: "account", params: {},
          apiKey: "", apiSecret: "s",
          readOnly: true,
        }),
        /API keys missing/,
      );
    });

    it("readOnly + apiSecret vacío → reject", async () => {
      await assert.rejects(
        BC.signedRequest({
          method: "GET", path: "account", params: {},
          apiKey: "k", apiSecret: "",
          readOnly: true,
        }),
        /API keys missing/,
      );
    });

    it("readOnly + GET + keys presentes → éxito", async () => {
      BC.setHttpOnce(makeSequenceFake([{ ret: { balances: [] } }]));
      const r = await BC.signedRequest({
        method: "GET", path: "account", params: {},
        apiKey: "k", apiSecret: "s",
        readOnly: true,
      });
      assert.deepEqual(r, { balances: [] });
    });
  });

  describe("isRetryableError() — helper puro", () => {
    it("ECONNRESET / ETIMEDOUT / EAI_AGAIN / Timeout → true", () => {
      assert.ok(BC.isRetryableError(new Error("ECONNRESET")));
      assert.ok(BC.isRetryableError(new Error("ETIMEDOUT")));
      assert.ok(BC.isRetryableError(new Error("EAI_AGAIN bla")));
      assert.ok(BC.isRetryableError(new Error("Timeout")));
    });

    it("-1003 / -1021 → true", () => {
      assert.ok(BC.isRetryableError(new Error("Binance error -1003: rate limit")));
      assert.ok(BC.isRetryableError(new Error("Binance error -1021: ts")));
    });

    it("-2010, -1013, 400 random, null → false", () => {
      assert.equal(BC.isRetryableError(new Error("Binance error -2010: insufficient")), false);
      assert.equal(BC.isRetryableError(new Error("Binance error -1013: filter")), false);
      assert.equal(BC.isRetryableError(new Error("400 Bad Request")), false);
      assert.equal(BC.isRetryableError(null), false);
      assert.equal(BC.isRetryableError(undefined), false);
    });
  });

  describe("_backoffMs() — helper puro", () => {
    it("intentos consecutivos → 1000, 1500, 2000...", () => {
      assert.equal(BC._backoffMs(0), 1000);
      assert.equal(BC._backoffMs(1), 1500);
      assert.equal(BC._backoffMs(2), 2000);
    });
  });
});

// ── Integración con server.js: verifica que server.js usa binance_client
describe("BATCH-1 HIGH-3 — server.js integra binance_client", () => {
  it("server.js requires './binance_client'", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "server.js"),
      "utf-8",
    );
    assert.ok(/require\(["']\.\/binance_client["']\)/.test(src),
      "server.js debe require('./binance_client')");
    assert.ok(/binanceClient\.signedRequest/.test(src),
      "server.js debe usar binanceClient.signedRequest");
  });

  it("server.js ya NO contiene https2.request directo (eliminado closure viejo)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "server.js"),
      "utf-8",
    );
    // El viejo binanceRequest/binanceReadOnlyRequest tenían
    // `https2.request({ hostname: "api.binance.com"` dentro del cuerpo.
    // Ahora toda la capa HTTP vive en src/binance_client.js.
    assert.ok(!/https2\.request/.test(src),
      "server.js ya no debe usar https2.request (delegado a binance_client)");
    assert.ok(/binanceClient\.signedRequest/.test(src),
      "server.js debe delegar a binanceClient.signedRequest");
  });
});
