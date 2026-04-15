// ── BATCH-1 FIX #9 (#2): setCapitalEverywhere tests ────────────────────
// Antes había dos paths para actualizar capital (TG callback y HTTP
// /api/set-capital) y ninguno propagaba a simpleBot._capitalDeclarado.
// El simpleBot seguía operando con INITIAL_CAPITAL del boot. Esta suite:
//
//   1) Verifica la semántica de la helper aislada (sin boot completo de
//      server.js, que arrancaría timers y abriría sockets). Reimplementa
//      el mismo algoritmo sobre una instancia real de SimpleBotEngine
//      para blindar la regla "respeta invest comprometido por capa".
//   2) Valida los rechazos de input (0, negativo, NaN, string, >$1M).
//   3) Static source-check de src/server.js: setCapitalEverywhere existe,
//      la llamada está wired en el TG callback y en el HTTP endpoint,
//      y _capitalDeclarado es el campo que se toca.
//
// Deliberadamente NO requerimos('../src/server') porque eso dispara
// listen(), timers de sync, conexión a Binance, etc.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

const { SimpleBotEngine } = require("../src/engine_simple");

// Réplica exacta del helper en src/server.js. Si server.js se corrige,
// este replicante debe actualizarse — el source-check al final de la
// suite se asegura de que server.js siga usándolo.
function makeSetCapitalEverywhere(S, { syncDeps = () => ({}) } = {}) {
  return function setCapitalEverywhere(newCap) {
    if (typeof newCap !== "number" || !Number.isFinite(newCap) || newCap <= 0) {
      throw new Error("capital must be a finite number > 0");
    }
    if (newCap > 1e6) {
      throw new Error("capital sanity check failed (>$1M)");
    }
    S.CAPITAL_USDT = newCap;
    if (S.bot) {
      if (typeof S.bot.cash === "number" && S.bot.cash > newCap) S.bot.cash = newCap;
    }
    if (S.simpleBot) {
      S.simpleBot._capitalDeclarado = newCap;
      const portfolio = S.simpleBot.portfolio || {};
      const committedC1 = Object.values(portfolio)
        .filter(p => p && p.capa === 1)
        .reduce((s, p) => s + (Number(p.invest) || 0), 0);
      const committedC2 = Object.values(portfolio)
        .filter(p => p && p.capa === 2)
        .reduce((s, p) => s + (Number(p.invest) || 0), 0);
      S.simpleBot.capa1Cash = Math.max(0, newCap * 0.60 - committedC1);
      S.simpleBot.capa2Cash = Math.max(0, newCap * 0.40 - committedC2);
      if (typeof S.simpleBot.syncCapitalFromBinance === "function") {
        Promise.resolve(S.simpleBot.syncCapitalFromBinance(syncDeps()))
          .catch(() => {});
      }
    }
    return { ok: true, capital: newCap };
  };
}

function makeFakeState() {
  const simpleBot = new SimpleBotEngine({});
  // Desactivamos sync real para evitar llamadas a red en los tests.
  simpleBot.syncCapitalFromBinance = async () => ({ ok: true });
  return {
    CAPITAL_USDT: 100,
    bot: { cash: 100 },
    simpleBot,
  };
}

describe("BATCH-1 FIX #9 — setCapitalEverywhere: propagación a _capitalDeclarado", () => {
  it("actualiza _capitalDeclarado en el simpleBot (regresión principal)", () => {
    const S = makeFakeState();
    const set = makeSetCapitalEverywhere(S);
    assert.equal(S.simpleBot._capitalDeclarado, 100, "preconditon");
    set(500);
    assert.equal(S.simpleBot._capitalDeclarado, 500,
      "_capitalDeclarado debe reflejar el nuevo capital (antes era no-op)");
  });

  it("actualiza S.CAPITAL_USDT", () => {
    const S = makeFakeState();
    const set = makeSetCapitalEverywhere(S);
    set(250);
    assert.equal(S.CAPITAL_USDT, 250);
  });

  it("baja S.bot.cash si supera el nuevo capital", () => {
    const S = makeFakeState();
    S.bot.cash = 1000; // pretend engine cached too much
    const set = makeSetCapitalEverywhere(S);
    set(200);
    assert.equal(S.bot.cash, 200, "bot.cash debe bajar a newCap");
  });

  it("NO sube S.bot.cash si está por debajo del nuevo capital", () => {
    const S = makeFakeState();
    S.bot.cash = 50;
    const set = makeSetCapitalEverywhere(S);
    set(200);
    assert.equal(S.bot.cash, 50, "bot.cash no debe auto-subir");
  });
});

