// ── BUG-N + BUG-O + BUG-P regression tests (24 abr 2026) ─────────────────
// Tres bugs de deuda técnica detectados en la sesión post-merge de
// pre-live-hardening. Cada uno tiene su commit propio; este archivo agrupa
// el coverage en un único suite para revertir granularmente si hace falta.
//
// BUG-N — broadcast({type:"tick"}) en loop.js leía S.bot.getState() (engine
//   zombie) en vez de getReportingState(S). Dashboard websocket veía $100/0
//   trades. Source-code audit replica la guardia de reporting-state.test.js.
//
// BUG-O — _peakTv arrancaba null tras boot fresh / resetAccounting. El
//   primer getState() lo asignaba a totalValue() puntual post-sync, lo que
//   podía dar peak < efectivo y disparar CB de drawdown 80% espurio. Lazy-
//   init en el success path de syncCapitalFromBinance.
//
// BUG-P — /api/simpleBot/state no exponía sb.log. Watchdog no podía
//   reconstruir historial reciente sin pegar a /api/simple (state completo
//   sin acotar tamaño). Añadido `log: sb.log.slice(-200)`.
"use strict";

process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");

const SRC = path.resolve(__dirname, "../src");

// ════════════════════════════════════════════════════════════════════════
// BUG-N — broadcast usa getReportingState, NO S.bot.getState
// ════════════════════════════════════════════════════════════════════════

