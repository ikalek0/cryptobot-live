// ── T0: Capital dinámico — tests unitarios ──────────────────────────────
// Mockea binanceReadOnlyRequest para verificar los 3 escenarios + fallo.
"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

// Fijar CAP a 100 antes de require para que INITIAL_CAPITAL se lea
process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

const { SimpleBotEngine, STRATEGIES, evalSignal } = require("../src/engine_simple");

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
        binancePublicRequest: makeFakeBinance(100),
      });
      assert.equal(r.ok, true);
      assert.equal(eng._capitalSyncPausedUntil, 0, "post-sync OK: unpaused");
    });

    // BATCH-4 FIX #5: Math.max preserves the longer H7 pause
    it("primer sync fallido preserva H7 pause (Math.max, no sobreescribe)", async () => {
      const eng = new SimpleBotEngine({});
      const before = Date.now();
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFailingBinance("down"),
        binancePublicRequest: makeFailingBinance("down"),
      });
      assert.equal(r.ok, false);
      // Math.max(H7 10min, now+5min) = H7 10min (since H7 was set ~same time)
      const delta = eng._capitalSyncPausedUntil - before;
      assert.ok(delta >= 4*60*1000,
        `post-fail: pausedUntil=${delta}ms debe ser >= 4min`);
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
        binancePublicRequest: makeFakeBinance(50),
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
        binancePublicRequest: makeFakeBinance(100),
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
        binancePublicRequest: makeFakeBinance(500),
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
        binancePublicRequest: makeFakeBinance(4),
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
        binanceReadOnlyRequest: makeFakeBinance(10),
        binancePublicRequest: makeFakeBinance(10), // libre=$10
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
      // Clear H7 default pause so we test pure sync error behavior
      eng._capitalSyncPausedUntil = 0;
      const before = Date.now();
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFailingBinance("timeout"),
        binancePublicRequest: makeFailingBinance("timeout"),
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
        binancePublicRequest: makeFailingBinance("rate limit"),
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
        binancePublicRequest: makeFailingBinance(),
      });
      assert.equal(eng._capitalSyncFailCount, 1);
      assert.ok(eng._capitalSyncPausedUntil > 0);

      const ok = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(80),
        binancePublicRequest: makeFakeBinance(80),
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
        binancePublicRequest: makeFakeBinance(9999),
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
        binancePublicRequest: makeFakeBinance(40),
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

  // ── M14: returnPct y drawdownPct contra baseline honesto ─────────────
  // El bug previo reportaba returnPct=-86% con capital real $14 vs declarado
  // $100 desde el primer tick, disparando falsas alertas de drawdown.
  // El fix: baseline = _capitalEfectivo, drawdown desde peak histórico.
  describe("M14: returnPct y drawdownPct contra baseline honesto", () => {
    it("tv == baseline → returnPct == 0 (no hay ganancia ni pérdida)", async () => {
      const eng = new SimpleBotEngine({});
      // Sync contra Binance con real=$50 → efectivo=$50 → baseline=$50
      await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(50),
        binancePublicRequest: makeFakeBinance(50),
      });
      // capa1=$30 + capa2=$20 = tv $50 = baseline
      assert.ok(Math.abs(eng.totalValue() - 50) < 0.01, `tv=${eng.totalValue()}`);
      const st = eng.getState();
      assert.equal(st.returnPct, 0,
        `baseline=$50, tv=$50 → returnPct debe ser 0, got ${st.returnPct}`);
      assert.equal(st.baseline, 50);
    });

    it("tv == baseline * 1.1 → returnPct == 10.0", async () => {
      const eng = new SimpleBotEngine({});
      await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(50),
        binancePublicRequest: makeFakeBinance(50),
      });
      // Simular ganancia: subir cash $5 (10%)
      eng.capa1Cash += 5;
      const st = eng.getState();
      assert.equal(st.returnPct, 10.0,
        `baseline=50, tv=55 → returnPct debe ser 10.0, got ${st.returnPct}`);
    });

    it("con capital real $14 < declarado $100 → returnPct NO reporta -86%", async () => {
      // Regression test del bug original: este escenario reportaba -85.84%.
      const eng = new SimpleBotEngine({});
      await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(14.16),
        binancePublicRequest: makeFakeBinance(14.16),
      });
      // baseline=14.16, tv=14.16 → returnPct=0, no -86%
      const st = eng.getState();
      assert.equal(st.returnPct, 0,
        `regression M14: baseline=14.16 tv=14.16 debe dar returnPct=0, got ${st.returnPct}`);
      assert.equal(st.drawdownPct, 0,
        `regression M14: peak=tv=14.16 debe dar drawdownPct=0, got ${st.drawdownPct}`);
    });

    it("sin sync aún (baseline fallback): returnPct usa INITIAL_CAPITAL", () => {
      // Pre-sync, _capitalEfectivo queda con el default del constructor.
      // El fallback debe ser INITIAL_CAPITAL para que el baseline exista.
      const eng = new SimpleBotEngine({});
      const st = eng.getState();
      // capa1=60 + capa2=40 = tv=100, baseline=100 → returnPct=0
      assert.equal(st.returnPct, 0);
      assert.equal(st.baseline, 100);
    });

    it("peakTv se actualiza cuando tv sube", async () => {
      const eng = new SimpleBotEngine({});
      await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(100),
        binancePublicRequest: makeFakeBinance(100),
      });
      const st1 = eng.getState();
      assert.equal(st1.peakTv, 100);

      // Sube tv a 120 → peak se actualiza
      eng.capa1Cash += 20;
      const st2 = eng.getState();
      assert.equal(st2.peakTv, 120);

      // Baja tv a 110 → peak se mantiene en 120
      eng.capa1Cash -= 10;
      const st3 = eng.getState();
      assert.equal(st3.peakTv, 120, "peak histórico no debe bajar");
    });

    it("drawdownPct refleja distancia desde peak, no desde baseline", async () => {
      const eng = new SimpleBotEngine({});
      await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(100),
        binancePublicRequest: makeFakeBinance(100),
      });
      // Subir a 120 (peak)
      eng.capa1Cash += 20;
      eng.getState(); // latch peak
      // Bajar a 108 → drawdown desde peak 120 = (120-108)/120 = 10%
      eng.capa1Cash -= 12;
      const st = eng.getState();
      assert.ok(Math.abs(st.drawdownPct - 10) < 0.01,
        `drawdownPct desde peak=120 a tv=108 debe ser 10%, got ${st.drawdownPct}`);
      // returnPct sigue siendo 8% (sobre baseline 100)
      assert.equal(st.returnPct, 8.0);
    });

    it("peakTv persiste via saveState → round-trip", async () => {
      const a = new SimpleBotEngine({});
      a.capa1Cash = 80;
      a.capa2Cash = 40; // tv=120
      a.getState(); // latch peak
      assert.equal(a._peakTv, 120);
      const saved = a.saveState();
      assert.equal(saved.peakTv, 120,
        "saveState debe persistir peakTv");

      const b = new SimpleBotEngine(saved);
      assert.equal(b._peakTv, 120,
        "constructor debe restaurar peakTv del saved state");
    });

    it("baseline se recalcula cuando _capitalEfectivo cambia (sync añade fondos)", async () => {
      const eng = new SimpleBotEngine({});
      // Sync inicial con $50
      await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(50),
        binancePublicRequest: makeFakeBinance(50),
      });
      const st1 = eng.getState();
      assert.equal(st1.baseline, 50);

      // Usuario añade $30 a Binance → próximo sync ve $80 → baseline sube
      await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(80),
        binancePublicRequest: makeFakeBinance(80),
      });
      const st2 = eng.getState();
      assert.equal(st2.baseline, 80,
        "baseline debe recalcularse tras sync con nuevo capital real");
      // tv también sube (efectivo=80, cash=80, portfolio vacío → tv=80)
      assert.equal(st2.returnPct, 0,
        "tras sync nuevo: tv=baseline=80 → returnPct=0");
    });
  });
});

