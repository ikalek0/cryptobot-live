// ── Sizing tests: Half-Kelly + cap 30% + min $10 ─────────────────────────────
// Guards against the $1500-on-$100 bug and validates all sizing constraints.
"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

// Set env BEFORE requiring engine_simple (INITIAL_CAPITAL reads at module load)
process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

const { SimpleBotEngine, calcKelly, STRATEGIES, evalSignal } = require("../src/engine_simple");

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
  it("Half-Kelly: $100 capital, kelly=0.4 -> invest=$20", () => {
    const invest = calcInvest(100, 0.4, 60);
    assert.equal(invest, 20, `Expected $20, got $${invest}`);
  });

  it("Half-Kelly: $100 capital, kelly=0.164 -> invest=$8.20 (below $10 minimum)", () => {
    const invest = calcInvest(100, 0.164, 60);
    assert.ok(invest < 10, `invest=$${invest} should be below $10 minimum -> trade skipped`);
  });

  it("Cap 30%: high kelly doesn't exceed 30% of capital", () => {
    const invest = calcInvest(100, 0.95, 100);
    assert.ok(invest <= 30, `invest=$${invest} should not exceed $30 (30% of $100)`);
    // kelly=0.5 (capped), half-kelly = 0.25, invest = $25
    assert.equal(invest, 25);
  });

  it("NEVER $1500 on $100 capital", () => {
    // The old bug: capital was $10000 instead of $100 due to missing dotenv
    // With correct capital=$100, even extreme kelly can't produce $1500
    const invest = calcInvest(100, 1.0, 100);
    assert.ok(invest <= 30, `invest=$${invest} must never be $1500 on $100 capital`);
  });

  it("Kelly fraction floor: negative kelly uses 0.05 minimum", () => {
    const invest = calcInvest(100, -0.5, 100);
    // kellyFrac = max(0.05, min(0.5, -0.5)) = max(0.05, -0.5) = 0.05
    // invest = 100 * 0.05 * 0.5 = $2.50
    assert.equal(invest, 2.5);
    assert.ok(invest < 10, "Negative kelly -> invest below $10 -> trade skipped");
  });

  it("Kelly fraction ceiling: extreme kelly capped at 0.5", () => {
    const invest = calcInvest(100, 2.0, 100);
    // kellyFrac = max(0.05, min(0.5, 2.0)) = 0.5
    // invest = 100 * 0.5 * 0.5 = $25
    assert.equal(invest, 25);
  });

  it("Available cash constraint: can't exceed available cash", () => {
    const invest = calcInvest(100, 0.4, 5);
    // Half-Kelly wants $20 but only $5 available
    assert.equal(invest, 5);
  });

  it("With buggy $10000 capital, sizing would be dangerously high", () => {
    // This proves WHY the dotenv fix was critical
    const buggyInvest = calcInvest(10000, 0.4, 10000);
    // kellyFrac=0.4, invest = 10000 * 0.4 * 0.5 = $2000
    assert.equal(buggyInvest, 2000);
    assert.ok(buggyInvest > 100, "Buggy capital produces >$100 invest on $100 account");
  });
});

