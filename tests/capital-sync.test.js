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
      });
      const st1 = eng.getState();
      assert.equal(st1.baseline, 50);

      // Usuario añade $30 a Binance → próximo sync ve $80 → baseline sube
      await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance(80),
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
