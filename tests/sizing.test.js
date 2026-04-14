// ── Sizing tests: Half-Kelly + cap 30% + min $10 ─────────────────────────────
// Guards against the $1500-on-$100 bug and validates all sizing constraints.
"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

// FIX-M3: respetar CAPITAL_USDT/USDC del entorno si está set; default $100.
// Así los tests escalan automáticamente si Iñigo cambia .env sin tocar código.
// Todos los números hardcodeados (phantoms, asserts) se derivan de CAP.
const CAP = parseFloat(process.env.CAPITAL_USDC || process.env.CAPITAL_USDT || "100");
process.env.CAPITAL_USDC = String(CAP);
process.env.CAPITAL_USDT = String(CAP);

const { SimpleBotEngine, calcKelly, STRATEGIES, evalSignal, INITIAL_CAPITAL, FEE } = require("../src/engine_simple");

// Sanity: el módulo debe haber leído la env que acabamos de poner
assert.equal(INITIAL_CAPITAL, CAP,
  `INITIAL_CAPITAL=${INITIAL_CAPITAL} should match test CAP=${CAP} (env leak?)`);

const CAP_LIMIT = INITIAL_CAPITAL * 1.005; // = cap del engine
const CAPA1_CAP = INITIAL_CAPITAL * 0.60;
const CAPA2_CAP = INITIAL_CAPITAL * 0.40;
// Scale factor para reescribir escenarios calibrados a $100 → cualquier CAP
const K = CAP / 100;

// Replicate the sizing formula from engine_simple.js _onCandleClose (lines 336-345)
// to test it in isolation with various inputs
function calcInvest(totalValue, kellyRaw, availCash) {
  const kellyFrac = Math.max(0.05, Math.min(0.5, kellyRaw || 0.1));
  let invest = totalValue * kellyFrac * 0.5; // Half-Kelly
  if (invest > totalValue * 0.30) invest = totalValue * 0.30; // cap 30%
  if (invest > availCash) invest = availCash;
  return invest;
}

describe("Sizing formula", () => {
  it(`Half-Kelly: $${CAP} capital, kelly=0.4 -> invest=${(CAP*0.2).toFixed(2)}`, () => {
    const invest = calcInvest(CAP, 0.4, CAPA1_CAP);
    // kellyFrac=0.4, half-kelly → invest = CAP * 0.4 * 0.5 = CAP * 0.20
    assert.ok(Math.abs(invest - CAP*0.20) < 1e-9, `Expected $${CAP*0.20}, got $${invest}`);
  });

  it(`Half-Kelly: kelly=0.164 -> invest=${(CAP*0.082).toFixed(2)} (below $10 if CAP=100)`, () => {
    const invest = calcInvest(CAP, 0.164, CAPA1_CAP);
    // invest = CAP * 0.164 * 0.5 = CAP * 0.082
    assert.ok(Math.abs(invest - CAP*0.082) < 1e-9,
      `invest should be CAP*0.082 = ${CAP*0.082}, got ${invest}`);
    if (CAP <= 121) {
      assert.ok(invest < 10, `CAP=${CAP} with kelly=0.164 should be below $10 min -> trade skipped`);
    }
  });

  it("Cap 30%: high kelly doesn't exceed 30% of capital", () => {
    const invest = calcInvest(CAP, 0.95, CAP);
    assert.ok(invest <= CAP*0.30 + 1e-9, `invest=$${invest} should not exceed 30% of CAP=$${CAP}`);
    // kelly=0.5 (capped), half-kelly = 0.25, invest = CAP * 0.25
    assert.ok(Math.abs(invest - CAP*0.25) < 1e-9);
  });

  it("NEVER exceeds 30% of CAP (the $1500-on-$100 bug regression)", () => {
    // The old bug: capital was $10000 instead of $100 due to missing dotenv.
    // With correct capital, even extreme kelly can't produce >30% of CAP.
    const invest = calcInvest(CAP, 1.0, CAP);
    assert.ok(invest <= CAP*0.30 + 1e-9, `invest=$${invest} must never exceed 30% of CAP=$${CAP}`);
  });

  it("Kelly fraction floor: negative kelly uses 0.05 minimum", () => {
    const invest = calcInvest(CAP, -0.5, CAP);
    // kellyFrac = max(0.05, min(0.5, -0.5)) = 0.05; invest = CAP * 0.05 * 0.5 = CAP * 0.025
    assert.ok(Math.abs(invest - CAP*0.025) < 1e-9);
    if (CAP < 400) {
      assert.ok(invest < 10, "Negative kelly -> invest below $10 -> trade skipped");
    }
  });

  it("Kelly fraction ceiling: extreme kelly capped at 0.5", () => {
    const invest = calcInvest(CAP, 2.0, CAP);
    // kellyFrac = max(0.05, min(0.5, 2.0)) = 0.5; invest = CAP * 0.5 * 0.5 = CAP * 0.25
    assert.ok(Math.abs(invest - CAP*0.25) < 1e-9);
  });

  it("Available cash constraint: can't exceed available cash", () => {
    const invest = calcInvest(CAP, 0.4, 5);
    // Half-Kelly wants CAP*0.20 but only $5 available
    assert.equal(invest, 5);
  });

  it("With buggy $10000 capital, sizing would be dangerously high", () => {
    // This proves WHY the dotenv fix was critical
    const buggyInvest = calcInvest(10000, 0.4, 10000);
    // kellyFrac=0.4, invest = 10000 * 0.4 * 0.5 = $2000
    assert.equal(buggyInvest, 2000);
    assert.ok(buggyInvest > CAP, `Buggy capital produces >$${CAP} invest on $${CAP} account`);
  });
});