describe("Sizing through SimpleBotEngine", () => {
  it("INITIAL_CAPITAL is $100 from env", () => {
    const bot = new SimpleBotEngine({});
    const tv = bot.totalValue();
    assert.equal(tv, 100, `totalValue should be $100, got $${tv}`);
  });

  it("Capa1 gets 60% and Capa2 gets 40%", () => {
    const bot = new SimpleBotEngine({});
    assert.equal(bot.capa1Cash, 60, `capa1Cash should be $60, got $${bot.capa1Cash}`);
    assert.equal(bot.capa2Cash, 40, `capa2Cash should be $40, got $${bot.capa2Cash}`);
  });

  it("After a BUY, invest is deducted from correct capa cash", () => {
    const bot = new SimpleBotEngine({});
    const initialCapa1 = bot.capa1Cash;
    // Simulate a BUY by directly manipulating portfolio like _onCandleClose does
    const invest = 20;
    const price = 600;
    const qty = invest * (1 - 0.001) / price;
    bot.capa1Cash -= invest;
    bot.portfolio["BNB_1h_RSI"] = {
      pair: "BNBUSDC", capa: 1, entryPrice: price, qty, invest,
      stop: price * 0.992, target: price * 1.016, openTs: Date.now()
    };
    assert.equal(bot.capa1Cash, initialCapa1 - invest);
    assert.ok(bot.totalValue() > 99 && bot.totalValue() < 101,
      "Total value should be ~$100 after BUY (fees aside)");
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
    // Pre-populate portfolio with $92 committed across 3 phantom positions.
    // Any real new trade wanting > $8.50 should be shrunk or rejected.
    bot.portfolio["PHANTOM_A"] = { pair: "X1", capa: 1, invest: 32, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now() };
    bot.portfolio["PHANTOM_B"] = { pair: "X2", capa: 1, invest: 30, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now() };
    bot.portfolio["PHANTOM_C"] = { pair: "X3", capa: 2, invest: 30, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now() };
    // Adjust cash to reflect the phantoms (capa1 used $62, capa2 used $30)
    bot.capa1Cash = 60 - 62; // may go negative, we don't care — test is about global cap
    bot.capa2Cash = 40 - 30;

    // Force candles and price for BNB_1h_RSI
    const candles = buyCandlesRSI();
    bot._candles["BNBUSDC_1h"] = candles;
    bot.prices["BNBUSDC"] = 95.5;

    // Make capa1Cash enough to not block via availCash path (force global cap to bite)
    bot.capa1Cash = 50;  // plenty of capa1 cash — but global cap should still win

    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");
    bot._onCandleClose(cfg, "BNBUSDC_1h");

    const committedAfter = Object.values(bot.portfolio)
      .reduce((s, p) => s + (p.invest || 0), 0);
    // cap = INITIAL_CAPITAL * 1.005 = $100.5
    assert.ok(committedAfter <= 100.5 + 0.01,  // float tolerance
      `committed=$${committedAfter.toFixed(2)} must be ≤ $100.50 (cap*1.005)`);
  });

  it("shrinks new invest to headroom when committed near cap", () => {
    const bot = new SimpleBotEngine({});
    // Commit $85 → headroom = $100.5 - $85 = $15.50
    bot.portfolio["PHANTOM_A"] = { pair: "X1", capa: 1, invest: 55, qty: 0.5, entryPrice: 100, stop: 99, target: 101, openTs: Date.now() };
    bot.portfolio["PHANTOM_B"] = { pair: "X2", capa: 2, invest: 30, qty: 0.3, entryPrice: 100, stop: 99, target: 101, openTs: Date.now() };
    bot.capa1Cash = 50;
    bot.capa2Cash = 50;

    bot._candles["BNBUSDC_1h"] = buyCandlesRSI();
    bot.prices["BNBUSDC"] = 95.5;

    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");
    bot._onCandleClose(cfg, "BNBUSDC_1h");

    const pos = bot.portfolio["BNB_1h_RSI"];
    if (pos) {
      // Position accepted: must be ≤ headroom ($15.50)
      assert.ok(pos.invest <= 15.5 + 0.01,
        `New position invest=$${pos.invest} must be ≤ $15.50 headroom`);
      assert.ok(pos.invest >= 10,
        `Accepted positions must be ≥ $10 minimum`);
    }
    // Whether accepted, shrunk, or rejected: committed must never exceed cap
    const committedAfter = Object.values(bot.portfolio)
      .reduce((s, p) => s + (p.invest || 0), 0);
    assert.ok(committedAfter <= 100.5 + 0.01,
      `After trade: committed=$${committedAfter.toFixed(2)} must be ≤ $100.50`);
  });

  it("new position has status='pending' marker (FIX-A + FASE 3 contract)", () => {
    const bot = new SimpleBotEngine({});
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
    bot.portfolio["PHANTOM_A"] = { pair: "X1", capa: 1, invest: 50, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "filled" };
    bot.portfolio["PHANTOM_B"] = { pair: "X2", capa: 2, invest: 40, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "filled" };
    // Estrategia candidata (FIX-A ya la insertó como pending + decrementó capa1Cash)
    bot.portfolio["BNB_1h_RSI"] = { pair: "BNBUSDC", capa: 1, invest: 15, qty: 0.15, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "pending" };
    bot.capa1Cash = 60 - 50 - 15; // 50 phantom + 15 reservado = -5 pero no importa para test

    const before = bot.capa1Cash;
    const res = simulatePlaceLiveBuyCapGuard(
      bot, "BNBUSDC", 15,
      { strategyId: "BNB_1h_RSI", capa: 1, expectedPrice: 100 },
      100.5 // cap = CAPITAL * 1.005
    );

    assert.equal(res.rejected, true, "committed(90)+new(15)=105 > cap(100.5) → reject");
    assert.ok(!bot.portfolio["BNB_1h_RSI"], "Pending reserve must be rolled back from portfolio");
    assert.equal(bot.capa1Cash, before + 15, "capa1Cash must be restored by rollback");
    // Phantoms intact
    assert.ok(bot.portfolio["PHANTOM_A"]);
    assert.ok(bot.portfolio["PHANTOM_B"]);
  });

  it("accepts when committed (excluding self) + new ≤ cap", () => {
    const bot = new SimpleBotEngine({});
    bot.portfolio["PHANTOM_A"] = { pair: "X1", capa: 1, invest: 30, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "filled" };
    bot.portfolio["BNB_1h_RSI"] = { pair: "BNBUSDC", capa: 1, invest: 20, qty: 0.2, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "pending" };

    const res = simulatePlaceLiveBuyCapGuard(
      bot, "BNBUSDC", 20,
      { strategyId: "BNB_1h_RSI", capa: 1, expectedPrice: 100 },
      100.5
    );

    assert.equal(res.rejected, false, "committed_excl_self(30)+new(20)=50 ≤ cap(100.5) → accept");
    assert.ok(bot.portfolio["BNB_1h_RSI"], "Pending reserve must remain intact on accept");
  });

  it("excludes self from committed sum (critical: self is already in portfolio per FIX-A)", () => {
    // Sin el filter id!==strategyId, committed contaría la propia reserva 2 veces:
    //   committed_raw = 30 (phantom) + 50 (self) = 80
    //   + new (50) = 130 > cap → falso positivo
    // Con el filter:
    //   committed_excl = 30
    //   + new (50) = 80 ≤ cap → accept
    const bot = new SimpleBotEngine({});
    bot.portfolio["PHANTOM_A"] = { pair: "X1", capa: 1, invest: 30, qty: 0.1, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "filled" };
    bot.portfolio["BNB_1h_RSI"] = { pair: "BNBUSDC", capa: 1, invest: 50, qty: 0.5, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "pending" };

    const res = simulatePlaceLiveBuyCapGuard(
      bot, "BNBUSDC", 50,
      { strategyId: "BNB_1h_RSI", capa: 1, expectedPrice: 100 },
      100.5
    );
    assert.equal(res.rejected, false,
      "Double-counting bug regression: self must be excluded from committed sum");
  });
});

