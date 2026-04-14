// ── T0-FEE: Manejo de fees con "Use BNB for fees" activo ────────────────
// Cubre los 7 casos del brief: predicción en ambos modos, fallbacks,
// detección de discrepancia, invariante BNB∉capital, latch de alerta.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Fijar CAP a 100 antes de require para que INITIAL_CAPITAL se lea
process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

const { SimpleBotEngine } = require("../src/engine_simple");

// Helper: crea un fake binanceReadOnlyRequest configurable.
// Soporta account (con BNB opcional) y myTrades (con commissionAsset).
function makeFakeBinance({ usdc = 100, bnb = 0, commissionAssetRecent = null } = {}) {
  return async (method, path, params) => {
    if (method !== "GET") throw new Error("read-only");
    if (path === "account") {
      const balances = [
        { asset: "USDC", free: String(usdc), locked: "0" },
      ];
      if (bnb > 0) balances.push({ asset: "BNB", free: String(bnb), locked: "0" });
      return { balances };
    }
    if (path === "myTrades") {
      if (!commissionAssetRecent) return [];
      return [
        { symbol: params?.symbol || "BNBUSDC",
          commission: "0.000075",
          commissionAsset: commissionAssetRecent,
          time: Date.now() - 1000 },
      ];
    }
    throw new Error(`unexpected path: ${path}`);
  };
}