describe("BATCH-1 FIX #9 — setCapitalEverywhere: reparto capa1/capa2 sin posiciones", () => {
  it("con portfolio vacío: capa1 = 60%, capa2 = 40%", () => {
    const S = makeFakeState();
    S.simpleBot.portfolio = {};
    const set = makeSetCapitalEverywhere(S);
    set(1000);
    assert.equal(S.simpleBot.capa1Cash, 600);
    assert.equal(S.simpleBot.capa2Cash, 400);
  });

  it("newCap = 100 → capa1=60, capa2=40", () => {
    const S = makeFakeState();
    S.simpleBot.portfolio = {};
    const set = makeSetCapitalEverywhere(S);
    set(100);
    assert.equal(S.simpleBot.capa1Cash, 60);
    assert.equal(S.simpleBot.capa2Cash, 40);
  });
});

describe("BATCH-1 FIX #9 — setCapitalEverywhere: respeta invest comprometido", () => {
  it("capa1 con $30 comprometidos → capa1Cash = 60 - 30 = 30", () => {
    const S = makeFakeState();
    S.simpleBot.portfolio = {
      "BNB_1h_RSI": { capa: 1, invest: 20 },
      "SOL_1h_EMA": { capa: 1, invest: 10 },
    };
    const set = makeSetCapitalEverywhere(S);
    set(100);
    assert.equal(S.simpleBot.capa1Cash, 30,
      "capa1Cash = 60 - (20 + 10) = 30 — el dinero comprometido NO se duplica");
    assert.equal(S.simpleBot.capa2Cash, 40, "capa2 sin posiciones, 40% completo");
  });

  it("capa2 con $25 comprometidos → capa2Cash = 40 - 25 = 15", () => {
    const S = makeFakeState();
    S.simpleBot.portfolio = {
      "XRP_4h_EMA": { capa: 2, invest: 25 },
    };
    const set = makeSetCapitalEverywhere(S);
    set(100);
    assert.equal(S.simpleBot.capa1Cash, 60, "capa1 sin posiciones");
    assert.equal(S.simpleBot.capa2Cash, 15, "capa2Cash = 40 - 25 = 15");
  });

  it("ambas capas con posiciones mezcladas", () => {
    const S = makeFakeState();
    S.simpleBot.portfolio = {
      "BNB_1h_RSI": { capa: 1, invest: 15 },
      "BTC_30m_EMA": { capa: 1, invest: 10 },
      "XRP_4h_EMA":  { capa: 2, invest: 20 },
      "SOL_4h_EMA":  { capa: 2, invest: 5  },
    };
    const set = makeSetCapitalEverywhere(S);
    set(200);
    // capa1 = 200*0.60 = 120, committed = 25 → 95
    // capa2 = 200*0.40 = 80,  committed = 25 → 55
    assert.equal(S.simpleBot.capa1Cash, 95);
    assert.equal(S.simpleBot.capa2Cash, 55);
  });

  it("invest > reparto nominal → capa cash clipped a 0 (no negativo)", () => {
    const S = makeFakeState();
    S.simpleBot.portfolio = {
      "BNB_1h_RSI": { capa: 1, invest: 100 }, // mucho más que el 60%
    };
    const set = makeSetCapitalEverywhere(S);
    set(100);
    assert.equal(S.simpleBot.capa1Cash, 0, "clipped a 0, NUNCA negativo");
  });

  it("ignora entries sin campo capa o invest inválido", () => {
    const S = makeFakeState();
    S.simpleBot.portfolio = {
      "valid":   { capa: 1, invest: 10 },
      "no_capa": { invest: 50 }, // sin capa → no cuenta para ninguna
      "nan":     { capa: 1, invest: "oops" },
      "null_p":  null,
    };
    const set = makeSetCapitalEverywhere(S);
    set(100);
    // committedC1 = 10 (el único con capa:1 y invest numérico)
    assert.equal(S.simpleBot.capa1Cash, 60 - 10);
    assert.equal(S.simpleBot.capa2Cash, 40);
  });
});

