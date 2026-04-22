// BUG-D — TWAP delay + flash crash adverso.
// Simula: pending armada, varios ticks (con stream tocando debajo del stop
// estimado) durante la ventana TWAP, finalmente applyRealBuyFill llega.
// Verificar que portfolio[id] sigue intacto, se promueve a filled con
// slippage negativo reconciliado, y el capa queda balanceado invariantemente
// (cash + committed ≈ baseline).
"use strict";

process.env.CAPITAL_USDC = "100";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SimpleBotEngine } = require("../src/engine_simple");

const STRAT_ID = "BTC_30m_RSI";
const PAIR = "BTCUSDC";

describe("BUG-D — TWAP delay + flash crash adverso", () => {
  it("90s de ticks adversos con pending → portfolio intacto, reconcile final balancea capa", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.capa1Cash = 60;
    eng.capa2Cash = 40;
    // _seedStratTrades del constructor siembra 20 trades por estrategia para
    // que Kelly no bloquee arranque. Snapshot length pre-test para verificar
    // que durante los ticks adversos NO se añade ningún trade nuevo.
    const stratTradesPreLen = (eng._stratTrades[STRAT_ID] || []).length;

    const entryPrice = 100;
    const invest = 16;
    const investWithFee = invest * 1.001;
    eng.portfolio[STRAT_ID] = {
      pair: PAIR, capa: 1, type: "RSI_MR_ADX", tf: "30m",
      entryPrice, qty: invest / entryPrice,
      stop: entryPrice * (1 - 0.008), target: entryPrice * (1 + 0.016),
      openTs: Date.now(),
      invest, _investWithFee: investWithFee,
      status: "pending",
      _feePredicted: {
        mode: "USDC", FEE_efectivo: 0.001, feePaidInBnb: false,
        expectedBnbFee: 0, feeUsdcEquivalent: invest * 0.001,
        bnbBalancePre: 0, bnbPrice: 0, pair: PAIR, ts: Date.now(),
      },
    };
    eng.capa1Cash -= investWithFee; // 60 - 16.016 = 43.984
    const capa1PostReserve = eng.capa1Cash;

    // 9 ticks de 10s = 90s TWAP, todos con flash crash a $98 (< stop estimado $99.2)
    for (let i = 0; i < 9; i++) {
      eng.prices[PAIR] = 98.0;
      await eng.evaluate();
    }

    // Verificar: portfolio intacto, ningún SELL emitido
    assert.ok(eng.portfolio[STRAT_ID], "portfolio[id] intacto tras 9 ticks adversos");
    assert.equal(eng.portfolio[STRAT_ID].status, "pending", "sigue pending");
    assert.equal(eng.log.filter(l => l.type === "SELL").length, 0, "cero SELLs emitidos");
    const stratTradesPostLen = (eng._stratTrades[STRAT_ID] || []).length;
    assert.equal(stratTradesPostLen, stratTradesPreLen,
      "_stratTrades NO crece durante TWAP adverso (no SELL fantasma contamina Kelly)");
    assert.equal(eng.capa1Cash, capa1PostReserve, "capa intacta durante TWAP adverso");

    // Al final del TWAP, applyRealBuyFill llega con fill real (slippage adverso
    // pequeño: spent $16.05, qty 0.1595 → realPrice ≈ 100.627)
    const realSpent = 16.05;
    const realQty = 0.1595;
    eng.applyRealBuyFill(STRAT_ID, { realSpent, realQty });

    // Status promovido a filled
    assert.equal(eng.portfolio[STRAT_ID].status, "filled", "promovido a filled");
    // drift = realSpent - invest = 0.05 descontado de capa1
    // Final: capa1 = 43.984 - 0.05 = 43.934
    const expectedCapa1 = capa1PostReserve - (realSpent - invest);
    assert.ok(Math.abs(eng.capa1Cash - expectedCapa1) < 1e-6,
      `capa1=${eng.capa1Cash.toFixed(4)} debe ≈ ${expectedCapa1.toFixed(4)} tras drift`);

    // Invariante contable: capa1+capa2 + pos.invest (ahora real) ≈ cap_declarado (sin pérdidas ni ganancias aún)
    const committed = eng.portfolio[STRAT_ID]._investWithFee;
    const total = eng.capa1Cash + eng.capa2Cash + committed;
    // 43.934 + 40 + 16.05*1.001 ≈ 99.99605
    assert.ok(Math.abs(total - 100) < 0.1, `invariante: cash+committed ≈ cap, got ${total}`);

    // Ahora sí, tick adverso post-fill → cierra normal con stop real
    eng.prices[PAIR] = 99.0; // < nuevo stop (realPrice * 0.992 ≈ 99.82)
    await eng.evaluate();
    assert.ok(!eng.portfolio[STRAT_ID], "post-fill + stop hit → cierra normal");
    assert.equal(eng.log.filter(l => l.type === "SELL").length, 1);
  });
});
