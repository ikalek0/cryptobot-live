// Regresión 20 Abril 2026 — simpleBot perdió contabilidad de 2 trades cerrados
// en STOP porque syncCapitalFromBinance corría en PAPER-LIVE y reseteaba capas
// cada 5 min borrando realizedPnl. Este fichero reproduce el escenario exacto
// y verifica que, tras el fix, capa1+capa2 refleja la pérdida acumulada.
"use strict";

process.env.CAPITAL_USDC = "100";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SimpleBotEngine } = require("../src/engine_simple");

// ── Helper: fake Binance para el sync (LIVE path). En PAPER no se usa ──
function makeFakeBinance(usdcFree = 100) {
  return async (method, path, params) => {
    if (path === "ticker/price" && params?.symbol === "USDCUSDT") {
      return { symbol: "USDCUSDT", price: "1.0" };
    }
    if (path === "account") {
      return {
        balances: [
          { asset: "USDC", free: String(usdcFree), locked: "0" },
          { asset: "BNB",  free: "0.05",          locked: "0" },
        ],
      };
    }
    if (path === "myTrades") return [];
    throw new Error(`unexpected path: ${path}`);
  };
}

describe("Regresión 20 abr 2026 — sync-overwrite borra realizedPnl en PAPER-LIVE", () => {
  it("BUG histórico: 2 SELLs virtuales en STOP deberían dejar capa1+capa2 ≈ 99.68 pero el sync reseteaba a 100", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    // Fake portfolio con 2 trades cerrados en STOP a -0.83%, pnl -$0.16 cada uno
    // Simulamos el close manualmente: capa1 debería bajar a 60 − 0.16 − 0.16 = 59.68
    // (approx: trade abre con cash $16, cierra con $15.84).
    eng.capa1Cash = 59.68; // post-2-trades
    eng.capa2Cash = 40;
    eng.realizedPnl = -0.32;
    eng.totalFees   = 0.032;
    eng.log = [
      { type: "BUY",  symbol: "BTCUSDC", strategy: "BTC_30m_RSI", price: 65000, invest: 16, ts: Date.now()-7200000 },
      { type: "SELL", symbol: "BTCUSDC", strategy: "BTC_30m_RSI", pnl: -0.83, reason: "STOP", ts: Date.now()-3700000 },
      { type: "BUY",  symbol: "SOLUSDC", strategy: "SOL_1h_EMA", price: 180, invest: 16, ts: Date.now()-1800000 },
      { type: "SELL", symbol: "SOLUSDC", strategy: "SOL_1h_EMA", pnl: -0.83, reason: "STOP", ts: Date.now()-600000 },
    ];

    // Pre-fix, el sync en PAPER-LIVE corría igualmente y reseteaba capas.
    // Post-fix: con liveMode=false, el sync debe hacer short-circuit.
    return eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(100),
      binancePublicRequest:   makeFakeBinance(100),
      liveMode: false, // PAPER-LIVE
    }).then(r => {
      assert.equal(r.skipped, true, "sync debe devolver skipped en PAPER-LIVE");
      assert.equal(r.reason, "PAPER-LIVE");
      // Verdad del invariante: capa1+capa2 NO se han tocado
      assert.equal(eng.capa1Cash, 59.68, "capa1Cash se preserva post-fix");
      assert.equal(eng.capa2Cash, 40, "capa2Cash se preserva");
      const total = eng.capa1Cash + eng.capa2Cash;
      assert.ok(Math.abs(total - 99.68) < 1e-9, `capa1+capa2 ≈ 99.68, got ${total}`);
      assert.equal(eng.realizedPnl, -0.32, "realizedPnl preservado post-fix");
    });
  });

  it("contra-prueba LIVE con fix definitivo: efectivo=min(real, declarado+rp), deposit no declarado queda invisible", () => {
    // Tarea B corregida (20 abr 2026): el primer fix "efectivo=real" era el bug
    // opuesto catastrófico — user tenía $17.92 personales encima de $100 operativos
    // y el bot los trataba como capital. Fix definitivo:
    //   operationalCap = max(0, declarado + realizedPnl)
    //   efectivo       = min(real, operationalCap)
    // Aquí: real=120 pero declarado=100 rp=0 → operationalCap=100 → efectivo=100.
    // Los $20 que Binance tiene de más NO son operativos hasta que el user
    // haga /capital 120 para redeclarar el baseline.
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.realizedPnl = 0;
    eng.capa1Cash = 60; eng.capa2Cash = 40;
    return eng.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(120),
      binancePublicRequest:   makeFakeBinance(120),
      liveMode: true,
    }).then(r => {
      assert.equal(r.ok, true);
      assert.equal(r.skipped, undefined, "en LIVE no hay skip");
      // real=120, operationalCap=max(0, 100+0)=100, efectivo=min(120,100)=100
      assert.ok(Math.abs(eng._capitalEfectivo - 100) < 0.01, `efectivo=100 (cap), got ${eng._capitalEfectivo}`);
      const total = eng.capa1Cash + eng.capa2Cash;
      assert.ok(Math.abs(total - 100) < 0.02, `capa1+capa2=100 (deposit no declarado invisible), got ${total}`);
    });
  });

  it("invariante accounting: tras 1 close virtual, realizedPnl = expectedNet − cashDebit", async () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.capa1Cash = 60; eng.capa2Cash = 40;
    // Forzamos una posición y simulamos close manualmente invocando evaluate().
    const entryPrice = 100;
    const invest = 16;
    const stopPrice = entryPrice * (1 - 0.008); // -0.8% → STOP
    eng.portfolio["BTC_30m_RSI"] = {
      pair:"BTCUSDC", capa:1, type:"RSI_MR_ADX", tf:"30m",
      entryPrice, qty: invest/entryPrice,
      stop: entryPrice*(1-0.008), target: entryPrice*(1+0.016),
      openTs: Date.now()-600000,
      invest,
      _investWithFee: invest * 1.001, // USDC mode
      status: "filled",
      _feePredicted: { mode: "USDC", FEE_efectivo: 0.001, feePaidInBnb: false,
                       expectedBnbFee: 0, feeUsdcEquivalent: invest * 0.001,
                       bnbBalancePre: 0, bnbPrice: 0, pair: "BTCUSDC", ts: Date.now() },
    };
    // capa1Cash ya estaba en 60-16.016=43.984
    eng.capa1Cash = 60 - invest * 1.001;
    // Simular precio por debajo del stop
    eng.prices["BTCUSDC"] = stopPrice * 0.999; // justo debajo del stop
    // evaluate() detectará hitStop y cerrará (async)
    await eng.evaluate();
    // Post-close: portfolio vacío, realizedPnl != 0
    assert.equal(Object.keys(eng.portfolio).length, 0, "posición cerrada");
    assert.notEqual(eng.realizedPnl, 0, "realizedPnl actualizado tras close");
    assert.ok(eng.realizedPnl < 0, `realizedPnl negativo (STOP), got ${eng.realizedPnl}`);
    // invariante: capa1 + capa2 + portfolio_value = _capitalDeclarado + realizedPnl
    const total = eng.capa1Cash + eng.capa2Cash;
    const expected = eng._capitalDeclarado + eng.realizedPnl;
    assert.ok(Math.abs(total - expected) < 0.001,
      `invariante: capa1+capa2=${total.toFixed(6)} ≈ cap+rp=${expected.toFixed(6)}`);
  });

  it("persistencia: realizedPnl y totalFees sobreviven restart via saveState/constructor", () => {
    const eng = new SimpleBotEngine({});
    eng.realizedPnl = -0.32;
    eng.totalFees   = 0.032;
    eng._peakTv     = 100.5;
    const saved = eng.saveState();
    assert.equal(saved.realizedPnl, -0.32);
    assert.equal(saved.totalFees,   0.032);
    const eng2 = new SimpleBotEngine(saved);
    assert.equal(eng2.realizedPnl, -0.32, "realizedPnl restaurado");
    assert.equal(eng2.totalFees,   0.032, "totalFees restaurado");
    assert.equal(eng2._peakTv,     100.5, "peakTv restaurado");
  });
});