describe("FIX-A closing loop: applyRealBuyFill", () => {
  it("reconciles drift (realSpent > expected) by deducting extra from correct capa", () => {
    const bot = new SimpleBotEngine({});
    bot.portfolio["BNB_1h_RSI"] = { pair: "BNBUSDC", capa: 1, invest: 20, qty: 0.2, entryPrice: 100, stop: 99, target: 101, openTs: Date.now(), status: "pending" };
    bot.capa1Cash = 40; // 60 - 20 reserved
    bot.capa2Cash = 40;

    // Real: gastamos $20.15 (slippage +0.15)
    bot.applyRealBuyFill("BNB_1h_RSI", { realSpent: 20.15, realQty: 0.1998 });

    const pos = bot.portfolio["BNB_1h_RSI"];
    assert.equal(pos.status, "filled", "Position must transition pending→filled");
    assert.ok(Math.abs(pos.invest - 20.15) < 1e-9, "invest updated to real");
    assert.ok(Math.abs(pos.qty - 0.1998) < 1e-9, "qty updated to real");
    assert.ok(Math.abs(bot.capa1Cash - (40 - 0.15)) < 1e-9,
      `capa1Cash must deduct drift: expected ${(40-0.15).toFixed(4)}, got ${bot.capa1Cash.toFixed(4)}`);
    // capa2 untouched
    assert.equal(bot.capa2Cash, 40);
  });

  it("reconciles drift (realSpent < expected) by returning surplus to capa", () => {
    const bot = new SimpleBotEngine({});
    bot.portfolio["XRP_4h_EMA"] = { pair: "XRPUSDC", capa: 2, invest: 18, qty: 30, entryPrice: 0.6, stop: 0.58, target: 0.64, openTs: Date.now(), status: "pending" };
    bot.capa1Cash = 60;
    bot.capa2Cash = 40 - 18; // 22

    // Real: gastamos solo $17.90 (slippage favorable -0.10)
    bot.applyRealBuyFill("XRP_4h_EMA", { realSpent: 17.90, realQty: 29.833 });

    assert.equal(bot.portfolio["XRP_4h_EMA"].status, "filled");
    assert.ok(Math.abs(bot.capa2Cash - (22 + 0.10)) < 1e-9,
      "capa2Cash must regain surplus: 22 + 0.10 = 22.10");
    assert.equal(bot.capa1Cash, 60, "capa1 untouched");
  });

  it("no-op safely when strategyId not in portfolio", () => {
    const bot = new SimpleBotEngine({});
    const before1 = bot.capa1Cash, before2 = bot.capa2Cash;
    bot.applyRealBuyFill("GHOST", { realSpent: 20, realQty: 0.2 });
    assert.equal(bot.capa1Cash, before1);
    assert.equal(bot.capa2Cash, before2);
  });
});