describe("Sizing through SimpleBotEngine", () => {
  it(`INITIAL_CAPITAL is $${CAP} from env`, () => {
    const bot = new SimpleBotEngine({});
    const tv = bot.totalValue();
    assert.equal(tv, CAP, `totalValue should be $${CAP}, got $${tv}`);
  });

  it("Capa1 gets 60% and Capa2 gets 40%", () => {
    const bot = new SimpleBotEngine({});
    assert.ok(Math.abs(bot.capa1Cash - CAPA1_CAP) < 1e-9,
      `capa1Cash should be $${CAPA1_CAP}, got $${bot.capa1Cash}`);
    assert.ok(Math.abs(bot.capa2Cash - CAPA2_CAP) < 1e-9,
      `capa2Cash should be $${CAPA2_CAP}, got $${bot.capa2Cash}`);
  });

  it("After a BUY, invest is deducted from correct capa cash", () => {
    const bot = new SimpleBotEngine({});
    const initialCapa1 = bot.capa1Cash;
    // Simulate a BUY by directly manipulating portfolio like _onCandleClose does
    const invest = CAP * 0.20;
    const price = 600;
    const qty = invest * (1 - FEE) / price;
    bot.capa1Cash -= invest;
    bot.portfolio["BNB_1h_RSI"] = {
      pair: "BNBUSDC", capa: 1, entryPrice: price, qty, invest,
      stop: price * 0.992, target: price * 1.016, openTs: Date.now()
    };
    assert.ok(Math.abs(bot.capa1Cash - (initialCapa1 - invest)) < 1e-9);
    // Fees aside, total value should be approximately CAP (minus fee on the invest)
    const tv = bot.totalValue();
    assert.ok(Math.abs(tv - CAP) < invest * FEE * 2,
      `Total value should be ~$${CAP} after BUY (fees aside), got ${tv}`);
  });
});

