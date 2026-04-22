// BUG-G LOW (Cowork audit) — drift floor en applyRealBuyFill.
// Casos: drift positivo extremo con capa insuficiente (floor aplicado +
// warning), drift positivo normal (aplicado completo), drift negativo
// (crédito sin clamp), drift cero (idempotente).
"use strict";

process.env.CAPITAL_USDC = "100";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { SimpleBotEngine } = require("../src/engine_simple");

const STRAT_ID = "BTC_30m_RSI";
const PAIR = "BTCUSDC";

function armPending(eng, { invest, capa = 1 }) {
  const entryPrice = 100;
  eng.portfolio[STRAT_ID] = {
    pair: PAIR, capa, type: "RSI_MR_ADX", tf: "30m",
    entryPrice, qty: invest / entryPrice,
    stop: entryPrice * 0.992, target: entryPrice * 1.016,
    openTs: Date.now(),
    invest, _investWithFee: invest * 1.001,
    status: "pending",
    _feePredicted: {
      mode: "USDC", FEE_efectivo: 0.001, feePaidInBnb: false,
      expectedBnbFee: 0, feeUsdcEquivalent: invest * 0.001,
      bnbBalancePre: 0, bnbPrice: 0, pair: PAIR, ts: Date.now(),
    },
  };
}

// Spy simple sobre console.warn
function collectWarns(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try { fn(); } finally { console.warn = orig; }
  return warns;
}

describe("BUG-G — drift floor en applyRealBuyFill", () => {
  it("drift positivo extremo excede capa → capa=0, warning loggeado con residuo", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.capa1Cash = 1.0;  // casi agotada por otros BUYs concurrentes
    eng.capa2Cash = 40;
    armPending(eng, { invest: 10, capa: 1 });
    // realSpent=11.5 → drift=1.5 > capa=1.0
    const warns = collectWarns(() => {
      eng.applyRealBuyFill(STRAT_ID, { realSpent: 11.5, realQty: 0.115 });
    });
    // capa1 debe haber ido a 0 (no negativo)
    assert.equal(eng.capa1Cash, 0, `capa1 floor en 0, got ${eng.capa1Cash}`);
    // Warning emitido con residuo = 1.5 - 1.0 = 0.5
    const bugGWarn = warns.find(w => w.includes("[SIMPLE][BUG-G]"));
    assert.ok(bugGWarn, "debe loggear warning BUG-G");
    assert.ok(/residuo \$0\.5000/.test(bugGWarn),
      `warning debe incluir residuo exacto, got: ${bugGWarn}`);
    assert.ok(/aplicado \$1\.0000/.test(bugGWarn),
      `warning debe incluir applied, got: ${bugGWarn}`);
  });

  it("drift positivo normal cabe en capa → aplicado completo, sin warning", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.capa1Cash = 44;
    eng.capa2Cash = 40;
    armPending(eng, { invest: 16, capa: 1 });
    // realSpent=16.05 → drift=0.05, cabe en capa=44
    const warns = collectWarns(() => {
      eng.applyRealBuyFill(STRAT_ID, { realSpent: 16.05, realQty: 0.1605 });
    });
    assert.ok(Math.abs(eng.capa1Cash - 43.95) < 1e-6,
      `capa1 = 44 - 0.05 = 43.95, got ${eng.capa1Cash}`);
    const bugGWarn = warns.find(w => w.includes("[SIMPLE][BUG-G]"));
    assert.equal(bugGWarn, undefined, "sin warning en caso normal");
  });

  it("drift negativo (crédito) → capa sube sin clamp", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.capa1Cash = 10;
    eng.capa2Cash = 40;
    armPending(eng, { invest: 16, capa: 1 });
    // realSpent=15.5 → drift=-0.5 (bot gastó menos del esperado)
    const warns = collectWarns(() => {
      eng.applyRealBuyFill(STRAT_ID, { realSpent: 15.5, realQty: 0.155 });
    });
    // drift negativo resta -0.5 = +0.5 crédito → capa=10.5
    assert.ok(Math.abs(eng.capa1Cash - 10.5) < 1e-6,
      `capa1 = 10 + 0.5 = 10.5, got ${eng.capa1Cash}`);
    const bugGWarn = warns.find(w => w.includes("[SIMPLE][BUG-G]"));
    assert.equal(bugGWarn, undefined, "sin warning en crédito");
  });

  it("drift cero (realSpent == invest) → capa sin cambio", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.capa1Cash = 50;
    eng.capa2Cash = 40;
    armPending(eng, { invest: 16, capa: 1 });
    eng.applyRealBuyFill(STRAT_ID, { realSpent: 16, realQty: 0.16 });
    assert.equal(eng.capa1Cash, 50, "sin cambio si drift=0");
  });

  it("capa2: mismo floor aplica a la otra capa", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.capa1Cash = 60;
    eng.capa2Cash = 2.0; // casi agotada
    armPending(eng, { invest: 20, capa: 2 });
    const warns = collectWarns(() => {
      eng.applyRealBuyFill(STRAT_ID, { realSpent: 25, realQty: 0.25 });
    });
    // drift=5, capa2=2 → capa2 floor a 0, residuo 3
    assert.equal(eng.capa2Cash, 0);
    const bugGWarn = warns.find(w => w.includes("[SIMPLE][BUG-G]"));
    assert.ok(bugGWarn);
    assert.ok(/capa2 disponible \$2\.0000/.test(bugGWarn));
    assert.ok(/residuo \$3\.0000/.test(bugGWarn));
  });
});
