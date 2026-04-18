// ─── DATABASE MODULE ─────────────────────────────────────────────────────────
// Usa PostgreSQL si está disponible, sino guarda en disco (data/state.json).
// Circuit breaker: si PG falla una vez (DNS, timeout, conexión cerrada), queda
// DESACTIVADO hasta el próximo restart — evita spam de reintentos en el log.
//
// BATCH-1 CRIT-1: saveSimpleState/loadSimpleState ahora tienen fallback a
// disco en data/simple_state.json. Sin este fallback, cuando DATABASE_URL
// estaba vacía (el caso actual de cryptobot-live), la persistencia del
// simpleBot NO escribía NADA a disco — cada restart de PM2 perdía el estado
// de los 7 strategies (kellyGate, portfolio abierto, capa1Cash/capa2Cash,
// ddAlerts/CB, depegPauseActive, boot invariant, capital sync pause,
// candles acumuladas). El bug era silencioso porque saveSimpleState
// "tenía éxito" (el try no lanzaba) sin persistir nada.
//
// BATCH-1 CRIT-2: escrituras atómicas. fs.writeFileSync NO es atómico — un
// crash/power-loss a mitad de escritura deja el fichero truncado o con
// JSON inválido, y loadState silenciaba el parse error devolviendo null
// (arranque con estado en blanco). Fix: atomicWriteFile escribe a un .tmp,
// hace fsync, rename, y rota el anterior a .bak. loadState/loadSimpleState
// intentan recuperar desde .bak si el fichero principal no parsea.
"use strict";

const fs   = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || "";
const STATE_FILE        = path.join(__dirname, "../data/state.json");
const SIMPLE_STATE_FILE = path.join(__dirname, "../data/simple_state.json");

// ── Atomic write helper (CRIT-2) ─────────────────────────────────────────────
// Patrón POSIX estándar:
//   1) escribir a file.tmp
//   2) fsync(file.tmp) — asegurar bytes en disco antes del rename
//   3) si el file existe, mover file → file.bak (rotación)
//   4) rename(file.tmp, file) — commit atómico (rename en el mismo FS es atómico)
//
// Si el proceso crashea entre pasos 3 y 4, queda .bak con el último estado
// conocido bueno. loadWithRecovery() re-escribe file desde .bak si falta.
//
// Nota: fs.renameSync sobre mismo filesystem es atómico en Linux
// (rename(2) swap o ENOTEMPTY). En Windows no garantiza atomicidad al
// overwrite, pero el .bak rotation mitiga el riesgo en ambos casos.
function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  const bakPath = `${filePath}.bak`;

  // 1) write + fsync a .tmp
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, content, 0, "utf8");
    // Best-effort fsync — si falla (p.ej. FS no soporta), no abortamos.
    try { fs.fsyncSync(fd); } catch {}
  } finally {
    fs.closeSync(fd);
  }

  // 2) rotar actual a .bak (si existe)
  if (fs.existsSync(filePath)) {
    try {
      // Borrar .bak previo antes de renombrar (Windows-safe)
      if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
      fs.renameSync(filePath, bakPath);
    } catch (e) {
      // Best-effort — si la rotación falla seguimos con el rename principal
      console.log(`[DB] atomicWrite: rotación .bak falló (${e.message}) — continúo`);
    }
  }

  // 3) commit atómico
  fs.renameSync(tmpPath, filePath);
}

// Lee JSON desde filePath; si falla parse, intenta .bak como fallback.
// Devuelve null si ambos fallan o no existen.
function loadWithRecovery(filePath, label) {
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      console.log(`[DB] ${label} cargado desde disco ✓`);
      return parsed;
    } catch (e) {
      console.log(`[DB] ${label} parse falló (${e.message}) — intentando .bak`);
    }
  }
  const bakPath = `${filePath}.bak`;
  if (fs.existsSync(bakPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(bakPath, "utf8"));
      console.log(`[DB] ${label} RECUPERADO desde .bak ✓`);
      // Rehidratar el fichero principal desde el .bak para evitar loops
      try {
        atomicWriteFile(filePath, JSON.stringify(parsed));
      } catch (e) {
        console.log(`[DB] ${label} rehidratación falló: ${e.message}`);
      }
      return parsed;
    } catch (e) {
      console.log(`[DB] ${label} .bak también corrupto (${e.message})`);
    }
  }
  return null;
}

// Hosts conocidos como muertos: bail out sin esperar al timeout de DNS
const DEAD_HOSTS = ["railway.internal", "railway.app"];

// ── PostgreSQL client (lazy load + circuit breaker) ──────────────────────────
let pgClient        = null;
let pgDisabled      = false; // true tras el primer fallo — no reintentar
let pgMessageLogged = false; // garantiza que el aviso sólo se loguea una vez

