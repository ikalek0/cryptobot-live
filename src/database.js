// ─── DATABASE MODULE ─────────────────────────────────────────────────────────
// Usa PostgreSQL si está disponible, sino guarda en disco (data/state.json).
// Circuit breaker: si PG falla una vez (DNS, timeout, conexión cerrada), queda
// DESACTIVADO hasta el próximo restart — evita spam de reintentos en el log.
"use strict";

const fs   = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || "";
const STATE_FILE        = path.join(__dirname, "../data/state.json");
const SIMPLE_STATE_FILE = path.join(__dirname, "../data/simple_state.json");

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
  // Fallback a disco
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, json, "utf8");
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
  // Fallback a disco
  if (fs.existsSync(STATE_FILE)) {
    try {
      console.log("[DB] Estado cargado desde disco ✓");
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch(e) {}
  }
  return null;
}

// ── DELETE ────────────────────────────────────────────────────────────────────
async function deleteState() {
  try {
    const client = await getClient();
    if (client) await client.query(`DELETE FROM bot_state WHERE key = 'live_main'`);
  } catch(e) { disablePg(`deleteState query falló: ${e.message}`); }
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
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
  // Fallback a disco con escritura atómica (tmpfile + rename)
  // Garantiza que un crash a mitad de write no deje el archivo corrupto.
  try {
    fs.mkdirSync(path.dirname(SIMPLE_STATE_FILE), { recursive: true });
    const tmp = `${SIMPLE_STATE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, json, "utf8");
    fs.renameSync(tmp, SIMPLE_STATE_FILE);
  } catch(e) { console.error("[DB] saveSimpleState disk falló:", e.message); }
}

async function loadSimpleState() {
  try {
    const client = await getClient();
    if (client) {
      const r = await client.query(`SELECT value FROM bot_state WHERE key='simple_state'`);
      if (r.rows[0]) {
        console.log("[DB] SimpleState cargado desde PostgreSQL ✓");
        return JSON.parse(r.rows[0].value);
      }
    }
  } catch(e) { disablePg(`loadSimpleState query falló: ${e.message}`); }
  // Fallback a disco
  if (fs.existsSync(SIMPLE_STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SIMPLE_STATE_FILE, "utf8"));
      console.log("[DB] SimpleState cargado desde disco ✓");
      return data;
    } catch(e) { console.warn("[DB] loadSimpleState parse error:", e.message); }
  }
  return null;
}

module.exports = { saveState, loadState, deleteState, saveSimpleState, loadSimpleState };