describe("BUG-N — broadcast({type:'tick'}) usa getReportingState", () => {
  const loopSrc = fs.readFileSync(path.join(SRC, "trading", "loop.js"), "utf-8");

  it("getReportingState ya está importado en loop.js", () => {
    assert.ok(/require\(["']\.\.\/reporting_state["']\)/.test(loopSrc),
      "loop.js debe seguir importando getReportingState desde ../reporting_state");
    assert.ok(/getReportingState/.test(loopSrc),
      "el símbolo getReportingState debe estar referenciado");
  });

  it("ningún broadcast({type:'tick'}) hace spread de S.bot.getState()", () => {
    // Buscar todas las llamadas a broadcast({type:"tick", ...}) y verificar
    // que el spread del data{} no usa S.bot.getState(). El patrón zombie es:
    //   broadcast({ type:"tick", data:{ ...S.bot.getState(), ... } })
    // El patrón correcto post-fix es:
    //   broadcast({ type:"tick", data:{ ...getReportingState(S), ... } })
    const lines = loopSrc.split("\n");
    const offending = [];
    for (let i = 0; i < lines.length; i++) {
      const window = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
      if (/broadcast\(\s*\{\s*type\s*:\s*["']tick["']/.test(window)
          && /\.\.\.\s*S\.bot\.getState\(\)/.test(window)) {
        offending.push(`${i+1}: ${lines[i].trim()}`);
      }
    }
    assert.equal(offending.length, 0,
      `broadcast({type:'tick'}) NO debe spreadear S.bot.getState() (engine zombie). Offenders:\n${offending.join("\n")}`);
  });

  it("ambos broadcast({type:'tick'}) hacen spread de getReportingState(S)", () => {
    // Contar las apariciones del patrón correcto en líneas con broadcast tick.
    const lines = loopSrc.split("\n");
    let matches = 0;
    for (let i = 0; i < lines.length; i++) {
      const window = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
      if (/broadcast\(\s*\{\s*type\s*:\s*["']tick["']/.test(window)
          && /\.\.\.\s*getReportingState\(\s*S\s*\)/.test(window)) {
        matches++;
      }
    }
    // Hay 2 broadcasts: boot-warmup (línea ~228) y tick principal (~447).
    // Cada uno aparece en una ventana propia, pero también puede ser
    // contado por ventanas adyacentes — usamos >=2 para no atar a la
    // implementación exacta del scanner.
    assert.ok(matches >= 2,
      `debe haber ≥2 broadcasts({type:'tick'}) usando getReportingState(S), encontré ${matches}`);
  });
});

// ════════════════════════════════════════════════════════════════════════
// BUG-O — lazy-init _peakTv tras primer syncCapitalFromBinance OK
// ════════════════════════════════════════════════════════════════════════

const { SimpleBotEngine, INITIAL_CAPITAL } = require("../src/engine_simple");

function makeFakeBinance(usdcFree) {
  return async (method, path, params) => {
    if (path === "ticker/price" && params?.symbol === "USDCUSDT") {
      return { symbol: "USDCUSDT", price: "1.0" };
    }
    if (path === "account") {
      return { balances: [
        { asset: "USDC", free: String(usdcFree), locked: "0" },
        { asset: "BNB",  free: "0.05",          locked: "0" },
      ]};
    }
    if (path === "myTrades") return [];
    throw new Error(`unexpected path: ${path}`);
  };
}

describe("BUG-O — lazy-init _peakTv tras syncCapitalFromBinance success", () => {
  it("boot fresh (saved.peakTv=null) → post-sync _peakTv = max(totalValue, efectivo)", async () => {
    const bot = new SimpleBotEngine({});
    assert.equal(bot._peakTv, null, "constructor sin saved.peakTv → null sentinela");

    const r = await bot.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(100),
      binancePublicRequest:   makeFakeBinance(100),
      liveMode: true,
    });
    assert.equal(r.ok, true, "sync debe completar OK");

    assert.notEqual(bot._peakTv, null,
      "tras success path, _peakTv NO debe seguir null");
    const expected = Math.max(bot.totalValue(), bot._capitalEfectivo);
    assert.equal(bot._peakTv, expected,
      `_peakTv debe ser max(totalValue=${bot.totalValue()}, efectivo=${bot._capitalEfectivo})`);
    assert.ok(bot._peakTv >= bot._capitalEfectivo,
      "invariante: peak inicial >= efectivo, así DD inicial = 0");
  });

  it("contra-test: saved.peakTv=100 NO se sobrescribe tras sync", async () => {
    const bot = new SimpleBotEngine({ peakTv: 100 });
    assert.equal(bot._peakTv, 100, "constructor con saved.peakTv=100 lo respeta");

    const r = await bot.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(150),
      binancePublicRequest:   makeFakeBinance(150),
      liveMode: true,
    });
    assert.equal(r.ok, true);

    assert.equal(bot._peakTv, 100,
      "_peakTv preservado: el lazy-init sólo actúa cuando es null");
  });

  it("PAPER-LIVE skip: lazy-init NO ejecutado (sigue null)", async () => {
    const bot = new SimpleBotEngine({});
    assert.equal(bot._peakTv, null);

    const r = await bot.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(100),
      binancePublicRequest:   makeFakeBinance(100),
      liveMode: false, // PAPER-LIVE short-circuit
    });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true, "PAPER-LIVE: sync skip explícito");

    assert.equal(bot._peakTv, null,
      "lazy-init sólo aplica al success path real, no al short-circuit PAPER-LIVE");
  });

  it("error path: lazy-init NO ejecutado", async () => {
    const bot = new SimpleBotEngine({});
    assert.equal(bot._peakTv, null);

    // Mock que tira error en account → entra al catch
    const failingBinance = async (method, path, params) => {
      if (path === "ticker/price" && params?.symbol === "USDCUSDT") {
        return { symbol: "USDCUSDT", price: "1.0" };
      }
      if (path === "account") throw new Error("simulated network error");
      return [];
    };
    const r = await bot.syncCapitalFromBinance({
      binanceReadOnlyRequest: failingBinance,
      binancePublicRequest:   failingBinance,
      liveMode: true,
    });
    assert.equal(r.ok, false, "sync debe fallar");
    assert.equal(bot._peakTv, null,
      "error path no debe disparar el lazy-init (la inicialización requiere capitalEfectivo válido)");
  });

  it("invariante post-fix: drawdownPct inicial = 0 en boot fresh + sync OK", async () => {
    const bot = new SimpleBotEngine({});
    await bot.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(100),
      binancePublicRequest:   makeFakeBinance(100),
      liveMode: true,
    });

    const s = bot.getState();
    assert.ok(s.drawdownPct < 1,
      `drawdownPct inicial debe ser ≈0 (no >80% espurio), got ${s.drawdownPct}`);
    assert.equal(bot._ddCircuitBreakerTripped !== true, true,
      "el CB de drawdown 15% NO debe estar tripped en boot fresh");
  });

  it("source guard: lazy-init existe en syncCapitalFromBinance", () => {
    const engineSrc = fs.readFileSync(path.join(SRC, "engine_simple.js"), "utf-8");
    // El bloque lazy-init debe estar presente cerca del return ok:true.
    assert.ok(/this\._peakTv\s*===\s*null[\s\S]{0,200}Math\.max\(\s*this\.totalValue\(\)\s*,\s*this\._capitalEfectivo\s*\)/.test(engineSrc),
      "el bloque lazy-init `_peakTv === null → Math.max(totalValue, _capitalEfectivo)` debe existir en engine_simple.js");
  });
});

// ════════════════════════════════════════════════════════════════════════
// BUG-P — /api/simpleBot/state expone log[] (slice -200)
// ════════════════════════════════════════════════════════════════════════

