// ── BATCH-4 FIX #6: HMAC raw body verification ──────────────────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "server.js"),
  "utf-8",
);

describe("BATCH-4 FIX #6 — HMAC raw body", () => {
  it("BATCH-4 FIX #6 comment present", () => {
    assert.ok(/BATCH-4 FIX #6/.test(src));
  });

  it("express.json verify callback captures rawBody", () => {
    assert.ok(/verify.*req.*buf[\s\S]*?req\.rawBody\s*=\s*buf/m.test(src),
      "must store buf as req.rawBody in verify callback");
  });

  it("rawBody only captured for /api/sync routes", () => {
    const verifyIdx = src.indexOf("verify:");
    assert.ok(verifyIdx >= 0);
    const verifyBlock = src.slice(verifyIdx, verifyIdx + 300);
    assert.ok(/\/api\/sync/.test(verifyBlock),
      "verify should check for /api/sync prefix");
  });

  it("/api/sync/params uses req.rawBody for HMAC", () => {
    const idx = src.indexOf("/api/sync/params");
    assert.ok(idx >= 0);
    const block = src.slice(idx, idx + 500);
    assert.ok(/req\.rawBody/.test(block),
      "sync/params must use req.rawBody");
    assert.ok(!/JSON\.stringify\(req\.body\)/.test(block),
      "sync/params must NOT use JSON.stringify(req.body) for HMAC");
  });

  it("/api/sync/daily uses req.rawBody for HMAC", () => {
    const idx = src.indexOf("/api/sync/daily");
    assert.ok(idx >= 0);
    const block = src.slice(idx, idx + 500);
    assert.ok(/req\.rawBody/.test(block),
      "sync/daily must use req.rawBody");
    assert.ok(!/JSON\.stringify\(req\.body\)/.test(block),
      "sync/daily must NOT use JSON.stringify(req.body) for HMAC");
  });

  it("missing rawBody returns 400", () => {
    const idx = src.indexOf("/api/sync/params");
    const block = src.slice(idx, idx + 500);
    assert.ok(/!req\.rawBody.*400/.test(block) || /rawBody.*400/.test(block),
      "must return 400 if rawBody missing");
  });
});
