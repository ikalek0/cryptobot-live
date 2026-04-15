// ── BATCH-1 FIX #6 (H2): WebSocket authentication ──────────────────────
// Tests del módulo src/ws_auth.js (helpers puros: timingSafeCompare,
// extractToken, makeVerifyClient) + verificación estática de que
// server.js e index.html están cableados.
//
// Cubrimos:
//   - timingSafeCompare: mismo string, strings distintos misma longitud,
//     longitudes distintas, null/undefined, strings vacíos.
//   - extractToken: URL con/sin query, con/sin param 'token', decodificación.
//   - makeVerifyClient: token vacío → accept-all (dev), token válido → accept,
//     inválido → reject, missing → reject, getToken reevaluado en cada call.
//   - server.js: require('./ws_auth'), WebSocketServer({verifyClient}),
//     injection de __WS_TOKEN__ en index.html, comentario del fix.
//   - index.html: usa window.__WS_TOKEN__ y lo añade al WS URL.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const WA = require("../src/ws_auth");

describe("BATCH-1 FIX #6 — ws_auth.timingSafeCompare", () => {
  it("strings iguales → true", () => {
    assert.equal(WA.timingSafeCompare("abc123", "abc123"), true);
  });

  it("strings distintos misma longitud → false", () => {
    assert.equal(WA.timingSafeCompare("abc123", "xyz456"), false);
  });

  it("longitudes distintas → false sin crashear", () => {
    assert.equal(WA.timingSafeCompare("short", "muchmuchlonger"), false);
  });

  it("null/undefined → false", () => {
    assert.equal(WA.timingSafeCompare(null, "abc"), false);
    assert.equal(WA.timingSafeCompare("abc", undefined), false);
    assert.equal(WA.timingSafeCompare(undefined, undefined), false);
    assert.equal(WA.timingSafeCompare(null, null), false);
  });

  it("números/objetos → false", () => {
    assert.equal(WA.timingSafeCompare(123, 123), false);
    assert.equal(WA.timingSafeCompare({}, {}), false);
  });

  it("strings vacíos iguales → true (edge case)", () => {
    assert.equal(WA.timingSafeCompare("", ""), true);
  });

  it("tokens realistas (64 chars hex) → compara correctamente", () => {
    const t1 = "a".repeat(64);
    const t2 = "a".repeat(64);
    const t3 = "a".repeat(63) + "b";
    assert.equal(WA.timingSafeCompare(t1, t2), true);
    assert.equal(WA.timingSafeCompare(t1, t3), false);
  });
});

describe("BATCH-1 FIX #6 — ws_auth.extractToken", () => {
  it("extrae token de query simple", () => {
    assert.equal(WA.extractToken("/?token=abc123"), "abc123");
  });

  it("extrae token con otros params antes/después", () => {
    assert.equal(WA.extractToken("/?foo=1&token=abc123&bar=2"), "abc123");
    assert.equal(WA.extractToken("/?token=abc123&foo=1"), "abc123");
  });

  it("path con token", () => {
    assert.equal(WA.extractToken("/ws?token=xyz"), "xyz");
    assert.equal(WA.extractToken("/deep/nested/path?token=xyz"), "xyz");
  });

  it("URL sin query → ''", () => {
    assert.equal(WA.extractToken("/"), "");
    assert.equal(WA.extractToken("/path"), "");
  });

  it("query sin param token → ''", () => {
    assert.equal(WA.extractToken("/?foo=bar"), "");
    assert.equal(WA.extractToken("/?foo=bar&baz=qux"), "");
  });

  it("undefined/null/no-string → ''", () => {
    assert.equal(WA.extractToken(undefined), "");
    assert.equal(WA.extractToken(null), "");
    assert.equal(WA.extractToken(123), "");
    assert.equal(WA.extractToken({}), "");
  });

  it("URI decoding", () => {
    assert.equal(WA.extractToken("/?token=ab%20cd"), "ab cd");
    assert.equal(WA.extractToken("/?token=a%2Bb"), "a+b");
  });

  it("token vacío en URL (?token=) → ''", () => {
    assert.equal(WA.extractToken("/?token="), "");
  });
});

