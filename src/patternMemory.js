// patternMemory.js — Memoria de patrones por par + aprendizaje cruzado entre correlacionados

/**
 * Almacena qué combinaciones (RSI bucket + BB zone + régimen) tienen mejor win rate
 * para cada par. Permite que el bot aprenda qué señales funcionan en cada contexto.
 */
class PatternMemory {
  constructor() {
    // { [symbol]: { [patternKey]: { wins, losses, totalPnl, avgPnl } } }
    this.patterns = {};
    // Correlaciones calculadas periódicamente
    this.correlations = {};
    // Historial de retornos para calcular correlación
    this.returnHistory = {}; // { [symbol]: number[] }
    this.MAX_HISTORY = 200;
  }

  // ── Pattern key helpers ───────────────────────────────────────────────────
  _rsiBucket(rsi) {
    if (rsi < 20) return 'oversold_extreme';
    if (rsi < 30) return 'oversold';
    if (rsi < 40) return 'below_mid';
    if (rsi < 60) return 'mid';
    if (rsi < 70) return 'above_mid';
    return 'overbought';
  }

  _bbZone(price, bb) {
    if (!bb) return 'unknown';
    if (price < bb.lower) return 'below_lower';
    if (price < bb.middle) return 'lower_half';
    if (price < bb.upper) return 'upper_half';
    return 'above_upper';
  }

  _patternKey(rsi, bb, price, regime) {
    return `${regime}|${this._rsiBucket(rsi)}|${this._bbZone(price, bb)}`;
  }

  // ── Record outcome ────────────────────────────────────────────────────────
  recordTrade(symbol, { rsiEntry, bbEntry, entryPrice, regime, pnlPct, win }) {
    if (!this.patterns[symbol]) this.patterns[symbol] = {};
    const key = this._patternKey(rsiEntry, bbEntry, entryPrice, regime);
    if (!this.patterns[symbol][key]) {
      this.patterns[symbol][key] = { wins: 0, losses: 0, totalPnl: 0, count: 0 };
    }
    const p = this.patterns[symbol][key];
    p.count++;
    p.totalPnl += pnlPct;
    if (win) p.wins++; else p.losses++;

    // Return history for correlation
    if (!this.returnHistory[symbol]) this.returnHistory[symbol] = [];
    this.returnHistory[symbol].push(pnlPct);
    if (this.returnHistory[symbol].length > this.MAX_HISTORY)
      this.returnHistory[symbol].shift();
  }

  // ── Query: win rate for a pattern ────────────────────────────────────────
  getPatternScore(symbol, rsi, bb, price, regime) {
    const key = this._patternKey(rsi, bb, price, regime);
    const p = this.patterns[symbol]?.[key];
    if (!p || p.count < 3) return null; // insufficient data

    const winRate = p.wins / p.count;
    const avgPnl = p.totalPnl / p.count;
    // Score: weighted combination
    const score = winRate * 0.6 + (avgPnl > 0 ? Math.min(avgPnl * 10, 0.4) : 0);
    return { key, winRate, avgPnl, count: p.count, score };
  }

  // ── Check if pattern has negative expectancy ──────────────────────────────
  isPatternUnfavorable(symbol, rsi, bb, price, regime) {
    const s = this.getPatternScore(symbol, rsi, bb, price, regime);
    if (!s) return false;
    return s.score < 0.3 || (s.count >= 5 && s.winRate < 0.35);
  }

  // ── Best patterns per symbol ──────────────────────────────────────────────
  getBestPatterns(symbol, topN = 5) {
    const patterns = this.patterns[symbol];
    if (!patterns) return [];
    return Object.entries(patterns)
      .filter(([, p]) => p.count >= 3)
      .map(([key, p]) => ({
        key,
        winRate: p.wins / p.count,
        avgPnl: p.totalPnl / p.count,
        count: p.count,
      }))
      .sort((a, b) => b.winRate - a.winRate || b.avgPnl - a.avgPnl)
      .slice(0, topN);
  }

  // ── Cross-pair correlation learning ──────────────────────────────────────
  updateCorrelations() {
    const symbols = Object.keys(this.returnHistory);
    for (const s1 of symbols) {
      if (!this.correlations[s1]) this.correlations[s1] = {};
      for (const s2 of symbols) {
        if (s1 === s2) continue;
        const corr = this._pearson(this.returnHistory[s1], this.returnHistory[s2]);
        this.correlations[s1][s2] = corr;
      }
    }
  }

  _pearson(a, b) {
    const n = Math.min(a.length, b.length, 50);
    if (n < 5) return 0;
    const ax = a.slice(-n), bx = b.slice(-n);
    const ma = ax.reduce((s, v) => s + v, 0) / n;
    const mb = bx.reduce((s, v) => s + v, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const ai = ax[i] - ma, bi = bx[i] - mb;
      num += ai * bi;
      da += ai * ai;
      db += bi * bi;
    }
    return (da && db) ? num / Math.sqrt(da * db) : 0;
  }

  // Returns correlated symbols (|corr| > threshold) for position sizing limits
  getCorrelatedSymbols(symbol, threshold = 0.7) {
    const corr = this.correlations[symbol] || {};
    return Object.entries(corr)
      .filter(([, c]) => Math.abs(c) > threshold)
      .map(([sym, c]) => ({ symbol: sym, correlation: c }));
  }

  // If a correlated pair just won/lost, transfer partial signal weight
  getCrossLearnedBias(symbol, rsi, bb, price, regime) {
    const correlated = this.getCorrelatedSymbols(symbol, 0.75);
    if (!correlated.length) return null;

    let totalWeight = 0, weightedScore = 0;
    for (const { symbol: sym, correlation } of correlated) {
      const score = this.getPatternScore(sym, rsi, bb, price, regime);
      if (score) {
        const w = Math.abs(correlation);
        weightedScore += score.score * w;
        totalWeight += w;
      }
    }
    if (!totalWeight) return null;
    return { crossLearnedScore: weightedScore / totalWeight, correlatedCount: correlated.length };
  }

  // ── Persistence ───────────────────────────────────────────────────────────
  toJSON() {
    return {
      patterns: this.patterns,
      correlations: this.correlations,
      returnHistory: Object.fromEntries(
        Object.entries(this.returnHistory).map(([k, v]) => [k, v.slice(-50)])
      ),
    };
  }

  loadJSON(data) {
    if (!data) return;
    if (data.patterns) this.patterns = data.patterns;
    if (data.correlations) this.correlations = data.correlations;
    if (data.returnHistory) this.returnHistory = data.returnHistory;
  }
}

module.exports = { PatternMemory };
