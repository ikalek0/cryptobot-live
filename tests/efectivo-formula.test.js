// ── Fórmula efectivo en LIVE_MODE (20 abr 2026 — fix definitivo) ──────────
// operationalCap = Math.max(0, declarado + realizedPnl)
// efectivo       = Math.min(real, operationalCap)
// Estos 7 casos borde cubren los escenarios confirmados por user:
// primero normal, segundo ganancia acumulada, tercero pérdida hoy, cuarto
// pérdida extrema, quinto insolvencia (rp < -declarado), sexto deposit
// declarado vía /capital, séptimo withdrawal real en Binance.
"use strict";

process.env.CAPITAL_USDC = "100";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SimpleBotEngine } = require("../src/engine_simple");

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
    throw new Error(`unexpected: ${path}`);
  };
}

async function runSync(eng, realUsdc, { declarado = 100, rp = 0 } = {}) {
  eng._capitalDeclarado = declarado;
  eng.realizedPnl = rp;
  const fake = makeFakeBinance(realUsdc);
  const r = await eng.syncCapitalFromBinance({
    binanceReadOnlyRequest: fake,
    binancePublicRequest: fake,
    liveMode: true,
  });
  return r;
}

describe("Fórmula efectivo — 7 casos borde de operationalCap + min(real, cap)", () => {
  it("CASO 1 normal: declarado=100 rp=0 real=100 → efectivo=100, capa1=60, capa2=40", async () => {
    const eng = new SimpleBotEngine({});
    const r = await runSync(eng, 100, { declarado: 100, rp: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.capitalEfectivo, 100);
    assert.ok(Math.abs(eng.capa1Cash - 60) < 0.01, `capa1=${eng.capa1Cash}`);
    assert.ok(Math.abs(eng.capa2Cash - 40) < 0.01, `capa2=${eng.capa2Cash}`);
  });

  it("CASO 2 ganancia acumulada: rp=+5 real=105 → operationalCap=105, efectivo=105, capa1=63, capa2=42", async () => {
    const eng = new SimpleBotEngine({});
    const r = await runSync(eng, 105, { declarado: 100, rp: 5 });
    assert.equal(r.capitalEfectivo, 105, "ganancia reflejada porque real y rp coinciden");
    assert.ok(Math.abs(eng.capa1Cash - 63) < 0.01, `capa1=${eng.capa1Cash}`);
    assert.ok(Math.abs(eng.capa2Cash - 42) < 0.01, `capa2=${eng.capa2Cash}`);
  });

  it("CASO 3 pérdida hoy: rp=-0.32 real=99.68 → efectivo=99.68, capa1=59.808, capa2=39.872", async () => {
    const eng = new SimpleBotEngine({});
    const r = await runSync(eng, 99.68, { declarado: 100, rp: -0.32 });
    assert.ok(Math.abs(r.capitalEfectivo - 99.68) < 0.001, `efectivo=${r.capitalEfectivo}`);
    assert.ok(Math.abs(eng.capa1Cash - 99.68 * 0.6) < 0.01);
    assert.ok(Math.abs(eng.capa2Cash - 99.68 * 0.4) < 0.01);
  });

  it("CASO 4 pérdida extrema: rp=-80 real=20 → operationalCap=20, efectivo=20, capa1=12, capa2=8", async () => {
    const eng = new SimpleBotEngine({});
    const r = await runSync(eng, 20, { declarado: 100, rp: -80 });
    assert.equal(r.capitalEfectivo, 20);
    assert.ok(Math.abs(eng.capa1Cash - 12) < 0.01);
    assert.ok(Math.abs(eng.capa2Cash - 8) < 0.01);
  });

  it("CASO 5 insolvencia: rp=-150 real=0 → operationalCap=max(0,-50)=0, efectivo=0, capas=0 (no negativas)", async () => {
    const eng = new SimpleBotEngine({});
    const r = await runSync(eng, 0, { declarado: 100, rp: -150 });
    assert.equal(r.capitalEfectivo, 0);
    assert.equal(eng.capa1Cash, 0, "capa1 no puede ser negativa");
    assert.equal(eng.capa2Cash, 0, "capa2 no puede ser negativa");
  });

  it("CASO 6 deposit declarado: user /capital 200, rp preservado=-0.32, real=217.92 → operationalCap=199.68, efectivo=199.68", async () => {
    // Simula flujo completo: user hizo /capital 200 (preservando rp=-0.32),
    // y ahora Binance refleja el deposit: real=217.92 (incluye $17.92 personales).
    const eng = new SimpleBotEngine({});
    const r = await runSync(eng, 217.92, { declarado: 200, rp: -0.32 });
    // operationalCap = max(0, 200 + (-0.32)) = 199.68
    // efectivo = min(217.92, 199.68) = 199.68 → $18.24 personales siguen invisibles
    assert.ok(Math.abs(r.capitalEfectivo - 199.68) < 0.001, `efectivo=${r.capitalEfectivo}`);
    assert.ok(Math.abs(eng.capa1Cash - 199.68 * 0.6) < 0.01);
    assert.ok(Math.abs(eng.capa2Cash - 199.68 * 0.4) < 0.01);
  });

  it("CASO 7 withdrawal real: declarado=100 rp=0 user retira $30 real=70 → efectivo=70 (conservador)", async () => {
    const eng = new SimpleBotEngine({});
    const r = await runSync(eng, 70, { declarado: 100, rp: 0 });
    // operationalCap = 100, efectivo = min(70, 100) = 70 — bot se adapta a
    // la realidad del balance. El user puede /capital 70 para redeclarar si
    // quiere convertir esto en el nuevo baseline, pero no es necesario.
    assert.equal(r.capitalEfectivo, 70);
    assert.ok(Math.abs(eng.capa1Cash - 42) < 0.01);
    assert.ok(Math.abs(eng.capa2Cash - 28) < 0.01);
  });

  it("aislamiento: escenario exacto del user (Binance=$117.92, bot declaró $100, rp=0) → efectivo=$100", async () => {
    // Reproducción literal del caso real del 20 abr 2026 en prod:
    //   - User tiene $117.92 en Binance: $100 operativos + $17.92 personales.
    //   - Bot declarado 100, sin trades realizados.
    //   - ANTES del fix definitivo: efectivo=117.92 → bot reclama los $17.92 personales (bug catastrófico).
    //   - Ahora: efectivo=100, $17.92 quedan intactos.
    const eng = new SimpleBotEngine({});
    const r = await runSync(eng, 117.92, { declarado: 100, rp: 0 });
    assert.equal(r.capitalEfectivo, 100, "fondos personales aislados");
    assert.ok(Math.abs(eng.capa1Cash - 60) < 0.01);
    assert.ok(Math.abs(eng.capa2Cash - 40) < 0.01);
  });
});
