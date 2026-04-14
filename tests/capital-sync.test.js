// ── T0: Capital dinámico — tests unitarios ──────────────────────────────
// Mockea binanceReadOnlyRequest para verificar los 3 escenarios + fallo.
"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

// Fijar CAP a 100 antes de require para que INITIAL_CAPITAL se lea
process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

const { SimpleBotEngine } = require("../src/engine_simple");

// Helper: crea un fake binanceReadOnlyRequest que devuelve balances dados.
function makeFakeBinance(usdcFree) {
  return async (method, path, params) => {
    if (method !== "GET") throw new Error("read-only");
    if (path !== "account") throw new Error("unexpected path");
    return {
      balances: [
        { asset: "USDC", free: String(usdcFree), locked: "0" },
        // Otros assets (SOL/XRP incidente) presentes pero NO deben contar
        // — la lógica itera sobre this.portfolio, no sobre balances.
        { asset: "SOL",  free: "0.594", locked: "0" },
        { asset: "XRP",  free: "36",    locked: "0" },
      ],
    };
  };
}

function makeFailingBinance(reason="network down") {
  return async () => { throw new Error(reason); };
}

describe("T0 — Capital dinámico", () => {
  // ── H7: Boot fail-closed ────────────────────────────────────────────────
  // Regression guard: el constructor debe dejar _capitalSyncPausedUntil en el
  // futuro hasta que el primer sync tenga éxito. Un primer sync fallido (o
  // ausente) mantiene BUYs bloqueados — mejor pausado que operando con datos
  // stale del saved state post-restart (incidente 12-abril).
  describe("H7: boot fail-closed default", () => {
    it("new SimpleBotEngine({}) deja _capitalSyncPausedUntil en el futuro (≥9min, ≤11min)", () => {
      const before = Date.now();
      const eng = new SimpleBotEngine({});
      const delta = eng._capitalSyncPausedUntil - before;
      assert.ok(delta >= 9*60*1000, `pausedUntil debe ser al menos 9min en el futuro, delta=${delta}ms`);
      assert.ok(delta <= 11*60*1000, `pausedUntil debe ser como mucho 11min en el futuro, delta=${delta}ms`);
    });

    it("primer sync exitoso resetea _capitalSyncPausedUntil a 0", async () => {
      const eng = new SimpleBotEngine({});
      assert.ok(eng._capitalSyncPausedUntil > Date.now(), "pre-sync: paused");
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(100),
      });
      assert.equal(r.ok, true);
      assert.equal(eng._capitalSyncPausedUntil, 0, "post-sync OK: unpaused");
    });

    it("primer sync fallido sobreescribe el default con pausa de 5min (no extiende los 10min)", async () => {
      const eng = new SimpleBotEngine({});
      const before = Date.now();
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFailingBinance("down"),
      });
      assert.equal(r.ok, false);
      // tras el fallo, el catch setea a now + 5min, lo que es < el default de 10min.
      const delta = eng._capitalSyncPausedUntil - before;
      assert.ok(delta >= 4*60*1000 && delta <= 6*60*1000,
        `post-fail: pausedUntil=${delta}ms debe caer en ventana 5min ±1`);
    });
  });

  // ── H6: Persistencia de estado de sync entre restarts ─────────────────
  // saveState() debe persistir los 4 campos de sync (failCount, pausedUntil,
  // lastTs, lastOk) y el constructor debe restaurarlos. Sin esto, un PM2
  // restart durante una pausa por fallo de sync arranca como si todo OK.
  describe("H6: persistencia del estado de sync", () => {
    it("saveState devuelve los 4 campos de sync", () => {
      const eng = new SimpleBotEngine({});
      eng._capitalSyncFailCount = 3;
      eng._lastCapitalSyncTs = 1700000000000;
      eng._lastCapitalSyncOk = false;
      const fixedPaused = Date.now() + 20*60*1000; // 20min futuro
      eng._capitalSyncPausedUntil = fixedPaused;

      const st = eng.saveState();
      assert.equal(st.capitalSyncFailCount, 3);
      assert.equal(st.lastCapitalSyncTs, 1700000000000);
      assert.equal(st.lastCapitalSyncOk, false);
      assert.equal(st.capitalSyncPausedUntil, fixedPaused);
    });

    it("round-trip: saveState → new instance restaura failCount y lastTs", () => {
      const a = new SimpleBotEngine({});
      a._capitalSyncFailCount = 2;
      a._lastCapitalSyncTs = 1700000000000;
      a._lastCapitalSyncOk = false;
      const saved = a.saveState();
      const b = new SimpleBotEngine(saved);
      assert.equal(b._capitalSyncFailCount, 2);
      assert.equal(b._lastCapitalSyncTs, 1700000000000);
      assert.equal(b._lastCapitalSyncOk, false);
    });

    it("saved pausedUntil > now+10min → se mantiene (no baja por default)", () => {
      const a = new SimpleBotEngine({});
      const future30min = Date.now() + 30*60*1000;
      a._capitalSyncPausedUntil = future30min;
      const saved = a.saveState();
      const b = new SimpleBotEngine(saved);
      assert.ok(b._capitalSyncPausedUntil >= future30min - 100,
        `saved 30min future debe mantenerse, got ${b._capitalSyncPausedUntil - Date.now()}ms`);
    });

    it("saved pausedUntil = 0 → constructor aplica fail-closed default (10min)", () => {
      const a = new SimpleBotEngine({});
      a._capitalSyncPausedUntil = 0;
      const saved = a.saveState();
      // assert: saveState persiste el 0 tal cual
      assert.equal(saved.capitalSyncPausedUntil, 0);
      // pero constructor aplica Math.max con el fail-closed default
      const before = Date.now();
      const b = new SimpleBotEngine(saved);
      const delta = b._capitalSyncPausedUntil - before;
      assert.ok(delta >= 9*60*1000 && delta <= 11*60*1000,
        `fail-closed default debe aplicarse, delta=${delta}ms`);
    });

    it("saved pausedUntil pasado (restart tardío) → default fail-closed supera", () => {
      const a = new SimpleBotEngine({});
      a._capitalSyncPausedUntil = Date.now() - 60*60*1000; // hace 1h (expirado)
      const saved = a.saveState();
      const before = Date.now();
      const b = new SimpleBotEngine(saved);
      const delta = b._capitalSyncPausedUntil - before;
      assert.ok(delta >= 9*60*1000,
        `pausedUntil expirado + fail-closed debe dar ≥9min, delta=${delta}ms`);
    });
  });

  describe("Escenario 1: real < declarado → efectivo = real", () => {
    it("$50 real vs $100 declarado → efectivo=$50, capa1=$30, capa2=$20", async () => {
      const eng = new SimpleBotEngine({});
      // Portfolio vacío, valorPosiciones = 0, usdcLibre = 50 → real = 50
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(50),
      });
      assert.equal(r.ok, true);
      assert.equal(r.capitalDeclarado, 100);
      assert.equal(r.capitalReal, 50);
      assert.equal(r.capitalEfectivo, 50);
      assert.equal(r.usdcLibre, 50);
      assert.equal(r.valorPosiciones, 0);
      assert.ok(Math.abs(eng.capa1Cash - 30) < 0.01, `capa1Cash=${eng.capa1Cash}`);
      assert.ok(Math.abs(eng.capa2Cash - 20) < 0.01, `capa2Cash=${eng.capa2Cash}`);
    });
  });

  describe("Escenario 2: real == declarado → efectivo = declarado", () => {
    it("$100 real vs $100 declarado → efectivo=$100, capa1=$60, capa2=$40", async () => {
      const eng = new SimpleBotEngine({});
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(100),
      });
      assert.equal(r.ok, true);
      assert.equal(r.capitalReal, 100);
      assert.equal(r.capitalEfectivo, 100);
      assert.ok(Math.abs(eng.capa1Cash - 60) < 0.01);
      assert.ok(Math.abs(eng.capa2Cash - 40) < 0.01);
    });
  });

  describe("Escenario 3: real > declarado → efectivo = declarado (cap)", () => {
    it("$500 real vs $100 declarado → efectivo=$100 (ignora exceso)", async () => {
      const eng = new SimpleBotEngine({});
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(500),
      });
      assert.equal(r.ok, true);
      assert.equal(r.capitalReal, 500);
      assert.equal(r.capitalEfectivo, 100, "efectivo debe capearse al declarado");
      assert.ok(Math.abs(eng.capa1Cash - 60) < 0.01);
      assert.ok(Math.abs(eng.capa2Cash - 40) < 0.01);
    });
  });

  describe("valorPosiciones SÓLO itera sobre this.portfolio (no sobre todos los balances)", () => {
    it("SOL/XRP en balances pero NO en portfolio → no se cuentan", async () => {
      const eng = new SimpleBotEngine({});
      // $4 libre + SOL/XRP huérfanos en balances (ver makeFakeBinance).
      // El bot NO los conoce → valorPosiciones=0, real=$4.
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(4),
      });
      assert.equal(r.ok, true);
      assert.equal(r.valorPosiciones, 0);
      assert.equal(r.capitalReal, 4);
      assert.equal(r.capitalEfectivo, 4);
    });

    it("Posición en this.portfolio → SÍ se cuenta con su MTM", async () => {
      const eng = new SimpleBotEngine({});
      // Simular una posición abierta gestionada por el bot
      eng.portfolio["BNB_1h_RSI"] = {
        pair: "BNBUSDC", capa: 1, type: "RSI_MR_ADX", tf: "1h",
        entryPrice: 600, qty: 0.05,           // MTM a $700 = $35
        stop: 595, target: 610, openTs: Date.now(),
        invest: 30, status: "filled",
      };
      eng.prices["BNBUSDC"] = 700;            // MTM nuevo = 0.05 * 700 = 35
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(10), // libre=$10
      });
      assert.equal(r.ok, true);
      assert.equal(r.valorPosiciones, 35, "MTM debe contar la pos gestionada");
      assert.equal(r.capitalReal, 45);
      assert.equal(r.capitalEfectivo, 45);
      // committed c1 = 30; capa1Cash = max(0, 45*0.60 - 30) = max(0, -3) = 0
      assert.ok(Math.abs(eng.capa1Cash - 0) < 0.01, `capa1Cash=${eng.capa1Cash}`);
      // La posición NO se cierra por el ajuste
      assert.ok(eng.portfolio["BNB_1h_RSI"], "posición abierta no debe cerrarse");
    });
  });

  describe("Fallo de Binance → pausa BUYs 5min", () => {
    it("sync falla → _capitalSyncPausedUntil > now y failCount++", async () => {
      const eng = new SimpleBotEngine({});
      const before = Date.now();
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFailingBinance("timeout"),
      });
      assert.equal(r.ok, false);
      assert.equal(eng._capitalSyncFailCount, 1);
      assert.equal(eng._lastCapitalSyncOk, false);
      assert.ok(eng._capitalSyncPausedUntil >= before + 4*60*1000,
        `pausedUntil=${eng._capitalSyncPausedUntil} before=${before}`);
      assert.ok(eng._capitalSyncPausedUntil <= before + 6*60*1000);
    });

    it("3 fallos consecutivos disparan telegramSend", async () => {
      const eng = new SimpleBotEngine({});
      let telegramCalls = 0;
      let lastMsg = "";
      const deps = {
        binanceReadOnlyRequest: makeFailingBinance("rate limit"),
        telegramSend: (msg) => { telegramCalls++; lastMsg = msg; },
      };
      await eng.syncCapitalFromBinance(deps);
      await eng.syncCapitalFromBinance(deps);
      await eng.syncCapitalFromBinance(deps);
      assert.equal(eng._capitalSyncFailCount, 3);
      assert.equal(telegramCalls, 1, "telegram sólo dispara al llegar a 3 fallos");
      assert.ok(lastMsg.includes("CAPITAL-SYNC"));
    });

    it("sync OK tras fallo resetea failCount y pausa", async () => {
      const eng = new SimpleBotEngine({});
      await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFailingBinance(),
      });
      assert.equal(eng._capitalSyncFailCount, 1);
      assert.ok(eng._capitalSyncPausedUntil > 0);

      const ok = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(80),
      });
      assert.equal(ok.ok, true);
      assert.equal(eng._capitalSyncFailCount, 0);
      assert.equal(eng._capitalSyncPausedUntil, 0);
      assert.equal(eng._lastCapitalSyncOk, true);
    });
  });

  describe("Invariante del cap: jamás > declarado", () => {
    it("aunque real=$9999, capitalEfectivo sigue siendo 100", async () => {
      const eng = new SimpleBotEngine({});
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(9999),
      });
      assert.equal(r.capitalEfectivo, 100);
      assert.ok(eng.capa1Cash + eng.capa2Cash <= 100.001,
        `cash total ${eng.capa1Cash + eng.capa2Cash} debe ≤ 100`);
    });
  });

  describe("Posiciones abiertas en ambas capas: ajuste proporcional sin cerrar", () => {
    it("efectivo baja → cash libre cae en ambas capas, portfolio intacto", async () => {
      const eng = new SimpleBotEngine({});
      // Dos posiciones, una en cada capa
      eng.portfolio["SOL_1h_EMA"] = {
        pair: "SOLUSDC", capa: 1, type: "EMA_CROSS", tf: "1h",
        entryPrice: 180, qty: 0.05,
        stop: 178, target: 183, openTs: Date.now(),
        invest: 9, status: "filled",
      };
      eng.portfolio["XRP_4h_EMA"] = {
        pair: "XRPUSDC", capa: 2, type: "EMA_CROSS", tf: "4h",
        entryPrice: 0.5, qty: 20,
        stop: 0.485, target: 0.53, openTs: Date.now(),
        invest: 10, status: "filled",
      };
      eng.prices["SOLUSDC"] = 180;
      eng.prices["XRPUSDC"] = 0.5;
      // MTM: SOL=9, XRP=10 → valorPosiciones=19
      // usdcLibre=40 → real=59 → efectivo=59
      // committedC1=9, committedC2=10
      // capa1Cash = max(0, 59*0.60 - 9) = max(0, 26.4) = 26.4
      // capa2Cash = max(0, 59*0.40 - 10) = max(0, 13.6) = 13.6
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(40),
      });
      assert.equal(r.ok, true);
      assert.equal(r.capitalReal, 59);
      assert.equal(r.capitalEfectivo, 59);
      assert.ok(Math.abs(eng.capa1Cash - 26.4) < 0.01, `capa1Cash=${eng.capa1Cash}`);
      assert.ok(Math.abs(eng.capa2Cash - 13.6) < 0.01, `capa2Cash=${eng.capa2Cash}`);
      // Portfolio intacto — regla 6
      assert.ok(eng.portfolio["SOL_1h_EMA"]);
      assert.ok(eng.portfolio["XRP_4h_EMA"]);
    });
  });
});
