// ── Safety tests: dotenv, env vars, engine no-op ─────────────────────────────
// Guards against the critical bugs discovered in the April 2026 session.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

// ── dotenv protection ───────────────────────────────────────────────────────

describe("dotenv protection", () => {
  it("server.js requires dotenv at the very top", () => {
    const content = fs.readFileSync(path.join(SRC, "server.js"), "utf-8");
    const lines = content.split("\n");
    // dotenv must be in the first 10 lines (after "use strict" and comments)
    const dotenvLine = lines.findIndex(l => l.includes("dotenv"));
    assert.ok(dotenvLine >= 0, "server.js must contain dotenv require");
    assert.ok(dotenvLine < 10, `dotenv require should be near top, found at line ${dotenvLine + 1}`);
  });

  it("package.json has dotenv as dependency", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    assert.ok(pkg.dependencies?.dotenv, "dotenv must be in package.json dependencies");
  });

  it("dotenv module is actually installed in node_modules", () => {
    const dotenvPath = path.join(ROOT, "node_modules", "dotenv");
    assert.ok(fs.existsSync(dotenvPath), "dotenv must be installed in node_modules");
  });
});

// ── INITIAL_CAPITAL defaults ────────────────────────────────────────────────

describe("INITIAL_CAPITAL fallback chain", () => {
  // A8: la cadena literal vive ahora sólo en src/config.js. engine_simple.js
  // y trading/state.js importan de allí. engine.js (viejo, no-op) todavía
  // lee el env directamente porque no está en el scope del refactor A8.
  it("config.js has the canonical fallback: CAPITAL_USDC -> CAPITAL_USDT -> 100", () => {
    const content = fs.readFileSync(path.join(SRC, "config.js"), "utf-8");
    assert.ok(
      content.includes('process.env.CAPITAL_USDC || process.env.CAPITAL_USDT || "100"'),
      "config.js CAPITAL must use canonical fallback chain"
    );
  });

  it("engine_simple.js imports CAPITAL from config.js (A8)", () => {
    const content = fs.readFileSync(path.join(SRC, "engine_simple.js"), "utf-8");
    assert.ok(
      content.includes('require("./config")') || content.includes("require('./config')"),
      "engine_simple.js must require ./config"
    );
    assert.ok(
      content.includes("CAPITAL: INITIAL_CAPITAL"),
      "engine_simple.js must destructure CAPITAL as INITIAL_CAPITAL from config"
    );
    // Regression: no debe quedar la cadena literal duplicada en engine_simple.js
    assert.ok(
      !content.includes('process.env.CAPITAL_USDC || process.env.CAPITAL_USDT || "100"'),
      "engine_simple.js debe delegar en config.js, no duplicar la cadena literal"
    );
  });

  it("engine.js has the same fallback chain (no-op engine, queda fuera del scope A8)", () => {
    const content = fs.readFileSync(path.join(SRC, "engine.js"), "utf-8");
    assert.ok(
      content.includes('process.env.CAPITAL_USDC || process.env.CAPITAL_USDT || "100"'),
      "engine.js INITIAL_CAPITAL must also fallback to 100"
    );
  });

  it("trading/state.js imports CAPITAL from config.js (A8)", () => {
    const content = fs.readFileSync(path.join(SRC, "trading", "state.js"), "utf-8");
    assert.ok(
      content.includes('require("../config")') || content.includes("require('../config')"),
      "state.js must require ../config"
    );
    // Regression: no debe quedar la cadena literal duplicada en state.js
    assert.ok(
      !content.includes('process.env.CAPITAL_USDC || process.env.CAPITAL_USDT || "100"'),
      "state.js debe delegar en config.js, no duplicar la cadena literal"
    );
  });

  it("F24 runtime: CAPITAL_USDC env propagates to S.CAPITAL_USDT (via config)", () => {
    // Limpiar cache + setear env ANTES del require. config.js lee dotenv
    // pero no sobreescribe valores ya presentes en process.env, así que
    // este patrón sigue siendo válido tras A8.
    const statePath  = require.resolve("../src/trading/state");
    const configPath = require.resolve("../src/config");
    delete require.cache[statePath];
    delete require.cache[configPath];
    const prevC = process.env.CAPITAL_USDC;
    const prevT = process.env.CAPITAL_USDT;
    process.env.CAPITAL_USDC = "250";
    delete process.env.CAPITAL_USDT;
    try {
      const S = require("../src/trading/state");
      assert.equal(S.CAPITAL_USDT, 250, "CAPITAL_USDC=250 (no USDT) must set S.CAPITAL_USDT=250");
    } finally {
      if (prevC === undefined) delete process.env.CAPITAL_USDC; else process.env.CAPITAL_USDC = prevC;
      if (prevT === undefined) delete process.env.CAPITAL_USDT; else process.env.CAPITAL_USDT = prevT;
      delete require.cache[statePath];
      delete require.cache[configPath];
    }
  });

  it("default fallback is 100, NOT 10000 (via config.js)", () => {
    const content = fs.readFileSync(path.join(SRC, "config.js"), "utf-8");
    // The old bug was defaulting to 10000
    const match = content.match(/CAPITAL\s*=\s*parseFloat\(([^)]+)\)/);
    assert.ok(match, "config.js CAPITAL should use parseFloat");
    assert.ok(!match[1].includes("10000"), "config.js CAPITAL must NOT default to 10000");
    assert.ok(match[1].includes('"100"'), "config.js CAPITAL must default to 100");
  });
});