const serverSrc = fs.readFileSync(path.join(SRC, "server.js"), "utf-8");

describe("BUG-P — /api/simpleBot/state expone log[] slice(-200) source guard", () => {
  it("handler /api/simpleBot/state contiene `log: ...sb.log.slice(-200)`", () => {
    const idx = serverSrc.indexOf('"/api/simpleBot/state"');
    assert.ok(idx > 0, "endpoint debe existir");
    const body = serverSrc.slice(idx, idx + 5000);
    assert.ok(/log\s*:\s*Array\.isArray\(sb\.log\)\s*\?\s*sb\.log\.slice\(\s*-200\s*\)\s*:\s*\[\s*\]/.test(body),
      "handler debe incluir `log: Array.isArray(sb.log) ? sb.log.slice(-200) : []`");
  });
});

// Replica literal del handler (siguiendo el patrón de simplebot-state-endpoint.test.js).
// Si el handler real diverge, este test no protege; sincronizar manualmente.
const FAR_FUTURE = 9999999999999;

function makeHandler(S, LIVE_MODE) {
  return (req, res) => {
    const sb = S.simpleBot;
    if (!sb) return res.status(503).json({ loading: true, instance: LIVE_MODE?"LIVE":"PAPER-LIVE" });
    const _capSync = Number.isFinite(sb._capitalSyncPausedUntil)
      ? (sb._capitalSyncPausedUntil || 0)
      : FAR_FUTURE;
    const s = sb.getState();
    const tv = s.totalValue || 0;
    res.json({
      instance: LIVE_MODE ? "LIVE" : "PAPER-LIVE",
      totalValue: +tv.toFixed(4),
      capitalSyncPausedUntil: _capSync,
      // BUG-P: campo bajo test
      log: Array.isArray(sb.log) ? sb.log.slice(-200) : [],
    });
  };
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: urlPath }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    }).on("error", reject);
  });
}

function fakeSimpleBot({ log } = {}) {
  return {
    log,
    _capitalSyncPausedUntil: 0,
    getState: () => ({ totalValue: 100 }),
  };
}

describe("BUG-P — /api/simpleBot/state runtime payload.log", () => {
  let server, port;
  let S;

  before(async () => {
    S = { simpleBot: null };
    const app = express();
    app.get("/api/simpleBot/state", makeHandler(S, false));
    server = app.listen(0);
    await new Promise(r => server.on("listening", r));
    port = server.address().port;
  });

  after(() => { server.close(); });

  it("sb.log con 500 entries → payload.log tiene 200 (slice -200)", async () => {
    const big = [];
    for (let i = 0; i < 500; i++) {
      big.push({ type: i % 2 === 0 ? "BUY" : "SELL", symbol: "BTCUSDC", ts: i });
    }
    S.simpleBot = fakeSimpleBot({ log: big });

    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.status, 200);
    assert.equal(Array.isArray(r.body.log), true);
    assert.equal(r.body.log.length, 200,
      "log debe estar acotado a las últimas 200 entries");
    // Verificar que son las ÚLTIMAS 200, no las primeras
    assert.equal(r.body.log[0].ts, 300, "primer entry del slice debe ser ts=300 (índice 500-200)");
    assert.equal(r.body.log[199].ts, 499, "último entry debe ser ts=499");
  });

  it("sb.log con 50 entries → payload.log tiene 50 (no upper bound artificial)", async () => {
    const small = [];
    for (let i = 0; i < 50; i++) {
      small.push({ type: "BUY", symbol: "ETHUSDC", ts: i });
    }
    S.simpleBot = fakeSimpleBot({ log: small });

    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.body.log.length, 50, "logs <200 deben pasar enteros");
  });

  it("sb.log undefined → payload.log === [] (no crash)", async () => {
    S.simpleBot = fakeSimpleBot({ log: undefined });

    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.status, 200, "no debe crashear con sb.log undefined");
    assert.deepEqual(r.body.log, [], "log debe ser array vacío, no undefined/null");
  });

  it("sb.log = null → payload.log === [] (no crash, Array.isArray false)", async () => {
    S.simpleBot = fakeSimpleBot({ log: null });

    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.log, []);
  });

  it("sb.log = string (corrupto) → payload.log === [] (Array.isArray guard)", async () => {
    // Edge case: si por algún path raro sb.log se asignara a algo no-array,
    // el Array.isArray guard previene .slice() crash.
    S.simpleBot = fakeSimpleBot({ log: "corrupted-not-an-array" });

    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.log, []);
  });
});
