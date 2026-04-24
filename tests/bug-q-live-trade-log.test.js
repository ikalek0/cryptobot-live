// ── BUG-Q: trade_log persistence en live ──────────────────────────────────
// Regresión: server.js:96 llamaba simpleBot.setContext(null, "live", ...)
// pasando db=null. engine_simple.js:397 dejaba this._db=null, y el gate
// `if(this._db) logTrade(...)` en _onCandleClose (L471) nunca ejecutaba el
// INSERT. Resultado: PG conectado pero trade_log vacío.
//
// Fix: server.js ahora llama `const pg = await getClient()` y pasa pg a
// setContext. Estos tests bloquean la regresión:
//   1. setContext asigna this._db al arg pasado (positivo).
//   2. evaluate() con posición que hitea STOP → pool.query('INSERT INTO trade_log')
//      ejecutado con bot="live".
//   3. Regression legacy — setContext(null) → evaluate() → pool.query NO llamado.
//   4. Static check — src/server.js no invoca setContext con primer arg null.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.CAPITAL_USDC = "100";

const { SimpleBotEngine, STRATEGIES } = require("../src/engine_simple");

// ── Mock pool: registra cada query llamada (sin red, sin pg real) ────────
function makeMockPool() {
  const queries = [];
  return {
    queries,
    query: async function (sql, params) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
}

// Inyecta una posición "filled" en el portfolio y fija el precio por debajo
// del stop para que el próximo evaluate() cierre con STOP y dispare logTrade.
// strategyId debe existir en STRATEGIES (usamos BTC_30m_RSI por defecto).
function seedPositionHittingStop(bot, strategyId = "BTC_30m_RSI") {
  const cfg = STRATEGIES.find((s) => s.id === strategyId);
  assert.ok(cfg, `strategyId ${strategyId} no existe en STRATEGIES`);
  const entry = 100;
  const stop = entry * (1 - cfg.stop); // 0.8% para capa1, 3% para capa2
  bot.portfolio[strategyId] = {
    pair: cfg.pair,
    capa: cfg.capa,
    tf: cfg.tf,
    qty: 1,
    entryPrice: entry,
    stop,
    target: entry * (1 + cfg.target),
    invest: 20,
    openTs: Date.now() - 60_000,
    status: "filled",
  };
  // Precio actual 5% por debajo del entry → hitStop=true
  bot.prices[cfg.pair] = entry * 0.95;
  // Kelly rolling necesita suficientes trades para no devolver null;
  // _seedStratTrades ya lo pobló en el constructor.
}

describe("BUG-Q: trade_log persistence en live", () => {
  it("1. setContext asigna this._db al pool pasado (no null)", () => {
    const bot = new SimpleBotEngine({});
    const pool = makeMockPool();
    bot.setContext(pool, "live", "BULL", 50);
    assert.equal(bot._db, pool, "this._db debe ser el pool pasado a setContext");
    assert.equal(bot._botName, "live");
    assert.equal(bot._regime, "BULL");
    assert.equal(bot._fearGreed, 50);
  });

  it("2. evaluate() con STOP dispara pool.query('INSERT INTO trade_log') con bot='live'", () => {
    const bot = new SimpleBotEngine({});
    const pool = makeMockPool();
    bot.setContext(pool, "live", "BULL", 42);
    seedPositionHittingStop(bot, "BTC_30m_RSI");

    // Silenciar _onSell callback — en tests no queremos placeLiveSell real
    bot._onSell = () => {};

    bot.evaluate();

    // logTrade es async fire-and-forget (.catch(()=>{})), pero pool.query se
    // llama sincrónicamente antes del primer await dentro de la función async,
    // así que queries[] ya tiene el entry cuando evaluate() retorna.
    const insert = pool.queries.find((q) => /INSERT INTO trade_log/.test(q.sql));
    assert.ok(insert, `Esperaba INSERT INTO trade_log, queries=${JSON.stringify(pool.queries.map((q) => q.sql))}`);
    // Params[0] es el nombre del bot (ver trade_logger.js:31).
    assert.equal(insert.params[0], "live", "bot debe ser 'live'");
    // Params[1] symbol, [2] strategy, [3] direction
    assert.equal(insert.params[1], "BTCUSDC");
    assert.equal(insert.params[2], "BTC_30m_RSI");
    assert.equal(insert.params[3], "long");
    // Params[11] reason
    assert.equal(insert.params[11], "STOP");
  });

  it("3. Regression — setContext(null) + STOP → pool.query NO llamado (bug pre-fix)", () => {
    const bot = new SimpleBotEngine({});
    const pool = makeMockPool();
    // Simulamos el comportamiento pre-fix: el pool existe en el servidor pero
    // setContext recibió null. El bot no tiene referencia → gate cierra.
    bot.setContext(null, "live", "BULL", 42);
    seedPositionHittingStop(bot, "BTC_30m_RSI");
    bot._onSell = () => {};

    bot.evaluate();

    assert.equal(bot._db, null, "Pre-fix this._db=null por definición del bug");
    // El pool mock existe pero NUNCA recibió query — porque el gate if(this._db)
    // cierra antes de llegar a logTrade.
    assert.equal(pool.queries.length, 0,
      `Pre-fix NO debe escribir a PG, pero queries=${pool.queries.length}`);
    // El SELL sí se logueó en memoria (bot.log), eso no depende de PG.
    const sellLog = bot.log.find((l) => l.type === "SELL" && l.strategy === "BTC_30m_RSI");
    assert.ok(sellLog, "SELL en memoria sí ocurre, solo la persistencia PG falla");
  });

  it("4. Static check — src/server.js inyecta pool vía getClient(), no null", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
    // Regla: no puede haber setContext(null, "live", ...) en el path del simpleBot.
    const nullWiring = /S\.simpleBot\.setContext\s*\(\s*null\s*,\s*"live"/;
    assert.ok(!nullWiring.test(serverSrc),
      "Regresión BUG-Q: setContext se está llamando con primer arg null en el path live");
    // Y además el getter debe estar invocado.
    const getterWired = /await\s+getClient\s*\(\s*\)/;
    assert.ok(getterWired.test(serverSrc),
      "server.js debe llamar `await getClient()` para obtener el pool antes de setContext");
    // Y destructurado del require de database.
    const importWired = /\{[^}]*\bgetClient\b[^}]*\}\s*=\s*require\s*\(\s*["']\.\/database["']\s*\)/;
    assert.ok(importWired.test(serverSrc),
      "getClient debe estar destructurado del require('./database')");
  });
});
