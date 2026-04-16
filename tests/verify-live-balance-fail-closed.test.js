// ── BATCH-3 FIX #2 (#3): verifyLiveBalance fail-closed ──────────────────
// Verifica que verifyLiveBalance:
//  A) LIVE_MODE sin API keys → process.exit(1)
//  B) balances === null → pausa 10min, NO toca portfolio
//  C) Reconciliación: orphan virtual → pausa 30min
//  D) Reconciliación: orphan real → pausa 30min
//  E) Zombie engine: NO borra portfolio
//  F) Catch error → pausa 10min (no silencia)
//
// Método: source-check estático de server.js. La lógica vive dentro de
// una función async, no es fácil de extraer sin boot completo. Los source
// checks blindan contra regresiones (alguien re-introduce el wipe).
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

const fnStart = src.indexOf("async function verifyLiveBalance()");
assert.ok(fnStart >= 0, "verifyLiveBalance must exist");
// Window large enough to cover the entire function (~120 lines)
const fnBody = src.slice(fnStart, fnStart + 8000);

describe("BATCH-3 FIX #2 — verifyLiveBalance fail-closed", () => {
  it("A: LIVE_MODE sin API keys → process.exit(1)", () => {
    assert.ok(/BINANCE_API_KEY/.test(fnBody), "debe checkear API_KEY");
    assert.ok(/BINANCE_API_SECRET/.test(fnBody), "debe checkear API_SECRET");
    assert.ok(/process\.exit\(1\)/.test(fnBody), "debe abortar boot");
  });

  it("B: balances null → pausa 10min, NO tocar portfolio", () => {
    // After the null check, should set _capitalSyncPausedUntil
    const nullIdx = fnBody.indexOf("!balances");
    assert.ok(nullIdx >= 0);
    const afterNull = fnBody.slice(nullIdx, nullIdx + 500);
    assert.ok(/capitalSyncPausedUntil\s*=\s*Date\.now\(\)\s*\+\s*10/.test(afterNull),
      "debe pausar 10min si balances null");
    assert.ok(!afterNull.includes("portfolio = {}"),
      "NO debe borrar portfolio cuando balances null");
  });

  it("C: reconciliación simpleBot detecta orphans virtuales", () => {
    assert.ok(/orphansVirtuales/.test(fnBody),
      "debe detectar posiciones virtuales sin asset real");
    assert.ok(/pos\.qty.*0\.9/.test(fnBody),
      "debe usar 90% threshold para detectar orphan virtual");
  });

  it("D: reconciliación simpleBot detecta orphans reales", () => {
    assert.ok(/orphansReales/.test(fnBody),
      "debe detectar assets reales sin posición virtual");
    assert.ok(/managedAssets/.test(fnBody),
      "debe construir set de assets gestionados");
  });

  it("orphans → pausa 30min + telegram + NO auto-reconcilia", () => {
    const orphanBlock = fnBody.slice(fnBody.indexOf("orphansReales.length || orphansVirtuales.length"));
    assert.ok(/capitalSyncPausedUntil.*Date\.now\(\).*30/.test(orphanBlock),
      "debe pausar 30min si hay orphans");
    assert.ok(/tg\.send/.test(orphanBlock), "debe enviar telegram");
    // NO debe borrar portfolio
    assert.ok(!orphanBlock.includes("S.simpleBot.portfolio = {}"),
      "NO debe auto-reconciliar portfolio");
  });

  it("E: zombie engine portfolio: log-only, sin S.bot.portfolio = {}", () => {
    // The entire fnBody should NOT contain S.bot.portfolio = {}
    assert.ok(!/S\.bot\.portfolio\s*=\s*\{\}/.test(fnBody),
      "verifyLiveBalance NO debe borrar S.bot.portfolio");
  });

  it("F: catch error → pausa 10min (no silencia)", () => {
    // Find the main catch(e) block (not inline try/catch{} wrappers)
    const catchMatch = fnBody.match(/\}\s*catch\s*\(\s*e\s*\)\s*\{/);
    assert.ok(catchMatch, "main catch(e) block must exist");
    const catchStart = fnBody.indexOf(catchMatch[0]);
    const catchBlock = fnBody.slice(catchStart, catchStart + 500);
    assert.ok(/capitalSyncPausedUntil/.test(catchBlock),
      "catch debe pausar compras");
    assert.ok(/tg\.send/.test(catchBlock),
      "catch debe enviar telegram");
    assert.ok(!/El bot continúa operando/.test(catchBlock),
      "NO debe decir que continúa operando sin verificar");
  });

  it("comentario BATCH-3 FIX #2 presente", () => {
    // The comment is above the function, inside the 5000 char window
    const startIdx = src.indexOf("BATCH-3 FIX #2");
    assert.ok(startIdx >= 0 && startIdx < fnStart + 5000,
      "BATCH-3 FIX #2 comment must be near verifyLiveBalance");
  });
});

describe("BATCH-3 FIX #2 — boot smoke: LIVE_MODE=true sin API keys → exit(1)", () => {
  const { spawn } = require("node:child_process");

  it("server.js con LIVE_MODE=true sin API keys aborta boot", { timeout: 90000 }, async () => {
    // Timeout largo: prefillSimpleBotCandles retries HTTP antes de llegar
    // a verifyLiveBalance (public Binance fetch, 3 retries × 6 pairs).
    const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
      env: {
        ...process.env,
        PORT: "0",
        LIVE_MODE: "true",
        CAPITAL_USDC: "100",
        CAPITAL_USDT: "100",
        BOT_SECRET: "very-long-strong-secret-xyz-01",
        SYNC_SECRET: "very-long-strong-secret-xyz-02",
        BAFIR_SECRET: "very-long-strong-secret-xyz-03",
        BINANCE_API_KEY: "",
        BINANCE_API_SECRET: "",
        TELEGRAM_TOKEN: "",
        TELEGRAM_CHAT_ID: "",
        DATABASE_URL: "",
        TICK_MS: "60000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        resolve(null);
      }, 80000);
      child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 1,
      `exitCode=${code}\nstdout:${stdout.slice(-500)}\nstderr:${stderr.slice(-500)}`);
    assert.ok(/API.*KEYS.*MISSING|API keys.*ABORT/i.test(stdout + stderr),
      "debe loguear motivo de abort");
  });
});
