// ── BATCH-1 boot smoke tests ───────────────────────────────────────────
// Verifica 5 combinaciones de boot de src/server.js con distintos env
// values para blindar los guardrails añadidos en BATCH-1:
//
//  (a) NODE_ENV=test LIVE_MODE=false             → boot OK
//  (b) LIVE_MODE=true sin secrets                 → exit(1) por security
//  (c) LIVE_MODE=true con BOT_SECRET predictable  → exit(1) por security
//  (d) LIVE_MODE=true con secrets válidos         → boot OK
//  (e) PG off + saveSimpleState → loadSimpleState → cubierto en
//      tests/persistence-disk-fallback.test.js (aquí lo reaseguramos
//      con un round-trip DB-level como smoke rápido).
//
// Método: spawn de `node src/server.js` como hijo con env específico y
// PORT=0 (OS-assigned). Se captura stdout+stderr y se mata el hijo tan
// pronto como aparezca el marker de boot completado, o se deja correr
// hasta timeout esperando exit(1).
//
// Este test NO es el que verifica la lógica funcional (eso ya lo cubren
// los otros ~449 tests). Solo verifica que los guardrails al boot
// disparan en el momento correcto.
"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const SERVER_JS = path.resolve(__dirname, "..", "src", "server.js");
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ── smoke runner ─────────────────────────────────────────────────────
// Arranca `node src/server.js` con env custom. Resuelve con
// { exitCode, signal, stdout, stderr, bootOK } donde:
//  - bootOK = true  → vio el marker "CRYPTOBOT LIVE en http" y matamos
//  - bootOK = false → el proceso salió por su cuenta antes del marker
//
// Siempre mata al hijo al final (SIGKILL si SIGTERM no alcanza).
function runServer(env, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const mergedEnv = {
      ...process.env,
      // neutralizar defaults dev que podrían contaminar el test
      PORT: "0",
      TICK_MS: "60000", // tick loop lento para no saturar
      // Usamos tmp dir para data/ a prueba de interferir con otros tests
      // (pero CWD sigue siendo projectRoot porque server.js usa paths
      // relativos a __dirname). Mantener CWD normal.
      ...env,
    };
    // Limpiar vars heredadas que no queremos inyectadas
    for (const k of ["DATABASE_URL", "BINANCE_API_KEY", "BINANCE_API_SECRET",
                     "TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "BAFIR_URL"]) {
      if (!(k in env)) mergedEnv[k] = "";
    }

    const child = spawn(process.execPath, [SERVER_JS], {
      cwd: PROJECT_ROOT,
      env: mergedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let bootOK = false;
    let killed = false;

    const finish = (result) => {
      if (killed) return;
      killed = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch {}
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (/CRYPTOBOT LIVE en http/.test(stdout) && !bootOK) {
        bootOK = true;
        // Dar un tick para que el resto del event loop no grite
        setTimeout(() => finish({
          exitCode: null, signal: "SIGKILL", stdout, stderr, bootOK: true,
        }), 150);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("exit", (code, signal) => {
      finish({ exitCode: code, signal, stdout, stderr, bootOK });
    });

    child.on("error", (err) => {
      finish({
        exitCode: -1, signal: null, stdout,
        stderr: stderr + "\n[spawn error] " + err.message,
        bootOK: false,
      });
    });

    const timer = setTimeout(() => {
      finish({ exitCode: null, signal: "TIMEOUT", stdout, stderr, bootOK });
    }, timeoutMs);
  });
}

const STRONG_SECRET_1 = "very-long-strong-secret-xyz-01";
const STRONG_SECRET_2 = "very-long-strong-secret-xyz-02";
const STRONG_SECRET_3 = "very-long-strong-secret-xyz-03";

// Directorio data/ debe existir para que los writes atómicos funcionen
// (el smoke test no lo usa pero server.js lee state al boot).
const DATA_DIR = path.join(PROJECT_ROOT, "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

describe("BATCH-1 boot smoke — (a) NODE_ENV=test LIVE_MODE=false → OK", () => {
  it("boot completa sin process.exit", async () => {
    const r = await runServer({
      NODE_ENV: "test",
      LIVE_MODE: "false",
      CAPITAL_USDC: "100",
      CAPITAL_USDT: "100",
      // Paper-live acepta secrets vacíos (solo advierte)
      BOT_SECRET: "",
      SYNC_SECRET: "",
      BAFIR_SECRET: "",
    }, { timeoutMs: 20000 });
    assert.equal(r.bootOK, true,
      `boot debe mostrar 'CRYPTOBOT LIVE en http'\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.ok(!/ABORT boot/.test(r.stderr + r.stdout),
      "no debe abortar boot");
  });
});

describe("BATCH-1 boot smoke — (b) LIVE_MODE=true sin secrets → exit(1)", () => {
  it("aborta boot con código distinto de 0", async () => {
    const r = await runServer({
      LIVE_MODE: "true",
      CAPITAL_USDC: "100",
      CAPITAL_USDT: "100",
      BOT_SECRET: "",
      SYNC_SECRET: "",
      BAFIR_SECRET: "",
    }, { timeoutMs: 10000 });
    assert.equal(r.bootOK, false, "NO debe llegar al server.listen");
    assert.equal(r.exitCode, 1,
      `exitCode=${r.exitCode} signal=${r.signal}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert.ok(
      /ABORT boot|secrets inválidos/.test(r.stderr + r.stdout),
      "debe loguear motivo security",
    );
  });
});

describe("BATCH-1 boot smoke — (c) LIVE_MODE=true BOT_SECRET=predictable → exit(1)", () => {
  it("aborta boot con el literal 'bafir_bot_secret' en BOT_SECRET", async () => {
    const r = await runServer({
      LIVE_MODE: "true",
      CAPITAL_USDC: "100",
      CAPITAL_USDT: "100",
      BOT_SECRET: "bafir_bot_secret",       // predictable
      SYNC_SECRET: STRONG_SECRET_1,          // OK
      BAFIR_SECRET: STRONG_SECRET_2,         // OK
    }, { timeoutMs: 10000 });
    assert.equal(r.bootOK, false);
    assert.equal(r.exitCode, 1,
      `exitCode=${r.exitCode}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert.ok(/predictable|BOT_SECRET|bafir_bot_secret/i.test(r.stderr + r.stdout));
  });

  it("aborta boot con BOT_SECRET demasiado corto", async () => {
    const r = await runServer({
      LIVE_MODE: "true",
      CAPITAL_USDC: "100",
      CAPITAL_USDT: "100",
      BOT_SECRET: "short123",                // <16 chars
      SYNC_SECRET: STRONG_SECRET_1,
      BAFIR_SECRET: STRONG_SECRET_2,
    }, { timeoutMs: 10000 });
    assert.equal(r.exitCode, 1);
    assert.ok(/too_short|BOT_SECRET/i.test(r.stderr + r.stdout));
  });
});

describe("BATCH-1 boot smoke — (d) LIVE_MODE=true con secrets válidos → OK", () => {
  it("boot completa con 3 secrets fuertes", async () => {
    const r = await runServer({
      LIVE_MODE: "true",
      CAPITAL_USDC: "100",
      CAPITAL_USDT: "100",
      BOT_SECRET:   STRONG_SECRET_1,
      SYNC_SECRET:  STRONG_SECRET_2,
      BAFIR_SECRET: STRONG_SECRET_3,
      // Sin API keys reales: verifyLiveBalance falla y logea warning
      // pero NO aborta (catch interno). El smoke verifica que warnings
      // ≠ abort.
      BINANCE_API_KEY: "",
      BINANCE_API_SECRET: "",
    }, { timeoutMs: 25000 });
    assert.equal(r.bootOK, true,
      `boot debe llegar al marker\nstdout:\n${r.stdout.slice(-500)}\nstderr:\n${r.stderr.slice(-500)}`);
    assert.ok(!/ABORT boot/.test(r.stderr + r.stdout),
      "no debe abortar boot con secrets válidos");
  });
});

describe("BATCH-1 boot smoke — (e) PG off + saveSimpleState round-trip", () => {
  // Smoke rápido sobre src/database directamente (sin spawn). El test
  // completo con múltiples escenarios vive en
  // tests/persistence-disk-fallback.test.js.
  it("con DATABASE_URL vacío, saveSimpleState+loadSimpleState round-trip", async () => {
    const savedDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "";
    // require con cache-bust para leer DATABASE_URL fresco
    delete require.cache[require.resolve("../src/database")];
    const DB = require("../src/database");
    const testPayload = {
      smoketest: true,
      ts: Date.now(),
      nested: { a: 1, b: [2, 3, 4] },
    };
    try {
      await DB.saveSimpleState(testPayload);
      const roundtrip = await DB.loadSimpleState();
      assert.ok(roundtrip, "loadSimpleState debe devolver payload no-null tras restart simulado");
      assert.equal(roundtrip.smoketest, true);
      assert.equal(roundtrip.ts, testPayload.ts);
      assert.deepEqual(roundtrip.nested, testPayload.nested);
    } finally {
      // cleanup: borrar simple_state.json
      try {
        const simpleFile = path.join(DATA_DIR, "simple_state.json");
        if (fs.existsSync(simpleFile)) fs.unlinkSync(simpleFile);
      } catch {}
      if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedDbUrl;
      delete require.cache[require.resolve("../src/database")];
    }
  });
});