function disablePg(reason) {
  pgDisabled = true;
  pgClient = null;
  if (!pgMessageLogged) {
    console.log(`[DB] PostgreSQL desactivado — usando disco. Motivo: ${reason}`);
    pgMessageLogged = true;
  }
}

async function getClient() {
  if (pgDisabled) return null;
  if (pgClient)   return pgClient;

  if (!DATABASE_URL) {
    disablePg("DATABASE_URL no configurada");
    return null;
  }
  if (DEAD_HOSTS.some(h => DATABASE_URL.includes(h))) {
    disablePg("DATABASE_URL apunta a host abandonado (Railway)");
    return null;
  }

  try {
    const { Client } = require("pg");
    pgClient = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pgClient.connect();
    // Crear tabla si no existe
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS bot_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        ts    TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("[DB] PostgreSQL conectado ✓");
    return pgClient;
  } catch(e) {
    disablePg(`connect falló: ${e.message}`);
    return null;
  }
}

// ── SAVE ─────────────────────────────────────────────────────────────────────
async function saveState(state) {
  const json = JSON.stringify(state);
  try {
    const client = await getClient();
    if (client) {
      await client.query(
        `INSERT INTO bot_state (key, value, ts) VALUES ('live_main', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, ts = NOW()`,
        [json]
      );
      return;
    }
  } catch(e) {
    disablePg(`saveState query falló: ${e.message}`);
  }
  // Fallback a disco (atomic write — CRIT-2)
  atomicWriteFile(STATE_FILE, json);
}

// ── LOAD ─────────────────────────────────────────────────────────────────────
async function loadState() {
  try {
    const client = await getClient();
    if (client) {
      const res = await client.query(`SELECT value FROM bot_state WHERE key = 'live_main'`);
      if (res.rows.length > 0) {
        console.log("[DB] Estado cargado desde PostgreSQL ✓");
        return JSON.parse(res.rows[0].value);
      }
    }
  } catch(e) {
    disablePg(`loadState query falló: ${e.message}`);
  }
  // Fallback a disco con recovery desde .bak (CRIT-2)
  return loadWithRecovery(STATE_FILE, "Estado");
}

// ── DELETE ────────────────────────────────────────────────────────────────────
async function deleteState() {
  try {
    const client = await getClient();
    if (client) await client.query(`DELETE FROM bot_state WHERE key = 'live_main'`);
  } catch(e) { disablePg(`deleteState query falló: ${e.message}`); }
  // Borrar fichero principal + .bak + .tmp de ambos estados
  for (const p of [STATE_FILE, SIMPLE_STATE_FILE]) {
    for (const suffix of ["", ".bak", ".tmp"]) {
      const fp = p + suffix;
      if (fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); } catch {}
      }
    }
  }
}


async function saveSimpleState(state) {
  const json = JSON.stringify(state);
  try {
    const client = await getClient();
    if (client) {
      await client.query(
        `INSERT INTO bot_state (key, value, ts) VALUES ('simple_state', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value=$1, ts=NOW()`,
        [json]
      );
      return;
    }
  } catch(e) { disablePg(`saveSimpleState query falló: ${e.message}`); }
  // Fallback a disco atómico (CRIT-1 + CRIT-2)
  atomicWriteFile(SIMPLE_STATE_FILE, json);
}

async function loadSimpleState() {
  try {
    const client = await getClient();
    if (client) {
      const r = await client.query(`SELECT value FROM bot_state WHERE key='simple_state'`);
      if (r.rows[0]) {
        console.log("[DB] SimpleBot estado cargado desde PostgreSQL ✓");
        return JSON.parse(r.rows[0].value);
      }
      // PG vivo pero sin fila — caer al fallback de disco por si había uno anterior
    }
  } catch(e) { disablePg(`loadSimpleState query falló: ${e.message}`); }
  // Fallback a disco con recovery desde .bak (CRIT-1 + CRIT-2)
  return loadWithRecovery(SIMPLE_STATE_FILE, "SimpleBot estado");
}

module.exports = {
  saveState, loadState, deleteState, saveSimpleState, loadSimpleState,
  // Exportado para trade_logger wiring (P0-conv): server.js hace
  // await getClient() al boot y, si devuelve un client, invoca
  // ensureTradeLogTable(client) y lo pasa a simpleBot.setContext + schedulers.
  // Si getClient() devuelve null (DATABASE_URL no config / disabled),
  // logTrade/weekly_report degradan silente como antes.
  getClient,
  // Exportado para tests
  atomicWriteFile, loadWithRecovery,
};