describe("BATCH-1 FIX #6 — ws_auth.makeVerifyClient", () => {
  it("dev mode (token esperado vacío) → accept all", () => {
    const vc = WA.makeVerifyClient(() => "");
    assert.equal(vc({ req: { url: "/" } }), true);
    assert.equal(vc({ req: { url: "/?token=anything" } }), true);
    assert.equal(vc({ req: { url: "/?token=" } }), true);
  });

  it("token esperado seteado + token válido → accept", () => {
    const vc = WA.makeVerifyClient(() => "secret-xyz-123");
    assert.equal(vc({ req: { url: "/?token=secret-xyz-123" } }), true);
  });

  it("token esperado seteado + token inválido → reject", () => {
    const vc = WA.makeVerifyClient(() => "secret-xyz-123");
    assert.equal(vc({ req: { url: "/?token=wrong" } }), false);
    assert.equal(vc({ req: { url: "/?token=secret-xyz-124" } }), false);
  });

  it("token esperado seteado + sin token → reject", () => {
    const vc = WA.makeVerifyClient(() => "secret-xyz");
    assert.equal(vc({ req: { url: "/" } }), false);
    assert.equal(vc({ req: { url: "/?foo=bar" } }), false);
  });

  it("info sin req / info undefined → reject (safe, no crash)", () => {
    const vc = WA.makeVerifyClient(() => "secret");
    assert.equal(vc({}), false);
    assert.equal(vc(undefined), false);
    assert.equal(vc(null), false);
    assert.equal(vc({ req: null }), false);
  });

  it("getToken() se evalúa en cada call (permite hot-reload)", () => {
    let currentToken = "first";
    const vc = WA.makeVerifyClient(() => currentToken);
    assert.equal(vc({ req: { url: "/?token=first" } }), true);
    currentToken = "second";
    assert.equal(vc({ req: { url: "/?token=first" } }), false);
    assert.equal(vc({ req: { url: "/?token=second" } }), true);
    currentToken = ""; // dev mode reactivado
    assert.equal(vc({ req: { url: "/" } }), true);
  });

  it("getToken no-función → TypeError", () => {
    assert.throws(() => WA.makeVerifyClient("notAFunction"), TypeError);
    assert.throws(() => WA.makeVerifyClient(null), TypeError);
    assert.throws(() => WA.makeVerifyClient(undefined), TypeError);
  });

  it("token con caracteres especiales URI-encoded → decoded match", () => {
    const vc = WA.makeVerifyClient(() => "ab cd");
    assert.equal(vc({ req: { url: "/?token=ab%20cd" } }), true);
    assert.equal(vc({ req: { url: "/?token=ab cd" } }), true);
  });
});

describe("BATCH-1 FIX #6 — server.js integra ws_auth", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "server.js"),
    "utf-8",
  );

  it("server.js requires './ws_auth'", () => {
    assert.ok(/require\(["']\.\/ws_auth["']\)/.test(src),
      "server.js debe require('./ws_auth')");
  });

  it("WebSocketServer se construye con verifyClient", () => {
    assert.ok(/new WebSocketServer\(\{[\s\S]*?verifyClient/.test(src),
      "new WebSocketServer({...}) debe incluir verifyClient");
  });

  it("verifyClient delegado a wsAuth.makeVerifyClient", () => {
    assert.ok(/wsAuth\.makeVerifyClient\(/.test(src),
      "server.js debe llamar a wsAuth.makeVerifyClient(...)");
  });

  it("token leído de process.env.WS_SECRET || BOT_SECRET", () => {
    assert.ok(/WS_SECRET/.test(src), "debe referenciar WS_SECRET");
    assert.ok(/BOT_SECRET/.test(src), "debe referenciar BOT_SECRET como fallback");
  });

  it("HTML inyecta window.__WS_TOKEN__ en <head>", () => {
    assert.ok(/__WS_TOKEN__/.test(src),
      "server.js debe inyectar __WS_TOKEN__ en el HTML servido");
    assert.ok(/<\/head>/.test(src),
      "server.js debe referenciar </head> como anchor del inject");
  });

  it("comentario del fix presente", () => {
    assert.ok(/BATCH-1 FIX #6/.test(src),
      "server.js debe documentar el fix con 'BATCH-1 FIX #6'");
  });

  it("NO usa sendFile para index (reemplazado por injection handler)", () => {
    // Antes: app.get("/", (req,res) => res.sendFile(... "index.html" ...))
    // Ahora: serveIndex() lee fs.readFile + injection
    assert.ok(!/sendFile\(path\.join\(__dirname,["']\.\.\/public\/index\.html["']\)/.test(src),
      "server.js ya no debe servir index.html con sendFile directo");
  });
});

describe("BATCH-1 FIX #6 — public/index.html usa token en WS URL", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "public", "index.html"),
    "utf-8",
  );

  it("lee window.__WS_TOKEN__ antes de conectar", () => {
    assert.ok(/window\.__WS_TOKEN__/.test(html),
      "index.html debe leer window.__WS_TOKEN__");
  });

  it("WS URL incluye ?token=... cuando hay token", () => {
    assert.ok(/token=\$\{encodeURIComponent/.test(html),
      "WS URL debe usar encodeURIComponent con el token");
  });

  it("comentario del fix presente (defense in depth)", () => {
    assert.ok(/BATCH-1 FIX #6/.test(html),
      "index.html debe documentar el cambio con 'BATCH-1 FIX #6'");
  });
});
