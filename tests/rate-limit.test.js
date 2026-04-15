// ── BATCH-1 FIX #7 (HIGH-4): rate limiter tests ────────────────────────
// Tests del módulo src/rate_limit.js:
//  - SlidingWindowLimiter: check / hit / checkAndHit / middleware
//  - Ventana deslizante (entries viejas dejan de contar)
//  - Per-bucket isolation (un bucket no afecta a otro)
//  - extractIp: socket directo vs TRUST_PROXY + x-forwarded-for
//  - middleware 429 con Retry-After header
//  - onBlock callback
//  - Verificación estática en server.js: require, middleware aplicada
//    a endpoints mutantes, onAuthFailure helper presente, dead code
//    src/security.js eliminado.
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const RL = require("../src/rate_limit");

// fake req/res para tests de middleware
function fakeReq(ip = "1.2.3.4", headers = {}) {
  return { socket: { remoteAddress: ip }, headers };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj)    { this.body = obj; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
  };
  return res;
}

describe("BATCH-1 FIX #7 — SlidingWindowLimiter", () => {
  let limiter;
  beforeEach(() => { limiter = new RL.SlidingWindowLimiter(); });
  afterEach(() => { limiter.stop(); });

  describe("check / hit / checkAndHit", () => {
    it("check: bucket vacío → ok=true, count=0", () => {
      const r = limiter.check("k1", 10, 60_000);
      assert.equal(r.ok, true);
      assert.equal(r.count, 0);
      assert.equal(r.retryAfterMs, 0);
    });

    it("hit: incrementa count", () => {
      assert.equal(limiter.hit("k1", 60_000), 1);
      assert.equal(limiter.hit("k1", 60_000), 2);
      assert.equal(limiter.hit("k1", 60_000), 3);
    });

    it("checkAndHit: acepta hasta `max` hits, rechaza el (max+1)-ésimo", () => {
      for (let i = 0; i < 5; i++) {
        const r = limiter.checkAndHit("k1", 5, 60_000);
        assert.equal(r.ok, true, `hit ${i+1} debe pasar`);
      }
      const r6 = limiter.checkAndHit("k1", 5, 60_000);
      assert.equal(r6.ok, false);
      assert.ok(r6.retryAfterMs > 0);
    });

    it("sliding window: hits viejos dejan de contar tras windowMs", () => {
      const t0 = 1_000_000;
      // 5 hits en t0
      for (let i = 0; i < 5; i++) limiter.checkAndHit("k1", 5, 60_000, t0);
      // El 6º en t0 → reject
      assert.equal(limiter.checkAndHit("k1", 5, 60_000, t0).ok, false);
      // Avanzamos windowMs+1ms → todos los viejos fuera → ok
      const t1 = t0 + 60_001;
      assert.equal(limiter.checkAndHit("k1", 5, 60_000, t1).ok, true);
    });

    it("buckets por key son independientes", () => {
      for (let i = 0; i < 5; i++) limiter.checkAndHit("k1", 5, 60_000);
      assert.equal(limiter.checkAndHit("k1", 5, 60_000).ok, false);
      // k2 sigue fresca
      assert.equal(limiter.checkAndHit("k2", 5, 60_000).ok, true);
    });

    it("clear() resetea todos los buckets", () => {
      for (let i = 0; i < 5; i++) limiter.checkAndHit("k1", 5, 60_000);
      limiter.clear();
      assert.equal(limiter.checkAndHit("k1", 5, 60_000).ok, true);
    });

    it("retryAfterMs decrece a medida que pasa el tiempo", () => {
      const t0 = 1_000_000;
      for (let i = 0; i < 5; i++) limiter.checkAndHit("k1", 5, 60_000, t0);
      const r1 = limiter.check("k1", 5, 60_000, t0 + 1000);
      const r2 = limiter.check("k1", 5, 60_000, t0 + 30000);
      assert.ok(!r1.ok && !r2.ok);
      assert.ok(r2.retryAfterMs < r1.retryAfterMs,
        `retryAfterMs debe decrecer: r1=${r1.retryAfterMs}, r2=${r2.retryAfterMs}`);
    });

    it("hit() filtra entries fuera de window al insertar", () => {
      const t0 = 1_000_000;
      limiter.hit("k1", 60_000, t0);
      limiter.hit("k1", 60_000, t0 + 30_000);
      // Avanza fuera de window de la primera → sólo queda la segunda
      const count = limiter.hit("k1", 60_000, t0 + 65_000);
      assert.equal(count, 2, "primera eliminada, segunda (30s) + tercera (65s)");
    });
  });

  describe("middleware() Express", () => {
    it("permite requests bajo el límite", () => {
      const mw = limiter.middleware({ max: 3, windowMs: 60_000 });
      const req = fakeReq("1.1.1.1");
      let nextCalled = 0;
      for (let i = 0; i < 3; i++) {
        const res = fakeRes();
        mw(req, res, () => nextCalled++);
        assert.equal(res.statusCode, 200);
      }
      assert.equal(nextCalled, 3);
    });

    it("bloquea el (max+1)-ésimo con 429 + Retry-After", () => {
      const mw = limiter.middleware({ max: 2, windowMs: 60_000 });
      const req = fakeReq("1.1.1.1");
      for (let i = 0; i < 2; i++) mw(req, fakeRes(), () => {});
      const res = fakeRes();
      let nextCalled = 0;
      mw(req, res, () => nextCalled++);
      assert.equal(res.statusCode, 429);
      assert.ok(res.headers["Retry-After"]);
      assert.ok(res.body.error.match(/too many/i));
      assert.ok(typeof res.body.retryAfterSec === "number");
      assert.equal(nextCalled, 0, "next() NO debe llamarse tras 429");
    });

    it("IPs distintas → buckets independientes", () => {
      const mw = limiter.middleware({ max: 2, windowMs: 60_000 });
      // IP1 llena su bucket
      mw(fakeReq("1.1.1.1"), fakeRes(), () => {});
      mw(fakeReq("1.1.1.1"), fakeRes(), () => {});
      const res1 = fakeRes();
      mw(fakeReq("1.1.1.1"), res1, () => {});
      assert.equal(res1.statusCode, 429);
      // IP2 pasa
      const res2 = fakeRes();
      let next2 = 0;
      mw(fakeReq("2.2.2.2"), res2, () => next2++);
      assert.equal(res2.statusCode, 200);
      assert.equal(next2, 1);
    });

    it("buckets distintos → no se interfieren", () => {
      const mwMut  = limiter.middleware({ max: 2, windowMs: 60_000, bucket: "mut" });
      const mwAuth = limiter.middleware({ max: 2, windowMs: 60_000, bucket: "auth" });
      const ip = "3.3.3.3";
      mwMut(fakeReq(ip), fakeRes(), () => {});
      mwMut(fakeReq(ip), fakeRes(), () => {});
      // bucket "mut" lleno, pero "auth" virgen → pasa
      const res = fakeRes();
      let n = 0;
      mwAuth(fakeReq(ip), res, () => n++);
      assert.equal(res.statusCode, 200);
      assert.equal(n, 1);
    });

    it("onBlock callback se invoca en el 429", () => {
      const blocked = [];
      const mw = limiter.middleware({
        max: 1, windowMs: 60_000,
        onBlock: (key, req) => blocked.push(key),
      });
      mw(fakeReq("4.4.4.4"), fakeRes(), () => {});
      mw(fakeReq("4.4.4.4"), fakeRes(), () => {}); // bloqueado
      assert.equal(blocked.length, 1);
      assert.ok(blocked[0].includes("4.4.4.4"));
    });

    it("onBlock que lanza no crashea el middleware", () => {
      const mw = limiter.middleware({
        max: 1, windowMs: 60_000,
        onBlock: () => { throw new Error("boom"); },
      });
      mw(fakeReq("5.5.5.5"), fakeRes(), () => {});
      const res = fakeRes();
      assert.doesNotThrow(() => mw(fakeReq("5.5.5.5"), res, () => {}));
      assert.equal(res.statusCode, 429);
    });

    it("max/windowMs inválidos → TypeError al construir", () => {
      assert.throws(() => limiter.middleware({ max: 0, windowMs: 1000 }), TypeError);
      assert.throws(() => limiter.middleware({ max: -1, windowMs: 1000 }), TypeError);
      assert.throws(() => limiter.middleware({ max: 10, windowMs: 0 }), TypeError);
      assert.throws(() => limiter.middleware({ max: "a", windowMs: 1000 }), TypeError);
    });
  });

  describe("extractIp", () => {
    it("devuelve req.socket.remoteAddress por default", () => {
      assert.equal(RL.extractIp({ socket: { remoteAddress: "9.8.7.6" }, headers: {} }), "9.8.7.6");
    });

    it("sin TRUST_PROXY: ignora x-forwarded-for", () => {
      delete process.env.TRUST_PROXY;
      const req = {
        socket: { remoteAddress: "9.8.7.6" },
        headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
      };
      assert.equal(RL.extractIp(req), "9.8.7.6");
    });

    it("con TRUST_PROXY=true: usa primera IP de x-forwarded-for", () => {
      process.env.TRUST_PROXY = "true";
      try {
        const req = {
          socket: { remoteAddress: "9.8.7.6" },
          headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
        };
        assert.equal(RL.extractIp(req), "1.1.1.1");
      } finally {
        delete process.env.TRUST_PROXY;
      }
    });

    it("sin req → 'unknown'", () => {
      assert.equal(RL.extractIp(null), "unknown");
      assert.equal(RL.extractIp(undefined), "unknown");
    });

    it("sin socket → fallback a req.ip o 'unknown'", () => {
      assert.equal(RL.extractIp({ headers: {}, ip: "7.7.7.7" }), "7.7.7.7");
      assert.equal(RL.extractIp({ headers: {} }), "unknown");
    });
  });

  describe("cleanup", () => {
    it("_cleanup() elimina entries fuera de MAX_KNOWN_WINDOW_MS", () => {
      const t0 = 1_000_000;
      limiter.hit("old", 60_000, t0);
      limiter.hit("fresh", 60_000, t0 + 14 * 60_000);
      // Cleanup a t0 + 16min → 'old' fuera (16min>15min), 'fresh' dentro
      limiter._cleanup(t0 + 16 * 60_000);
      assert.equal(limiter.buckets.has("old"), false);
      assert.equal(limiter.buckets.has("fresh"), true);
    });

    it("stop() limpia el interval (no keeps process alive)", () => {
      const l = new RL.SlidingWindowLimiter();
      assert.ok(l._cleanupTimer);
      l.stop();
      assert.equal(l._cleanupTimer, null);
    });
  });
});

