// ── BUG-I / BUG-J / BUG-K / BUG-L — audit Cowork #2 (22 abr 2026) ────────
//
// Cuatro bugs de persistencia/boot identificados por auditoría sobre
// claude/pre-live-hardening, no bloqueantes a $20 pero bloqueantes a $100.
//
//   BUG-I: SIGTERM/SIGINT handler solo persistía S.bot zombie, no S.simpleBot
//          → restart limpio podía perder 60s de realizedPnl / /capital /
//          fills recientes. Fix: shutdown() en src/boot_hardening.js con
//          try/catch independientes para save() y saveSimpleState().
//   BUG-J: setCapitalEverywhere + resetAccounting no persistían antes del
//          return 200 → ventana de 60s donde PM2 kill perdía la mutación.
//          Fix: patrón {ok, ...datos, saved: Promise} awaitable por HTTP.
//   BUG-K: verifyLiveBalance iteraba portfolio sin filtrar pos.status
//          → pending BUYs (qty reservada, realQty=0) generaban false
//          positives al restart, pausando 30min. Fix: skip status !== "filled".
//   BUG-L: resetAccounting usaba `|| 100` en vez de `?? 100` para el fallback
//          de _capitalDeclarado — inconsistente con BUG-H que ya aplicó ??.
//
// Métrica: boot_hardening.js se testea directo (funciones puras). Las
// funciones server.js (setCapitalEverywhere / resetAccounting) se simulan
// inline siguiendo el patrón de tests/capital-semantics.test.js — el código
// server.js no expone módulos para unit test sin spawn completo.

"use strict";

process.env.CAPITAL_USDC = "100";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { shutdown, detectOrphansVirtuales } = require("../src/boot_hardening");
const { SimpleBotEngine } = require("../src/engine_simple");

// ── Simulación de setCapitalEverywhere con el fix BUG-J aplicado ─────────
// Replica literal de server.js:1291-1346 para testear la semántica sin
// levantar express/websocket/loop. Devuelve {ok, capital, realizedPnlPreserved, saved}.
function simulateSetCapitalEverywhereWithSave(S, saveSimpleStateFn, newCap) {
  if (typeof newCap !== "number" || !Number.isFinite(newCap) || newCap <= 0) {
    throw new Error("capital must be a finite number > 0");
  }
  if (newCap > 1e6) throw new Error("capital sanity check failed (>$1M)");
  if (S.simpleBot && S.simpleBot.portfolio) {
    const openCount = Object.keys(S.simpleBot.portfolio).length;
    if (openCount > 0) throw new Error(`cannot change capital with ${openCount} open position(s)`);
  }
  S.CAPITAL_USDT = newCap;
  if (S.simpleBot) {
    S.simpleBot._capitalDeclarado = newCap;
    const rp = Number.isFinite(S.simpleBot.realizedPnl) ? S.simpleBot.realizedPnl : 0;
    const operational = Math.max(0, newCap + rp);
    S.simpleBot.capa1Cash = operational * 0.60;
    S.simpleBot.capa2Cash = operational * 0.40;
  }
  const saved = (async () => {
    try {
      if (S.simpleBot && typeof S.simpleBot.saveState === "function") {
        await saveSimpleStateFn(S.simpleBot.saveState());
      }
    } catch (e) { /* swallow, log en prod */ }
  })();
  return { ok: true, capital: newCap, realizedPnlPreserved: true, saved };
}

function simulateResetAccountingWithSave(S, saveSimpleStateFn) {
  if (!S.simpleBot) throw new Error("simpleBot not initialized");
  const openCount = Object.keys(S.simpleBot.portfolio || {}).length;
  if (openCount > 0) throw new Error(`cannot reset accounting with ${openCount} open position(s)`);
  const before = {
    realizedPnl: S.simpleBot.realizedPnl || 0,
    totalFees:   S.simpleBot.totalFees   || 0,
    peakTv:      S.simpleBot._peakTv,
  };
  S.simpleBot.realizedPnl = 0;
  S.simpleBot.totalFees   = 0;
  S.simpleBot._peakTv     = null;
  S.simpleBot._ddAlert3   = false;
  S.simpleBot._ddAlert5   = false;
  S.simpleBot._ddAlert10  = false;
  S.simpleBot._ddCircuitBreakerTripped = false;
  // BUG-L: ?? en vez de ||
  const cap = S.simpleBot._capitalDeclarado ?? 100;
  S.simpleBot.capa1Cash = cap * 0.60;
  S.simpleBot.capa2Cash = cap * 0.40;
  const saved = (async () => {
    try {
      if (S.simpleBot && typeof S.simpleBot.saveState === "function") {
        await saveSimpleStateFn(S.simpleBot.saveState());
      }
    } catch (e) { /* swallow */ }
  })();
  return { ok: true, before, saved };
}

