// BUG C (20 abr 2026) — _checkFeeDiscrepancy qtyBought/qtySold adjustment.
// Antes: bnbDelta = bnbBefore - bnbAfter. Para pares BNB* el balance BNB
// cambia por la propia compra/venta, no solo por la fee → falso positivo
// "predicho BNB pero BNB no bajó — USDC fallback" + alerta Telegram espuria.
// Fix: ajustar bnbDelta por qtyTraded cuando el par es BNBUSDC/BNBUSDT.
"use strict";

process.env.CAPITAL_USDC = "100";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SimpleBotEngine } = require("../src/engine_simple");

function collectTelegramSends() {
  const msgs = [];
  return { send: (m) => msgs.push(m), msgs };
}

describe("BUG C — _checkFeeDiscrepancy ajusta bnbDelta por flujo del par", () => {
  it("BNB-BUY con fee pagada en BNB: NO dispara falso positivo ni alerta Telegram", () => {
    const eng = new SimpleBotEngine({});
    // Estado pre-fill: BNB balance X, predicho modo BNB, expectedFee 0.000022 BNB
    const bnbBefore = 0.05;
    const expectedFee = 0.000022;
    // Post-fill: compra 0.02758 BNB, paga 0.000022 BNB de fee.
    eng._bnbBalance = bnbBefore + 0.02758 - expectedFee;
    const predicted = {
      mode: "BNB",
      FEE_efectivo: 0,
      feePaidInBnb: true,
      expectedBnbFee: expectedFee,
      feeUsdcEquivalent: 0.016,
      bnbBalancePre: bnbBefore,
      bnbPrice: 580,
      pair: "BNBUSDC", // clave para el fix
      ts: Date.now(),
    };
    const tg = collectTelegramSends();
    const r = eng._checkFeeDiscrepancy("BNB_1h_RSI", "BUY", predicted, tg.send, { qtyTraded: 0.02758 });
    assert.equal(r.ok, true, "no mismatch cuando fee efectiva coincide con expected");
    assert.equal(r.mismatch, false);
    assert.equal(tg.msgs.length, 0, "no hay alerta Telegram espuria");
    // deltaReal debería ser ≈ expectedFee (NO la qty comprada)
    assert.ok(Math.abs(r.deltaReal - expectedFee) < 1e-6,
      `deltaReal=${r.deltaReal} ≈ ${expectedFee}`);
  });

  it("BNB-BUY con fee pagada en USDC fallback (Binance ignoró BNB): SÍ detecta fallback", () => {
    const eng = new SimpleBotEngine({});
    const bnbBefore = 0.05;
    // Post-fill: compra 0.02758 BNB, Binance NO cobró BNB (fallback USDC) → BNB solo sube por compra
    eng._bnbBalance = bnbBefore + 0.02758;
    const predicted = {
      mode: "BNB",
      FEE_efectivo: 0,
      feePaidInBnb: true,
      expectedBnbFee: 0.000022,
      feeUsdcEquivalent: 0.016,
      bnbBalancePre: bnbBefore,
      bnbPrice: 580,
      pair: "BNBUSDC",
      ts: Date.now(),
    };
    const tg = collectTelegramSends();
    const r = eng._checkFeeDiscrepancy("BNB_1h_RSI", "BUY", predicted, tg.send, { qtyTraded: 0.02758 });
    // deltaReal ajustado = bnbBefore + qtyBought − bnbAfter = 0
    assert.ok(Math.abs(r.deltaReal) < 1e-6, `deltaReal ≈ 0 (no hubo fee BNB real), got ${r.deltaReal}`);
    assert.equal(r.mismatch, true, "fee esperada no coincide con 0 → mismatch");
    assert.ok(tg.msgs.length >= 1, "debe haber alerta Telegram de discrepancia real");
  });

  it("SELL SOLUSDC (no-BNB pair) con fee en BNB: la fórmula original sigue funcionando", () => {
    const eng = new SimpleBotEngine({});
    const bnbBefore = 0.05;
    const expectedFee = 0.000030;
    // Post-SELL SOL: BNB balance solo bajó por la fee (SOL no toca BNB)
    eng._bnbBalance = bnbBefore - expectedFee;
    const predicted = {
      mode: "BNB",
      FEE_efectivo: 0,
      feePaidInBnb: true,
      expectedBnbFee: expectedFee,
      feeUsdcEquivalent: 0.018,
      bnbBalancePre: bnbBefore,
      bnbPrice: 580,
      pair: "SOLUSDC", // no-BNB pair → qtyTraded ignorado internamente
      ts: Date.now(),
    };
    const tg = collectTelegramSends();
    // qtyTraded=50 (SOL sold) pero como pair no es BNB, el ajuste es inerte
    const r = eng._checkFeeDiscrepancy("SOL_1h_EMA", "SELL", predicted, tg.send, { qtyTraded: 50 });
    assert.equal(r.ok, true);
    assert.equal(r.mismatch, false);
    assert.equal(tg.msgs.length, 0);
    assert.ok(Math.abs(r.deltaReal - expectedFee) < 1e-6);
  });

  it("USDC mode sobre BNB pair: NO debería haber cambio en BNB ajustado", () => {
    const eng = new SimpleBotEngine({});
    const bnbBefore = 0.001; // insuficiente para fee BNB → modo USDC
    // BUY BNBUSDC: el balance BNB sube por la compra, fee en USDC
    eng._bnbBalance = bnbBefore + 0.02758;
    const predicted = {
      mode: "USDC",
      FEE_efectivo: 0.001,
      feePaidInBnb: false,
      expectedBnbFee: 0,
      feeUsdcEquivalent: 0.016,
      bnbBalancePre: bnbBefore,
      bnbPrice: 580,
      pair: "BNBUSDC",
      ts: Date.now(),
    };
    const tg = collectTelegramSends();
    const r = eng._checkFeeDiscrepancy("BNB_1h_RSI", "BUY", predicted, tg.send, { qtyTraded: 0.02758 });
    // deltaReal ajustado ≈ 0 (no hubo fee BNB). En modo USDC, eso es correcto.
    assert.ok(Math.abs(r.deltaReal) < 1e-6);
    assert.equal(r.ok, true);
    assert.equal(r.mismatch, false);
    assert.equal(tg.msgs.length, 0, "no alerta en modo USDC si BNB ajustado ≈ 0");
  });
});
