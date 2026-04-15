// ── BATCH-1 CRIT-1: persistence disk fallback ──────────────────────────
// Regression guard del bug silencioso en src/database.js: cuando
// DATABASE_URL está vacía (el caso actual de cryptobot-live),
// saveSimpleState "tenía éxito" sin escribir nada a disco y
// loadSimpleState devolvía null tras cada restart.
//
// Estos tests forzan DATABASE_URL vacía y verifican el ciclo completo:
//   saveSimpleState → disk → loadSimpleState → same object
//
// Además cubren:
//  - saveState/loadState round-trip (ya tenía fallback, regression guard)
//  - loadSimpleState con disco corrupto (parse fail → null, no crash)
//  - deleteState limpia AMBOS ficheros (state.json + simple_state.json)
"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// CRÍTICO: vaciar DATABASE_URL ANTES del require — el módulo la lee a top-level.
process.env.DATABASE_URL = "";

const DB = require("../src/database");

const DATA_DIR          = path.join(__dirname, "..", "data");
const STATE_FILE        = path.join(DATA_DIR, "state.json");
const SIMPLE_STATE_FILE = path.join(DATA_DIR, "simple_state.json");

function safeUnlink(p) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

describe("BATCH-1 CRIT-1 — persistence disk fallback", () => {
  beforeEach(() => {
    // Limpiar ficheros entre tests para aislamiento
    safeUnlink(STATE_FILE);
    safeUnlink(SIMPLE_STATE_FILE);
  });

  after(() => {
    safeUnlink(STATE_FILE);
    safeUnlink(SIMPLE_STATE_FILE);
  });

  describe("saveSimpleState con DATABASE_URL vacía → disco", () => {
    it("saveSimpleState escribe data/simple_state.json", async () => {
      const state = { foo: "bar", nested: { a: 1, b: [2, 3] } };
      await DB.saveSimpleState(state);
      assert.ok(fs.existsSync(SIMPLE_STATE_FILE),
        "simple_state.json debe existir tras saveSimpleState");
      const raw = fs.readFileSync(SIMPLE_STATE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      assert.deepEqual(parsed, state, "contenido del fichero == estado guardado");
    });

    it("loadSimpleState devuelve el estado escrito previamente", async () => {
      const state = {
        capa1Cash: 60.5, capa2Cash: 39.2,
        ddCircuitBreakerTripped: false,
        portfolio: { BNB_1h_RSI: { invest: 16, qty: 0.026 } },
        kellyGate: { BNB_1h_RSI: { wins: 5, losses: 3 } },
      };
      await DB.saveSimpleState(state);
      const loaded = await DB.loadSimpleState();
      assert.deepEqual(loaded, state,
        "loadSimpleState debe devolver exactamente lo que saveSimpleState escribió");
    });

    it("loadSimpleState sin fichero → null (no crash)", async () => {
      assert.ok(!fs.existsSync(SIMPLE_STATE_FILE), "pre: no file");
      const loaded = await DB.loadSimpleState();
      assert.equal(loaded, null, "sin fichero debe devolver null");
    });

    it("loadSimpleState con JSON corrupto → null (parse fail silencioso)", async () => {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SIMPLE_STATE_FILE, "{not-valid-json", "utf8");
      const loaded = await DB.loadSimpleState();
      assert.equal(loaded, null,
        "JSON corrupto debe devolver null, no lanzar excepción");
    });

    it("save sucesivos sobrescriben el fichero (última llamada gana)", async () => {
      await DB.saveSimpleState({ version: 1 });
      await DB.saveSimpleState({ version: 2 });
      await DB.saveSimpleState({ version: 3 });
      const loaded = await DB.loadSimpleState();
      assert.equal(loaded.version, 3);
    });
  });

  describe("saveState regression guard (ya tenía fallback)", () => {
    it("saveState/loadState round-trip con PG vacío", async () => {
      const state = { bot: { portfolio: {}, trades: [] }, regime: "neutral" };
      await DB.saveState(state);
      assert.ok(fs.existsSync(STATE_FILE), "state.json debe existir");
      const loaded = await DB.loadState();
      assert.deepEqual(loaded, state);
    });

    it("loadState sin fichero → null", async () => {
      assert.ok(!fs.existsSync(STATE_FILE));
      const loaded = await DB.loadState();
      assert.equal(loaded, null);
    });
  });

  describe("deleteState limpia ambos ficheros", () => {
    it("deleteState borra state.json y simple_state.json", async () => {
      await DB.saveState({ x: 1 });
      await DB.saveSimpleState({ y: 2 });
      assert.ok(fs.existsSync(STATE_FILE));
      assert.ok(fs.existsSync(SIMPLE_STATE_FILE));
      await DB.deleteState();
      assert.ok(!fs.existsSync(STATE_FILE), "state.json borrado");
      assert.ok(!fs.existsSync(SIMPLE_STATE_FILE), "simple_state.json borrado");
    });
  });
});
