// BUG-D — _cleanupStalePending timeout + reconciliación Binance.
// Verifica el mecanismo existente (STALE_MS=5min + binanceReadOnlyRequest
// opcional inyectado) para pending colgadas: primero fills reales detectados
// promueven a filled vía applyRealBuyFill, segundo sin fills hace rollback
// (devuelve _investWithFee), tercero Binance timeout mantiene pending
// (conservador, reintenta próximo tick).
"use strict";

process.env.CAPITAL_USDC = "100";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SimpleBotEngine } = require("../src/engine_simple");

const STRAT_ID = "BTC_30m_RSI";
const PAIR = "BTCUSDC";
const STALE_MS = 5 * 60 * 1000;

function armOldPending(eng, { invest = 16 } = {}) {
  const entryPrice = 100;
  const investWithFee = invest * 1.001;
  eng.portfolio[STRAT_ID] = {
    pair: PAIR, capa: 1, type: "RSI_MR_ADX", tf: "30m",
    entryPrice, qty: invest / entryPrice,
    stop: entryPrice * (1 - 0.008), target: entryPrice * (1 + 0.016),
    openTs: Date.now() - STALE_MS - 60 * 1000, // >5min + 60s atrás
    invest, _investWithFee: investWithFee,
    status: "pending",
    _feePredicted: {
      mode: "USDC", FEE_efectivo: 0.001, feePaidInBnb: false,
      expectedBnbFee: 0, feeUsdcEquivalent: invest * 0.001,
      bnbBalancePre: 0, bnbPrice: 0, pair: PAIR, ts: Date.now(),
    },
  };
  if (eng.capa1Cash >= investWithFee) eng.capa1Cash -= investWithFee;
}

describe("BUG-D — _cleanupStalePending: fills reales detectados → applyRealBuyFill", () => {
  it("Binance devuelve fills reales post-openTs → promueve a filled, no rollback", async () => {
    const eng = new SimpleBotEngine({});
    eng.capa1Cash = 60; eng.capa2Cash = 40;
    armOldPending(eng);
    const capa1PreCleanup = eng.capa1Cash; // 43.984

    // Inyectar mock de binanceReadOnlyRequest que devuelve fills
    eng._binanceReadOnlyRequest = async (method, path, params) => {
      if (path === "myTrades") {
        return [{
          isBuyer: true,
          qty: "0.16",
          quoteQty: "16.00",
          time: (eng.portfolio[STRAT_ID].openTs || 0) + 1000,
        }];
      }
      return [];
    };

    await eng._cleanupStalePending();

    // Posición debe seguir, promovida a filled
    assert.ok(eng.portfolio[STRAT_ID], "portfolio[id] preservado tras reconcile");
    assert.equal(eng.portfolio[STRAT_ID].status, "filled", "promovido a filled");
    // applyRealBuyFill ajusta drift: realSpent=16, expected=16 (pos.invest=16), drift=0
    // capa1 se mantiene en pre-cleanup (no hubo drift)
    assert.ok(Math.abs(eng.capa1Cash - capa1PreCleanup) < 0.01,
      `capa1 sin cambio por drift=0, got ${eng.capa1Cash}`);
  });
});

describe("BUG-D — _cleanupStalePending: sin fills → rollback cash al capa", () => {
  it("Binance confirma sin fills → rollback, devuelve _investWithFee a capa", async () => {
    const eng = new SimpleBotEngine({});
    eng.capa1Cash = 60; eng.capa2Cash = 40;
    armOldPending(eng);
    const capa1PreCleanup = eng.capa1Cash; // 43.984

    eng._binanceReadOnlyRequest = async (method, path, params) => {
      if (path === "myTrades") return []; // sin fills
      return [];
    };

    await eng._cleanupStalePending();

    // Posición eliminada
    assert.ok(!eng.portfolio[STRAT_ID], "portfolio[id] borrado tras rollback");
    // _investWithFee devuelto a capa1
    const expected = capa1PreCleanup + 16 * 1.001;
    assert.ok(Math.abs(eng.capa1Cash - expected) < 1e-6,
      `capa1 debe subir por _investWithFee, got ${eng.capa1Cash} expected ${expected}`);
  });
});

describe("BUG-D — _cleanupStalePending: Binance timeout → mantiene pending", () => {
  it("binanceReadOnlyRequest throws → NO rollback, reintenta próximo tick", async () => {
    const eng = new SimpleBotEngine({});
    eng.capa1Cash = 60; eng.capa2Cash = 40;
    armOldPending(eng);
    const capa1PreCleanup = eng.capa1Cash;

    eng._binanceReadOnlyRequest = async () => {
      throw new Error("ETIMEDOUT");
    };

    await eng._cleanupStalePending();

    // Posición sigue pending, capa intacta (no borrar asset potencialmente real)
    assert.ok(eng.portfolio[STRAT_ID], "portfolio[id] preservado con Binance timeout");
    assert.equal(eng.portfolio[STRAT_ID].status, "pending");
    assert.equal(eng.capa1Cash, capa1PreCleanup, "capa intacta");
  });
});