describe("BATCH-1 FIX #9 — setCapitalEverywhere: validación de input", () => {
  const S = makeFakeState();
  const set = makeSetCapitalEverywhere(S);

  it("0 → throw", () => {
    assert.throws(() => set(0), /> 0/);
  });

  it("negativo → throw", () => {
    assert.throws(() => set(-100), /> 0/);
  });

  it("NaN → throw", () => {
    assert.throws(() => set(NaN), /finite number/);
  });

  it("Infinity → throw", () => {
    assert.throws(() => set(Infinity), /finite number/);
  });

  it("string → throw", () => {
    assert.throws(() => set("100"), /finite number/);
  });

  it("null/undefined → throw", () => {
    assert.throws(() => set(null), /finite number/);
    assert.throws(() => set(undefined), /finite number/);
  });

  it(">$1M sanity cap → throw", () => {
    assert.throws(() => set(1_000_001), /sanity check/);
    assert.throws(() => set(1e9),      /sanity check/);
  });

  it("exactamente $1M → ok", () => {
    const S2 = makeFakeState();
    const set2 = makeSetCapitalEverywhere(S2);
    assert.doesNotThrow(() => set2(1_000_000));
    assert.equal(S2.simpleBot._capitalDeclarado, 1_000_000);
  });

  it("input inválido NO toca el estado (transaccionalidad)", () => {
    const S3 = makeFakeState();
    S3.simpleBot.portfolio = {};
    const set3 = makeSetCapitalEverywhere(S3);
    const beforeCap = S3.simpleBot._capitalDeclarado;
    const beforeC1  = S3.simpleBot.capa1Cash;
    const beforeC2  = S3.simpleBot.capa2Cash;
    try { set3(-1); } catch {}
    assert.equal(S3.simpleBot._capitalDeclarado, beforeCap);
    assert.equal(S3.simpleBot.capa1Cash,         beforeC1);
    assert.equal(S3.simpleBot.capa2Cash,         beforeC2);
  });
});

describe("BATCH-1 FIX #9 — setCapitalEverywhere: dispara sync con Binance", () => {
  it("llama a syncCapitalFromBinance con deps inyectadas (fire-and-forget)", async () => {
    const S = makeFakeState();
    let calls = 0;
    let lastDeps = null;
    S.simpleBot.syncCapitalFromBinance = async (deps) => {
      calls++;
      lastDeps = deps;
      return { ok: true };
    };
    const DEPS_TOKEN = { fake: "deps" };
    const set = makeSetCapitalEverywhere(S, { syncDeps: () => DEPS_TOKEN });
    set(250);
    // micro-tick para que la promise se enganche
    await new Promise(r => setImmediate(r));
    assert.equal(calls, 1, "debe disparar un sync");
    assert.equal(lastDeps, DEPS_TOKEN, "deps inyectadas deben pasarse al motor");
  });

  it("rejection del sync NO propaga (fire-and-forget)", async () => {
    const S = makeFakeState();
    S.simpleBot.syncCapitalFromBinance = async () => {
      throw new Error("network down");
    };
    const set = makeSetCapitalEverywhere(S);
    // Si propagara, esto rompería el test con unhandled rejection.
    assert.doesNotThrow(() => set(300));
    assert.equal(S.simpleBot._capitalDeclarado, 300,
      "el estado ya quedó actualizado antes del sync");
    await new Promise(r => setImmediate(r));
  });
});

