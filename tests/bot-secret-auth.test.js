// ── BATCH-1 FIX #8 (#5): bot secret hardening tests ────────────────────
// Cubre src/secrets.js:
//   - PREDICTABLE_SECRETS: contiene los triviales conocidos
//   - isPredictableSecret: case-insensitive, ignora espacios
//   - validateBootSecret: empty / predictable / too_short / ok
//   - timingSafeCompare: igual a src/ws_auth.js pattern
//   - makeBotSecretChecker: fail-closed si env inválido, accepts con env
//     válido y input correcto, reject con input incorrecto
//
// Verificación estática en server.js:
//   - require('./secrets')
//   - checkBotSecret creado vía makeBotSecretChecker
//   - 5 paths que antes tenían `|| "bafir_bot_secret"` ahora usan
//     !checkBotSecret(secret)
//   - literal "bafir_bot_secret" ya no aparece como valor activo
//     (sólo en comentarios, contado aparte)
//   - warnPredictableSecrets usa validateBootSecret
//   - BOT_SECRET boot guard sigue abortando en LIVE_MODE
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const S = require("../src/secrets");

describe("BATCH-1 FIX #8 — secrets.PREDICTABLE_SECRETS", () => {
  it("incluye 'bafir_bot_secret' (el literal histórico del bot)", () => {
    assert.ok(S.PREDICTABLE_SECRETS.has("bafir_bot_secret"));
  });

  it("incluye 'paper_live_sync_secret' (el sync secret default)", () => {
    assert.ok(S.PREDICTABLE_SECRETS.has("paper_live_sync_secret"));
  });

  it("incluye triviales comunes", () => {
    for (const s of ["changeme", "password", "admin", "default", "test", "secret", "12345"]) {
      assert.ok(S.PREDICTABLE_SECRETS.has(s), `${s} debe estar en la lista`);
    }
  });
});

describe("BATCH-1 FIX #8 — secrets.isPredictableSecret", () => {
  it("detecta el literal del bot", () => {
    assert.equal(S.isPredictableSecret("bafir_bot_secret"), true);
  });

  it("case-insensitive", () => {
    assert.equal(S.isPredictableSecret("BAFIR_BOT_SECRET"), true);
    assert.equal(S.isPredictableSecret("Bafir_Bot_Secret"), true);
  });

  it("ignora espacios alrededor", () => {
    assert.equal(S.isPredictableSecret("  bafir_bot_secret  "), true);
  });

  it("no marca secrets fuertes como predictable", () => {
    assert.equal(S.isPredictableSecret("a1b2c3d4e5f6g7h8i9j0"), false);
    assert.equal(S.isPredictableSecret("Zx7!pQ9@mK3#vL5$"), false);
  });

  it("no-string → false", () => {
    assert.equal(S.isPredictableSecret(null), false);
    assert.equal(S.isPredictableSecret(undefined), false);
    assert.equal(S.isPredictableSecret(123), false);
    assert.equal(S.isPredictableSecret({}), false);
  });
});

describe("BATCH-1 FIX #8 — secrets.validateBootSecret", () => {
  it("empty → { ok:false, reason:'empty' }", () => {
    assert.deepEqual(S.validateBootSecret(""),        { ok: false, reason: "empty" });
    assert.deepEqual(S.validateBootSecret(undefined), { ok: false, reason: "empty" });
    assert.deepEqual(S.validateBootSecret(null),      { ok: false, reason: "empty" });
  });

  it("predictable → { ok:false, reason:'predictable' }", () => {
    assert.deepEqual(S.validateBootSecret("bafir_bot_secret"), { ok: false, reason: "predictable" });
    assert.deepEqual(S.validateBootSecret("changeme"),         { ok: false, reason: "predictable" });
    assert.deepEqual(S.validateBootSecret("admin"),            { ok: false, reason: "predictable" });
  });

  it("too_short (<16 chars) → { ok:false, reason:'too_short' }", () => {
    assert.deepEqual(S.validateBootSecret("abc"),           { ok: false, reason: "too_short" });
    assert.deepEqual(S.validateBootSecret("123456789012345"), { ok: false, reason: "too_short" });
  });

  it("válido (≥16 chars, no predictable) → { ok:true }", () => {
    assert.deepEqual(S.validateBootSecret("1234567890123456"),  { ok: true });
    assert.deepEqual(S.validateBootSecret("my-super-strong-secret-xyz"), { ok: true });
  });

  it("exactamente 16 chars → ok", () => {
    assert.equal(S.validateBootSecret("a".repeat(16)).ok, true);
    assert.equal(S.validateBootSecret("a".repeat(15)).ok, false);
  });
});

describe("BATCH-1 FIX #8 — secrets.timingSafeCompare", () => {
  it("iguales → true", () => {
    assert.equal(S.timingSafeCompare("abc123", "abc123"), true);
  });

  it("distintos misma longitud → false", () => {
    assert.equal(S.timingSafeCompare("abc123", "xyz456"), false);
  });

  it("longitudes distintas → false", () => {
    assert.equal(S.timingSafeCompare("short", "muchmuchlonger"), false);
  });

  it("no-string → false", () => {
    assert.equal(S.timingSafeCompare(null, "abc"), false);
    assert.equal(S.timingSafeCompare(123, 123), false);
  });
});

