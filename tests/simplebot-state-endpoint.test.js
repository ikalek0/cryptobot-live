// ── A10: /api/simpleBot/state debe exponer flags de pausa ──────────────
// El endpoint sirve como single point para watchdogs externos: capViolation,
// drawdownPct, capitalSyncPausedUntil, y — tras A10 — paused/tgControlsPaused.
// Sin estos, un monitor tipo Uptime Kuma no puede distinguir "bot corriendo"
// de "bot pausado por /pausa Telegram", y podría dar falsos positivos en
// dashboards de uptime.
//
// Los tests funcionan en dos niveles:
//   1) Source-level: grep del source de server.js para asegurar que los
//      campos nuevos están presentes (regression guard).
//   2) Runtime: replica literal del handler en un mini Express para
//      ejercitarlo con un fake S.simpleBot y verificar el JSON emitido.
//      El handler real no se carga porque require("../src/server") arranca
//      listeners, sockets, y el bot entero.
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");

process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

const SRC = path.resolve(__dirname, "../src");
const serverSrc = fs.readFileSync(path.join(SRC, "server.js"), "utf-8");

// ── Source-level regression guard ──────────────────────────────────────

describe("A10 — /api/simpleBot/state source guard", () => {
  it("endpoint expone `paused` en el JSON response", () => {
    // El string "paused," debe aparecer en el bloque del handler
    const idx = serverSrc.indexOf('"/api/simpleBot/state"');
    assert.ok(idx > 0, "endpoint debe existir");
    const body = serverSrc.slice(idx, idx + 4000);
    assert.ok(/\bpaused\s*,/.test(body), "response debe incluir 'paused,'");
    assert.ok(/tgControlsPaused/.test(body), "response debe incluir 'tgControlsPaused'");
  });

  it("endpoint expone `capitalSyncPausedUntil` en raíz para watchdog externo", () => {
    const idx = serverSrc.indexOf('"/api/simpleBot/state"');
    const body = serverSrc.slice(idx, idx + 4000);
    assert.ok(/capitalSyncPausedUntil/.test(body),
      "response debe incluir capitalSyncPausedUntil para detectar A5 CB trip");
  });
});

// ── Runtime test: replica literal del handler ──────────────────────────
// Si la lógica del handler real diverge de esta réplica, el test no
// protege nada. Cualquier cambio al handler real debe reflejarse aquí.

// BUG-4: sentinel numérico FAR_FUTURE en vez de null, para que un watchdog
// externo pueda distinguir "pausa indefinida por CB A5 / boot invariant"
// de "dato ausente / no pausado". Flags ddCircuitBreakerTripped y
// bootInvariantViolated dan visibilidad explícita del motivo.
const FAR_FUTURE = 9999999999999;

function makeHandler(S, LIVE_MODE) {
  return (req, res) => {
    const sb = S.simpleBot;
    if (!sb) return res.status(503).json({ loading: true, instance: LIVE_MODE?"LIVE":"PAPER-LIVE" });
    const _capSync = Number.isFinite(sb._capitalSyncPausedUntil)
      ? (sb._capitalSyncPausedUntil || 0)
      : FAR_FUTURE;
    const s          = sb.getState();
    const committed  = Object.values(sb.portfolio||{}).reduce((a,p)=>a+(p.invest||0), 0);
    const capa1Cash  = sb.capa1Cash || 0;
    const capa2Cash  = sb.capa2Cash || 0;
    const totalLedger = capa1Cash + capa2Cash + committed;
    const cap        = S.CAPITAL_USDT;
    const tv         = s.totalValue || 0;
    const paused          = sb.paused === true;
    const tgControlsPaused = !!(S.tgControls && typeof S.tgControls.isPaused === "function" && S.tgControls.isPaused());
    res.json({
      instance:     LIVE_MODE ? "LIVE" : "PAPER-LIVE",
      cap:          cap,
      totalValue:   +tv.toFixed(4),
      capa1Cash:    +capa1Cash.toFixed(4),
      capa2Cash:    +capa2Cash.toFixed(4),
      committed:    +committed.toFixed(4),
      totalLedger:  +totalLedger.toFixed(4),
      paused,
      tgControlsPaused,
      capitalSyncPausedUntil: _capSync,
      ddCircuitBreakerTripped: sb._ddCircuitBreakerTripped === true,
      bootInvariantViolated:   sb._bootInvariantViolated === true,
      capitalSync: {
        pausedUntil: _capSync,
      },
    });
  };
}

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    }).on("error", reject);
  });
}