describe("BATCH-1 FIX #9 — server.js wiring (static source check)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "server.js"),
    "utf-8",
  );

  it("server.js define function setCapitalEverywhere", () => {
    assert.ok(/function\s+setCapitalEverywhere\s*\(/.test(src),
      "server.js debe declarar setCapitalEverywhere");
  });

  it("setCapitalEverywhere toca simpleBot._capitalDeclarado", () => {
    const idx = src.indexOf("function setCapitalEverywhere");
    const win = src.slice(idx, idx + 2500);
    assert.ok(/_capitalDeclarado\s*=/.test(win),
      "la helper debe asignar _capitalDeclarado");
  });

  it("setCapitalEverywhere valida input (>0, <1e6)", () => {
    const idx = src.indexOf("function setCapitalEverywhere");
    const win = src.slice(idx, idx + 2500);
    assert.ok(/newCap\s*<=\s*0/.test(win) || /> 0/.test(win),
      "debe validar que newCap sea > 0");
    assert.ok(/1e6|1_000_000|1000000/.test(win),
      "debe existir sanity cap alrededor de $1M");
  });

  it("setCapitalEverywhere respeta invest comprometido por capa", () => {
    const idx = src.indexOf("function setCapitalEverywhere");
    const win = src.slice(idx, idx + 2500);
    assert.ok(/committedC1/.test(win), "debe calcular committed capa1");
    assert.ok(/committedC2/.test(win), "debe calcular committed capa2");
    assert.ok(/capa1Cash\s*=\s*Math\.max\(0/.test(win),
      "capa1Cash debe clamp a 0");
    assert.ok(/capa2Cash\s*=\s*Math\.max\(0/.test(win),
      "capa2Cash debe clamp a 0");
  });

  it("setCapitalEverywhere dispara syncCapitalFromBinance", () => {
    const idx = src.indexOf("function setCapitalEverywhere");
    const win = src.slice(idx, idx + 2500);
    assert.ok(/syncCapitalFromBinance\(/.test(win),
      "helper debe disparar sync inmediato");
  });

  it("TG callback setCapital delega en setCapitalEverywhere", () => {
    // El callback vive dentro del objeto que se pasa a crearTg(...).
    // Verificamos que el callback llama a setCapitalEverywhere — no
    // que sobreescriba capa1Cash/capa2Cash inline.
    const idx = src.indexOf("setCapital:");
    assert.ok(idx >= 0, "setCapital callback debe existir");
    const win = src.slice(idx, idx + 400);
    assert.ok(/setCapitalEverywhere\(/.test(win),
      "TG setCapital debe delegar en setCapitalEverywhere");
    // Regression guard: ya NO debe haber asignación inline a capa1Cash
    // dentro del callback del TG.
    assert.ok(!/capa1Cash\s*=\s*v\s*\*\s*0\.60/.test(win),
      "TG callback no debe setear capa1Cash inline (debe delegar)");
  });

  it("HTTP /api/set-capital delega en setCapitalEverywhere", () => {
    const idx = src.indexOf('app.post("/api/set-capital"');
    assert.ok(idx >= 0, "handler /api/set-capital debe existir");
    const win = src.slice(idx, idx + 1200);
    assert.ok(/setCapitalEverywhere\(/.test(win),
      "HTTP handler debe llamar a setCapitalEverywhere");
    // Validación de input debe estar presente antes de la llamada.
    assert.ok(/Capital inválido|capitalUSD/.test(win));
    // Regression guard: ya NO debe setear S.CAPITAL_USDT inline sin
    // pasar por el helper.
    assert.ok(!/S\.CAPITAL_USDT\s*=\s*capitalUSD/.test(win),
      "HTTP handler no debe actualizar CAPITAL_USDT inline");
  });

  it("comentario del fix presente", () => {
    assert.ok(/BATCH-1 FIX #9/.test(src),
      "server.js debe documentar el fix con 'BATCH-1 FIX #9'");
  });
});
