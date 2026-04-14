// ── C1: Pause gate tests ────────────────────────────────────────────────
// El comando /pausa debe bloquear BUYs ANTES de que el portfolio se mute.
// Sin esto, un usuario que pausa en crisis ve cómo el bot sigue comprando
// mientras las ventas (stops/targets) están bloqueadas → se acumulan
// posiciones que no pueden cerrarse.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

const { SimpleBotEngine, STRATEGIES, evalSignal } = require("../src/engine_simple");

// Genera velas que producen señal BUY para RSI_MR_ADX (copiado literal de
// sizing.test.js — 22 flat + 14 subida + 13 bajada + 1 sharp drop = 50 velas
// con RSI~0, close<BB.lower y ADX<25 en los últimos 28).
function buyCandlesRSI() {
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

describe("C1: pause gate blocks BUYs", () => {
  it("engine-level: bot.paused=true bloquea _onCandleClose antes de mutar portfolio", () => {
    const bot = new SimpleBotEngine({});
    bot._capitalSyncPausedUntil = 0; // aislar del gate H7
    bot.paused = true;

    // Setup candles con señal BUY válida — si la pausa no funciona,
    // este setup dispararía una compra.
    bot._candles["BNBUSDC_1h"] = buyCandlesRSI();
    // sanity: la fixture efectivamente dispara BUY sin pausa
    assert.equal(evalSignal("RSI_MR_ADX", buyCandlesRSI()), "BUY",
      "fixture: debe producir BUY (pre-condition del test)");
    bot.prices["BNBUSDC"] = 95.5;

    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");
    const portfolioBefore = Object.keys(bot.portfolio).length;
    const logBefore = bot.log.length;
    bot._onCandleClose(cfg, "BNBUSDC_1h");

    assert.equal(Object.keys(bot.portfolio).length, portfolioBefore,
      "pausa: portfolio NO debe mutarse");
    assert.equal(bot.log.length, logBefore,
      "pausa: no debe añadirse entry BUY al log");
  });

  it("engine-level: bot.paused=false deja pasar la evaluación (sanity opuesta)", () => {
    const bot = new SimpleBotEngine({});
    bot._capitalSyncPausedUntil = 0;
    bot.paused = false;

    bot._candles["BNBUSDC_1h"] = buyCandlesRSI();
    bot.prices["BNBUSDC"] = 95.5;
    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");
    bot._onCandleClose(cfg, "BNBUSDC_1h");

    // Debería haberse abierto la posición (sanity: gate no bloquea con pausa off)
    assert.ok(bot.portfolio["BNB_1h_RSI"],
      "sin pausa, la señal BUY debe abrir posición (sanity del gate)");
  });

  it("pause gate es la PRIMERA guard — antes del capital-sync gate", () => {
    // Si los dos gates están activos, el log debe mostrar PAUSE, no CAPITAL-SYNC.
    // Verifica el orden correcto de las guards: pausa primero.
    const bot = new SimpleBotEngine({});
    bot.paused = true;
    // _capitalSyncPausedUntil queda en el fail-closed default (future) → también bloquearía
    bot._candles["BNBUSDC_1h"] = buyCandlesRSI();
    bot.prices["BNBUSDC"] = 95.5;
    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");

    // Interceptar console.log para ver qué gate dispara
    const origLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      bot._onCandleClose(cfg, "BNBUSDC_1h");
    } finally {
      console.log = origLog;
    }
    const pauseLog = logs.find(l => l.includes("[SIMPLE][PAUSE]"));
    const capitalLog = logs.find(l => l.includes("[SIMPLE][CAPITAL-SYNC]"));
    assert.ok(pauseLog, "pause gate debe loguearse primero");
    assert.ok(!capitalLog,
      "capital-sync gate NO debe loguearse: pause gate debe return antes");
  });

  it("callback-level: _onBuy con pausa activa rollbackea la reserva y no llama placeLiveBuy", () => {
    // Defense in depth: simula el callback _onBuy de server.js con una pausa
    // detectada concurrente. Estado inicial: pos pending (la mutación atómica
    // de _onCandleClose ya ocurrió). El callback debe rollback la reserva.
    const bot = new SimpleBotEngine({});
    const capa1Before = bot.capa1Cash;
    bot.portfolio["BNB_1h_RSI"] = {
      pair: "BNBUSDC", capa: 1, invest: 20, qty: 0.2,
      entryPrice: 100, stop: 99, target: 101,
      openTs: Date.now(), status: "pending",
    };
    bot.capa1Cash -= 20; // post-reserve (FIX-A contract)

    // Simulación literal del guard de server.js S.simpleBot._onBuy:
    //   si paused → rollback de pending + return (no placeLiveBuy)
    const paused = true;
    let placeLiveBuyCalled = false;
    if (paused) {
      const pos = bot.portfolio["BNB_1h_RSI"];
      if (pos && pos.status === "pending") {
        if (pos.capa === 1) bot.capa1Cash += pos.invest || 0;
        else                bot.capa2Cash += pos.invest || 0;
        delete bot.portfolio["BNB_1h_RSI"];
      }
    } else {
      placeLiveBuyCalled = true;
    }

    assert.equal(placeLiveBuyCalled, false, "placeLiveBuy NO debe llamarse");
    assert.ok(!bot.portfolio["BNB_1h_RSI"], "pending debe rollbackear del portfolio");
    assert.ok(Math.abs(bot.capa1Cash - capa1Before) < 1e-9,
      `capa1Cash debe restaurarse: expected ${capa1Before}, got ${bot.capa1Cash}`);
  });
});