// ── A5: drawdown alerts + circuit breaker ─────────────────────────────
// Helper para disparar getState() con un DD controlado sin tener que
// simular trades reales. Usamos:
//   - capa1Cash + capa2Cash + portfolio vacío → totalValue() = suma
//   - _peakTv seteado al peak artificial
//   - drawdownPct resultante = (peak - tv) / peak * 100
function setDrawdown(eng, drawdownPct) {
  // tv = peak * (1 - dd/100)
  const peak = 100;
  const tv = peak * (1 - drawdownPct / 100);
  eng.capa1Cash = tv;
  eng.capa2Cash = 0;
  eng.portfolio = {};
  eng._peakTv = peak;
  // baseline también a 100 para que returnPct tenga sentido
  eng._capitalEfectivo = 100;
}

function makeEngWithTelegram() {
  const eng = new SimpleBotEngine({});
  eng._capitalSyncPausedUntil = 0; // no fail-closed
  const sent = [];
  eng.setTelegramSend((msg) => sent.push(msg));
  return { eng, sent };
}

describe("A5 — drawdown alerts + circuit breaker", () => {
  describe("setTelegramSend", () => {
    it("por defecto _telegramSend es null (sends no-op en tests)", () => {
      const eng = new SimpleBotEngine({});
      assert.equal(eng._telegramSend, null);
    });

    it("setTelegramSend guarda función si es callable", () => {
      const eng = new SimpleBotEngine({});
      const fn = () => {};
      eng.setTelegramSend(fn);
      assert.equal(eng._telegramSend, fn);
    });

    it("setTelegramSend(null) o inválido deja _telegramSend en null", () => {
      const eng = new SimpleBotEngine({});
      eng.setTelegramSend(null);
      assert.equal(eng._telegramSend, null);
      eng.setTelegramSend("not-a-fn");
      assert.equal(eng._telegramSend, null);
    });
  });

  describe("umbrales de alerta escalados", () => {
    it("drawdown 2% NO dispara ninguna alerta", () => {
      const { eng, sent } = makeEngWithTelegram();
      setDrawdown(eng, 2);
      eng.getState();
      assert.equal(sent.length, 0, "DD 2% no debe alertar");
      assert.equal(eng._ddAlert3, false);
      assert.equal(eng._ddAlert5, false);
      assert.equal(eng._ddAlert10, false);
    });

    it("drawdown 3.1% dispara ddAlert3 una sola vez", () => {
      const { eng, sent } = makeEngWithTelegram();
      setDrawdown(eng, 3.1);
      eng.getState();
      eng.getState(); // segunda llamada: latch evita re-send
      assert.equal(eng._ddAlert3, true);
      assert.equal(eng._ddAlert5, false);
      assert.equal(sent.length, 1, "exactamente 1 alerta tras 2 getState()");
      assert.ok(/drawdown/i.test(sent[0]));
    });

    it("drawdown 5.5% dispara ddAlert5 Y ddAlert3 (ambos thresholds)", () => {
      const { eng, sent } = makeEngWithTelegram();
      setDrawdown(eng, 5.5);
      eng.getState();
      assert.equal(eng._ddAlert3, true);
      assert.equal(eng._ddAlert5, true);
      assert.equal(eng._ddAlert10, false);
      assert.equal(sent.length, 2, "DD 5.5% dispara ddAlert5 + ddAlert3");
    });

    it("drawdown 10.2% dispara ddAlert10 + 5 + 3", () => {
      const { eng, sent } = makeEngWithTelegram();
      setDrawdown(eng, 10.2);
      eng.getState();
      assert.equal(eng._ddAlert10, true);
      assert.equal(eng._ddAlert5, true);
      assert.equal(eng._ddAlert3, true);
      assert.equal(eng._ddCircuitBreakerTripped, false);
      assert.equal(sent.length, 3, "DD 10.2% dispara 3 alertas");
    });

    it("drawdown 15% dispara circuit breaker + pausedUntil=Infinity", () => {
      const { eng, sent } = makeEngWithTelegram();
      setDrawdown(eng, 15.5);
      eng.getState();
      assert.equal(eng._ddCircuitBreakerTripped, true);
      assert.equal(eng._capitalSyncPausedUntil, Infinity,
        "CB debe setear _capitalSyncPausedUntil a Infinity");
      // Se envían 4 mensajes: CB + DD10 + DD5 + DD3
      assert.equal(sent.length, 4);
      assert.ok(sent.some(m => /CIRCUIT BREAKER/i.test(m)),
        "debe enviarse mensaje de CIRCUIT BREAKER");
    });
  });

  describe("latch reset con histéresis", () => {
    it("ddAlert3 se resetea cuando DD baja < 2.5%", () => {
      const { eng, sent } = makeEngWithTelegram();
      setDrawdown(eng, 3.5);
      eng.getState();
      assert.equal(eng._ddAlert3, true);
      assert.equal(sent.length, 1);
      // DD cae
      setDrawdown(eng, 2);
      eng.getState();
      assert.equal(eng._ddAlert3, false, "latch reseteado");
      // DD sube de nuevo → vuelve a disparar
      setDrawdown(eng, 3.5);
      eng.getState();
      assert.equal(eng._ddAlert3, true);
      assert.equal(sent.length, 2, "segunda alerta tras reset");
    });

    it("ddAlert5 se resetea con histéresis 4.5%, vuelve a disparar", () => {
      const { eng, sent } = makeEngWithTelegram();
      setDrawdown(eng, 6);
      eng.getState();
      const initial = sent.length;
      setDrawdown(eng, 4);
      eng.getState();
      assert.equal(eng._ddAlert5, false);
      setDrawdown(eng, 6);
      eng.getState();
      assert.equal(eng._ddAlert5, true);
      assert.ok(sent.length > initial, "re-dispara tras reset");
    });

    it("ddAlert10 se resetea con histéresis 9.5%", () => {
      const { eng } = makeEngWithTelegram();
      setDrawdown(eng, 10.5);
      eng.getState();
      assert.equal(eng._ddAlert10, true);
      setDrawdown(eng, 9);
      eng.getState();
      assert.equal(eng._ddAlert10, false);
    });

    it("circuit breaker NO se resetea automáticamente aunque drawdown baje a 0", () => {
      const { eng } = makeEngWithTelegram();
      setDrawdown(eng, 16);
      eng.getState();
      assert.equal(eng._ddCircuitBreakerTripped, true);
      // DD cae a 0
      setDrawdown(eng, 0);
      eng.getState();
      assert.equal(eng._ddCircuitBreakerTripped, true,
        "CB NO se resetea automáticamente — requiere intervención manual");
      assert.equal(eng._capitalSyncPausedUntil, Infinity,
        "pausedUntil sigue en Infinity");
    });
  });

  describe("persistencia del CB across restart", () => {
    it("saveState persiste los 4 flags A5", () => {
      const { eng } = makeEngWithTelegram();
      setDrawdown(eng, 16);
      eng.getState(); // dispara CB + otros latches
      const saved = eng.saveState();
      assert.equal(saved.ddAlert3, true);
      assert.equal(saved.ddAlert5, true);
      assert.equal(saved.ddAlert10, true);
      assert.equal(saved.ddCircuitBreakerTripped, true);
    });

    it("constructor restaura ddCircuitBreakerTripped + aplica Infinity", () => {
      // Simula post-JSON.stringify/parse: Infinity → null
      const savedRaw = {
        ddCircuitBreakerTripped: true,
        ddAlert3: true, ddAlert5: true, ddAlert10: true,
        capitalSyncPausedUntil: null, // JSON dropped
      };
      // Forzar parse round-trip para mimear disco real
      const saved = JSON.parse(JSON.stringify(savedRaw));
      const eng = new SimpleBotEngine(saved);
      assert.equal(eng._ddCircuitBreakerTripped, true,
        "flag CB debe restaurarse");
      assert.equal(eng._capitalSyncPausedUntil, Infinity,
        "constructor debe re-aplicar Infinity tras detectar CB tripped");
    });

    it("sin CB tripped en saved, el fail-closed de H7 sigue siendo finito", () => {
      const saved = { ddCircuitBreakerTripped: false };
      const eng = new SimpleBotEngine(saved);
      assert.equal(eng._ddCircuitBreakerTripped, false);
      assert.ok(Number.isFinite(eng._capitalSyncPausedUntil),
        "pausedUntil debe ser finito (H7 default 10min)");
    });

    it("round-trip completo: save → JSON.stringify/parse → new instance preserva CB", () => {
      const { eng: eng1 } = makeEngWithTelegram();
      setDrawdown(eng1, 15.5);
      eng1.getState();
      const saved = JSON.parse(JSON.stringify(eng1.saveState()));
      const eng2 = new SimpleBotEngine(saved);
      assert.equal(eng2._ddCircuitBreakerTripped, true);
      assert.equal(eng2._capitalSyncPausedUntil, Infinity);
    });
  });

  describe("sin _telegramSend inyectado: sends son no-op silenciosos", () => {
    it("getState con DD 16% NO crashea aunque _telegramSend sea null", () => {
      const eng = new SimpleBotEngine({});
      eng._capitalSyncPausedUntil = 0;
      // NO llamar setTelegramSend
      setDrawdown(eng, 16);
      // No debe lanzar
      const st = eng.getState();
      assert.equal(eng._ddCircuitBreakerTripped, true);
      assert.ok(st.drawdownPct >= 15);
    });
  });
});

