// ── boot_hardening.js ────────────────────────────────────────────────────────
// Funciones puras para operaciones de boot/shutdown. Aisladas en su propio
// módulo para testear sin levantar el server entero. Consumidas desde
// src/server.js.
//
// Contiene:
//   - shutdown(sig, deps): persistencia graceful en SIGTERM/SIGINT.
//   - detectOrphansVirtuales(portfolio, balances): detecta posiciones
//     virtuales sin backing real en Binance (solo mira status="filled").

"use strict";

// ── shutdown(sig, deps) ──────────────────────────────────────────────────────
// Replica el patrón ya probado de uncaughtException (server.js:1080-1094) para
// SIGTERM/SIGINT, que antes solo persistía S.bot (engine zombie) vía save() y
// dejaba S.simpleBot fuera — restart limpio podía perder hasta 60s de
// realizedPnl, /capital, /reset-contable o fills recientes (BUG-I).
//
// Ambos try/catch son INDEPENDIENTES a propósito: save() y saveSimpleState()
// escriben a keys distintas (bot_state zombie vs simple_state); un fallo de
// PG/disco en uno no debe impedir la persistencia del otro. Si quisiéramos un
// único try/catch, una excepción temprana dejaría al segundo sin correr.
async function shutdown(sig, deps) {
  const {
    save,
    saveSimpleState,
    simpleBot,
    exit = (c) => process.exit(c),
    log = console.log,
    errorLog = console.error,
  } = deps || {};

  log(`[SHUTDOWN] ${sig} — persistiendo estado...`);

  try {
    if (typeof save === "function") await save();
  } catch (e) {
    errorLog("[SHUTDOWN-SAVE]", e && e.message ? e.message : String(e));
  }

  try {
    if (simpleBot && typeof simpleBot.saveState === "function" && typeof saveSimpleState === "function") {
      await saveSimpleState(simpleBot.saveState());
    }
  } catch (e) {
    errorLog("[SHUTDOWN-SIMPLE-SAVE]", e && e.message ? e.message : String(e));
  }

  exit(0);
}

// ── detectOrphansVirtuales(portfolio, balances) ──────────────────────────────
// Reconcilia portfolio simpleBot ↔ balances Binance buscando posiciones
// registradas sin respaldo real. Antes (BUG-K) el loop no filtraba por status
// → una BUY pending tiene pos.qty reservada optimísticamente pero realQty=0 en
// Binance (fill aún en vuelo) → falso positivo que pausaba 30min en el boot.
// Mismo patrón que BUG-D pero una capa arriba (verifyLiveBalance).
function detectOrphansVirtuales(portfolio, balances) {
  const orphans = [];
  const bals = Array.isArray(balances) ? balances : [];
  for (const [id, pos] of Object.entries(portfolio || {})) {
    if (!pos || pos.status !== "filled") continue;
    const asset = (pos.pair || "").replace(/USDC$|USDT$/, "");
    const bal = bals.find(b => b && b.asset === asset);
    const realQty = bal ? parseFloat(bal.free || 0) : 0;
    if (realQty < (pos.qty || 0) * 0.9) {
      orphans.push({ id, pair: pos.pair, expected: pos.qty, real: realQty });
    }
  }
  return orphans;
}

module.exports = { shutdown, detectOrphansVirtuales };
