// ── BATCH-5 FIX #10: exportParams no longer leaks secret in body ─────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "sync.js"),
  "utf-8",
);

describe("BATCH-5 FIX #10 — exportParams secret not in body", () => {
  it("bodyStr does NOT include secret field", () => {
    const idx = src.indexOf("function exportParams");
    assert.ok(idx >= 0);
    const body = src.slice(idx, idx + 700);
    assert.ok(!body.includes("{ secret, ...payload }"),
      "body must NOT spread secret into payload");
    assert.ok(body.includes("JSON.stringify(payload)"),
      "body must stringify payload only (without secret)");
  });

  it("HMAC still uses secret as key", () => {
    const idx = src.indexOf("function exportParams");
    const body = src.slice(idx, idx + 700);
    assert.ok(body.includes('createHmac("sha256", secret)'),
      "HMAC must still use secret as the key");
  });

  it("X-Signature header still sent", () => {
    const idx = src.indexOf("function exportParams");
    const body = src.slice(idx, idx + 900);
    assert.ok(body.includes('"X-Signature"'),
      "must still send X-Signature header");
  });

  it("BATCH-5 FIX #10 comment present", () => {
    assert.ok(src.includes("BATCH-5 FIX #10"),
      "must have BATCH-5 FIX #10 marker");
  });
});