// ── A7: validación de invariante al boot (Opus M17) ───────────────────
// server.js initBot llama eng.validateBootInvariant() tras el primer
// sync. El método es puro — no depende de red ni de LIVE_MODE. Verifica
// que el ledger virtual (capa1+capa2+committed) no exceda capEfectivo*1.02.

describe("A7 — boot invariant check (Opus M17)", () => {
  it("OK: ledger consistente — no pausa", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalEfectivo = 100;
    eng.capa1Cash = 60;
    eng.capa2Cash = 40;
    eng.portfolio = {};
    const sent = [];
    eng.setTelegramSend((m) => sent.push(m));
    const r = eng.validateBootInvariant();
    assert.equal(r.ok, true);
    assert.equal(eng._capitalSyncPausedUntil, 0, "sin violación, pausedUntil queda en 0");
    assert.equal(sent.length, 0);
  });

  it("OK: ledger con committed legítimo (posición abierta)", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalEfectivo = 100;
    eng.capa1Cash = 40;
    eng.capa2Cash = 40;
    // Committed de $20 → total 100 → exactamente capEfectivo
    eng.portfolio = {
      "POS_1": { pair: "BTCUSDC", capa: 1, invest: 20, qty: 0.001, entryPrice: 20000, stop: 19000, target: 21000, openTs: Date.now(), status: "filled" },
    };
    const r = eng.validateBootInvariant();
    assert.equal(r.ok, true);
    assert.equal(r.totalLedger, 100);
  });

  it("OK: drift 1.5% dentro del tolerance 1.02", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalEfectivo = 100;
    eng.capa1Cash = 61; // 1% de drift
    eng.capa2Cash = 40;
    eng.portfolio = {};
    const r = eng.validateBootInvariant();
    // 101 ≤ 100*1.02 = 102 → OK
    assert.equal(r.ok, true);
  });

  it("VIOLATED: ledger > capEfectivo*1.02 → pausedUntil=Infinity + alerta", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalEfectivo = 100;
    eng.capa1Cash = 150; // GROSS corruption
    eng.capa2Cash = 40;
    eng.portfolio = {};
    const sent = [];
    eng.setTelegramSend((m) => sent.push(m));
    const r = eng.validateBootInvariant();
    assert.equal(r.ok, false);
    assert.equal(r.totalLedger, 190);
    assert.equal(eng._capitalSyncPausedUntil, Infinity,
      "violación debe setear pausedUntil a Infinity");
    assert.equal(sent.length, 1);
    assert.ok(/INVARIANT VIOLATED/.test(sent[0]));
  });

  it("VIOLATED: committed inflado (portfolio corrupto) dispara la guard", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalEfectivo = 100;
    eng.capa1Cash = 30;
    eng.capa2Cash = 30;
    eng.portfolio = {
      "POS_1": { pair: "X1", capa: 1, invest: 70, qty: 1, entryPrice: 70, stop: 65, target: 75, openTs: Date.now() },
      "POS_2": { pair: "X2", capa: 2, invest: 60, qty: 1, entryPrice: 60, stop: 55, target: 65, openTs: Date.now() },
    };
    // total = 30 + 30 + 70 + 60 = 190 >> 100*1.02 = 102
    const r = eng.validateBootInvariant();
    assert.equal(r.ok, false);
    assert.equal(eng._capitalSyncPausedUntil, Infinity);
  });

  it("SKIPPED: capEfectivo=0 (sync pendiente) → sin violación", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalEfectivo = 0; // sin sync
    eng.capa1Cash = 60;
    eng.capa2Cash = 40;
    eng.portfolio = {};
    const r = eng.validateBootInvariant();
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.ok(/sync pendiente/.test(r.reason));
  });

  it("sin _telegramSend inyectado: violación no crashea aunque no envíe alerta", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalEfectivo = 100;
    eng.capa1Cash = 200;
    eng.capa2Cash = 40;
    eng.portfolio = {};
    // NO setTelegramSend
    const r = eng.validateBootInvariant();
    assert.equal(r.ok, false);
    assert.equal(eng._capitalSyncPausedUntil, Infinity);
  });

  it("server.js initBot llama validateBootInvariant tras syncCapitalFromBinance", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf-8");
    // Orden: syncCapitalFromBinance aparece antes de validateBootInvariant
    const syncIdx = src.indexOf("S.simpleBot.syncCapitalFromBinance(_capitalSyncDeps())");
    const invIdx  = src.indexOf("validateBootInvariant");
    assert.ok(syncIdx > 0, "sync call debe existir en server.js");
    assert.ok(invIdx > syncIdx,
      "validateBootInvariant debe llamarse DESPUÉS del primer sync");
  });
});