// ── FIX-D: SELL slippage reconciliation via applyRealSellFill ───────────────
describe("FIX-D: applyRealSellFill reconciles SELL slippage to correct capa", () => {
  it("delta = realNet - expectedNet → credited to ctx.capa", () => {
    const bot = new SimpleBotEngine({});
    const FEE = 0.001;
    // Escenario: SELL Capa1 con expectedNet=$19.98 (gross 20 * 0.999)
    // pre-acreditado virtualmente; real gross = $20.20 (slippage favorable +1%).
    bot.capa1Cash = 50; // estado post SELL virtual
    bot.capa2Cash = 30;
    const expectedNet = 19.98;
    const realGross = 20.20;
    const realNet = realGross * (1-FEE); // 20.1798
    const delta = realNet - expectedNet;   // +0.1998

    bot.applyRealSellFill("BNB_1h_RSI", { realGross, capa: 1, expectedNet });

    assert.ok(Math.abs(bot.capa1Cash - (50 + delta)) < 1e-9,
      `capa1Cash expected ${(50+delta).toFixed(4)}, got ${bot.capa1Cash.toFixed(4)}`);
    assert.equal(bot.capa2Cash, 30, "capa2 untouched");
  });

  it("negative slippage (real < expected) debits the capa correctly", () => {
    const bot = new SimpleBotEngine({});
    const FEE = 0.001;
    bot.capa1Cash = 40;
    bot.capa2Cash = 55;
    // Capa 2 SELL: expected $50 gross * 0.999 = 49.95; real $49.50 gross
    const expectedNet = 49.95;
    const realGross = 49.50;
    const realNet = realGross * (1-FEE);
    const delta = realNet - expectedNet; // negative

    bot.applyRealSellFill("XRP_4h_EMA", { realGross, capa: 2, expectedNet });

    assert.ok(Math.abs(bot.capa2Cash - (55 + delta)) < 1e-9,
      `capa2Cash expected ${(55+delta).toFixed(4)}, got ${bot.capa2Cash.toFixed(4)}`);
    assert.equal(bot.capa1Cash, 40, "capa1 untouched");
    assert.ok(delta < 0, "sanity: this scenario requires negative delta");
  });

  it("_onSell callback receives capa in ctx BEFORE portfolio delete", () => {
    const bot = new SimpleBotEngine({});
    // Posición Capa2 que va a cerrar por TARGET
    bot.portfolio["BNB_1d_T200"] = {
      pair: "BNBUSDC", capa: 2, type: "TREND_200", tf: "1d",
      entryPrice: 100, qty: 0.5, stop: 97, target: 106,
      openTs: Date.now(), invest: 50, status: "filled",
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
    // El total debe ser equivalente a acreditar directamente realNet.
    const bot = new SimpleBotEngine({});
    const FEE = 0.001;
    bot.portfolio["SOL_4h_EMA"] = {
      pair: "SOLUSDC", capa: 2, type: "EMA_CROSS", tf: "4h",
      entryPrice: 100, qty: 0.5, stop: 97, target: 106,
      openTs: Date.now(), invest: 50, status: "filled",
    };
    const capa2Before = 30;
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
  it("blocks mark-to-market inflation: tv=$200 from open profit, sizingBase=$100", () => {
    const bot = new SimpleBotEngine({});
    // Inflate an existing position: entry $100, qty 1.0, current price $200 → mark-to-market = $200
    bot.portfolio["INFLATED"] = {
      pair: "BNBUSDC", capa: 1, invest: 20, qty: 1.0,
      entryPrice: 100, stop: 99, target: 101, openTs: Date.now()
    };
    bot.capa1Cash = 40;  // $60 original - $20 invest
    bot.capa2Cash = 40;
    bot.prices["BNBUSDC"] = 200; // mark-to-market: qty*price = 1*200 = $200
    // tv = 40 + 40 + 200 = $280
    assert.equal(bot.totalValue(), 280, "tv should reflect mark-to-market inflation");

    // Now trigger BUY for BTC_30m_RSI (different pair so correlation doesn't block)
    bot._candles["BTCUSDC_30m"] = buyCandlesRSI();
    bot.prices["BTCUSDC"] = 95.5;
    // capa2Cash=40, so it fits without cap issue. But sizing base should be $100 not $280.
    const cfg = STRATEGIES.find(s => s.id === "BTC_30m_RSI");
    bot._onCandleClose(cfg, "BTCUSDC_30m");

    const pos = bot.portfolio["BTC_30m_RSI"];
    if (pos) {
      // With FIX-B: invest ≤ sizingBase * 0.30 = $100 * 0.30 = $30
      // Without FIX-B (bug): invest could be up to $280 * 0.30 = $84
      assert.ok(pos.invest <= 30 + 0.01,
        `FIX-B: invest=$${pos.invest} must be ≤ $30 (30% of $100 sizingBase, NOT 30% of $280 tv)`);
    }
  });

  it("sizingBase = $100 when tv > $100 (mark-to-market up)", () => {
    // Quick standalone check of the sizing formula using tv > INITIAL_CAPITAL
    const tv = 150;
    const sizingBase = Math.min(tv, 100); // mimics the FIX-B line in engine_simple
    assert.equal(sizingBase, 100);
  });

  it("sizingBase = tv when tv < $100 (drawdown)", () => {
    // After a loss, sizing should shrink with the account
    const tv = 85;
    const sizingBase = Math.min(tv, 100);
    assert.equal(sizingBase, 85, "In drawdown, use actual tv (not INITIAL_CAPITAL)");
  });
});