function fakeSimpleBot({
  paused = false,
  capitalSyncPausedUntil = 0,
  ddCircuitBreakerTripped = false,
  bootInvariantViolated = false,
} = {}) {
  return {
    paused,
    _capitalSyncPausedUntil: capitalSyncPausedUntil,
    _ddCircuitBreakerTripped: ddCircuitBreakerTripped,
    _bootInvariantViolated: bootInvariantViolated,
    capa1Cash: 60, capa2Cash: 40, portfolio: {},
    getState: () => ({ totalValue: 100, drawdownPct: 0, peakTv: 100, baseline: 100, trades: 0, winRate: 0, returnPct: 0 }),
  };
}

describe("A10 — /api/simpleBot/state runtime", () => {
  let server, port;
  let S;

  before(async () => {
    S = { simpleBot: null, CAPITAL_USDT: 100, tgControls: null };
    const app = express();
    app.get("/api/simpleBot/state", makeHandler(S, false));
    server = app.listen(0);
    await new Promise(r => server.on("listening", r));
    port = server.address().port;
  });

  after(() => { server.close(); });

  it("bot pausado: paused=true en el JSON response", async () => {
    S.simpleBot = fakeSimpleBot({ paused: true });
    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.status, 200);
    assert.equal(r.body.paused, true, "paused debe ser true");
  });

  it("bot no pausado: paused=false en el JSON response", async () => {
    S.simpleBot = fakeSimpleBot({ paused: false });
    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.body.paused, false);
  });

  it("tgControls.isPaused() true → tgControlsPaused=true", async () => {
    S.simpleBot = fakeSimpleBot({ paused: false });
    S.tgControls = { isPaused: () => true };
    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.body.tgControlsPaused, true, "tgControlsPaused debe reflejar listener Telegram");
    S.tgControls = null;
  });

  it("tgControls null → tgControlsPaused=false (no crash)", async () => {
    S.simpleBot = fakeSimpleBot({ paused: false });
    S.tgControls = null;
    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.body.tgControlsPaused, false);
  });

  // ── BUG-4 tests ──────────────────────────────────────────────────────
  // Sentinel FAR_FUTURE en vez de null + flags explícitos para watchdog.

  it("BUG-4: capitalSyncPausedUntil=Infinity → FAR_FUTURE (no null)", async () => {
    S.simpleBot = fakeSimpleBot({
      capitalSyncPausedUntil: Infinity,
      ddCircuitBreakerTripped: true,
    });
    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.body.capitalSyncPausedUntil, FAR_FUTURE,
      "Infinity debe serializarse como FAR_FUTURE sentinel, no null");
    assert.notEqual(r.body.capitalSyncPausedUntil, null,
      "null sería ambiguo: watchdog no distingue 'sin dato' de 'pausa infinita'");
  });

  it("BUG-4: CB tripped → ddCircuitBreakerTripped=true en endpoint", async () => {
    S.simpleBot = fakeSimpleBot({
      capitalSyncPausedUntil: Infinity,
      ddCircuitBreakerTripped: true,
    });
    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.body.ddCircuitBreakerTripped, true,
      "watchdog debe detectar CB trip explícitamente");
    assert.equal(r.body.bootInvariantViolated, false);
  });

  it("BUG-4: boot invariant violated → bootInvariantViolated=true en endpoint", async () => {
    S.simpleBot = fakeSimpleBot({
      capitalSyncPausedUntil: Infinity,
      bootInvariantViolated: true,
    });
    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.body.bootInvariantViolated, true,
      "watchdog debe detectar boot invariant violation explícitamente");
    assert.equal(r.body.ddCircuitBreakerTripped, false);
  });

  it("BUG-4: sin flags → ambos false, pausedUntil finito o 0", async () => {
    const future = Date.now() + 300000;
    S.simpleBot = fakeSimpleBot({ capitalSyncPausedUntil: future });
    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.body.capitalSyncPausedUntil, future);
    assert.equal(r.body.ddCircuitBreakerTripped, false);
    assert.equal(r.body.bootInvariantViolated, false);
    assert.ok(Number.isFinite(r.body.capitalSyncPausedUntil) && r.body.capitalSyncPausedUntil < FAR_FUTURE,
      "timeout normal debe ser valor finito < FAR_FUTURE");
  });

  it("BUG-4: capitalSync.pausedUntil sub-objeto también usa FAR_FUTURE", async () => {
    S.simpleBot = fakeSimpleBot({ capitalSyncPausedUntil: Infinity });
    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.body.capitalSync.pausedUntil, FAR_FUTURE,
      "sub-objeto capitalSync.pausedUntil también debe usar sentinel");
  });

  it("capitalSyncPausedUntil finito → valor numérico en JSON", async () => {
    const future = Date.now() + 300000;
    S.simpleBot = fakeSimpleBot({ capitalSyncPausedUntil: future });
    const r = await getJson(port, "/api/simpleBot/state");
    assert.equal(r.body.capitalSyncPausedUntil, future);
  });
});
