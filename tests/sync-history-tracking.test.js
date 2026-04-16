// ── BATCH-5 FIX #1: syncHistory entries include adopted field ──────────
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { evaluateIncomingParams } = require("../src/sync");

describe("BATCH-5 FIX #1 — syncHistory adopted tracking", () => {
  it("rejected entry has adopted:false", () => {
    const history = [];
    const result = evaluateIncomingParams(
      { params: { kellyFraction: 0.1 }, paperStats: { winRate: 60, avgPnl: 0.5, nTrades: 10 }, exportedAt: new Date().toISOString() },
      { kellyFraction: 0.1 },
      { winRate: 70, avgPnl: 1.0, nTrades: 10 },
      history,
    );
    assert.equal(result.adopted, false);
    assert.equal(history.length, 1);
    assert.equal(history[0].adopted, false);
  });

  it("adopted entry (bootstrap) has adopted:true", () => {
    const history = [];
    const result = evaluateIncomingParams(
      { params: { kellyFraction: 0.2 }, paperStats: { winRate: 70, avgPnl: 1.0, nTrades: 10 }, exportedAt: new Date().toISOString() },
      { kellyFraction: 0.1 },
      { winRate: 50, avgPnl: 0.3, nTrades: 10 },
      history,
    );
    assert.equal(result.adopted, true);
    assert.equal(history.length, 1);
    assert.equal(history[0].adopted, true);
  });

  it("range-rejected entry has adopted:false", () => {
    const history = [];
    const result = evaluateIncomingParams(
      { params: { kellyFraction: 99 }, paperStats: { winRate: 70, avgPnl: 1.0, nTrades: 10 } },
      {},
      { winRate: 50, avgPnl: 0.3, nTrades: 10 },
      history,
    );
    assert.equal(result.adopted, false);
    assert.equal(history[0].adopted, false);
  });

  it("insufficient trades entry has adopted:false", () => {
    const history = [];
    evaluateIncomingParams(
      { params: { kellyFraction: 0.1 }, paperStats: { winRate: 70, avgPnl: 1.0, nTrades: 2 } },
      {},
      { winRate: 50, avgPnl: 0.3, nTrades: 10 },
      history,
    );
    assert.equal(history[0].adopted, false);
  });

  it("identical params entry has adopted:false", () => {
    const history = [];
    const params = { kellyFraction: 0.1 };
    evaluateIncomingParams(
      { params, paperStats: { winRate: 70, avgPnl: 1.0, nTrades: 10 } },
      { kellyFraction: 0.1 },
      { winRate: 50, avgPnl: 0.3, nTrades: 10 },
      history,
    );
    assert.equal(history[0].adopted, false);
  });

  it("every history entry has adopted field (mix of outcomes)", () => {
    const history = [];
    // 1: rejected (paper worse)
    evaluateIncomingParams(
      { params: { a: 1 }, paperStats: { winRate: 30, avgPnl: -1, nTrades: 10 } },
      { a: 0 }, { winRate: 70, avgPnl: 1, nTrades: 10 }, history,
    );
    // 2: adopted (bootstrap, paper better)
    evaluateIncomingParams(
      { params: { a: 2 }, paperStats: { winRate: 70, avgPnl: 1, nTrades: 10 } },
      { a: 0 }, { winRate: 30, avgPnl: -1, nTrades: 10 }, history,
    );
    assert.equal(history.length, 2);
    assert.equal(history[0].adopted, false);
    assert.equal(history[1].adopted, true);
  });
});