// ── BUG-1: sync success path NO debe borrar pausa si CB o boot invariant ─
// Regression guard del bug detectado en auditoría adversarial: el éxito
// del sync reseteaba _capitalSyncPausedUntil=0 incondicionalmente, borrando
// la pausa Infinity seteada por el CB (A5) o por validateBootInvariant (A7).
// El efecto era que el CB solo duraba hasta el próximo sync exitoso (~5min).

describe("BUG-1 — sync success respeta CB + boot invariant", () => {
  it("CB tripped + sync exitoso → pausedUntil sigue Infinity", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    setDrawdown(eng, 16);
    eng.getState(); // dispara CB
    assert.equal(eng._ddCircuitBreakerTripped, true, "pre: CB debe estar tripped");
    assert.equal(eng._capitalSyncPausedUntil, Infinity, "pre: pausedUntil=Infinity");
    // Ahora un sync exitoso
    const r = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(100),
      binancePublicRequest: makeFakeBinance(100),
    });
    assert.equal(r.ok, true, "sync ok");
    assert.equal(eng._capitalSyncPausedUntil, Infinity,
      "POST-sync: pausedUntil DEBE seguir en Infinity (CB tripped)");
    assert.equal(eng._ddCircuitBreakerTripped, true, "CB sigue tripped");
  });

  it("boot invariant violated + sync exitoso → pausedUntil sigue Infinity", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalEfectivo = 100;
    eng.capa1Cash = 200; // corrupted ledger
    eng.capa2Cash = 40;
    eng.portfolio = {};
    const r1 = eng.validateBootInvariant();
    assert.equal(r1.ok, false, "pre: invariante violado");
    assert.equal(eng._bootInvariantViolated, true, "pre: flag seteado");
    assert.equal(eng._capitalSyncPausedUntil, Infinity, "pre: pausedUntil=Infinity");
    // Sync exitoso — NO debe borrar la pausa
    const r2 = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(100),
      binancePublicRequest: makeFakeBinance(100),
    });
    assert.equal(r2.ok, true, "sync ok");
    assert.equal(eng._capitalSyncPausedUntil, Infinity,
      "POST-sync: pausedUntil DEBE seguir en Infinity (boot invariant)");
    assert.equal(eng._bootInvariantViolated, true, "flag sigue true");
  });

  it("sin CB ni boot invariant → sync exitoso resetea a 0 (comportamiento normal)", async () => {
    const eng = new SimpleBotEngine({});
    assert.equal(eng._ddCircuitBreakerTripped, false);
    assert.equal(eng._bootInvariantViolated, false);
    assert.ok(eng._capitalSyncPausedUntil > Date.now(), "pre: fail-closed default (10min)");
    const r = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(100),
      binancePublicRequest: makeFakeBinance(100),
    });
    assert.equal(r.ok, true);
    assert.equal(eng._capitalSyncPausedUntil, 0,
      "POST-sync sin flags: pausedUntil debe ir a 0");
  });

  it("saveState persiste bootInvariantViolated", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalEfectivo = 100;
    eng.capa1Cash = 200;
    eng.capa2Cash = 40;
    eng.portfolio = {};
    eng.validateBootInvariant();
    assert.equal(eng._bootInvariantViolated, true);
    const saved = eng.saveState();
    assert.equal(saved.bootInvariantViolated, true,
      "saveState debe incluir bootInvariantViolated=true");
  });

  it("constructor restaura bootInvariantViolated + reaplica Infinity", () => {
    // Mimic post-JSON round-trip: Infinity dropped a null
    const savedRaw = {
      bootInvariantViolated: true,
      capitalSyncPausedUntil: null, // JSON dropped
    };
    const saved = JSON.parse(JSON.stringify(savedRaw));
    const eng = new SimpleBotEngine(saved);
    assert.equal(eng._bootInvariantViolated, true,
      "flag debe restaurarse");
    assert.equal(eng._capitalSyncPausedUntil, Infinity,
      "constructor debe reaplicar Infinity al boot con flag tripped");
  });

  it("round-trip completo: save → parse → new instance preserva boot invariant", () => {
    const eng1 = new SimpleBotEngine({});
    eng1._capitalEfectivo = 100;
    eng1.capa1Cash = 200;
    eng1.capa2Cash = 40;
    eng1.portfolio = {};
    eng1.validateBootInvariant();
    const saved = JSON.parse(JSON.stringify(eng1.saveState()));
    const eng2 = new SimpleBotEngine(saved);
    assert.equal(eng2._bootInvariantViolated, true);
    assert.equal(eng2._capitalSyncPausedUntil, Infinity);
  });

  it("sin bootInvariantViolated en saved, el fail-closed de H7 sigue siendo finito", () => {
    const saved = { bootInvariantViolated: false };
    const eng = new SimpleBotEngine(saved);
    assert.equal(eng._bootInvariantViolated, false);
    assert.ok(Number.isFinite(eng._capitalSyncPausedUntil),
      "sin flag: pausedUntil finito (H7 default)");
  });
});