describe("BATCH-1 FIX #7 — server.js integra rate_limit", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "server.js"),
    "utf-8",
  );

  it("server.js requires './rate_limit'", () => {
    assert.ok(/require\(["']\.\/rate_limit["']\)/.test(src),
      "server.js debe require('./rate_limit')");
  });

  it("instancia SlidingWindowLimiter + crea mutationLimiter", () => {
    assert.ok(/new SlidingWindowLimiter\(\)/.test(src));
    assert.ok(/mutationLimiter/.test(src));
  });

  it("mutationLimiter usa max=10, windowMs=60_000", () => {
    // Búsqueda laxa dentro de la definición
    const def = src.match(/mutationLimiter\s*=\s*rateLimiter\.middleware\(\{[\s\S]*?\}\)/);
    assert.ok(def, "debe existir la definición de mutationLimiter");
    assert.ok(/max:\s*10/.test(def[0]), "max debe ser 10");
    assert.ok(/60_000|60000/.test(def[0]), "windowMs debe ser 60s");
  });

  it("onAuthFailure usa 5 intentos / 15min", () => {
    const fn = src.match(/function onAuthFailure[\s\S]*?^}/m);
    assert.ok(fn, "debe existir onAuthFailure");
    assert.ok(/checkAndHit\([^,]+,\s*5\s*,\s*15\s*\*\s*60\s*\*\s*1000\)/.test(fn[0]),
      "onAuthFailure debe usar 5 intentos / 15min");
  });

  it("mutationLimiter aplicado a /api/reset-state", () => {
    assert.ok(/app\.post\(["']\/api\/reset-state["'],\s*mutationLimiter/.test(src));
  });

  it("mutationLimiter aplicado a /api/sync/params", () => {
    assert.ok(/app\.post\(["']\/api\/sync\/params["'],\s*mutationLimiter/.test(src));
  });

  it("mutationLimiter aplicado a /api/sync/daily", () => {
    assert.ok(/app\.post\(["']\/api\/sync\/daily["'],\s*mutationLimiter/.test(src));
  });

  it("mutationLimiter aplicado a /api/shadow/entry y /exit", () => {
    assert.ok(/app\.post\(["']\/api\/shadow\/entry["'],\s*mutationLimiter/.test(src));
    assert.ok(/app\.post\(["']\/api\/shadow\/exit["'],\s*mutationLimiter/.test(src));
  });

  it("mutationLimiter aplicado a /api/set-alert-config y /api/set-capital", () => {
    assert.ok(/app\.post\(["']\/api\/set-alert-config["'],\s*mutationLimiter/.test(src));
    assert.ok(/app\.post\(["']\/api\/set-capital["'],\s*mutationLimiter/.test(src));
  });

  it("onAuthFailure llamado en vez de res.status(401) inline", () => {
    // Los endpoints que antes tenían `return res.status(401).json(...)` ahora
    // deben delegar a onAuthFailure. Contamos apariciones.
    const authFailCalls = (src.match(/onAuthFailure\(req,\s*res\)/g) || []).length;
    assert.ok(authFailCalls >= 7,
      `onAuthFailure llamado en al menos 7 paths (5 bot-secret + 2 HMAC paths), got ${authFailCalls}`);
  });

  it("comentario del fix presente", () => {
    assert.ok(/BATCH-1 FIX #7/.test(src),
      "server.js debe documentar el fix con 'BATCH-1 FIX #7'");
  });
});

describe("BATCH-1 FIX #7 — src/security.js eliminado", () => {
  const fs = require("fs");
  const path = require("path");

  it("src/security.js ya no existe", () => {
    const p = path.join(__dirname, "..", "src", "security.js");
    assert.equal(fs.existsSync(p), false,
      "src/security.js debe estar eliminado (dead code)");
  });

  it("nadie requiere ./security en src/", () => {
    // Verificación textual en todos los .js de src/
    const srcDir = path.join(__dirname, "..", "src");
    const files = fs.readdirSync(srcDir).filter(f => f.endsWith(".js"));
    for (const f of files) {
      const content = fs.readFileSync(path.join(srcDir, f), "utf-8");
      assert.ok(!/require\(["']\.\/security["']\)/.test(content),
        `${f} no debe require('./security')`);
    }
  });
});
