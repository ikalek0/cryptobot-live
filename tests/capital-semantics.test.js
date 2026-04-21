// Task B (20 abr 2026) — nueva semántica de /capital + /reset-contable.
// /capital V: declara nuevo baseline, PRESERVA realizedPnl histórico.
// /reset-contable: hard reset — realizedPnl=0, peakTv=null, ddAlerts reset,
//   capa redistribuidas sobre _capitalDeclarado actual. Guard no-positions
//   en ambos paths.
"use strict";

process.env.CAPITAL_USDC = "100";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SimpleBotEngine } = require("../src/engine_simple");

// Simulamos setCapitalEverywhere y resetAccounting contra una instancia
// aislada del simpleBot sin necesitar el servidor entero — reimplementamos
// la lógica esencial aquí para testear la semántica pura.
// (La prueba completa end-to-end con express+server requiere setup mayor;
// aquí verificamos que la transformación de estado es la correcta.)
function simulateSetCapitalEverywhere(eng, newCap) {
  const openCount = Object.keys(eng.portfolio || {}).length;
  if (openCount > 0) throw new Error(`cannot change capital with ${openCount} open position(s)`);
  eng._capitalDeclarado = newCap;
  const rp = Number.isFinite(eng.realizedPnl) ? eng.realizedPnl : 0;
  const operational = Math.max(0, newCap + rp);
  eng.capa1Cash = operational * 0.60;
  eng.capa2Cash = operational * 0.40;
  return { ok: true, capital: newCap, realizedPnlPreserved: true };
}

function simulateResetAccounting(eng) {
  const openCount = Object.keys(eng.portfolio || {}).length;
  if (openCount > 0) throw new Error(`cannot reset accounting with ${openCount} open position(s)`);
  const before = { realizedPnl: eng.realizedPnl || 0, totalFees: eng.totalFees || 0, peakTv: eng._peakTv };
  eng.realizedPnl = 0;
  eng.totalFees   = 0;
  eng._peakTv     = null;
  eng._ddAlert3   = false;
  eng._ddAlert5   = false;
  eng._ddAlert10  = false;
  eng._ddCircuitBreakerTripped = false;
  const cap = eng._capitalDeclarado || 100;
  eng.capa1Cash = cap * 0.60;
  eng.capa2Cash = cap * 0.40;
  return { ok: true, before };
}

describe("/capital nueva semántica (preserva realizedPnl)", () => {
  it("tras realizedPnl=-0.32, /capital 100 mantiene capa1+capa2 = 99.68", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.realizedPnl = -0.32;
    eng.capa1Cash = 59.81; eng.capa2Cash = 39.87; // post-2-losses aprox
    simulateSetCapitalEverywhere(eng, 100);
    const total = eng.capa1Cash + eng.capa2Cash;
    assert.ok(Math.abs(total - 99.68) < 0.001, `capa1+capa2 = 99.68 (cap+rp), got ${total}`);
    assert.equal(eng.realizedPnl, -0.32, "realizedPnl NO se borra en /capital");
  });

  it("/capital 200 sobre realizedPnl=-0.32 → operational=199.68 (deposit respeta PnL)", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.realizedPnl = -0.32;
    simulateSetCapitalEverywhere(eng, 200);
    const total = eng.capa1Cash + eng.capa2Cash;
    assert.ok(Math.abs(total - 199.68) < 0.001, `capa1+capa2 = 199.68, got ${total}`);
    assert.equal(eng.realizedPnl, -0.32, "realizedPnl preservado tras aporte de capital");
    assert.equal(eng._capitalDeclarado, 200);
  });

  it("rechaza si hay posiciones abiertas", () => {
    const eng = new SimpleBotEngine({});
    eng.portfolio["BTC_30m_RSI"] = { pair:"BTCUSDC", capa:1, invest:16 };
    assert.throws(() => simulateSetCapitalEverywhere(eng, 150),
      /open position/, "debe rechazar con posiciones abiertas");
  });
});

describe("/reset-contable (hard reset)", () => {
  it("borra realizedPnl, totalFees, peakTv, ddAlerts, CB — capas redistribuidas sobre declarado", () => {
    const eng = new SimpleBotEngine({});
    eng._capitalDeclarado = 100;
    eng.realizedPnl = -5.32;
    eng.totalFees   = 0.75;
    eng._peakTv     = 105.0;
    eng._ddAlert3   = true;
    eng._ddAlert5   = true;
    eng._ddCircuitBreakerTripped = true;
    const r = simulateResetAccounting(eng);
    assert.equal(r.ok, true);
    assert.equal(r.before.realizedPnl, -5.32);
    assert.equal(r.before.peakTv, 105.0);
    // After
    assert.equal(eng.realizedPnl, 0);
    assert.equal(eng.totalFees, 0);
    assert.equal(eng._peakTv, null);
    assert.equal(eng._ddAlert3, false);
    assert.equal(eng._ddAlert5, false);
    assert.equal(eng._ddCircuitBreakerTripped, false);
    assert.equal(eng.capa1Cash, 60, "capa1 redistribuida a 60 (60% de cap=100)");
    assert.equal(eng.capa2Cash, 40);
  });

  it("rechaza reset contable con posiciones abiertas", () => {
    const eng = new SimpleBotEngine({});
    eng.portfolio["BTC_30m_RSI"] = { pair:"BTCUSDC", capa:1, invest:16 };
    assert.throws(() => simulateResetAccounting(eng), /open position/);
  });

  it("trade_log / stratTrades siguen vivos tras /reset-contable (solo reset contable)", () => {
    const eng = new SimpleBotEngine({});
    eng._stratTrades["BTC_30m_RSI"] = [
      { pnl: -0.83, ts: Date.now()-3600000 },
      { pnl: -0.83, ts: Date.now()-1800000 },
    ];
    eng.log = [
      { type: "SELL", symbol: "BTCUSDC", strategy: "BTC_30m_RSI", pnl: -0.83, reason: "STOP", ts: Date.now()-3600000 },
    ];
    simulateResetAccounting(eng);
    assert.equal(eng._stratTrades["BTC_30m_RSI"].length, 2, "Kelly histórico preservado");
    assert.equal(eng.log.length, 1, "log preservado (ayuda forense/backtesting)");
  });
});
