// ── C3: /api/reset-state auth tests ─────────────────────────────────────
// POST /api/reset-state sin auth es remote-wipe trivial del ledger virtual.
// Este test monta un mini Express con la lógica de auth idéntica a la de
// server.js (misma constante de default BOT_SECRET) y verifica:
// - POST sin secret → 401
// - POST con secret incorrecto → 401
// - POST con secret correcto → 200 (el cuerpo del handler mockeado)
// No carga server.js directamente (require hace boot que inicia timers
// y abre sockets; este test solo verifica la política de auth).
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

process.env.CAPITAL_USDC = "100";
process.env.CAPITAL_USDT = "100";

// ── Replica LITERAL de la lógica de auth en src/server.js /api/reset-state
// Si esta implementación diverge del handler real, el test no protege
// nada — por eso cualquier cambio en server.js debe reflejarse aquí.
function makeResetStateHandler({ deleteStateMock, saveSimpleStateMock }) {
  return async (req, res) => {
    // parse body como JSON mínimo
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch {}
    const { secret } = parsed;
    if (secret !== (process.env.BOT_SECRET || "bafir_bot_secret")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "No autorizado" }));
      return;
    }
    try {
      await deleteStateMock();
      await saveSimpleStateMock({});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "State deleted. Restart PM2 to apply." }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  };
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({
      hostname: "127.0.0.1", port, path, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("C3: /api/reset-state auth", () => {
  let server, port;
  let deleteStateCalls, saveSimpleStateCalls;
  const ORIG_BOT_SECRET = process.env.BOT_SECRET;

  before(async () => {
    // Fijar BOT_SECRET a un valor conocido para el test
    process.env.BOT_SECRET = "test-bot-secret-c3";
    deleteStateCalls = 0;
    saveSimpleStateCalls = 0;
    const handler = makeResetStateHandler({
      deleteStateMock: async () => { deleteStateCalls++; },
      saveSimpleStateMock: async () => { saveSimpleStateCalls++; },
    });
    server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/reset-state") return handler(req, res);
      res.writeHead(404); res.end("not found");
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });

  after(async () => {
    await new Promise(r => server.close(r));
    if (ORIG_BOT_SECRET === undefined) delete process.env.BOT_SECRET;
    else process.env.BOT_SECRET = ORIG_BOT_SECRET;
  });

  it("POST sin body devuelve 401 y NO llama a deleteState", async () => {
    const before = deleteStateCalls;
    const res = await postJson(port, "/api/reset-state", {});
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "No autorizado");
    assert.equal(deleteStateCalls, before, "deleteState NO debe llamarse");
  });

  it("POST con secret incorrecto devuelve 401 y NO llama a deleteState", async () => {
    const before = deleteStateCalls;
    const res = await postJson(port, "/api/reset-state", { secret: "wrong-secret" });
    assert.equal(res.status, 401);
    assert.equal(deleteStateCalls, before);
  });

  it("POST con secret correcto devuelve 200 y ejecuta deleteState + saveSimpleState", async () => {
    const beforeDel = deleteStateCalls;
    const beforeSave = saveSimpleStateCalls;
    const res = await postJson(port, "/api/reset-state", { secret: "test-bot-secret-c3" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(deleteStateCalls, beforeDel + 1);
    assert.equal(saveSimpleStateCalls, beforeSave + 1);
  });
});

describe("C3: /api/reset-state handler in server.js source (regression guard)", () => {
  // Asegura que nadie quite la auth del handler real en src/server.js.
  // Falla si el string de auth desaparece del source.
  it("server.js contiene el secret check para /api/reset-state", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../src/server.js"), "utf-8");
    // Regex: buscamos el handler reset-state y confirmamos que tiene secret check cercano
    const idx = src.indexOf('app.post("/api/reset-state"');
    assert.ok(idx >= 0, "handler de /api/reset-state debe existir");
    // Los siguientes 600 chars deben contener el patrón de auth
    const window = src.slice(idx, idx + 600);
    assert.ok(window.includes("secret") && window.includes("BOT_SECRET"),
      "/api/reset-state debe tener secret check (BOT_SECRET) en el handler");
    // BATCH-1 FIX #7: el 401 ahora se emite dentro de onAuthFailure(req,res).
    // El handler debe delegar a ese helper en vez de inline res.status(401).
    assert.ok(window.includes("onAuthFailure") || window.includes("401"),
      "/api/reset-state debe rechazar auth inválida (vía onAuthFailure o 401 inline)");
  });

  it("warnPredictableSecrets aborta boot en LIVE_MODE con secrets default", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../src/server.js"), "utf-8");
    // Debe haber process.exit(1) guardado por LIVE_MODE dentro de warnPredictableSecrets
    const idx = src.indexOf("warnPredictableSecrets");
    assert.ok(idx >= 0);
    const window = src.slice(idx, idx + 2000);
    assert.ok(window.includes("if (LIVE_MODE)"),
      "warnPredictableSecrets debe checkear LIVE_MODE");
    assert.ok(window.includes("process.exit(1)"),
      "warnPredictableSecrets debe llamar process.exit(1) en LIVE_MODE con defaults");
    assert.ok(window.includes("ufw"),
      "mensaje de error debe incluir guardrail operativo del firewall");
  });

  it("/api/myip y /api/myip-egress están guardados con LIVE_MODE check", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../src/server.js"), "utf-8");
    const ipHandler = src.indexOf('app.get("/api/myip"');
    assert.ok(ipHandler >= 0);
    const ipWindow = src.slice(ipHandler, ipHandler + 400);
    assert.ok(ipWindow.includes("LIVE_MODE"),
      "/api/myip debe verificar LIVE_MODE");
    assert.ok(ipWindow.includes("404"),
      "/api/myip debe devolver 404 en LIVE_MODE");

    const egHandler = src.indexOf('app.get("/api/myip-egress"');
    assert.ok(egHandler >= 0);
    const egWindow = src.slice(egHandler, egHandler + 400);
    assert.ok(egWindow.includes("LIVE_MODE"),
      "/api/myip-egress debe verificar LIVE_MODE");
    assert.ok(egWindow.includes("404"),
      "/api/myip-egress debe devolver 404 en LIVE_MODE");
  });
});