// ── BUG-1.5: error path de syncCapitalFromBinance también respeta CB ─────
// BUG-1 cubrió el success path. El catch path (línea 844) tenía el mismo
// bug: seteaba _capitalSyncPausedUntil = now + 5min incondicionalmente,
// sobrescribiendo Infinity si CB o boot invariant estaban activos.
// Efecto: tras el flash crash (CB tripped), un error de red en el próximo
// sync bajaba la pausa de Infinity a 5min → BUYs vuelven a permitirse tras
// esa ventana.

describe("BUG-1.5 — sync ERROR respeta CB + boot invariant", () => {
  it("CB tripped + sync error → pausedUntil sigue Infinity (NO reescrito a now+5min)", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    setDrawdown(eng, 16);
    eng.getState(); // dispara CB
    assert.equal(eng._ddCircuitBreakerTripped, true, "pre: CB tripped");
    assert.equal(eng._capitalSyncPausedUntil, Infinity, "pre: pausedUntil=Infinity");
    // Ahora un sync fallido
    const r = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFailingBinance("network down"),
      binancePublicRequest: makeFailingBinance("network down"),
    });
    assert.equal(r.ok, false, "sync fallido");
    assert.equal(eng._capitalSyncPausedUntil, Infinity,
      "POST-error: pausedUntil DEBE seguir en Infinity (CB tripped)");
    assert.equal(eng._ddCircuitBreakerTripped, true, "CB sigue tripped");
    // Sanity: failCount sí se incrementa (el error se sigue registrando)
    assert.equal(eng._capitalSyncFailCount, 1, "failCount debe incrementarse");
    assert.equal(eng._lastCapitalSyncOk, false, "lastOk debe ser false");
  });

  it("bootInvariant violated + sync error → pausedUntil sigue Infinity", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalEfectivo = 100;
    eng.capa1Cash = 200; // ledger corrupto
    eng.capa2Cash = 40;
    eng.portfolio = {};
    const r1 = eng.validateBootInvariant();
    assert.equal(r1.ok, false, "pre: invariante violado");
    assert.equal(eng._bootInvariantViolated, true);
    assert.equal(eng._capitalSyncPausedUntil, Infinity);
    // Sync fallido — no debe borrar Infinity
    const r2 = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFailingBinance("timeout"),
      binancePublicRequest: makeFailingBinance("timeout"),
    });
    assert.equal(r2.ok, false);
    assert.equal(eng._capitalSyncPausedUntil, Infinity,
      "POST-error: pausedUntil DEBE seguir en Infinity (boot invariant)");
    assert.equal(eng._bootInvariantViolated, true, "flag sigue true");
    assert.equal(eng._capitalSyncFailCount, 1);
  });

  it("sin flags + sync error → comportamiento normal (pausedUntil = now + 5min)", async () => {
    const eng = new SimpleBotEngine({});
    // Limpiar el H7 fail-closed para que el error path pueda escribir claro
    eng._capitalSyncPausedUntil = 0;
    assert.equal(eng._ddCircuitBreakerTripped, false);
    assert.equal(eng._bootInvariantViolated, false);
    const before = Date.now();
    const r = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFailingBinance("connect ETIMEDOUT"),
      binancePublicRequest: makeFailingBinance("connect ETIMEDOUT"),
    });
    assert.equal(r.ok, false);
    // Sin flags, el error path escribe now + 5min
    const delta = eng._capitalSyncPausedUntil - before;
    assert.ok(delta >= 4*60*1000 && delta <= 6*60*1000,
      `pausedUntil debe estar en ventana now+5min (±1min), delta=${delta}ms`);
    assert.ok(Number.isFinite(eng._capitalSyncPausedUntil),
      "pausedUntil debe ser finito sin flags");
  });
});

// ── H10: USDC/USDT depeg guard ──────────────────────────────────────────
// Detecta desestabilización del peg USDC en desastres de mercado.
// - drift ≤1% → proceder (comportamiento normal)
// - drift 1-5% → warn + continuar
// - drift >5% → pausa 1h, NO tocar ledger, alertar Telegram
// - depeg severo + CB tripped → preservar Infinity

// Helper: fake que devuelve USDCUSDT ticker con precio configurable
// además del balance de account. Incluye BNB=0.05 por encima del umbral
// low-alert (0.005) para que esos tests no reciban Telegram extra del
// watchdog BNB.
function makeFakeBinanceWithTicker(usdcFree, usdcUsdtPrice) {
  return async (method, path, params) => {
    if (method !== "GET") throw new Error("read-only");
    if (path === "ticker/price" && params?.symbol === "USDCUSDT") {
      return { symbol: "USDCUSDT", price: String(usdcUsdtPrice) };
    }
    if (path === "account") {
      return {
        balances: [
          { asset: "USDC", free: String(usdcFree), locked: "0" },
          { asset: "BNB",  free: "0.05",  locked: "0" },
          { asset: "SOL",  free: "0.594", locked: "0" },
          { asset: "XRP",  free: "36",    locked: "0" },
        ],
      };
    }
    if (path === "myTrades") {
      return []; // detector de fee mode: empty trade history → null, no cambio
    }
    throw new Error(`unexpected path: ${path}`);
  };
}