// A8: Single source of truth — engine_simple, state y config deben devolver
// el MISMO valor de CAPITAL en runtime. Regression directa contra divergencia.
describe("A8 — config.js single source of truth", () => {
  it("config.CAPITAL === engine_simple.INITIAL_CAPITAL === S.CAPITAL_USDT", () => {
    const configPath  = require.resolve("../src/config");
    const statePath   = require.resolve("../src/trading/state");
    const enginePath  = require.resolve("../src/engine_simple");
    delete require.cache[configPath];
    delete require.cache[statePath];
    delete require.cache[enginePath];
    const prevC = process.env.CAPITAL_USDC;
    const prevT = process.env.CAPITAL_USDT;
    process.env.CAPITAL_USDC = "317";
    delete process.env.CAPITAL_USDT;
    try {
      const cfg     = require("../src/config");
      const S       = require("../src/trading/state");
      const engine  = require("../src/engine_simple");
      assert.equal(cfg.CAPITAL, 317, "config.CAPITAL debe leer CAPITAL_USDC=317");
      assert.equal(S.CAPITAL_USDT, 317, "S.CAPITAL_USDT debe coincidir con config.CAPITAL");
      assert.equal(engine.INITIAL_CAPITAL, 317, "engine_simple.INITIAL_CAPITAL debe coincidir con config.CAPITAL");
    } finally {
      if (prevC === undefined) delete process.env.CAPITAL_USDC; else process.env.CAPITAL_USDC = prevC;
      if (prevT === undefined) delete process.env.CAPITAL_USDT; else process.env.CAPITAL_USDT = prevT;
      delete require.cache[configPath];
      delete require.cache[statePath];
      delete require.cache[enginePath];
    }
  });

  it("config.js object is frozen (no mutación accidental)", () => {
    const configPath = require.resolve("../src/config");
    delete require.cache[configPath];
    const cfg = require("../src/config");
    assert.ok(Object.isFrozen(cfg), "config export debe estar frozen");
    // Intento de mutación debe ser no-op (strict mode lanza)
    try { cfg.CAPITAL = 99999; } catch {}
    assert.notEqual(cfg.CAPITAL, 99999, "CAPITAL no debe poder mutarse");
    delete require.cache[configPath];
  });
});

// ── LIVE_MODE safety ────────────────────────────────────────────────────────

describe("LIVE_MODE safety", () => {
  it("server.js logs LIVE_MODE and API_KEY status at boot", () => {
    const content = fs.readFileSync(path.join(SRC, "server.js"), "utf-8");
    assert.ok(content.includes("[BOOT]"), "Must log [BOOT] with LIVE_MODE status");
    assert.ok(content.includes("API_KEY"), "Must log API_KEY status at boot");
  });

  it("LIVE_MODE defaults to false when env is undefined", () => {
    const content = fs.readFileSync(path.join(SRC, "server.js"), "utf-8");
    // When LIVE_MODE env is undefined AND no API keys: should be false
    // Code: const LIVE_MODE = _lm !== undefined ? _lm === "true" : (BINANCE_API_KEY !== "" && ...)
    // With empty keys -> false. Good.
    assert.ok(
      content.includes('_lm === "true"'),
      'LIVE_MODE must require explicit "true" string, not truthy'
    );
  });
});

// ── Engine viejo (CryptoBotFinal) is truly no-op ────────────────────────────

describe("Engine viejo evaluate() is no-op", () => {
  it("evaluate() source code returns empty newTrades", () => {
    const content = fs.readFileSync(path.join(SRC, "engine.js"), "utf-8");
    // Find the evaluate() method
    const evalIdx = content.indexOf("evaluate(){");
    assert.ok(evalIdx > 0, "evaluate() method must exist in engine.js");

    // Extract the method body (rough extraction)
    const evalSection = content.slice(evalIdx, evalIdx + 500);

    // Must contain the no-op comment
    assert.ok(
      evalSection.includes("No-op") || evalSection.includes("no-op"),
      "evaluate() must be marked as no-op"
    );

    // Must return newTrades:[] (no actual trades generated)
    assert.ok(
      evalSection.includes("newTrades:[]"),
      "evaluate() must return empty newTrades array"
    );

    // Must NOT contain any BUY logic
    assert.ok(
      !evalSection.includes("type:\"BUY\"") && !evalSection.includes('type:"BUY"'),
      "evaluate() must not contain BUY trade generation"
    );
  });

  it("evaluate() runtime returns empty newTrades and signals", () => {
    // Require engine.js and instantiate CryptoBotFinal
    const { CryptoBotFinal } = require("../src/engine");
    const bot = new CryptoBotFinal();

    // Feed enough prices so evaluate() doesn't early-return
    bot.prices = {
      BTCUSDC: 65000, ETHUSDC: 3500, SOLUSDC: 84,
      BNBUSDC: 600, XRPUSDC: 0.55
    };
    // Need history for regime detection
    bot.history = { BTCUSDC: Array(100).fill(65000) };

    const result = bot.evaluate();
    assert.ok(result, "evaluate() must return a result object");
    assert.deepEqual(result.newTrades, [], "newTrades must be empty (no-op)");
    assert.deepEqual(result.signals, [], "signals must be empty (no-op)");
  });
});

// ── File structure sanity ───────────────────────────────────────────────────

describe("File structure", () => {
  const requiredFiles = [
    "src/server.js", "src/engine.js", "src/engine_simple.js",
    "src/trading/loop.js", "src/trading/state.js",
    "src/database.js", "src/telegram.js",
    "src/risk.js", "src/market.js",
    "package.json",
  ];

  for (const file of requiredFiles) {
    it(`${file} exists`, () => {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} must exist`);
    });
  }
});
