// ── BATCH-1 FIX #3 (bug #10): stops/targets siguen disparando en pausa ──
// Antes de este fix, trading/loop.js saltaba S.simpleBot.evaluate() cuando
// el bot estaba pausado (isPaused() || _pausedByTelegram). Eso tenía dos
// efectos no deseados:
//
//   1) Las posiciones abiertas quedaban atrapadas: un stop-loss a -3% no
//      disparaba porque evaluate() nunca corría. En un crash de mercado
//      esto multiplica las pérdidas — el usuario pausa para "protegerse"
//      y lo único que consigue es dejar de limitar el downside.
//
//   2) _cleanupStalePending (reconciliación de pending stuck) se saltaba,
//      así que una BUY en limbo entre reserva y fill quedaba bloqueando
//      capital hasta el restart.
//
// El contrato correcto: /pausa bloquea NUEVAS entradas (vía _onCandleClose
// pause gate, línea 484). evaluate() — que NO crea posiciones, sólo cierra
// las abiertas por stop/target/time-stop — debe correr siempre.
//
// Estos tests verifican:
//  - bot.paused=true + posición en stop → evaluate() dispara SELL
//  - bot.paused=true + posición en target → evaluate() dispara SELL
//  - bot.paused=true + posición en time-stop (>48h + pnl<0.5%) → SELL
//  - bot.paused=true + _onCandleClose NO crea BUYs (contract preservation)
//  - sanity: bot.paused=false + stop hit → SELL (comportamiento normal)
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

const { SimpleBotEngine, STRATEGIES } = require("../src/engine_simple");

// Helper: bot con una posición abierta en capa 1
function makeBotWithOpenPosition({ entryPrice, currentPrice, qty = 0.05, capa = 1, id = "BNB_1h_RSI", pair = "BNBUSDC", openTs = Date.now() - 1000 }) {
  const bot = new SimpleBotEngine({});
  bot._capitalSyncPausedUntil = 0; // no fail-closed
  bot._streamDeadPausedUntil = 0;
  bot.portfolio[id] = {
    pair, capa, type: "RSI_MR_ADX", tf: "1h",
    entryPrice, qty,
    stop: entryPrice * 0.99,      // 1% stop
    target: entryPrice * 1.02,    // 2% target
    openTs,
    invest: qty * entryPrice,
    status: "filled",
  };
  bot.prices[pair] = currentPrice;
  if (capa === 1) bot.capa1Cash = 0;
  else            bot.capa2Cash = 0;
  return bot;
}