describe("H10 — USDC/USDT depeg guard", () => {
  it("stable peg (price=1.0): sync procede normal, _lastUsdcUsdt=1", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0; // reset H7 default
    const r = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinanceWithTicker(100, 1.0),
      binancePublicRequest: makeFakeBinanceWithTicker(100, 1.0),
    });
    assert.equal(r.ok, true, "sync debe completar con peg estable");
    assert.equal(eng._lastUsdcUsdt, 1, "lastUsdcUsdt capturado");
    assert.equal(eng._usdcDepegAlertSent, false, "no alert con peg estable");
    assert.equal(eng._capitalSyncPausedUntil, 0, "no pausa con peg estable");
    assert.equal(eng._capitalReal, 100);
  });

  it("peg casi estable (price=1.005, drift=0.5%): sync normal, no warn", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    const r = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinanceWithTicker(100, 1.005),
      binancePublicRequest: makeFakeBinanceWithTicker(100, 1.005),
    });
    assert.equal(r.ok, true);
    assert.equal(eng._lastUsdcUsdt, 1.005);
    assert.equal(eng._usdcDepegAlertSent, false,
      "drift 0.5% <1% no debe disparar alert latch");
  });

  it("drift moderado (price=0.98, drift=2%): sync continúa, warn + latch", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    let tgSent = 0;
    const r = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinanceWithTicker(100, 0.98),
      binancePublicRequest: makeFakeBinanceWithTicker(100, 0.98),
      telegramSend: (_msg) => { tgSent++; },
    });
    assert.equal(r.ok, true, "drift moderado: sync completa normal");
    assert.equal(eng._lastUsdcUsdt, 0.98);
    assert.equal(eng._usdcDepegAlertSent, true, "latch activo tras warn");
    assert.equal(tgSent, 1, "Telegram enviado una vez");
    assert.equal(eng._capitalReal, 100, "capital actualizado normalmente");
    assert.equal(eng._capitalSyncPausedUntil, 0, "no pausa en drift moderado");
  });

  it("drift moderado repetido: latch no re-envía Telegram (anti-spam)", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    let tgSent = 0;
    const deps = {
      binanceReadOnlyRequest: makeFakeBinanceWithTicker(100, 0.97),
      binancePublicRequest: makeFakeBinanceWithTicker(100, 0.97),
      telegramSend: (_msg) => { tgSent++; },
    };
    await eng.syncCapitalFromBinance(deps);
    await eng.syncCapitalFromBinance(deps);
    await eng.syncCapitalFromBinance(deps);
    assert.equal(tgSent, 1, "3 syncs consecutivos con drift moderado = 1 solo telegram");
    assert.equal(eng._usdcDepegAlertSent, true);
  });

  it("depeg severo (price=0.90, drift=10%): pausa 1h, ledger intacto, telegram", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalReal = 100; // ledger pre-depeg
    eng._capitalEfectivo = 100;
    eng.capa1Cash = 60;
    eng.capa2Cash = 40;
    let tgSent = 0;
    let tgMsg = "";
    const before = Date.now();
    const r = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinanceWithTicker(50, 0.90),
      binancePublicRequest: makeFakeBinanceWithTicker(50, 0.90),
      telegramSend: (msg) => { tgSent++; tgMsg = msg; },
    });
    assert.equal(r.ok, false, "sync reporta ok=false por depeg severo");
    assert.ok(r.error.includes("depeg"), "error message indica depeg");
    assert.equal(eng._lastUsdcUsdt, 0.9);
    // LEDGER INTACTO: capitalReal/efectivo NO debe haberse recalculado a $50
    assert.equal(eng._capitalReal, 100, "capitalReal NO debe modificarse en depeg severo");
    assert.equal(eng._capitalEfectivo, 100, "capitalEfectivo NO debe modificarse");
    assert.equal(eng.capa1Cash, 60, "capa1Cash intacto");
    assert.equal(eng.capa2Cash, 40, "capa2Cash intacto");
    // Pausa 1h
    const delta = eng._capitalSyncPausedUntil - before;
    assert.ok(delta >= 59*60*1000 && delta <= 61*60*1000,
      `pausa debe ser ~1h, delta=${delta}ms`);
    assert.equal(tgSent, 1, "Telegram alerta enviada");
    assert.ok(tgMsg.includes("DEPEG"), "mensaje telegram contiene DEPEG");
    assert.equal(eng._lastCapitalSyncOk, false, "sync marcado como failed");
    assert.ok(eng._lastCapitalSyncTs > 0, "timestamp actualizado para watchdog");
  });

  it("depeg severo + CB tripped: Infinity preservado (NO se sobrescribe con 1h)", async () => {
    const eng = new SimpleBotEngine({});
    eng._ddCircuitBreakerTripped = true;
    eng._capitalSyncPausedUntil = Infinity;
    const r = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinanceWithTicker(100, 0.80),
      binancePublicRequest: makeFakeBinanceWithTicker(100, 0.80),
    });
    assert.equal(r.ok, false);
    assert.equal(eng._capitalSyncPausedUntil, Infinity,
      "CB tripped: Infinity debe preservarse, NO sobrescribirse con now+1h");
    assert.equal(eng._ddCircuitBreakerTripped, true, "flag CB sigue true");
  });

  it("depeg severo + boot invariant violated: Infinity preservado", async () => {
    const eng = new SimpleBotEngine({});
    eng._bootInvariantViolated = true;
    eng._capitalSyncPausedUntil = Infinity;
    const r = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinanceWithTicker(100, 1.20),
      binancePublicRequest: makeFakeBinanceWithTicker(100, 1.20),
    });
    assert.equal(r.ok, false);
    assert.equal(eng._capitalSyncPausedUntil, Infinity,
      "boot invariant: Infinity debe preservarse contra pausa 1h");
    assert.equal(eng._bootInvariantViolated, true);
  });

  it("ticker call falla: sync continúa normalmente (best-effort)", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    const fake = async (method, path, params) => {
      if (path === "ticker/price") throw new Error("ticker down");
      if (path === "account") {
        return { balances: [{ asset: "USDC", free: "100", locked: "0" }] };
      }
      throw new Error("unexpected");
    };
    const r = await eng.syncCapitalFromBinance({ binanceReadOnlyRequest: fake ,
    binancePublicRequest: fake});
    assert.equal(r.ok, true, "ticker fail no debe bloquear sync OK");
    assert.equal(eng._capitalReal, 100);
  });

  it("H10 state persiste via saveState: lastUsdcUsdt + usdcDepegAlertSent", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinanceWithTicker(100, 0.97),
      binancePublicRequest: makeFakeBinanceWithTicker(100, 0.97),
    });
    const saved = eng.saveState();
    assert.equal(saved.lastUsdcUsdt, 0.97, "lastUsdcUsdt persistido");
    assert.equal(saved.usdcDepegAlertSent, true, "latch persistido");
    // Restart simulado
    const eng2 = new SimpleBotEngine(saved);
    assert.equal(eng2._lastUsdcUsdt, 0.97, "lastUsdcUsdt restaurado");
    assert.equal(eng2._usdcDepegAlertSent, true, "latch restaurado");
  });
});

// ── H10-CRITICAL: depeg pause latch ─────────────────────────────────────
// Regression guard del hallazgo adversarial (Opus parte 2): el success
// path de syncCapitalFromBinance borraba la pausa de 1h del depeg severo
// en el siguiente sync si el ticker USDCUSDT fallaba (best-effort catch
// absorbía el error) y el account fetch tenía éxito. El patrón es
// idéntico a BUG-1/1.5 pero con una fuente de pausa nueva (depeg) que no
// estaba en el guard. Fix: _depegPauseActive como tercera condición del
// guard en success/error paths, resetearlo automáticamente cuando el peg
// vuelve a estable (<1% drift).
//
// Helper: fake binance con comportamiento programable por "sync call".
// Cada paso del programa define { ticker, account?, usdcFree? } para un
// sync. El step se avanza con el ticker call (primer call de cada sync),
// para que la rama de severe depeg (que hace early return sin llamar a
// account) aún avance al siguiente step en el próximo sync.
function makeProgrammableBinance(programSteps) {
  let tickerCalls = 0;
  return async (method, path, params) => {
    if (path === "ticker/price" && params?.symbol === "USDCUSDT") {
      const step = programSteps[Math.min(tickerCalls, programSteps.length - 1)];
      tickerCalls++;
      if (step.ticker instanceof Error) throw step.ticker;
      return { symbol: "USDCUSDT", price: String(step.ticker) };
    }
    // account/myTrades usan el step del ticker MÁS RECIENTE
    const stepIdx = Math.max(0, tickerCalls - 1);
    const step = programSteps[Math.min(stepIdx, programSteps.length - 1)];
    if (path === "account") {
      if (step.account instanceof Error) throw step.account;
      return {
        balances: [
          { asset: "USDC", free: String(step.usdcFree ?? 100), locked: "0" },
          { asset: "BNB",  free: "0.05",  locked: "0" },
        ],
      };
    }
    if (path === "myTrades") return [];
    throw new Error(`unexpected path: ${path}`);
  };
}

