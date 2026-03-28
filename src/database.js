// ─── DATABASE MODULE ─────────────────────────────────────────────────────────
// Usa PostgreSQL si está disponible (Railway), sino guarda en disco (local)
"use strict";

const fs   = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || "";
const STATE_FILE   = path.join(__dirname, "../data/state.json");

// ── PostgreSQL client (lazy load) ─────────────────────────────────────────────
let pgClient = null;

async function getClient() {
  if (!DATABASE_URL) return null;
  if (pgClient) return pgClient;
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
    console.warn("[DB] PostgreSQL no disponible, usando disco:", e.message);
    pgClient = null;
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
        `INSERT INTO bot_state (key, value, ts) VALUES ('main', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, ts = NOW()`,
        [json]
      );
      return;
    }
  } catch(e) {
    console.warn("[DB] Error guardando en PG, usando disco:", e.message);
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
      const res = await client.query(`SELECT value FROM bot_state WHERE key = 'main'`);
      if (res.rows.length > 0) {
        console.log("[DB] Estado cargado desde PostgreSQL ✓");
        return JSON.parse(res.rows[0].value);
      }
    }
  } catch(e) {
    console.warn("[DB] Error leyendo PG:", e.message);
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
    if (client) await client.query(`DELETE FROM bot_state WHERE key = 'main'`);
  } catch(e) {}
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

module.exports = { saveState, loadState, deleteState };