describe("T0-FEE — Manejo de fees con BNB activo", () => {

  describe("TEST-FEE-1: BNB suficiente + bnbFeeEnabled=true → FEE_efectivo=0", () => {
    it("pred.mode='BNB', FEE_efectivo=0, expectedBnbFee > 0", () => {
      const eng = new SimpleBotEngine({});
      eng._bnbFeeEnabled = true;
      eng._bnbBalance    = 0.1;                // sobra para cualquier trade
      eng.prices.BNBUSDC = 600;

      const pred = eng._computeFeePrediction(20); // trade $20
      // fee USDC equiv = 20 * 0.001 = 0.02 USDC
      // expectedBnbFee = 0.02 / 600 * 0.75 = 0.000025
      assert.equal(pred.mode, "BNB");
      assert.equal(pred.FEE_efectivo, 0);
      assert.equal(pred.feePaidInBnb, true);
      assert.ok(pred.expectedBnbFee > 0, "expectedBnbFee debe ser > 0");
      assert.ok(Math.abs(pred.expectedBnbFee - 0.000025) < 1e-8,
        `expectedBnbFee=${pred.expectedBnbFee}`);
      assert.equal(pred.feeUsdcEquivalent, 0.02);
      assert.equal(pred.bnbBalancePre, 0.1);
    });
  });

  describe("TEST-FEE-2: BNB insuficiente + bnbFeeEnabled=true → FEE_efectivo=0.001", () => {
    it("pred.mode='USDC' cuando BNB < expectedBnbFee", () => {
      const eng = new SimpleBotEngine({});
      eng._bnbFeeEnabled = true;
      eng._bnbBalance    = 0.000001;           // ínfimo, no cubre fee
      eng.prices.BNBUSDC = 600;

      const pred = eng._computeFeePrediction(20);
      // expectedBnbFee = 0.000025 > _bnbBalance → fallback USDC
      assert.equal(pred.mode, "USDC");
      assert.equal(pred.FEE_efectivo, 0.001);
      assert.equal(pred.feePaidInBnb, false);
      // expectedBnbFee se calcula igualmente para diagnóstico
      assert.ok(Math.abs(pred.expectedBnbFee - 0.000025) < 1e-8);
    });
  });

  describe("TEST-FEE-3: bnbFeeEnabled=false → FEE_efectivo=0.001 siempre", () => {
    it("con BNB de sobra pero opción desactivada cae a USDC", () => {
      const eng = new SimpleBotEngine({});
      eng._bnbFeeEnabled = false;              // opción desactivada
      eng._bnbBalance    = 10;                 // BNB masivo no importa
      eng.prices.BNBUSDC = 600;

      const pred = eng._computeFeePrediction(20);
      assert.equal(pred.mode, "USDC");
      assert.equal(pred.FEE_efectivo, 0.001);
      assert.equal(pred.feePaidInBnb, false);
      // expectedBnbFee=0 porque no se considera BNB
      assert.equal(pred.expectedBnbFee, 0);
    });
  });

  describe("TEST-FEE-4: precio BNB no disponible → fallback conservador USDC", () => {
    it("sin prices.BNBUSDC cacheado, FEE_efectivo=0.001 aunque BNB abunde", () => {
      const eng = new SimpleBotEngine({});
      eng._bnbFeeEnabled = true;
      eng._bnbBalance    = 10;
      // prices.BNBUSDC NO seteado (undefined ó 0)
      const pred = eng._computeFeePrediction(20);
      assert.equal(pred.mode, "USDC");
      assert.equal(pred.FEE_efectivo, 0.001);
      assert.equal(pred.feePaidInBnb, false);
      assert.equal(pred.bnbPrice, 0);
    });
  });

  describe("TEST-FEE-5: _checkFeeDiscrepancy dispara alerta si delta BNB > 5% off", () => {
    it("mode BNB con delta real fuera de tolerancia → telegramSend con 'Discrepancia BNB'", () => {
      const eng = new SimpleBotEngine({});
      // Simular predicción de un trade reciente
      const predicted = {
        mode: "BNB",
        FEE_efectivo: 0,
        feePaidInBnb: true,
        expectedBnbFee: 0.0001,
        feeUsdcEquivalent: 0.08,
        bnbBalancePre: 0.05,
        bnbPrice: 600,
        ts: Date.now() - 1000,
      };
      // El balance post-fill bajó a 0.0498 → delta=0.0002 (2x expected, fuera de 5%)
      eng._bnbBalance = 0.0498;

      let telegramMsgs = [];
      const tg = (m) => telegramMsgs.push(m);
      const r = eng._checkFeeDiscrepancy("BNB_1h_RSI", "BUY", predicted, tg);

      assert.equal(r.ok, false, "ok=false por mismatch");
      assert.equal(r.mode, "BNB");
      assert.equal(r.mismatch, true);
      assert.ok(Math.abs(r.deltaReal - 0.0002) < 1e-9,
        `deltaReal=${r.deltaReal}`);
      assert.equal(telegramMsgs.length, 1);
      assert.ok(telegramMsgs[0].includes("Discrepancia BNB"),
        `msg=${telegramMsgs[0]}`);
    });

    it("mode BNB con delta real dentro de tolerancia → ok, sin alerta", () => {
      const eng = new SimpleBotEngine({});
      const predicted = {
        mode: "BNB",
        expectedBnbFee: 0.0001,
        bnbBalancePre: 0.05,
      };
      eng._bnbBalance = 0.05 - 0.0001 * 1.02; // 2% off → dentro del 5%
      let calls = 0;
      const tg = () => calls++;
      const r = eng._checkFeeDiscrepancy("X", "BUY", predicted, tg);
      assert.equal(r.ok, true);
      assert.equal(r.mismatch, false);
      assert.equal(calls, 0, "sin alerta si está dentro de tolerancia");
    });

    it("mode USDC con BNB que no bajó → ok sin alerta", () => {
      const eng = new SimpleBotEngine({});
      const predicted = {
        mode: "USDC",
        expectedBnbFee: 0,
        bnbBalancePre: 0.05,
      };
      eng._bnbBalance = 0.05; // no cambió
      let calls = 0;
      const r = eng._checkFeeDiscrepancy("X", "BUY", predicted, () => calls++);
      assert.equal(r.ok, true);
      assert.equal(r.mismatch, false);
      assert.equal(calls, 0);
    });
  });

  describe("TEST-FEE-6: _bnbBalance JAMÁS se suma a _capitalReal", () => {
    it("sync con BNB 0.5 en balances → capitalReal sólo refleja USDC+MTM", async () => {
      const eng = new SimpleBotEngine({});
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance({ usdc: 50, bnb: 0.5 }),
      });
      assert.equal(r.ok, true);
      assert.equal(r.capitalReal, 50, "capitalReal = USDC libre, NUNCA suma BNB");
      assert.equal(r.capitalEfectivo, 50);
      // El BNB sí se registra separado pero no entra al capital
      assert.equal(eng._bnbBalance, 0.5);
      assert.ok(eng._bnbBalance > 0);
      // Verificación cruzada: capa1+capa2 ≤ capitalEfectivo = 50
      assert.ok(eng.capa1Cash + eng.capa2Cash <= 50.001,
        `cash=${eng.capa1Cash + eng.capa2Cash}`);
    });

    it("sync con BNB masivo (10 BNB ≈ $6000) → capitalEfectivo sigue siendo 100", async () => {
      const eng = new SimpleBotEngine({});
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance({ usdc: 100, bnb: 10 }),
      });
      assert.equal(r.capitalReal, 100, "BNB de $6000 NO se suma a capitalReal");
      assert.equal(r.capitalEfectivo, 100);
      assert.equal(eng._bnbBalance, 10);
    });
  });

  describe("TEST-FEE-7: latch _bnbLowAlertSent evita spam y se resetea al recuperar", () => {
    it("BNB < 0.005 dispara una sola alerta; recuperar resetea latch", async () => {
      const eng = new SimpleBotEngine({});
      let telegramCalls = 0;
      const deps = {
        binanceReadOnlyRequest: makeFakeBinance({ usdc: 50, bnb: 0.001 }),
        telegramSend: () => telegramCalls++,
      };

      // Primera sync: BNB=0.001 < 0.005 → alerta
      await eng.syncCapitalFromBinance(deps);
      assert.equal(telegramCalls, 1, "primera sync dispara alerta");
      assert.equal(eng._bnbLowAlertSent, true);

      // Segunda sync con BNB aún bajo → NO re-dispara (latch activo)
      await eng.syncCapitalFromBinance(deps);
      assert.equal(telegramCalls, 1, "segunda sync con BNB bajo no repite alerta");

      // Tercera sync con BNB recuperado → latch resetea
      const deps2 = {
        binanceReadOnlyRequest: makeFakeBinance({ usdc: 50, bnb: 0.05 }),
        telegramSend: () => telegramCalls++,
      };
      await eng.syncCapitalFromBinance(deps2);
      assert.equal(eng._bnbLowAlertSent, false, "latch reseteado al recuperar");

      // Cuarta sync con BNB otra vez bajo → dispara nueva alerta
      await eng.syncCapitalFromBinance(deps);
      assert.equal(telegramCalls, 2, "tras recuperar y volver a caer, alerta fresca");
    });
  });

  describe("Detección fee mode vía commissionAsset (cascade + default)", () => {
    it("myTrades devuelve commissionAsset='BNB' → _bnbFeeEnabled=true", async () => {
      const eng = new SimpleBotEngine({});
      eng._bnbFeeEnabled = false; // forzar estado previo distinto
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance({ usdc: 50, bnb: 0.05, commissionAssetRecent: "BNB" }),
      });
      assert.equal(r.ok, true);
      assert.equal(eng._bnbFeeEnabled, true);
    });

    it("myTrades devuelve commissionAsset='BTC' (no BNB) → _bnbFeeEnabled=false", async () => {
      const eng = new SimpleBotEngine({});
      eng._bnbFeeEnabled = true;
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance({ usdc: 50, bnb: 0.05, commissionAssetRecent: "BTC" }),
      });
      assert.equal(r.ok, true);
      assert.equal(eng._bnbFeeEnabled, false);
    });

    it("myTrades array vacío en todos los candidatos → valor previo preservado", async () => {
      const eng = new SimpleBotEngine({});
      eng._bnbFeeEnabled = true; // seed
      const r = await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance({ usdc: 50, bnb: 0.05 }), // sin commissionAssetRecent
      });
      assert.equal(r.ok, true);
      assert.equal(eng._bnbFeeEnabled, true, "sin datos, mantiene previo true");

      // Ahora con seed false
      eng._bnbFeeEnabled = false;
      await eng.syncCapitalFromBinance({
        binanceReadOnlyRequest: makeFakeBinance({ usdc: 50, bnb: 0.05 }),
      });
      assert.equal(eng._bnbFeeEnabled, false, "sin datos, mantiene previo false");
    });
  });
});