describe("H10-CRITICAL — depeg pause latch respetado en success/error path", () => {
  it("BUG: depeg severo + ticker fail en sync siguiente → pausa preservada", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalReal = 100; eng._capitalEfectivo = 100;
    eng.capa1Cash = 60; eng.capa2Cash = 40;

    const program = [
      { ticker: 0.85,                      usdcFree: 100 }, // severe depeg
      { ticker: new Error("ticker down"),  usdcFree: 100 }, // transient fail
    ];
    const fake = makeProgrammableBinance(program);

    // Sync 1: severe depeg → pausa 1h + flag=true
    const tBefore = Date.now();
    const r1 = await eng.syncCapitalFromBinance({ binanceReadOnlyRequest: fake ,
    binancePublicRequest: fake});
    assert.equal(r1.ok, false, "sync 1: severe depeg → ok=false");
    assert.equal(eng._depegPauseActive, true, "flag _depegPauseActive seteado");
    const pause1 = eng._capitalSyncPausedUntil;
    const delta1 = pause1 - tBefore;
    assert.ok(delta1 >= 59*60*1000 && delta1 <= 61*60*1000,
      `sync 1: pausa debe ser ~1h, delta=${delta1}ms`);

    // Sync 2: ticker falla (transient) pero account OK → success path
    const r2 = await eng.syncCapitalFromBinance({ binanceReadOnlyRequest: fake ,
    binancePublicRequest: fake});
    assert.equal(r2.ok, true, "sync 2: account OK → ok=true");
    // Crítico: la pausa NO debe haberse borrado a 0
    assert.notEqual(eng._capitalSyncPausedUntil, 0,
      "BUG preservation: pausa NO debe haberse borrado a 0");
    assert.equal(eng._capitalSyncPausedUntil, pause1,
      "pausa sigue siendo el timestamp del depeg original (~T+1h)");
    assert.equal(eng._depegPauseActive, true, "flag sigue true tras sync 2");
    // CB y boot invariant siguen false (el fix no los activó por error)
    assert.equal(eng._ddCircuitBreakerTripped, false);
    assert.equal(eng._bootInvariantViolated, false);
  });

  it("BUG: depeg severo + sync error en sync siguiente → pausa preservada", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalReal = 100; eng._capitalEfectivo = 100;

    const program = [
      { ticker: 0.85,                          usdcFree: 100 }, // severe depeg
      { ticker: new Error("ticker down"),      account: new Error("ETIMEDOUT") }, // full error
    ];
    const fake = makeProgrammableBinance(program);

    // Sync 1: severe depeg
    const tBefore = Date.now();
    const r1 = await eng.syncCapitalFromBinance({ binanceReadOnlyRequest: fake ,
    binancePublicRequest: fake});
    assert.equal(r1.ok, false);
    assert.equal(eng._depegPauseActive, true);
    const pause1 = eng._capitalSyncPausedUntil;
    assert.ok(pause1 - tBefore >= 59*60*1000, "pausa ~1h tras depeg");

    // Sync 2: error path (account falla). Sin el fix, este path
    // sobrescribiría pausedUntil a now+5min, reduciendo los ~55min
    // restantes del depeg.
    const r2 = await eng.syncCapitalFromBinance({ binanceReadOnlyRequest: fake ,
    binancePublicRequest: fake});
    assert.equal(r2.ok, false, "sync 2: account falla → ok=false");
    assert.equal(eng._capitalSyncPausedUntil, pause1,
      "BUG preservation: error path NO debe haber acortado la pausa a now+5min");
    assert.equal(eng._depegPauseActive, true, "flag sigue true");
  });

  it("recovery: peg vuelve a estable → flag se limpia y siguiente sync resetea pausa", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    eng._capitalReal = 100; eng._capitalEfectivo = 100;

    const program = [
      { ticker: 0.85,  usdcFree: 100 }, // severe depeg
      { ticker: 1.000, usdcFree: 100 }, // peg recovered, drift 0%
    ];
    const fake = makeProgrammableBinance(program);

    // Sync 1: severe depeg → flag + pausa
    await eng.syncCapitalFromBinance({ binanceReadOnlyRequest: fake ,
    binancePublicRequest: fake});
    assert.equal(eng._depegPauseActive, true, "pre-recovery: flag true");
    assert.ok(eng._capitalSyncPausedUntil > Date.now(), "pre-recovery: paused");

    // Sync 2: peg recuperado → stable branch limpia flags
    const r2 = await eng.syncCapitalFromBinance({ binanceReadOnlyRequest: fake ,
    binancePublicRequest: fake});
    assert.equal(r2.ok, true, "sync 2 OK con peg estable");
    assert.equal(eng._depegPauseActive, false,
      "recovery: flag _depegPauseActive reseteado automáticamente");
    assert.equal(eng._usdcDepegAlertSent, false,
      "recovery: latch de alerta también reseteado");
    assert.equal(eng._capitalSyncPausedUntil, 0,
      "recovery: pausa ahora SÍ se resetea a 0 (BUYs habilitados)");
  });

  it("round-trip persistencia: saveState/load preserva _depegPauseActive", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalSyncPausedUntil = 0;
    // Trigger severe depeg → activa flag
    await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinanceWithTicker(100, 0.85),
      binancePublicRequest: makeFakeBinanceWithTicker(100, 0.85),
    });
    assert.equal(eng._depegPauseActive, true, "flag activo tras depeg severo");

    // saveState debe incluir el flag
    const saved = eng.saveState();
    assert.equal(saved.depegPauseActive, true,
      "saveState debe persistir depegPauseActive=true");

    // Nueva instancia restaura el flag
    const eng2 = new SimpleBotEngine(saved);
    assert.equal(eng2._depegPauseActive, true,
      "constructor debe restaurar depegPauseActive desde saved");

    // Y el guard del success path sigue respetando el flag post-restart:
    // un sync exitoso con ticker transient fail NO debe borrar la pausa.
    const pausePre = eng2._capitalSyncPausedUntil;
    const fakeTransient = async (method, path, params) => {
      if (path === "ticker/price") throw new Error("ticker flaky");
      if (path === "account") {
        return {
          balances: [
            { asset: "USDC", free: "100", locked: "0" },
            { asset: "BNB",  free: "0.05", locked: "0" },
          ],
        };
      }
      if (path === "myTrades") return [];
      throw new Error("unexpected");
    };
    const r = await eng2.syncCapitalFromBinance({ binanceReadOnlyRequest: fakeTransient ,
    binancePublicRequest: fakeTransient});
    assert.equal(r.ok, true, "sync 2 post-restart: account OK → ok=true");
    assert.equal(eng2._capitalSyncPausedUntil, pausePre,
      "pausa persistida NO debe borrarse por el success path post-restart");
    assert.equal(eng2._depegPauseActive, true,
      "flag sigue true post-restart tras sync con ticker fail");
  });
});