describe("BATCH-1 FIX #8 — secrets.makeBotSecretChecker", () => {
  it("env vacío → fail-closed (siempre rechaza)", () => {
    const check = S.makeBotSecretChecker(() => "");
    assert.equal(check("any"),                false);
    assert.equal(check("bafir_bot_secret"),   false);
    assert.equal(check(""),                    false);
  });

  it("env predictable → fail-closed incluso si el provided matchea", () => {
    const check = S.makeBotSecretChecker(() => "bafir_bot_secret");
    // El admin seteó el default literal. El attacker lo sabe y lo envía.
    // Igualmente rechazamos porque el env value no pasa la validación.
    assert.equal(check("bafir_bot_secret"), false);
    assert.equal(check("whatever"),         false);
  });

  it("env too_short → fail-closed", () => {
    const check = S.makeBotSecretChecker(() => "short");
    assert.equal(check("short"), false);
  });

  it("env válido + provided correcto → true", () => {
    const strong = "very-long-strong-secret-xyz-01";
    const check = S.makeBotSecretChecker(() => strong);
    assert.equal(check(strong), true);
  });

  it("env válido + provided incorrecto → false", () => {
    const check = S.makeBotSecretChecker(() => "very-long-strong-secret-xyz-01");
    assert.equal(check("wrong"),                          false);
    assert.equal(check("very-long-strong-secret-xyz-02"), false); // casi igual
  });

  it("provided no-string → false", () => {
    const check = S.makeBotSecretChecker(() => "very-long-strong-secret-xyz-01");
    assert.equal(check(null),      false);
    assert.equal(check(undefined), false);
    assert.equal(check(123),       false);
    assert.equal(check({}),        false);
  });

  it("getEnvValue no-función → TypeError", () => {
    assert.throws(() => S.makeBotSecretChecker("str"),    TypeError);
    assert.throws(() => S.makeBotSecretChecker(null),     TypeError);
    assert.throws(() => S.makeBotSecretChecker(undefined),TypeError);
  });

  it("getEnvValue se evalúa en cada call (hot-reload)", () => {
    let current = "";
    const check = S.makeBotSecretChecker(() => current);
    assert.equal(check("very-long-strong-secret-xyz-01"), false);
    current = "very-long-strong-secret-xyz-01";
    assert.equal(check("very-long-strong-secret-xyz-01"), true);
    assert.equal(check("wrong"),                          false);
  });
});

describe("BATCH-1 FIX #8 — server.js integra secrets module", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "server.js"),
    "utf-8",
  );

  it("server.js requires './secrets'", () => {
    assert.ok(/require\(["']\.\/secrets["']\)/.test(src),
      "server.js debe require('./secrets')");
  });

  it("checkBotSecret creado vía makeBotSecretChecker", () => {
    assert.ok(/makeBotSecretChecker\(/.test(src),
      "server.js debe llamar a makeBotSecretChecker");
    assert.ok(/const checkBotSecret\s*=/.test(src),
      "server.js debe exponer checkBotSecret como constante");
  });

  it("los 5 paths antes inline usan !checkBotSecret(secret)", () => {
    const uses = (src.match(/!checkBotSecret\(secret\)/g) || []).length;
    assert.ok(uses >= 5,
      `al menos 5 usages de !checkBotSecret(secret), got ${uses}`);
  });

  it("literal 'bafir_bot_secret' ya NO aparece como valor activo", () => {
    // Permitimos menciones en comentarios. Strip comments (// hasta EOL y /* ... */)
    // antes de buscar el literal como valor de código.
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "") // bloque /* ... */
      .split("\n")
      .map(line => {
        const idx = line.indexOf("//");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    assert.equal(/bafir_bot_secret/.test(noComments), false,
      "server.js no debe referenciar 'bafir_bot_secret' como valor activo (sólo comentarios permitidos)");
  });

  it("warnPredictableSecrets usa validateBootSecret", () => {
    const idx = src.indexOf("warnPredictableSecrets");
    assert.ok(idx >= 0);
    const win = src.slice(idx, idx + 2000);
    assert.ok(/validateBootSecret\(/.test(win),
      "warnPredictableSecrets debe usar secrets.validateBootSecret");
  });

  it("warnPredictableSecrets sigue con el abort en LIVE_MODE", () => {
    const idx = src.indexOf("warnPredictableSecrets");
    const win = src.slice(idx, idx + 2500);
    assert.ok(/if \(LIVE_MODE\)/.test(win));
    assert.ok(/process\.exit\(1\)/.test(win));
  });

  it("comentario del fix presente", () => {
    assert.ok(/BATCH-1 FIX #8/.test(src),
      "server.js debe documentar el fix con 'BATCH-1 FIX #8'");
  });

  it("BAFIR_SECRET ya no tiene default 'bafir_bot_secret' inline", () => {
    assert.ok(!/const BAFIR_SECRET\s*=\s*process\.env\.BAFIR_SECRET\s*\|\|\s*["']bafir_bot_secret["']/.test(src),
      "BAFIR_SECRET debe ya no tener fallback hardcoded al literal");
  });
});
