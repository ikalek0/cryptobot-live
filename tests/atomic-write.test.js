// ── BATCH-1 CRIT-2: atomic write + .bak recovery ───────────────────────
// fs.writeFileSync NO es atómico. Un crash/power-loss a mitad de escritura
// dejaba data/state.json truncado o con JSON inválido, y loadState
// silenciaba el parse error devolviendo null — el bot arrancaba con
// estado en blanco (portfolio perdido, KellyGate reseteado, etc.).
//
// Fix (src/database.js): atomicWriteFile(path, content) escribe a .tmp,
// rota el fichero principal a .bak, y rename .tmp → path (commit atómico).
// loadWithRecovery() intenta el fichero principal; si el parse falla,
// recupera desde .bak y rehidrata.
//
// Tests:
//  - atomicWriteFile crea fichero principal + .bak al reescribir
//  - tras corromper el principal, loadWithRecovery recupera desde .bak
//  - tras corromper ambos, devuelve null (sin crash)
//  - save sucesivos rotan .bak correctamente (última versión → principal,
//    penúltima → .bak)
//  - .tmp limpio al final (no leak de temp files)
//  - saveState/saveSimpleState invocan atomicWriteFile (integración)
"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.DATABASE_URL = ""; // forzar disco

const DB = require("../src/database");

// Directorio temporal aislado para los tests de atomicWriteFile
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "batch1-atomic-"));
const TEST_FILE = path.join(TMP_DIR, "test.json");

// Nota: estos tests trabajan sólo sobre TMP_DIR — no tocan data/state.json
// ni data/simple_state.json para evitar race conditions con
// persistence-disk-fallback.test.js (Node corre test files en paralelo).
// La integración con saveState/saveSimpleState está cubierta en
// tests/persistence-disk-fallback.test.js.

function safeUnlink(p) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

function cleanupTestFile() {
  safeUnlink(TEST_FILE);
  safeUnlink(TEST_FILE + ".bak");
  safeUnlink(TEST_FILE + ".tmp");
}

describe("BATCH-1 CRIT-2 — atomic write + .bak recovery", () => {
  beforeEach(() => {
    cleanupTestFile();
  });

  after(() => {
    cleanupTestFile();
    try { fs.rmdirSync(TMP_DIR); } catch {}
  });

  describe("atomicWriteFile() — semántica básica", () => {
    it("primera escritura crea el fichero, sin .bak todavía", () => {
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 1 }));
      assert.ok(fs.existsSync(TEST_FILE), "principal creado");
      assert.ok(!fs.existsSync(TEST_FILE + ".bak"), "sin .bak en primera write");
      assert.ok(!fs.existsSync(TEST_FILE + ".tmp"), "sin .tmp residual");
    });

    it("segunda escritura rota el anterior a .bak", () => {
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 1 }));
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 2 }));
      assert.ok(fs.existsSync(TEST_FILE));
      assert.ok(fs.existsSync(TEST_FILE + ".bak"), ".bak creado en segunda write");
      const main = JSON.parse(fs.readFileSync(TEST_FILE, "utf8"));
      const bak  = JSON.parse(fs.readFileSync(TEST_FILE + ".bak", "utf8"));
      assert.equal(main.v, 2, "principal = última versión");
      assert.equal(bak.v, 1, ".bak = versión anterior");
      assert.ok(!fs.existsSync(TEST_FILE + ".tmp"), "sin .tmp residual");
    });

    it("escrituras sucesivas mantienen solo 1 nivel de .bak (última + penúltima)", () => {
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 1 }));
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 2 }));
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 3 }));
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 4 }));
      const main = JSON.parse(fs.readFileSync(TEST_FILE, "utf8"));
      const bak  = JSON.parse(fs.readFileSync(TEST_FILE + ".bak", "utf8"));
      assert.equal(main.v, 4);
      assert.equal(bak.v, 3, "solo la penúltima se preserva en .bak");
    });

    it("crea directorio si no existe (mkdirSync recursive)", () => {
      const deepPath = path.join(TMP_DIR, "nested", "deep", "file.json");
      DB.atomicWriteFile(deepPath, JSON.stringify({ ok: true }));
      assert.ok(fs.existsSync(deepPath));
      // cleanup
      fs.unlinkSync(deepPath);
      fs.rmdirSync(path.dirname(deepPath));
      fs.rmdirSync(path.join(TMP_DIR, "nested"));
    });
  });

  describe("loadWithRecovery() — recovery desde .bak", () => {
    it("fichero principal OK → parseo directo", () => {
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 42 }));
      const loaded = DB.loadWithRecovery(TEST_FILE, "test");
      assert.deepEqual(loaded, { v: 42 });
    });

    it("principal corrupto + .bak válido → recovery desde .bak", () => {
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 1, good: true }));
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 2, good: true }));
      // Corromper el principal (simular crash a mitad de escritura)
      fs.writeFileSync(TEST_FILE, "{not-json-at-all", "utf8");
      const loaded = DB.loadWithRecovery(TEST_FILE, "test");
      // .bak tiene v=1 (la versión anterior a la v=2)
      assert.deepEqual(loaded, { v: 1, good: true });
      // Rehidratación: el principal ahora debe parsear OK
      const rehydrated = JSON.parse(fs.readFileSync(TEST_FILE, "utf8"));
      assert.deepEqual(rehydrated, { v: 1, good: true },
        "principal debe rehidratarse desde .bak");
    });

    it("principal truncado a 0 bytes → recovery desde .bak", () => {
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 1 }));
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 2 }));
      fs.writeFileSync(TEST_FILE, "", "utf8"); // power-loss simulado
      const loaded = DB.loadWithRecovery(TEST_FILE, "test");
      assert.deepEqual(loaded, { v: 1 });
    });

    it("ambos corruptos → null (no crash)", () => {
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 1 }));
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: 2 }));
      fs.writeFileSync(TEST_FILE,          "garbage1", "utf8");
      fs.writeFileSync(TEST_FILE + ".bak", "garbage2", "utf8");
      const loaded = DB.loadWithRecovery(TEST_FILE, "test");
      assert.equal(loaded, null);
    });

    it("sin fichero principal + sin .bak → null", () => {
      assert.ok(!fs.existsSync(TEST_FILE));
      assert.ok(!fs.existsSync(TEST_FILE + ".bak"));
      const loaded = DB.loadWithRecovery(TEST_FILE, "test");
      assert.equal(loaded, null);
    });

    it("principal ausente + .bak válido → recovery y rehidratación", () => {
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: "first" }));
      DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: "second" }));
      // Borrar solo el principal (caso raro: rename incompleto)
      fs.unlinkSync(TEST_FILE);
      assert.ok(fs.existsSync(TEST_FILE + ".bak"));
      const loaded = DB.loadWithRecovery(TEST_FILE, "test");
      assert.deepEqual(loaded, { v: "first" });
      assert.ok(fs.existsSync(TEST_FILE),
        "principal rehidratado tras recovery");
    });
  });

  describe("no .tmp leaks", () => {
    it("ninguna escritura deja .tmp residual tras éxito", () => {
      for (let i = 0; i < 5; i++) {
        DB.atomicWriteFile(TEST_FILE, JSON.stringify({ v: i }));
        assert.ok(!fs.existsSync(TEST_FILE + ".tmp"),
          `sin .tmp tras write #${i}`);
      }
    });
  });
});
