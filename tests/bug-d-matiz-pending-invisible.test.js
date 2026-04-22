// BUG-D MATIZ — pending NO debe alimentar decisiones financieras.
// Dos iteradores fuera del evaluate() principal también necesitan el guard
// status==="filled": primero valorPosiciones en syncCapitalFromBinance
// (doble-conteo contra usdcLibre no gastado → efectivo inflado), segundo
// totalValue() (tv infla sizingBase de otras estrategias en el mismo tick).
"use strict";

process.env.CAPITAL_USDC = "100";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SimpleBotEngine } = require("../src/engine_simple");

const STRAT_ID = "BTC_30m_RSI";
const PAIR = "BTCUSDC";

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

function insertPending(eng, { invest = 16, entryPrice = 100, priceNow = 100 } = {}) {
  eng.portfolio[STRAT_ID] = {
    pair: PAIR, capa: 1, type: "RSI_MR_ADX", tf: "30m",
    entryPrice, qty: invest / entryPrice,
    stop: entryPrice * (1 - 0.008), target: entryPrice * (1 + 0.016),
    openTs: Date.now(),
    invest, _investWithFee: invest * 1.001,
    status: "pending",
    _feePredicted: {
      mode: "USDC", FEE_efectivo: 0.001, feePaidInBnb: false,
      expectedBnbFee: 0, feeUsdcEquivalent: invest * 0.001,
      bnbBalancePre: 0, bnbPrice: 0, pair: PAIR, ts: Date.now(),
    },
  };
  eng.capa1Cash -= invest * 1.001;
  eng.prices[PAIR] = priceNow;
}

describe("BUG-D MATIZ — totalValue() skip pending", () => {
  it("tv excluye MTM de pending — cash + filled_MTM solamente", () => {
    const eng = new SimpleBotEngine({});
    eng.capa1Cash = 60; eng.capa2Cash = 40;
    insertPending(eng, { invest: 16, entryPrice: 100, priceNow: 105 });
    // Con guard: tv = capa1Cash (43.984) + capa2Cash (40) + 0 (pending skipped) = 83.984
    const tv = eng.totalValue();
    assert.ok(Math.abs(tv - 83.984) < 1e-6,
      `tv debe excluir pending MTM, got ${tv} expected 83.984`);

    // Post-fill: ahora pending→filled, MTM sí cuenta
    eng.applyRealBuyFill(STRAT_ID, { realSpent: 16, realQty: 0.16 });
    const tvAfterFill = eng.totalValue();
    // filled_MTM = 0.16 * 105 = 16.8; tv = 43.984 + 40 + 16.8 = 100.784
    assert.ok(Math.abs(tvAfterFill - 100.784) < 0.01,
      `tv post-fill debe incluir MTM, got ${tvAfterFill} expected ≈100.784`);
  });

  it("pending con price inflado NO eleva sizingBase via tv (protección race)", () => {
    // Escenario: estrategia A abre pending con invest=30 a precio 100,
    // segundos después precio sube a 150 (MTM fantasma = 45, +50% inflado).
    // Estrategia B evaluando en el mismo tick leería tv inflado como base
    // de sizing. Con el guard, el MTM de pending no cuenta hasta filled.
    const eng = new SimpleBotEngine({});
    eng.capa1Cash = 60; eng.capa2Cash = 40;
    insertPending(eng, { invest: 30, entryPrice: 100, priceNow: 150 });
    const tv = eng.totalValue();
    // Sin guard (buggy): 29.97 + 40 + 0.3*150 = 114.97 — sizingBase fantasma
    // Con guard: 29.97 + 40 + 0 = 69.97
    assert.ok(tv < 80, `tv NO debe estar inflado por pending, got ${tv}`);
    assert.ok(Math.abs(tv - 69.97) < 0.01, `tv exacto esperado ≈ 69.97`);
  });
});

describe("BUG-D MATIZ — syncCapitalFromBinance valorPosiciones skip pending", () => {
  it("valorPosiciones excluye MTM de pending en sync (evita doble-conteo)", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.capa1Cash = 60; eng.capa2Cash = 40;
    insertPending(eng, { invest: 16, entryPrice: 100, priceNow: 105 });
    // Balance Binance: usdcLibre=100 (como si el BUY aún no hubiera ejecutado).
    // Con bug: valorPosiciones = 0.16*105 = 16.8 → real=116.8 → efectivo inflado.
    // Con guard: valorPosiciones = 0 → real=100 → efectivo=min(100, 100+0)=100.
    const r = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(100),
      binancePublicRequest: makeFakeBinance(100),
      liveMode: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.valorPosiciones, 0, "pending excluido de valorPosiciones");
    assert.equal(r.capitalReal, 100, "real = usdcLibre sin pending inflado");
    assert.equal(r.capitalEfectivo, 100);
  });

  it("post-fill valorPosiciones sí incluye MTM (reconciled)", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.capa1Cash = 60; eng.capa2Cash = 40;
    insertPending(eng, { invest: 16, entryPrice: 100, priceNow: 105 });
    eng.applyRealBuyFill(STRAT_ID, { realSpent: 16, realQty: 0.16 });
    // Ahora Binance ya cobró $16 (usdcLibre=84) y el bot tiene 0.16 BTC
    const r = await eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(84),
      binancePublicRequest: makeFakeBinance(84),
      liveMode: true,
    });
    assert.equal(r.valorPosiciones, 16.8, "filled MTM = 0.16*105 = 16.8");
    assert.equal(r.capitalReal, 100.8, "real = 84 + 16.8 = 100.8");
    // operationalCap = max(0, 100+0) = 100, efectivo = min(100.8, 100) = 100
    assert.equal(r.capitalEfectivo, 100);
  });
});