// ── BUG-I ────────────────────────────────────────────────────────────────

describe("BUG-I — shutdown persiste save() + saveSimpleState() antes de exit", () => {
  it("invoca save() + saveSimpleState() + exit(0) en orden con SIGTERM", async () => {
    const calls = [];
    const save = async () => { calls.push("save"); };
    const saveSimpleState = async (state) => { calls.push(["saveSimpleState", state]); };
    const simpleBot = { saveState: () => ({ sig: "snapshot" }) };
    let exitCode = null;
    const exit = (c) => { exitCode = c; calls.push(["exit", c]); };

    await shutdown("SIGTERM", { save, saveSimpleState, simpleBot, exit, log: () => {}, errorLog: () => {} });

    assert.equal(calls.length, 3, `expected 3 calls, got ${calls.length}: ${JSON.stringify(calls)}`);
    assert.equal(calls[0], "save", "save() debe ejecutarse primero");
    assert.deepEqual(calls[1], ["saveSimpleState", { sig: "snapshot" }],
      "saveSimpleState() recibe el snapshot del simpleBot");
    assert.deepEqual(calls[2], ["exit", 0], "exit(0) al final");
    assert.equal(exitCode, 0);
  });

  it("contra-test: simpleBot=null → save() + exit(0), no crash", async () => {
    const calls = [];
    const save = async () => { calls.push("save"); };
    const saveSimpleState = async () => { calls.push("saveSimpleState-UNEXPECTED"); };
    let exitCode = null;
    const exit = (c) => { exitCode = c; calls.push(["exit", c]); };

    // simpleBot no existe: solo save() debe correr, saveSimpleState skip.
    await shutdown("SIGINT", { save, saveSimpleState, simpleBot: null, exit, log: () => {}, errorLog: () => {} });

    assert.equal(exitCode, 0);
    assert.ok(calls.includes("save"), "save() debe haber corrido");
    assert.ok(!calls.includes("saveSimpleState-UNEXPECTED"),
      "saveSimpleState no debe correr sin simpleBot");
  });

  it("save() throw no impide saveSimpleState() (try/catch independientes)", async () => {
    const calls = [];
    const save = async () => { calls.push("save-start"); throw new Error("disk full"); };
    const saveSimpleState = async (s) => { calls.push(["saveSimpleState", s]); };
    const simpleBot = { saveState: () => ({ snap: 1 }) };
    let exitCode = null;
    const exit = (c) => { exitCode = c; };

    await shutdown("SIGTERM", { save, saveSimpleState, simpleBot, exit, log: () => {}, errorLog: () => {} });

    assert.equal(exitCode, 0, "exit(0) se alcanza aunque save() fallase");
    assert.deepEqual(calls[1], ["saveSimpleState", { snap: 1 }],
      "saveSimpleState corrió pese al error de save — try/catch independientes");
  });
});

// ── BUG-J ────────────────────────────────────────────────────────────────