// ── H10-CRITICAL follow-up: defense in depth en _onCandleClose ──────────
// El guard anterior del capital-sync gate miraba SOLO el timestamp. Edge
// case: PM2 restart durante depeg severo. saveState persiste
// _depegPauseActive=true PERO _capitalSyncPausedUntil (T+1h) se serializa
// a un número que luego H7 fail-closed restaura a now+10min. Tras los
// 10min, el gate anterior permitía BUYs porque el flag estaba ignorado.
//
// Misma clase de bug afecta _ddCircuitBreakerTripped y
// _bootInvariantViolated — en sus casos el constructor re-fuerza
// pausedUntil a Infinity, así que el timestamp-only check funcionaba por
// accidente. Pero cualquier futuro latch time-bound tendría el mismo
// agujero. Fix: el gate ahora evalúa (timestamp || latch) como trigger.
//
// Estos 3 tests cubren: depeg latch sin timestamp, CB latch sin
// timestamp, y path normal sin latch (sanity: no falsos positivos).
function buyCandlesRSI_for_gate() {
  // Fixture que dispara BUY para RSI_MR_ADX en BNB_1h_RSI — 22 flat +
  // 14 subida + 13 bajada + 1 sharp drop. Copiado literal de
  // pause-gate.test.js para mantener los tests self-contained.
  const c = [];
  for (let i = 0; i < 22; i++) {
    c.push({ open: 100, high: 100.1, low: 99.9, close: 100, start: 0 });
  }
  for (let i = 0; i < 14; i++) {
    const p = 100 + i * 0.5;
    c.push({ open: p, high: p + 0.3, low: p - 0.3, close: p + 0.3, start: 0 });
  }
  for (let i = 0; i < 13; i++) {
    const p = 106.5 - i * 0.7;
    c.push({ open: p, high: p + 0.3, low: p - 0.3, close: p - 0.3, start: 0 });
  }
  c.push({ open: 97.5, high: 97.7, low: 95.5, close: 95.5, start: 0 });
  return c;
}

describe("H10-CRITICAL follow-up — _onCandleClose gate revisa latches además del timestamp", () => {
  it("depeg latch activo + timestamp expirado → BUY bloqueado (post-restart edge case)", () => {
    // Simulamos el estado post-restart tras H7 fail-closed: flag persistido
    // true, pero pausedUntil ya venció (0 para simplificar — el gate no
    // distingue entre <now y 0).
    const bot = new SimpleBotEngine({});
    bot._capitalSyncPausedUntil = 0;      // timestamp expirado
    bot._depegPauseActive = true;         // latch restaurado desde saveState
    bot._ddCircuitBreakerTripped = false;
    bot._bootInvariantViolated = false;
    bot.paused = false;

    // Fixture disparando BUY — sin el fix, el gate solo miraría timestamp
    // (que es 0) y dejaría pasar el tick → se abriría posición con peg roto.
    assert.equal(evalSignal("RSI_MR_ADX", buyCandlesRSI_for_gate()), "BUY",
      "pre-condition: fixture dispara BUY");
    bot._candles["BNBUSDC_1h"] = buyCandlesRSI_for_gate();
    bot.prices["BNBUSDC"] = 95.5;
    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");

    // Interceptar warn para verificar el log de defense-in-depth
    const origWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args.join(" "));

    const portfolioBefore = Object.keys(bot.portfolio).length;
    try {
      bot._onCandleClose(cfg, "BNBUSDC_1h");
    } finally {
      console.warn = origWarn;
    }

    assert.equal(Object.keys(bot.portfolio).length, portfolioBefore,
      "portfolio NO debe mutarse: latch de depeg debe bloquear BUY");
    assert.ok(!bot.portfolio["BNB_1h_RSI"],
      "no debe haberse abierto posición BNB_1h_RSI");
    const gateWarn = warns.find(l => l.includes("[SIMPLE][GATE]") && l.includes("depeg pause"));
    assert.ok(gateWarn,
      `debe loguearse warn del gate latch (depeg). warns=${JSON.stringify(warns)}`);
  });

  it("CB latch activo + timestamp expirado → BUY bloqueado", () => {
    // Aunque el constructor normalmente re-fuerza pausedUntil a Infinity
    // cuando CB está trippeado, aquí testeamos el gate en aislamiento:
    // si por cualquier razón llegamos a un estado con flag=true y
    // timestamp=0, el gate debe bloquear igualmente.
    const bot = new SimpleBotEngine({});
    bot._capitalSyncPausedUntil = 0;
    bot._ddCircuitBreakerTripped = true;
    bot._depegPauseActive = false;
    bot._bootInvariantViolated = false;
    bot.paused = false;

    bot._candles["BNBUSDC_1h"] = buyCandlesRSI_for_gate();
    bot.prices["BNBUSDC"] = 95.5;
    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");

    const origWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args.join(" "));

    const portfolioBefore = Object.keys(bot.portfolio).length;
    try {
      bot._onCandleClose(cfg, "BNBUSDC_1h");
    } finally {
      console.warn = origWarn;
    }

    assert.equal(Object.keys(bot.portfolio).length, portfolioBefore,
      "portfolio NO debe mutarse: CB latch debe bloquear BUY");
    const gateWarn = warns.find(l => l.includes("[SIMPLE][GATE]") && l.includes("CB tripped"));
    assert.ok(gateWarn,
      `debe loguearse warn del gate latch (CB). warns=${JSON.stringify(warns)}`);
  });

  it("sanity: sin latches + timestamp expirado → BUY ejecuta (gate NO bloquea falsos positivos)", () => {
    // Verifica que el fix no introduce una regresión: el path feliz
    // (ningún flag activo, sync OK) sigue permitiendo BUYs.
    const bot = new SimpleBotEngine({});
    bot._capitalSyncPausedUntil = 0;       // timestamp OK (no paused)
    bot._ddCircuitBreakerTripped = false;  // sin latches
    bot._bootInvariantViolated = false;
    bot._depegPauseActive = false;
    bot.paused = false;

    bot._candles["BNBUSDC_1h"] = buyCandlesRSI_for_gate();
    bot.prices["BNBUSDC"] = 95.5;
    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");

    bot._onCandleClose(cfg, "BNBUSDC_1h");

    assert.ok(bot.portfolio["BNB_1h_RSI"],
      "sanity: sin latches ni timestamp activo, BUY debe ejecutarse");
  });
});
