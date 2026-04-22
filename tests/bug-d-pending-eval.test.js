// BUG-D (CRITICAL, Cowork audit) — evaluate() NO debe procesar pending.
// Reproduce el PoC exacto: insertar pending con stop optimista, tick adverso
// que cruza el stop, verificar que portfolio[id] PERSISTE y que NO se emite
// SELL, NO se muta _stratTrades, NO se mueve capa.
"use strict";

process.env.CAPITAL_USDC = "100";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SimpleBotEngine } = require("../src/engine_simple");

// Estrategia real del portfolio para que cfg exista y timeStop tenga cfg
const STRAT_ID = "BTC_30m_RSI";
const PAIR = "BTCUSDC";

function armPending(eng, { entryPrice = 100, invest = 16, capa = 1 } = {}) {
  const qty = invest / entryPrice;
  eng.portfolio[STRAT_ID] = {
    pair: PAIR, capa, type: "RSI_MR_ADX", tf: "30m",
    entryPrice, qty,
    stop:   entryPrice * (1 - 0.008),
    target: entryPrice * (1 + 0.016),
    openTs: Date.now(),
    invest,
    _investWithFee: invest * 1.001,
    status: "pending", // <<< clave
    _feePredicted: {
      mode: "USDC", FEE_efectivo: 0.001, feePaidInBnb: false,
      expectedBnbFee: 0, feeUsdcEquivalent: invest * 0.001,
      bnbBalancePre: 0, bnbPrice: 0, pair: PAIR, ts: Date.now(),
    },
  };
  if (capa === 1) eng.capa1Cash -= invest * 1.001;
  else            eng.capa2Cash -= invest * 1.001;
}

describe("BUG-D — evaluate() skip pending positions", () => {
  it("tick cruza stop estimado con pending → portfolio PERSISTE, no SELL, no stratTrades, capa intacta", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.capa1Cash = 60;
    eng.capa2Cash = 40;
    const capa1Pre = eng.capa1Cash;

    armPending(eng, { entryPrice: 100, invest: 16 });
    const capa1PostOpen = eng.capa1Cash; // 60 - 16.016 = 43.984
    const stratTradesPre = (eng._stratTrades[STRAT_ID] || []).length;
    const logLenPre = eng.log.length;

    // Price cruza el stop estimado (100 * 0.992 = 99.2) — adverso
    eng.prices[PAIR] = 99.0;
    // Callback _onSell no debe dispararse — si lo hace, el test falla
    let onSellCalls = 0;
    eng._onSell = () => { onSellCalls++; };

    await eng.evaluate();

    // Portfolio: la posición DEBE seguir ahí (no fue cerrada)
    assert.ok(eng.portfolio[STRAT_ID], "portfolio[id] debe persistir, evaluate skip por status=pending");
    assert.equal(eng.portfolio[STRAT_ID].status, "pending", "sigue pending");

    // _stratTrades: NO se añadió ningún trade (no SELL fantasma)
    const stratTradesPost = (eng._stratTrades[STRAT_ID] || []).length;
    assert.equal(stratTradesPost, stratTradesPre, "_stratTrades NO mutado");

    // log: ningún SELL nuevo
    const newSells = eng.log.slice(logLenPre).filter(l => l.type === "SELL");
    assert.equal(newSells.length, 0, "no SELL emitido");

    // capa1: se mantiene en el valor post-open (43.984 aprox), NO se acreditó expectedNet fantasma
    assert.ok(Math.abs(eng.capa1Cash - capa1PostOpen) < 1e-9,
      `capa1Cash debe seguir en ${capa1PostOpen}, got ${eng.capa1Cash}`);

    // _onSell callback NO llamado
    assert.equal(onSellCalls, 0, "_onSell NO debe dispararse sobre pending");

    // realizedPnl y totalFees siguen en 0
    assert.equal(eng.realizedPnl, 0);
    assert.equal(eng.totalFees, 0);
  });

  it("cuando pending promueve a filled via applyRealBuyFill, evaluate SÍ procesa (close normal)", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.capa1Cash = 60;
    eng.capa2Cash = 40;
    armPending(eng, { entryPrice: 100, invest: 16 });
    // Promover a filled via applyRealBuyFill (sin drift para simplicidad)
    eng.applyRealBuyFill(STRAT_ID, { realSpent: 16, realQty: 0.16 });
    assert.equal(eng.portfolio[STRAT_ID].status, "filled");

    // Ahora tick adverso → evaluate SÍ cierra
    eng.prices[PAIR] = 99.0; // < stop
    await eng.evaluate();
    assert.ok(!eng.portfolio[STRAT_ID], "filled + stop hit → position cerrada normal");
    assert.ok(eng._stratTrades[STRAT_ID].length > 0, "_stratTrades actualizado");
    const sells = eng.log.filter(l => l.type === "SELL");
    assert.equal(sells.length, 1, "1 SELL emitido");
  });
});