describe("BUG-J — saved Promise persiste antes del HTTP 200", () => {
  it("setCapitalEverywhere invoca saveSimpleState exactamente 1 vez tras mutación", async () => {
    let calls = 0;
    let lastPayload = null;
    const saveSimpleState = async (state) => { calls++; lastPayload = state; };
    const bot = new SimpleBotEngine({});
    const S = { simpleBot: bot, CAPITAL_USDT: 100 };

    const r = simulateSetCapitalEverywhereWithSave(S, saveSimpleState, 50);
    await r.saved;

    assert.equal(calls, 1, "saveSimpleState se invoca exactamente una vez");
    assert.equal(bot._capitalDeclarado, 50, "_capitalDeclarado mutado ANTES del save");
    assert.equal(lastPayload?.capitalDeclarado, 50,
      "el snapshot que se persiste refleja el nuevo capitalDeclarado");
    assert.equal(r.ok, true);
  });

  it("resetAccounting invoca saveSimpleState exactamente 1 vez tras mutación", async () => {
    let calls = 0;
    const saveSimpleState = async () => { calls++; };
    const bot = new SimpleBotEngine({});
    bot.realizedPnl = -0.55;
    bot.totalFees = 0.12;
    const S = { simpleBot: bot };

    const r = simulateResetAccountingWithSave(S, saveSimpleState);
    await r.saved;

    assert.equal(calls, 1, "saveSimpleState se invoca exactamente una vez");
    assert.equal(bot.realizedPnl, 0, "mutación realizedPnl=0 antes del save");
    assert.equal(bot.totalFees, 0);
    assert.equal(r.before.realizedPnl, -0.55, "r.before captura el valor pre-reset");
  });

  it("contra-test: si saveSimpleState falla, la función sigue retornando ok (log-only)", async () => {
    const saveSimpleState = async () => { throw new Error("PG connection refused"); };
    const bot = new SimpleBotEngine({});
    const S = { simpleBot: bot, CAPITAL_USDT: 100 };

    const r = simulateSetCapitalEverywhereWithSave(S, saveSimpleState, 75);
    // await r.saved NO debe rechazar (try/catch interno swallows)
    await assert.doesNotReject(() => r.saved,
      "r.saved nunca rechaza; errores de PG se loggean pero no tumban el flujo");
    assert.equal(r.ok, true, "la función reporta ok incluso si el save falló");
    assert.equal(r.capital, 75);
  });
});

// ── BUG-K ────────────────────────────────────────────────────────────────

describe("BUG-K — detectOrphansVirtuales filtra status != filled", () => {
  it("portfolio con 1 pending + 1 filled sin backing real → solo flaggea filled", () => {
    const portfolio = {
      "BTC_30m_RSI": { status: "pending", pair: "BTCUSDC", qty: 0.001 },
      "SOL_1h_EMA":  { status: "filled",  pair: "SOLUSDC", qty: 0.05  },
    };
    const balances = [
      { asset: "USDC", free: "100" },
      // NI BTC NI SOL aparecen → ambos tendrían realQty=0
    ];

    const orphans = detectOrphansVirtuales(portfolio, balances);

    assert.equal(orphans.length, 1, "solo 1 orphan (el filled sin backing)");
    assert.equal(orphans[0].id, "SOL_1h_EMA",
      "el pending se skip — aún está en vuelo, no es huérfano real");
    assert.equal(orphans[0].pair, "SOLUSDC");
  });

  it("contra-test: portfolio con solo 1 pending sin backing → sin orphans (no 30min pausa)", () => {
    const portfolio = {
      "BTC_30m_RSI": { status: "pending", pair: "BTCUSDC", qty: 0.001 },
    };
    const balances = [{ asset: "USDC", free: "100" }];

    const orphans = detectOrphansVirtuales(portfolio, balances);

    assert.equal(orphans.length, 0,
      "pending sin backing real NO es falso positivo — el BUY aún puede fillear");
  });

  it("positivo: filled con backing correcto → no flaggea", () => {
    const portfolio = {
      "BTC_30m_RSI": { status: "filled", pair: "BTCUSDC", qty: 0.001 },
    };
    const balances = [
      { asset: "BTC",  free: "0.001" },
      { asset: "USDC", free: "50"    },
    ];

    const orphans = detectOrphansVirtuales(portfolio, balances);

    assert.equal(orphans.length, 0, "filled con backing real no es orphan");
  });
});

// ── BUG-L ────────────────────────────────────────────────────────────────

describe("BUG-L — resetAccounting usa ?? (no ||) para _capitalDeclarado", () => {
  it("_capitalDeclarado=0 → capa1=0 y capa2=0 (no fallback a 100)", async () => {
    const saveSimpleState = async () => {};
    const bot = new SimpleBotEngine({ capitalDeclarado: 0 });
    assert.equal(bot._capitalDeclarado, 0, "sanity: constructor respeta capitalDeclarado=0");
    const S = { simpleBot: bot };

    const r = simulateResetAccountingWithSave(S, saveSimpleState);
    await r.saved;

    assert.equal(bot.capa1Cash, 0,
      "capa1 = 0 * 0.60 = 0 — con `|| 100` erróneo habría caído a 60");
    assert.equal(bot.capa2Cash, 0,
      "capa2 = 0 * 0.40 = 0 — con `|| 100` erróneo habría caído a 40");
    assert.notEqual(bot.capa1Cash, 60,
      "explícitamente NO es 60 (lo que daría el bug original con `|| 100`)");
  });
});
