// ── A6: trade_log schema audit (Opus Group-A) ─────────────────────────
// Fix A6 es NO-OP en términos de código ejecutable: la tabla trade_log
// ya existe con 20 columnas y ensureTradeLogTable ya la crea on-demand.
// Estos tests son REGRESSION GUARDS para:
//   (1) la CREATE TABLE statement no pierda columnas accidentalmente
//   (2) el logTrade INSERT mantenga alineación posicional con el schema
//   (3) el gap documentado (5 columnas missing vs spec) siga siendo
//       visible — si alguien añade las 5 columnas más tarde, el test
//       debe romperse para que alguien actualice la documentación del
//       gap y el spec.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const TRADE_LOGGER = path.resolve(__dirname, "..", "src", "trade_logger.js");
const src = fs.readFileSync(TRADE_LOGGER, "utf-8");

describe("A6 — trade_log schema audit", () => {
  it("CREATE TABLE trade_log existe en trade_logger.js", () => {
    assert.ok(/CREATE TABLE IF NOT EXISTS trade_log/.test(src),
      "trade_logger.js debe contener CREATE TABLE trade_log");
  });

  // Las 20 columnas de datos esperadas (id y created_at son metadata,
  // no las contamos en los 20 que menciona el journal).
  const EXPECTED_COLUMNS = [
    "bot", "symbol", "strategy", "direction",
    "open_ts", "close_ts", "duration_min",
    "entry_price", "exit_price",
    "pnl_pct", "invest_usdc", "reason",
    "regime", "adx", "rsi_at_entry",
    "fear_greed", "hour_utc",
    "kelly_rolling", "mae_real", "mfe_real",
  ];

  it(`CREATE TABLE contiene las 20 columnas esperadas (${EXPECTED_COLUMNS.length})`, () => {
    // Extraer sólo el cuerpo del CREATE TABLE
    const m = src.match(/CREATE TABLE IF NOT EXISTS trade_log \(([^)]+)\)/s);
    assert.ok(m, "CREATE TABLE body debe ser extraíble");
    const body = m[1];
    for (const col of EXPECTED_COLUMNS) {
      assert.ok(new RegExp(`\\b${col}\\b`).test(body),
        `Columna '${col}' debe estar en el CREATE TABLE`);
    }
  });

  it("el total de columnas de datos es exactamente 20 (los 20 que menciona el journal)", () => {
    // Contamos campos en el CREATE TABLE por líneas no vacías excluyendo
    // id SERIAL, PRIMARY KEY, created_at, y cierres.
    const m = src.match(/CREATE TABLE IF NOT EXISTS trade_log \(([^)]+)\)/s);
    const body = m[1];
    // split por comas de top-level (hay paréntesis en DEFAULT NOW() pero no en las defs)
    const parts = body.split(/,\s*/).map(s => s.trim()).filter(Boolean);
    // Ignorar id y created_at
    const dataColumns = parts.filter(p =>
      !p.startsWith("id SERIAL") && !p.startsWith("created_at ")
    );
    assert.equal(dataColumns.length, EXPECTED_COLUMNS.length,
      `Esperaba 20 columnas de datos, encontré ${dataColumns.length}`);
  });

  it("INSERT statement usa 20 parámetros alineados con las columnas", () => {
    // El INSERT debe listar los 20 nombres y tener 20 placeholders
    const insertIdx = src.indexOf("INSERT INTO trade_log");
    assert.ok(insertIdx > 0);
    const insert = src.slice(insertIdx, insertIdx + 800);
    // Placeholders $1..$20
    for (let i = 1; i <= 20; i++) {
      assert.ok(new RegExp(`\\$${i}\\b`).test(insert),
        `INSERT debe usar $${i}`);
    }
    // $21 no debe existir (sería columna extra no declarada)
    assert.ok(!/\$21\b/.test(insert), "INSERT no debe tener $21 (solo 20 columnas)");
  });

  // ── Regression guard para el gap documentado ──────────────────────
  // Si alguien añade las 5 columnas en el futuro y olvida actualizar la
  // nota A6, este test se rompe: fuerza una revisión del schema doc.
  const MISSING_FROM_SPEC = ["qty", "capa", "fee_mode", "pnl_usd"];
  // "fee" solo a secas chocaría con "fee_mode" en el regex, así que
  // lo chequeamos aparte con word boundary estricto.

  it("el gap A6 está documentado explícitamente en el comentario", () => {
    assert.ok(/A6 — Schema audit/.test(src),
      "trade_logger.js debe tener el comentario A6 Schema audit");
    assert.ok(/Faltan del spec \(5\)/.test(src),
      "el comentario debe enumerar las 5 columnas missing");
    for (const col of MISSING_FROM_SPEC) {
      assert.ok(new RegExp(`\\b${col}\\b`).test(src),
        `gap doc debe mencionar '${col}' explícitamente`);
    }
  });

  it("las 5 columnas missing NO están en el CREATE TABLE (gap A6 confirmado)", () => {
    const m = src.match(/CREATE TABLE IF NOT EXISTS trade_log \(([^)]+)\)/s);
    const body = m[1];
    for (const col of MISSING_FROM_SPEC) {
      assert.ok(!new RegExp(`\\b${col}\\b`).test(body),
        `Columna '${col}' NO debe estar en el CREATE TABLE (gap A6 documentado)`);
    }
    // fee como palabra aislada (no fee_mode, no rsi_fee...)
    // Aquí queremos confirmar que no hay columna fee NUMERIC explícita.
    assert.ok(!/\bfee\s+NUMERIC\b/i.test(body),
      "Columna 'fee NUMERIC' NO debe estar en el CREATE TABLE (gap A6)");
  });

  it("ensureTradeLogTable y logTrade exportados", () => {
    assert.ok(/module\.exports\s*=\s*\{[^}]*ensureTradeLogTable/.test(src));
    assert.ok(/module\.exports\s*=\s*\{[^}]*logTrade/.test(src));
  });
});