// ── FIX-A: Atomic global committed cap check ────────────────────────────────
// Construye >=50 candles que producen BUY determinista para RSI_MR_ADX
// (22 flat de padding + 14 subida + 13 bajada + 1 sharp drop = 50 velas
//  con RSI~0, close<BB.lower y ADX<25 en los últimos 28)
function buyCandlesRSI() {
  const c = [];
  // Padding para cumplir CANDLE_MIN[1h/30m/4h] = 50 (no afecta indicadores recientes)
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

describe("FIX-A: atomic committed cap check", () => {
  it("sanity: buyCandlesRSI produces BUY for RSI_MR_ADX", () => {
    assert.equal(evalSignal("RSI_MR_ADX", buyCandlesRSI()), "BUY",
      "Test fixture broken: candles no longer produce BUY");
  });

  it("blocks new BUY when committed + invest would exceed cap * 1.005", () => {
    const bot = new SimpleBotEngine({});
    bot._capitalSyncPausedUntil = 0; // H7: bypass fail-closed boot default; este test es sobre cap check, no sync gate.
    // Pre-populate portfolio with 92% of CAP committed across 3 phantom positions.
    bot.portfolio["PHANTOM_A"] = { pair: "X1", capa: 1, invest: 32*K, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now() };
    bot.portfolio["PHANTOM_B"] = { pair: "X2", capa: 1, invest: 30*K, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now() };
    bot.portfolio["PHANTOM_C"] = { pair: "X3", capa: 2, invest: 30*K, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now() };

    // Force candles and price for BNB_1h_RSI
    bot._candles["BNBUSDC_1h"] = buyCandlesRSI();
    bot.prices["BNBUSDC"] = 95.5;

    // Make capa1Cash enough to not block via availCash path (force global cap to bite)
    bot.capa1Cash = 50*K;  // plenty of capa1 cash — but global cap should still win
    bot.capa2Cash = CAPA2_CAP - 30*K;

    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");
    bot._onCandleClose(cfg, "BNBUSDC_1h");

    const committedAfter = Object.values(bot.portfolio)
      .reduce((s, p) => s + (p.invest || 0), 0);
    // cap = INITIAL_CAPITAL * 1.005 = CAP_LIMIT
    assert.ok(committedAfter <= CAP_LIMIT + 0.01,  // float tolerance
      `committed=$${committedAfter.toFixed(2)} must be ≤ $${CAP_LIMIT.toFixed(2)} (cap*1.005)`);
  });

  it("shrinks new invest to headroom when committed near cap", () => {
    const bot = new SimpleBotEngine({});
    bot._capitalSyncPausedUntil = 0; // H7: bypass fail-closed boot default.
    // Commit 85% of CAP → headroom = CAP_LIMIT - 85% of CAP = 15.5% of CAP
    bot.portfolio["PHANTOM_A"] = { pair: "X1", capa: 1, invest: 55*K, qty: 0.5, entryPrice: 100, stop: 99, target: 101, openTs: Date.now() };
    bot.portfolio["PHANTOM_B"] = { pair: "X2", capa: 2, invest: 30*K, qty: 0.3, entryPrice: 100, stop: 99, target: 101, openTs: Date.now() };
    bot.capa1Cash = 50*K;
    bot.capa2Cash = 50*K;

    bot._candles["BNBUSDC_1h"] = buyCandlesRSI();
    bot.prices["BNBUSDC"] = 95.5;

    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");
    bot._onCandleClose(cfg, "BNBUSDC_1h");

    const headroom = CAP_LIMIT - 85*K;
    const pos = bot.portfolio["BNB_1h_RSI"];
    if (pos) {
      // Position accepted: must be ≤ headroom
      assert.ok(pos.invest <= headroom + 0.01,
        `New position invest=$${pos.invest} must be ≤ $${headroom.toFixed(2)} headroom`);
      assert.ok(pos.invest >= 10,
        `Accepted positions must be ≥ $10 minimum`);
    }
    // Whether accepted, shrunk, or rejected: committed must never exceed cap
    const committedAfter = Object.values(bot.portfolio)
      .reduce((s, p) => s + (p.invest || 0), 0);
    assert.ok(committedAfter <= CAP_LIMIT + 0.01,
      `After trade: committed=$${committedAfter.toFixed(2)} must be ≤ $${CAP_LIMIT.toFixed(2)}`);
  });

  it("new position has status='pending' marker (FIX-A + FASE 3 contract)", () => {
    const bot = new SimpleBotEngine({});
    bot._capitalSyncPausedUntil = 0; // H7: bypass fail-closed boot default.
    bot._candles["BNBUSDC_1h"] = buyCandlesRSI();
    bot.prices["BNBUSDC"] = 95.5;
    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");
    bot._onCandleClose(cfg, "BNBUSDC_1h");
    const pos = bot.portfolio["BNB_1h_RSI"];
    assert.ok(pos, "Position should be opened on BUY signal");
    assert.equal(pos.status, "pending",
      "FIX-A atomicity contract: new positions must be marked pending until applyRealFill");
  });

  it("_onBuy callback is invoked AFTER portfolio mutation (atomicity contract)", () => {
    const bot = new SimpleBotEngine({});
    bot._capitalSyncPausedUntil = 0; // H7: bypass fail-closed boot default.
    bot._candles["BNBUSDC_1h"] = buyCandlesRSI();
    bot.prices["BNBUSDC"] = 95.5;
    let seenPortfolioAtCallback = null;
    bot._onBuy = (pair, invest, ctx) => {
      // At this point, portfolio MUST already contain the new entry
      seenPortfolioAtCallback = { ...bot.portfolio };
    };
    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");
    bot._onCandleClose(cfg, "BNBUSDC_1h");
    assert.ok(seenPortfolioAtCallback, "Callback should be invoked on BUY");
    assert.ok(seenPortfolioAtCallback["BNB_1h_RSI"],
      "At callback time, portfolio must already contain the new entry (atomicity)");
  });
});

// ── FIX-C: placeLiveBuy cap guard rollback (unit-level logic) ───────────────
// No invocamos placeLiveBuy directamente (requiere LIVE_MODE + Binance mock);
// en su lugar replicamos la lógica rollback + cap check para proteger el
// contrato: si committed+new > cap, la reserva optimista debe deshacerse.
function simulatePlaceLiveBuyCapGuard(bot, symbol, usdtAmount, ctx, cap) {
  // Copia literal de la lógica FIX-C en server.js placeLiveBuy
  const committed = Object.entries(bot.portfolio)
    .filter(([id]) => id !== ctx?.strategyId)
    .reduce((s, [,p]) => s + (p.invest || 0), 0);
  if (committed + usdtAmount > cap) {
    // rollback reservation (FIX-A committed this synchronously before callback)
    if (ctx?.strategyId && bot.portfolio[ctx.strategyId]) {
      const pos = bot.portfolio[ctx.strategyId];
      if (pos.status === "pending") {
        if (pos.capa === 1) bot.capa1Cash += pos.invest;
        else                bot.capa2Cash += pos.invest;
        delete bot.portfolio[ctx.strategyId];
      }
    }
    return { rejected: true, committed, cap };
  }
  return { rejected: false };
}

describe("FIX-C: placeLiveBuy committed+new cap guard + rollback", () => {
  it("rejects when committed (excluding self) + new > cap, rollbacks reservation", () => {
    const bot = new SimpleBotEngine({});
    // Simular estado post-FIX-A: 2 phantoms pre-existentes + reserva optimista
    // de la estrategia que está intentando ejecutar placeLiveBuy.
    bot.portfolio["PHANTOM_A"] = { pair: "X1", capa: 1, invest: 50*K, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "filled" };
    bot.portfolio["PHANTOM_B"] = { pair: "X2", capa: 2, invest: 40*K, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "filled" };
    // Estrategia candidata (FIX-A ya la insertó como pending + decrementó capa1Cash)
    bot.portfolio["BNB_1h_RSI"] = { pair: "BNBUSDC", capa: 1, invest: 15*K, qty: 0.15, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "pending" };
    bot.capa1Cash = CAPA1_CAP - 50*K - 15*K; // puede ir negativo, no importa para el test

    const before = bot.capa1Cash;
    const res = simulatePlaceLiveBuyCapGuard(
      bot, "BNBUSDC", 15*K,
      { strategyId: "BNB_1h_RSI", capa: 1, expectedPrice: 100 },
      CAP_LIMIT // cap = CAPITAL * 1.005
    );

    assert.equal(res.rejected, true, `committed(${(90*K).toFixed(2)})+new(${(15*K).toFixed(2)})=${(105*K).toFixed(2)} > cap(${CAP_LIMIT.toFixed(2)}) → reject`);
    assert.ok(!bot.portfolio["BNB_1h_RSI"], "Pending reserve must be rolled back from portfolio");
    assert.ok(Math.abs(bot.capa1Cash - (before + 15*K)) < 1e-9, "capa1Cash must be restored by rollback");
    // Phantoms intact
    assert.ok(bot.portfolio["PHANTOM_A"]);
    assert.ok(bot.portfolio["PHANTOM_B"]);
  });

  it("accepts when committed (excluding self) + new ≤ cap", () => {
    const bot = new SimpleBotEngine({});
    bot.portfolio["PHANTOM_A"] = { pair: "X1", capa: 1, invest: 30*K, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "filled" };
    bot.portfolio["BNB_1h_RSI"] = { pair: "BNBUSDC", capa: 1, invest: 20*K, qty: 0.2, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "pending" };

    const res = simulatePlaceLiveBuyCapGuard(
      bot, "BNBUSDC", 20*K,
      { strategyId: "BNB_1h_RSI", capa: 1, expectedPrice: 100 },
      CAP_LIMIT
    );

    assert.equal(res.rejected, false, `committed_excl_self(${(30*K).toFixed(2)})+new(${(20*K).toFixed(2)})=${(50*K).toFixed(2)} ≤ cap(${CAP_LIMIT.toFixed(2)}) → accept`);
    assert.ok(bot.portfolio["BNB_1h_RSI"], "Pending reserve must remain intact on accept");
  });

  it("excludes self from committed sum (critical: self is already in portfolio per FIX-A)", () => {
    // Sin el filter id!==strategyId, committed contaría la propia reserva 2 veces.
    const bot = new SimpleBotEngine({});
    bot.portfolio["PHANTOM_A"] = { pair: "X1", capa: 1, invest: 30*K, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "filled" };
    bot.portfolio["BNB_1h_RSI"] = { pair: "BNBUSDC", capa: 1, invest: 50*K, qty: 0.5, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "pending" };

    const res = simulatePlaceLiveBuyCapGuard(
      bot, "BNBUSDC", 50*K,
      { strategyId: "BNB_1h_RSI", capa: 1, expectedPrice: 100 },
      CAP_LIMIT
    );
    assert.equal(res.rejected, false,
      "Double-counting bug regression: self must be excluded from committed sum");
  });
});

describe("FIX-A closing loop: applyRealBuyFill", () => {
  it("reconciles drift (realSpent > expected) by deducting extra from correct capa", () => {
    const bot = new SimpleBotEngine({});
    bot.portfolio["BNB_1h_RSI"] = { pair: "BNBUSDC", capa: 1, invest: 20*K, qty: 0.2, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "pending" };
    bot.capa1Cash = CAPA1_CAP - 20*K;
    bot.capa2Cash = CAPA2_CAP;

    // Real: slippage +0.15 (escala con K)
    const realSpent = 20*K + 0.15*K;
    bot.applyRealBuyFill("BNB_1h_RSI", { realSpent, realQty: 0.1998 });

    const pos = bot.portfolio["BNB_1h_RSI"];
    assert.equal(pos.status, "filled", "Position must transition pending→filled");
    assert.ok(Math.abs(pos.invest - realSpent) < 1e-9, "invest updated to real");
    assert.ok(Math.abs(pos.qty - 0.1998) < 1e-9, "qty updated to real");
    assert.ok(Math.abs(bot.capa1Cash - (CAPA1_CAP - 20*K - 0.15*K)) < 1e-9,
      `capa1Cash must deduct drift: got ${bot.capa1Cash.toFixed(4)}`);
    // capa2 untouched
    assert.equal(bot.capa2Cash, CAPA2_CAP);
  });

  it("reconciles drift (realSpent < expected) by returning surplus to capa", () => {
    const bot = new SimpleBotEngine({});
    bot.portfolio["XRP_4h_EMA"] = { pair: "XRPUSDC", capa: 2, invest: 18*K, qty: 30, entryPrice: 0.6, stop: 0.58, target: 0.64, openTs: Date.now(), status: "pending" };
    bot.capa1Cash = CAPA1_CAP;
    bot.capa2Cash = CAPA2_CAP - 18*K;

    // Real: slippage favorable -0.10
    const realSpent = 18*K - 0.10*K;
    bot.applyRealBuyFill("XRP_4h_EMA", { realSpent, realQty: 29.833 });

    assert.equal(bot.portfolio["XRP_4h_EMA"].status, "filled");
    assert.ok(Math.abs(bot.capa2Cash - (CAPA2_CAP - 18*K + 0.10*K)) < 1e-9,
      "capa2Cash must regain surplus");
    assert.equal(bot.capa1Cash, CAPA1_CAP, "capa1 untouched");
  });

  it("no-op safely when strategyId not in portfolio", () => {
    const bot = new SimpleBotEngine({});
    const before1 = bot.capa1Cash, before2 = bot.capa2Cash;
    bot.applyRealBuyFill("GHOST", { realSpent: 20*K, realQty: 0.2 });
    assert.equal(bot.capa1Cash, before1);
    assert.equal(bot.capa2Cash, before2);
  });

  // M2: applyRealBuyFill recomputes entryPrice/stop/target with real price
  it("M2: recomputes entryPrice/stop/target with real price preserving original %", () => {
    const bot = new SimpleBotEngine({});
    // Posición con entry=100, stop=99 (-1%), target=102 (+2%)
    bot.portfolio["BNB_1h_RSI"] = {
      pair: "BNBUSDC", capa: 1, invest: 20*K, qty: 0.2,
      entryPrice: 100, stop: 99, target: 102,
      openTs: Date.now(), status: "pending"
    };
    bot.capa1Cash = CAPA1_CAP - 20*K;
    bot.capa2Cash = CAPA2_CAP;

    // Fill real: precio ejecutado = 101 (1% slippage adverso en BUY)
    // realSpent=20*K, realQty = 20*K / 101
    const realPrice = 101;
    const realSpent = 20*K;
    const realQty = realSpent / realPrice;
    bot.applyRealBuyFill("BNB_1h_RSI", { realSpent, realQty });

    const pos = bot.portfolio["BNB_1h_RSI"];
    assert.equal(pos.status, "filled");
    // entryPrice debe ser el real, no el esperado
    assert.ok(Math.abs(pos.entryPrice - realPrice) < 1e-9,
      `entryPrice should be real=${realPrice}, got ${pos.entryPrice}`);
    // stop% original = -1% → nuevo stop = 101 * 0.99 = 99.99
    assert.ok(Math.abs(pos.stop - realPrice * 0.99) < 1e-9,
      `stop should preserve -1% from real price: ${realPrice*0.99}, got ${pos.stop}`);
    // target% original = +2% → nuevo target = 101 * 1.02 = 103.02
    assert.ok(Math.abs(pos.target - realPrice * 1.02) < 1e-9,
      `target should preserve +2% from real price: ${realPrice*1.02}, got ${pos.target}`);
  });
});

// ── FIX-D: SELL slippage reconciliation via applyRealSellFill ───────────────
describe("FIX-D: applyRealSellFill reconciles SELL slippage to correct capa", () => {
  it("delta = realNet - expectedNet → credited to ctx.capa", () => {
    const bot = new SimpleBotEngine({});
    // Escenario: SELL Capa1 con expectedNet virtual pre-acreditado,
    // real gross = 20.20 * K (slippage favorable +1%).
    bot.capa1Cash = 50*K; // estado post SELL virtual
    bot.capa2Cash = 30*K;
    const expectedNet = 19.98*K;
    const realGross = 20.20*K;
    const realNet = realGross * (1-FEE);
    const delta = realNet - expectedNet;

    bot.applyRealSellFill("BNB_1h_RSI", { realGross, capa: 1, expectedNet });

    assert.ok(Math.abs(bot.capa1Cash - (50*K + delta)) < 1e-9,
      `capa1Cash expected ${(50*K+delta).toFixed(4)}, got ${bot.capa1Cash.toFixed(4)}`);
    assert.ok(Math.abs(bot.capa2Cash - 30*K) < 1e-9, "capa2 untouched");
  });

  it("negative slippage (real < expected) debits the capa correctly", () => {
    const bot = new SimpleBotEngine({});
    bot.capa1Cash = 40*K;
    bot.capa2Cash = 55*K;
    // Capa 2 SELL: expected gross 50*K * 0.999; real gross 49.50*K
    const expectedNet = 49.95*K;
    const realGross = 49.50*K;
    const realNet = realGross * (1-FEE);
    const delta = realNet - expectedNet; // negative

    bot.applyRealSellFill("XRP_4h_EMA", { realGross, capa: 2, expectedNet });

    assert.ok(Math.abs(bot.capa2Cash - (55*K + delta)) < 1e-9,
      `capa2Cash expected ${(55*K+delta).toFixed(4)}, got ${bot.capa2Cash.toFixed(4)}`);
    assert.ok(Math.abs(bot.capa1Cash - 40*K) < 1e-9, "capa1 untouched");
    assert.ok(delta < 0, "sanity: this scenario requires negative delta");
  });

  it("_onSell callback receives capa in ctx BEFORE portfolio delete", () => {
    const bot = new SimpleBotEngine({});
    // Posición Capa2 que va a cerrar por TARGET
    bot.portfolio["BNB_1d_T200"] = {
      pair: "BNBUSDC", capa: 2, type: "TREND_200", tf: "1d",
      entryPrice: 100, qty: 0.5, stop: 97, target: 106,
      openTs: Date.now(), invest: 50*K, status: "filled",
    };
    bot.capa2Cash = 0;
    bot.prices["BNBUSDC"] = 106.5; // hit target

    let captured = null;
    bot._onSell = (pair, qty, ctx) => {
      // Portfolio ya está borrado en este punto, pero ctx debe preservar todo
      captured = { pair, qty, ctx, stillInPortfolio: !!bot.portfolio["BNB_1d_T200"] };
    };

    bot.evaluate();

    assert.ok(captured, "_onSell must fire on SELL trigger");
    assert.equal(captured.pair, "BNBUSDC");
    assert.equal(captured.ctx.strategyId, "BNB_1d_T200");
    assert.equal(captured.ctx.capa, 2, "ctx.capa must be preserved (FIX-D contract)");
    assert.ok(typeof captured.ctx.expectedNet === "number", "ctx.expectedNet present");
    assert.ok(typeof captured.ctx.expectedGross === "number", "ctx.expectedGross present");
    assert.equal(captured.ctx.reason, "TARGET");
    assert.equal(captured.stillInPortfolio, false,
      "Portfolio MUST be deleted before callback fires (contract: callback is post-mutation)");
  });

  it("roundtrip: SELL virtual credit + applyRealSellFill = real final balance", () => {
    // Simula el flujo completo: evaluate() acredita expectedNet a capa,
    // luego placeLiveSell→applyRealSellFill ajusta por slippage real.
    const bot = new SimpleBotEngine({});
    bot.portfolio["SOL_4h_EMA"] = {
      pair: "SOLUSDC", capa: 2, type: "EMA_CROSS", tf: "4h",
      entryPrice: 100, qty: 0.5, stop: 97, target: 106,
      openTs: Date.now(), invest: 50*K, status: "filled",
    };
    const capa2Before = 30*K;
    bot.capa2Cash = capa2Before;
    bot.prices["SOLUSDC"] = 106.5;

    let sellCtx = null;
    bot._onSell = (_p, _q, ctx) => { sellCtx = ctx; };
    bot.evaluate(); // trigger TARGET → credits expectedNet

    const capa2AfterVirtual = bot.capa2Cash;
    // Virtual should equal pre + (qty * price * (1-FEE))
    const virtualGross = 0.5 * 106.5;
    const virtualNet = virtualGross * (1-FEE);
    assert.ok(Math.abs(capa2AfterVirtual - (capa2Before + virtualNet)) < 1e-9,
      "evaluate() virtual credit must match expectedNet");

    // Now Binance fill came back with -0.5% slippage
    const realGross = virtualGross * 0.995;
    bot.applyRealSellFill(sellCtx.strategyId, {
      realGross, capa: sellCtx.capa, expectedNet: sellCtx.expectedNet,
    });

    const realNet = realGross * (1-FEE);
    const expected = capa2Before + realNet;
    assert.ok(Math.abs(bot.capa2Cash - expected) < 1e-9,
      `roundtrip: expected capa2Cash=${expected.toFixed(4)}, got ${bot.capa2Cash.toFixed(4)}`);
  });
});

// ── FIX-B: Sizing uses min(totalValue, INITIAL_CAPITAL) ─────────────────────
describe("FIX-B: sizing base is min(tv, INITIAL_CAPITAL)", () => {
  it("blocks mark-to-market inflation: tv inflated, sizingBase=INITIAL_CAPITAL", () => {
    const bot = new SimpleBotEngine({});
    bot._capitalSyncPausedUntil = 0; // H7: bypass fail-closed boot default.
    // Inflate an existing position: entry 100, qty 1.0, current price 200 → mark-to-market = 200
    bot.portfolio["INFLATED"] = {
      pair: "BNBUSDC", capa: 1, invest: 20*K, qty: 1.0,
      entryPrice: 100, stop: 99, target: 101, openTs: Date.now()
    };
    bot.capa1Cash = 40*K;
    bot.capa2Cash = 40*K;
    bot.prices["BNBUSDC"] = 200;
    const inflatedTV = 40*K + 40*K + 200; // cash + qty*price
    assert.ok(Math.abs(bot.totalValue() - inflatedTV) < 1e-9,
      "tv should reflect mark-to-market inflation");

    // Now trigger BUY for BTC_30m_RSI (different pair so correlation doesn't block)
    bot._candles["BTCUSDC_30m"] = buyCandlesRSI();
    bot.prices["BTCUSDC"] = 95.5;
    const cfg = STRATEGIES.find(s => s.id === "BTC_30m_RSI");
    bot._onCandleClose(cfg, "BTCUSDC_30m");

    const pos = bot.portfolio["BTC_30m_RSI"];
    if (pos) {
      // With FIX-B: invest ≤ INITIAL_CAPITAL * 0.30
      // Without FIX-B (bug): invest could be up to inflatedTV * 0.30 (much larger)
      const sizingCap = INITIAL_CAPITAL * 0.30;
      assert.ok(pos.invest <= sizingCap + 0.01,
        `FIX-B: invest=$${pos.invest} must be ≤ $${sizingCap.toFixed(2)} (30% of sizingBase=INITIAL_CAPITAL, NOT 30% of inflated tv=$${inflatedTV.toFixed(2)})`);
    }
  });

  it("sizingBase = INITIAL_CAPITAL when tv > INITIAL_CAPITAL (mark-to-market up)", () => {
    const tv = INITIAL_CAPITAL * 1.5;
    const sizingBase = Math.min(tv, INITIAL_CAPITAL);
    assert.equal(sizingBase, INITIAL_CAPITAL);
  });

  it("sizingBase = tv when tv < INITIAL_CAPITAL (drawdown)", () => {
    const tv = INITIAL_CAPITAL * 0.85;
    const sizingBase = Math.min(tv, INITIAL_CAPITAL);
    assert.equal(sizingBase, tv, "In drawdown, use actual tv (not INITIAL_CAPITAL)");
  });
});

// ── M7: Cumulative drift across many BUY/SELL cycles ────────────────────────
// Propósito: garantizar que applyRealBuyFill/applyRealSellFill NO introducen
// error contable más allá de la física esperada (fees + slippage). Un bug de
// reconciliation (doble-débito, capa errónea, delta invertido) se manifestaría
// como drift del orden de $invest * cycles, no céntimos.
describe("M7: accumulated drift over 100 BUY/SELL cycles stays bounded", () => {
  it("no-slippage cycles: drift matches fee-only model within floating-point tolerance", () => {
    // Escenario sin slippage — aísla la corrección de reconciliation.
    // Cada ciclo BUY+SELL al mismo precio paga 2×FEE → drag determinista.
    const bot = new SimpleBotEngine({});
    const tvBefore = bot.totalValue();
    const invest = 10*K;
    const entryPrice = 100;
    const cycles = 100;

    for (let i = 0; i < cycles; i++) {
      // Reserve (FIX-A atomicity)
      const qty = invest * (1 - FEE) / entryPrice;
      bot.portfolio["CYC"] = {
        pair: "BNBUSDC", capa: 1, type: "RSI_MR_ADX", tf: "1h",
        entryPrice, qty, invest,
        stop: entryPrice * 0.992, target: entryPrice * 1.016,
        openTs: Date.now(), status: "pending"
      };
      bot.capa1Cash -= invest;

      // BUY reconcile con precio exacto (no slippage)
      bot.applyRealBuyFill("CYC", { realSpent: invest, realQty: qty });

      // SELL virtual credit + real reconcile (ambos a entryPrice exacto)
      const pos = bot.portfolio["CYC"];
      const expectedGross = pos.qty * entryPrice;
      const expectedNet = expectedGross * (1 - FEE);
      bot.capa1Cash += expectedNet;
      delete bot.portfolio["CYC"];
      bot.applyRealSellFill("CYC", { realGross: expectedGross, capa: 1, expectedNet });
    }

    // Física esperada: cada ciclo pierde invest*(1 - (1-FEE)^2) por fees round-trip
    const perCycleDrag = invest * (1 - Math.pow(1 - FEE, 2));
    const expectedDrag = perCycleDrag * cycles;
    const tvAfter = bot.totalValue();
    const actualDrag = tvBefore - tvAfter;
    const reconciliationError = Math.abs(actualDrag - expectedDrag);

    // Si reconciliation funciona: error ~ floating-point residual (1e-9 range)
    // Un bug contable real (capa equivocada, doble-débito) mostraría error >> $0.01
    assert.ok(reconciliationError < 0.01,
      `Reconciliation drift beyond physics: expected drag=${expectedDrag.toFixed(6)}, actual drag=${actualDrag.toFixed(6)}, error=${reconciliationError.toFixed(6)}`);
    // Sanity: portfolio limpio
    assert.equal(Object.keys(bot.portfolio).length, 0,
      "Portfolio should be empty after 100 full BUY/SELL cycles");
  });

  it("random symmetric slippage: drift stays within physics-derived tolerance", () => {
    // Con slippage simétrico [-0.3%, +0.3%], el drift debe ser aproximadamente
    // el drag de fees (determinista) más ruido de variance (~sqrt(N)).
    const bot = new SimpleBotEngine({});
    const tvBefore = bot.totalValue();
    const invest = 10*K;
    const entryPrice = 100;
    const cycles = 100;

    // PRNG determinista (Mulberry32) para reproducibilidad
    let seed = 0xdeadbeef;
    const rand = () => {
      seed = (seed + 0x6D2B79F5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const slip = () => (rand() - 0.5) * 0.006; // ±0.3%

    for (let i = 0; i < cycles; i++) {
      const qty_est = invest * (1 - FEE) / entryPrice;
      bot.portfolio["CYC"] = {
        pair: "BNBUSDC", capa: 1, type: "RSI_MR_ADX", tf: "1h",
        entryPrice, qty: qty_est, invest,
        stop: entryPrice * 0.992, target: entryPrice * 1.016,
        openTs: Date.now(), status: "pending"
      };
      bot.capa1Cash -= invest;

      // BUY real con slippage en el precio; quoteOrderQty = invest fijo
      const realBuyPrice = entryPrice * (1 + slip());
      const realQty = invest * (1 - FEE) / realBuyPrice;
      bot.applyRealBuyFill("CYC", { realSpent: invest, realQty });

      // SELL virtual a exitPrice con slippage; real = exitPrice exacto
      const pos = bot.portfolio["CYC"];
      const exitPrice = entryPrice * (1 + slip());
      const expectedGross = pos.qty * exitPrice;
      const expectedNet = expectedGross * (1 - FEE);
      bot.capa1Cash += expectedNet;
      delete bot.portfolio["CYC"];
      bot.applyRealSellFill("CYC", { realGross: expectedGross, capa: 1, expectedNet });
    }

    const tvAfter = bot.totalValue();
    const drift = Math.abs(tvAfter - tvBefore);

    // Física: fee drag determinista + variance de slippage simétrico.
    // Cota superior generosa: 2 * invest * cycles * (FEE + maxSlip)
    //   = 2 * 10 * 100 * (0.001 + 0.003) * K = 8 * K
    const upperBound = 8 * K;
    assert.ok(drift < upperBound,
      `After 100 cycles drift=${drift.toFixed(4)} must be < physics upper bound ${upperBound.toFixed(4)}`);
    assert.equal(Object.keys(bot.portfolio).length, 0);
  });

  it("capa isolation: drift in capa1 doesn't leak into capa2", () => {
    // Si un bug de reconciliation asignara delta a la capa equivocada,
    // capa2 cambiaría aunque solo tradeamos en capa1. Este test lo caza.
    const bot = new SimpleBotEngine({});
    const capa2Before = bot.capa2Cash;
    const invest = 10*K;
    const entryPrice = 100;

    for (let i = 0; i < 50; i++) {
      const qty = invest * (1 - FEE) / entryPrice;
      bot.portfolio["CAPA1_ONLY"] = {
        pair: "BNBUSDC", capa: 1, type: "RSI_MR_ADX", tf: "1h",
        entryPrice, qty, invest,
        stop: entryPrice * 0.992, target: entryPrice * 1.016,
        openTs: Date.now(), status: "pending"
      };
      bot.capa1Cash -= invest;

      const realBuyPrice = entryPrice * 1.002; // adverse
      const realQty = invest * (1 - FEE) / realBuyPrice;
      bot.applyRealBuyFill("CAPA1_ONLY", { realSpent: invest, realQty });

      const pos = bot.portfolio["CAPA1_ONLY"];
      const expectedGross = pos.qty * entryPrice;
      const expectedNet = expectedGross * (1 - FEE);
      bot.capa1Cash += expectedNet;
      delete bot.portfolio["CAPA1_ONLY"];
      const realGross = pos.qty * (entryPrice * 0.998); // adverse
      bot.applyRealSellFill("CAPA1_ONLY", { realGross, capa: 1, expectedNet });
    }

    // Capa2 NUNCA debe cambiar (floating-point puro)
    assert.ok(Math.abs(bot.capa2Cash - capa2Before) < 1e-9,
      `Capa isolation broken: capa2Cash ${capa2Before} → ${bot.capa2Cash}`);
  });
});

// ── M8: placeLiveBuy legacy-call guard ──────────────────────────────────────
// placeLiveBuy vive en server.js y requiere LIVE_MODE + side effects, así que
// replicamos su guard aquí en aislamiento. El contrato es: si !ctx?.strategyId
// la llamada retorna sin side-effects (early return antes del cap check).
function simulatePlaceLiveBuyWithGuard(bot, symbol, usdtAmount, ctx, cap) {
  // FIX-M8 guard — debe ser la PRIMERA validación tras LIVE_MODE check
  if (!ctx?.strategyId) {
    return { rejected: true, reason: "LEGACY_CALL_NO_CTX" };
  }
  // El resto replica FIX-C (simulatePlaceLiveBuyCapGuard pero desde cero)
  const committed = Object.entries(bot.portfolio)
    .filter(([id]) => id !== ctx.strategyId)
    .reduce((s, [,p]) => s + (p.invest || 0), 0);
  if (committed + usdtAmount > cap) {
    if (ctx.strategyId && bot.portfolio[ctx.strategyId]) {
      const pos = bot.portfolio[ctx.strategyId];
      if (pos.status === "pending") {
        if (pos.capa === 1) bot.capa1Cash += pos.invest;
        else                bot.capa2Cash += pos.invest;
        delete bot.portfolio[ctx.strategyId];
      }
    }
    return { rejected: true, reason: "CAP_EXCEEDED" };
  }
  return { rejected: false };
}

describe("M8: placeLiveBuy rejects legacy calls without ctx.strategyId", () => {
  it("rejects when ctx is undefined — no side effects on portfolio/cash", () => {
    const bot = new SimpleBotEngine({});
    const capa1Before = bot.capa1Cash;
    const capa2Before = bot.capa2Cash;
    const portfolioBefore = { ...bot.portfolio };

    const res = simulatePlaceLiveBuyWithGuard(bot, "BNBUSDC", 20*K, undefined, CAP_LIMIT);

    assert.equal(res.rejected, true);
    assert.equal(res.reason, "LEGACY_CALL_NO_CTX");
    assert.equal(bot.capa1Cash, capa1Before, "capa1Cash must be unchanged");
    assert.equal(bot.capa2Cash, capa2Before, "capa2Cash must be unchanged");
    assert.deepEqual(bot.portfolio, portfolioBefore, "portfolio must be unchanged");
  });

  it("rejects when ctx={} (missing strategyId) — no side effects", () => {
    const bot = new SimpleBotEngine({});
    const res = simulatePlaceLiveBuyWithGuard(bot, "BNBUSDC", 20*K, {}, CAP_LIMIT);
    assert.equal(res.rejected, true);
    assert.equal(res.reason, "LEGACY_CALL_NO_CTX");
  });

  it("rejects when ctx.strategyId is null/empty — no side effects", () => {
    const bot = new SimpleBotEngine({});
    const res1 = simulatePlaceLiveBuyWithGuard(bot, "BNBUSDC", 20*K, { strategyId: null }, CAP_LIMIT);
    const res2 = simulatePlaceLiveBuyWithGuard(bot, "BNBUSDC", 20*K, { strategyId: "" }, CAP_LIMIT);
    assert.equal(res1.rejected, true, "null strategyId → reject");
    assert.equal(res2.rejected, true, "empty strategyId → reject");
  });

  it("accepts normal calls with valid ctx.strategyId", () => {
    const bot = new SimpleBotEngine({});
    bot.portfolio["BNB_1h_RSI"] = { pair: "BNBUSDC", capa: 1, invest: 15*K, qty: 0.15, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "pending" };
    const res = simulatePlaceLiveBuyWithGuard(
      bot, "BNBUSDC", 15*K,
      { strategyId: "BNB_1h_RSI", capa: 1, expectedPrice: 100 },
      CAP_LIMIT
    );
    assert.equal(res.rejected, false, "valid ctx → accept");
  });
});

// ── M9: _cleanupStalePending rolls back stuck pending positions ─────────────
describe("M9: _cleanupStalePending rolls back pending positions after 5min", () => {
  it("rolls back pending positions older than 5 min", () => {
    const bot = new SimpleBotEngine({});
    const capa1Before = bot.capa1Cash; // CAPA1_CAP
    const oldTs = Date.now() - 6 * 60 * 1000; // 6 min atrás
    bot.portfolio["STALE"] = {
      pair: "BNBUSDC", capa: 1, invest: 20*K, qty: 0.2,
      entryPrice: 100, stop: 98, target: 103,
      openTs: oldTs, status: "pending"
    };
    bot.capa1Cash -= 20*K; // post-reserve (FIX-A contract)

    bot._cleanupStalePending();

    assert.ok(!bot.portfolio["STALE"], "Stale pending must be removed");
    assert.ok(Math.abs(bot.capa1Cash - capa1Before) < 1e-9,
      `capa1Cash must be restored: expected ${capa1Before}, got ${bot.capa1Cash}`);
  });

  it("rolls back to correct capa (capa2 scenario)", () => {
    const bot = new SimpleBotEngine({});
    const capa2Before = bot.capa2Cash;
    const oldTs = Date.now() - 10 * 60 * 1000;
    bot.portfolio["STALE2"] = {
      pair: "XRPUSDC", capa: 2, invest: 18*K, qty: 30,
      entryPrice: 0.6, stop: 0.58, target: 0.64,
      openTs: oldTs, status: "pending"
    };
    bot.capa2Cash -= 18*K;

    bot._cleanupStalePending();

    assert.ok(!bot.portfolio["STALE2"]);
    assert.ok(Math.abs(bot.capa2Cash - capa2Before) < 1e-9, "capa2 restored");
    assert.equal(bot.capa1Cash, CAPA1_CAP, "capa1 untouched");
  });

  it("preserves pending positions younger than 5 min", () => {
    const bot = new SimpleBotEngine({});
    const recent = Date.now() - 60 * 1000; // 1 min atrás
    bot.portfolio["FRESH"] = {
      pair: "BNBUSDC", capa: 1, invest: 20*K, qty: 0.2,
      entryPrice: 100, stop: 98, target: 103,
      openTs: recent, status: "pending"
    };
    const capa1AtMoment = bot.capa1Cash;

    bot._cleanupStalePending();

    assert.ok(bot.portfolio["FRESH"], "Fresh pending must be preserved");
    assert.equal(bot.capa1Cash, capa1AtMoment, "capa1Cash unchanged");
  });

  it("doesn't touch filled positions regardless of age", () => {
    const bot = new SimpleBotEngine({});
    const capa1Before = bot.capa1Cash;
    bot.portfolio["OLD_FILLED"] = {
      pair: "BNBUSDC", capa: 1, invest: 20*K, qty: 0.2,
      entryPrice: 100, stop: 98, target: 103,
      openTs: Date.now() - 24 * 60 * 60 * 1000, // 1 día
      status: "filled"
    };

    bot._cleanupStalePending();

    assert.ok(bot.portfolio["OLD_FILLED"], "Filled positions immune to cleanup");
    assert.equal(bot.capa1Cash, capa1Before);
  });

  it("evaluate() calls _cleanupStalePending before processing", () => {
    const bot = new SimpleBotEngine({});
    const oldTs = Date.now() - 6 * 60 * 1000;
    bot.portfolio["STALE"] = {
      pair: "BNBUSDC", capa: 1, invest: 20*K, qty: 0.2,
      entryPrice: 100, stop: 98, target: 103,
      openTs: oldTs, status: "pending"
    };
    const capa1AfterReserve = bot.capa1Cash - 20*K;
    bot.capa1Cash = capa1AfterReserve;

    bot.evaluate();

    assert.ok(!bot.portfolio["STALE"], "evaluate() must invoke cleanup → STALE gone");
    assert.ok(Math.abs(bot.capa1Cash - (capa1AfterReserve + 20*K)) < 1e-9,
      `After cleanup: capa1Cash must be restored to ${capa1AfterReserve + 20*K}, got ${bot.capa1Cash}`);
  });

  it("handles multiple stale positions in one pass", () => {
    const bot = new SimpleBotEngine({});
    const capa1Before = bot.capa1Cash;
    const capa2Before = bot.capa2Cash;
    const oldTs = Date.now() - 6 * 60 * 1000;
    bot.portfolio["STALE_A"] = { pair: "BNBUSDC", capa: 1, invest: 12*K, qty: 0.12, entryPrice: 100, stop: 99, target: 101, openTs: oldTs, status: "pending" };
    bot.portfolio["STALE_B"] = { pair: "SOLUSDC", capa: 1, invest: 10*K, qty: 0.10, entryPrice: 100, stop: 99, target: 101, openTs: oldTs, status: "pending" };
    bot.portfolio["STALE_C"] = { pair: "XRPUSDC", capa: 2, invest: 15*K, qty: 15,   entryPrice: 1,   stop: 0.99, target: 1.01, openTs: oldTs, status: "pending" };
    bot.capa1Cash -= 22*K;
    bot.capa2Cash -= 15*K;

    bot._cleanupStalePending();

    assert.equal(Object.keys(bot.portfolio).length, 0, "All stale positions must be cleaned");
    assert.ok(Math.abs(bot.capa1Cash - capa1Before) < 1e-9, "capa1 fully restored");
    assert.ok(Math.abs(bot.capa2Cash - capa2Before) < 1e-9, "capa2 fully restored");
  });
});
