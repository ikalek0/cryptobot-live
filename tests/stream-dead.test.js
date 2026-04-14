// ── C2: Stream-dead tests ────────────────────────────────────────────────
// simulatePrices() escribe random-walk desde SEEDS hardcoded cuando el
// WebSocket de Binance lleva >=10s sin emitir. trading/loop.js NO debe
// propagar esos precios fabricados al simpleBot: el engine construiría
// velas OHLC con datos falsos y podría disparar señales BUY sobre ruido.
// Este test verifica (1) el guard en loop.js (replicando la lógica como
// función pura) y (2) el gate _streamDeadPausedUntil en _onCandleClose.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

const { SimpleBotEngine, STRATEGIES } = require("../src/engine_simple");

// Replicamos la lógica del guard de trading/loop.js como función pura.
// Si isPriceStreamLive devuelve false, NO propagar al simpleBot.
function forwardPricesIfStreamLive(simpleBot, prices, isPriceStreamLive) {
  const streamLive = typeof isPriceStreamLive === "function" ? isPriceStreamLive() : true;
  if (simpleBot && prices && streamLive) {
    for (const [sym, price] of Object.entries(prices)) {
      simpleBot.updatePrice(sym, price);
    }
  }
  return streamLive;
}

// Fixture: velas BUY-signal para RSI_MR_ADX (literal de sizing.test.js)
function buyCandlesRSI() {
  const c = [];
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

describe("C2: stream-dead guard", () => {
  describe("propagación de precios en loop.js", () => {
    it("stream VIVA → simpleBot.updatePrice se invoca para cada símbolo", () => {
      const bot = new SimpleBotEngine({});
      const fakePrices = { BNBUSDC: 600, SOLUSDC: 180, BTCUSDC: 65000 };
      const streamLive = forwardPricesIfStreamLive(
        bot, fakePrices, () => true /* isPriceStreamLive */
      );
      assert.equal(streamLive, true);
      assert.equal(bot.prices["BNBUSDC"], 600);
      assert.equal(bot.prices["SOLUSDC"], 180);
      assert.equal(bot.prices["BTCUSDC"], 65000);
    });

    it("stream MUERTA → simpleBot.prices queda intacto", () => {
      const bot = new SimpleBotEngine({});
      // Pre-cargar un precio real
      bot.prices["BNBUSDC"] = 600;
      // simulatePrices fabricaría esto en stream-dead
      const fakePrices = { BNBUSDC: 999, SOLUSDC: 999 };
      const streamLive = forwardPricesIfStreamLive(
        bot, fakePrices, () => false /* stream dead */
      );
      assert.equal(streamLive, false);
      // Los precios NO deben haberse actualizado al valor fabricado
      assert.equal(bot.prices["BNBUSDC"], 600, "precio real debe mantenerse");
      assert.equal(bot.prices["SOLUSDC"], undefined, "fabricado no debe escribirse");
    });
  });

  describe("gate en _onCandleClose por _streamDeadPausedUntil", () => {
    it("streamDeadPausedUntil en el futuro → _onCandleClose bloquea BUYs con log STREAM-DEAD", () => {
      const bot = new SimpleBotEngine({});
      bot._capitalSyncPausedUntil = 0; // aislar de sync gate
      bot._streamDeadPausedUntil = Date.now() + 30 * 1000; // 30s futuro
      bot._candles["BNBUSDC_1h"] = buyCandlesRSI();
      bot.prices["BNBUSDC"] = 95.5;

      const origLog = console.log;
      const logs = [];
      console.log = (...args) => logs.push(args.join(" "));
      try {
        const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");
        bot._onCandleClose(cfg, "BNBUSDC_1h");
      } finally {
        console.log = origLog;
      }

      assert.ok(!bot.portfolio["BNB_1h_RSI"],
        "stream-dead gate: portfolio NO debe mutarse");
      assert.ok(logs.some(l => l.includes("[SIMPLE][STREAM-DEAD]")),
        "log debe mostrar STREAM-DEAD específico (no CAPITAL-SYNC)");
      assert.ok(!logs.some(l => l.includes("[SIMPLE][CAPITAL-SYNC]")),
        "capital-sync gate NO debe loguearse (distinguir semánticas)");
    });

    it("streamDeadPausedUntil en el pasado → pasa el gate (no bloquea)", () => {
      const bot = new SimpleBotEngine({});
      bot._capitalSyncPausedUntil = 0;
      bot._streamDeadPausedUntil = Date.now() - 1000; // expirado
      bot._candles["BNBUSDC_1h"] = buyCandlesRSI();
      bot.prices["BNBUSDC"] = 95.5;

      const cfg = STRATEGIES.find(s => s.id === "BNB_1h_RSI");
      bot._onCandleClose(cfg, "BNBUSDC_1h");

      assert.ok(bot.portfolio["BNB_1h_RSI"],
        "gate expirado: BUY debe proceder normalmente");
    });
  });

  describe("persistencia de _streamDeadPausedUntil (H6 pattern)", () => {
    it("saveState persiste streamDeadPausedUntil", () => {
      const bot = new SimpleBotEngine({});
      const future = Date.now() + 45 * 1000;
      bot._streamDeadPausedUntil = future;
      const saved = bot.saveState();
      assert.equal(saved.streamDeadPausedUntil, future);
    });

    it("round-trip: new instance restaura streamDeadPausedUntil del saved state", () => {
      const a = new SimpleBotEngine({});
      const future = Date.now() + 55 * 1000;
      a._streamDeadPausedUntil = future;
      const saved = a.saveState();
      const b = new SimpleBotEngine(saved);
      assert.equal(b._streamDeadPausedUntil, future,
        "streamDeadPausedUntil debe sobrevivir restart");
    });
  });
});
