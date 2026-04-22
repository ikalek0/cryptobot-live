// BUG-H (22 abr 2026) — _capitalDeclarado persistido round-trip.
// Smoke test pre-LIVE detectó: /capital N actualizaba capas en memoria pero
// no persistía _capitalDeclarado → syncCapitalFromBinance tras restart caía
// a INITIAL_CAPITAL del .env y reseteaba el cap del usuario silenciosamente.
// Cinco tests: setCapital in-memory + saveState includes, restart gana sobre
// INITIAL_CAPITAL, sync honra declarado persistido, backward compat sin campo,
// edge case _capitalDeclarado===0 no cae a INITIAL_CAPITAL.
"use strict";

process.env.CAPITAL_USDC = "100";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SimpleBotEngine, INITIAL_CAPITAL } = require("../src/engine_simple");

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
    throw new Error(`unexpected path: ${path}`);
  };
}

describe("BUG-H — _capitalDeclarado round-trip", () => {
  it("Test 1: setCapital(20) in-memory → saveState() expone capitalDeclarado=20", () => {
    const bot = new SimpleBotEngine({});
    assert.equal(bot._capitalDeclarado, INITIAL_CAPITAL, "constructor default es INITIAL_CAPITAL");
    // Simular setCapitalEverywhere sin montar server entero:
    // server.js:1312 hace literalmente `S.simpleBot._capitalDeclarado = newCap`.
    bot._capitalDeclarado = 20;
    const saved = bot.saveState();
    assert.equal(saved.capitalDeclarado, 20,
      "saveState() debe serializar capitalDeclarado sin underscore en el JSON");
  });

  it("Test 2: restart con saved.capitalDeclarado=20 gana sobre INITIAL_CAPITAL=100", () => {
    // Simula PM2 restart: new engine con el saved persistido.
    const bot = new SimpleBotEngine({ capitalDeclarado: 20 });
    assert.equal(bot._capitalDeclarado, 20,
      "constructor debe leer saved.capitalDeclarado, no caer a INITIAL_CAPITAL");
    assert.notEqual(bot._capitalDeclarado, INITIAL_CAPITAL,
      "explícitamente NO INITIAL_CAPITAL del .env");
  });

  it("Test 3: syncCapitalFromBinance honra _capitalDeclarado=20 persistido (efectivo=min(real, cap+rp))", async () => {
    const bot = new SimpleBotEngine({ capitalDeclarado: 20 });
    // rp=0 inicial. Binance reporta usdcLibre=150 (personal del user en la
    // misma cuenta spot). Sin el fix, _capitalDeclarado=100 → efectivo=100
    // → capas 60/40 fantasma. Con fix, _capitalDeclarado=20 → operationalCap=20
    // → efectivo=min(150,20)=20 → capas 12/8 (correcto).
    const r = await bot.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(150),
      binancePublicRequest:   makeFakeBinance(150),
      liveMode: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.capitalDeclarado, 20, "declarado persistido visible en response");
    assert.equal(r.capitalEfectivo, 20,
      "efectivo = min(real=150, operationalCap=max(0,20+0)=20) = 20");
    assert.ok(Math.abs(bot.capa1Cash - 12) < 1e-6, `capa1 = 20*0.60 = 12, got ${bot.capa1Cash}`);
    assert.ok(Math.abs(bot.capa2Cash - 8) < 1e-6, `capa2 = 20*0.40 = 8, got ${bot.capa2Cash}`);
  });

  it("Test 4: backward compat — saved sin capitalDeclarado cae a INITIAL_CAPITAL", () => {
    // simple_state.json pre-fix no tiene el campo. Constructor debe degradar
    // a INITIAL_CAPITAL del .env para que un usuario actualizando no rompa.
    const bot = new SimpleBotEngine({}); // saved vacío
    assert.equal(bot._capitalDeclarado, INITIAL_CAPITAL,
      "saved sin capitalDeclarado → fallback a INITIAL_CAPITAL");

    // También cubre el caso de saved explícitamente undefined
    const bot2 = new SimpleBotEngine({ capitalDeclarado: undefined });
    assert.equal(bot2._capitalDeclarado, INITIAL_CAPITAL);
  });

  it("Test 5: edge case _capitalDeclarado===0 no cae a INITIAL_CAPITAL (nullish, no falsy)", async () => {
    // Insolvencia extrema declarada: user hace /capital 0 conceptualmente,
    // o un reset contable deja declarado=0. El `??` debe preservar el 0
    // literal en vez de caer al fallback.
    const bot = new SimpleBotEngine({ capitalDeclarado: 0 });
    assert.equal(bot._capitalDeclarado, 0, "?? preserva 0, || lo habría descartado");

    // _onCandleClose usa capDeclaradoLocal = this._capitalDeclarado ?? INITIAL_CAPITAL.
    // Verificamos el patrón directamente (acceso al mismo snippet lógico):
    const capDeclaradoLocal = bot._capitalDeclarado ?? INITIAL_CAPITAL;
    assert.equal(capDeclaradoLocal, 0, "capDeclaradoLocal respeta 0");

    // syncCapitalFromBinance con declarado=0 y rp=0 → operationalCap=0 →
    // efectivo = min(real, 0) = 0 → capas = 0/0. El bot queda efectivamente
    // pausado operacionalmente (sizing < $10 bloqueará cualquier BUY).
    const r = await bot.syncCapitalFromBinance({
      binanceReadOnlyRequest: makeFakeBinance(50),
      binancePublicRequest:   makeFakeBinance(50),
      liveMode: true,
    });
    assert.equal(r.capitalDeclarado, 0);
    assert.equal(r.capitalEfectivo, 0, "efectivo=min(50, max(0, 0+0))=0, no cae a INITIAL_CAPITAL");
    assert.equal(bot.capa1Cash, 0);
    assert.equal(bot.capa2Cash, 0);
  });
});