describe("BATCH-1 FIX #3 — stops/targets fire incluso con bot.paused=true", () => {
  it("paused=true + price <= stop → SELL disparada", async () => {
    const bot = makeBotWithOpenPosition({
      entryPrice: 100,
      currentPrice: 98.5, // 1.5% drop — below stop(99)
    });
    bot.paused = true;

    assert.ok(bot.portfolio["BNB_1h_RSI"], "pre: posición abierta");

    await bot.evaluate();

    assert.ok(!bot.portfolio["BNB_1h_RSI"],
      "posición cerrada pese a pausa (stop hit)");
    const sellLog = bot.log.find(l => l.type === "SELL" && l.reason === "STOP");
    assert.ok(sellLog, "log registra SELL con reason=STOP");
    assert.ok(bot.capa1Cash > 0, "capa1Cash creditado del gross del SELL");
  });

  it("paused=true + price >= target → SELL disparada", async () => {
    const bot = makeBotWithOpenPosition({
      entryPrice: 100,
      currentPrice: 102.5, // 2.5% up — above target(102)
    });
    bot.paused = true;

    await bot.evaluate();

    assert.ok(!bot.portfolio["BNB_1h_RSI"]);
    const sellLog = bot.log.find(l => l.type === "SELL" && l.reason === "TARGET");
    assert.ok(sellLog, "log registra SELL con reason=TARGET");
  });

  it("paused=true + time-stop (>48h, pnl<0.5%) → SELL disparada", async () => {
    const bot = makeBotWithOpenPosition({
      entryPrice: 100,
      currentPrice: 100.1,                  // pnl=0.1% <0.5%
      openTs: Date.now() - 49 * 3600 * 1000, // 49h atrás
    });
    bot.paused = true;

    await bot.evaluate();

    assert.ok(!bot.portfolio["BNB_1h_RSI"]);
    const sellLog = bot.log.find(l => l.type === "SELL" && l.reason === "TIME STOP");
    assert.ok(sellLog, "log registra SELL con reason=TIME STOP");
  });

  it("paused=true + _onCandleClose NO crea nuevas posiciones (contrato)", () => {
    // Verificación del otro lado: new BUY gate sigue activo cuando paused.
    const bot = new SimpleBotEngine({});
    bot._capitalSyncPausedUntil = 0;
    bot._streamDeadPausedUntil = 0;
    bot.paused = true;

    // Fixture que dispararía un BUY si no hubiera pausa (velas simuladas)
    const candles = [];
    for (let i = 0; i < 22; i++) candles.push({ open: 100, high: 100.1, low: 99.9, close: 100, start: 0 });
    for (let i = 0; i < 14; i++) {
      const p = 100 + i * 0.5;
      candles.push({ open: p, high: p + 0.3, low: p - 0.3, close: p + 0.3, start: 0 });
    }
    for (let i = 0; i < 13; i++) {
      const p = 106.5 - i * 0.7;
      candles.push({ open: p, high: p + 0.3, low: p - 0.3, close: p - 0.3, start: 0 });
    }
    candles.push({ open: 97.5, high: 97.7, low: 95.5, close: 95.5, start: 0 });

    bot._candles["BNBUSDC_1h"] = candles;
    bot.prices["BNBUSDC"] = 95.5;
    const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");

    bot._onCandleClose(cfg, "BNBUSDC_1h");

    assert.equal(Object.keys(bot.portfolio).length, 0,
      "paused=true: _onCandleClose NO debe abrir posición");
  });

  it("sanity: paused=false + stop hit → SELL disparada (comportamiento normal)", async () => {
    const bot = makeBotWithOpenPosition({
      entryPrice: 100,
      currentPrice: 98,
    });
    // paused por defecto es false
    assert.equal(bot.paused, false);

    await bot.evaluate();

    assert.ok(!bot.portfolio["BNB_1h_RSI"]);
    const sellLog = bot.log.find(l => l.type === "SELL");
    assert.ok(sellLog, "sanity: SELL disparada sin pausa");
  });

  it("evaluate() con bot.paused=true NO crashea (regression guard)", async () => {
    const bot = new SimpleBotEngine({});
    bot._capitalSyncPausedUntil = 0;
    bot.paused = true;
    // Portfolio vacío — sólo verificar que no lanza
    await bot.evaluate();
    // Tick debe incrementar normalmente
    assert.equal(bot.tick, 1);
  });
});

describe("BATCH-1 FIX #3 — trading/loop.js: evaluate() llamado sin gate de pausa", () => {
  it("loop.js llama S.simpleBot.evaluate() sin gate de pausa", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "trading", "loop.js"),
      "utf-8",
    );

    // El fragmento anterior buggy:
    //   if(S.simpleBot && !S.tgControls?.isPaused() && !S.bot._pausedByTelegram)
    // El fix elimina el gate de pausa alrededor de evaluate().
    const buggyGuard = /if\s*\(\s*S\.simpleBot\s*&&\s*!\s*S\.tgControls\?\.isPaused\(\)\s*&&\s*!\s*S\.bot\._pausedByTelegram\s*\)/;
    assert.ok(!buggyGuard.test(src),
      "loop.js no debe tener el gate viejo que salta evaluate() en pausa");

    // Y debe seguir llamando a evaluate() — búsqueda laxa
    assert.ok(/S\.simpleBot\.evaluate\(\)/.test(src),
      "loop.js debe seguir llamando S.simpleBot.evaluate()");

    // Defense in depth: el comentario del fix debe estar presente para que
    // un futuro refactor no reintroduzca el gate accidentalmente.
    assert.ok(/BATCH-1 FIX #3/.test(src),
      "comentario del fix debe documentar el contrato");
  });
});
