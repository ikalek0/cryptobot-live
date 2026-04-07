// counterfactual.js — Análisis contrafactual avanzado
// Compara: entrada más tarde, stop diferente, salida en RSI 70

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = gains / (losses || 1);
  return 100 - 100 / (1 + rs);
}

function calcATR(candles, period = 14) {
  if (candles.length < 2) return 0.001;
  const trs = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/**
 * Analiza el contrafactual de un trade real:
 * dado entry, stop, target reales y las velas siguientes,
 * simula qué habría pasado con distintas alternativas.
 */
function analyzeCounterfactual(trade, futureCandles) {
  if (!futureCandles || futureCandles.length < 2) return null;

  const { entry, stop: realStop, target: realTarget, qty, regime } = trade;

  // Resultados reales (ya conocidos)
  const realPnl = (trade.exit - entry) * qty;
  const realPnlPct = (trade.exit - entry) / entry;

  // ── Alternativa 1: Entrada 5 velas más tarde (precio ligeramente diferente) ──
  const laterEntryCandle = futureCandles[Math.min(5, futureCandles.length - 1)];
  const laterEntry = laterEntryCandle.close;
  const alt1 = simulateAlternativeEntry(
    laterEntry, realStop, realTarget, qty, futureCandles.slice(5), 'later_entry_5bars'
  );

  // ── Alternativa 2: Stop más estrecho (ATR × 1 en vez de ATR × 2) ──────────
  const atr = calcATR(futureCandles);
  const tightStop = entry - atr;
  const alt2 = simulateAlternativeEntry(
    entry, tightStop, realTarget, qty, futureCandles, 'tight_stop_1atr'
  );

  // ── Alternativa 3: Stop más amplio (ATR × 3) ─────────────────────────────
  const wideStop = entry - atr * 3;
  const alt3 = simulateAlternativeEntry(
    entry, wideStop, realTarget, qty, futureCandles, 'wide_stop_3atr'
  );

  // ── Alternativa 4: Salida en RSI 70 (si el price alcanza RSI 70) ──────────
  const rsi70Exit = findRSI70Exit(entry, qty, futureCandles);

  // ── Alternativa 5: Target 2× en vez del real ─────────────────────────────
  const bigTarget = entry + (realTarget - entry) * 2;
  const alt5 = simulateAlternativeEntry(
    entry, realStop, bigTarget, qty, futureCandles, 'double_target'
  );

  const alternatives = [alt1, alt2, alt3, rsi70Exit, alt5].filter(Boolean);
  const bestAlt = alternatives.reduce((best, a) => a.pnlPct > best.pnlPct ? a : best, { pnlPct: -Infinity });
  const worstAlt = alternatives.reduce((worst, a) => a.pnlPct < worst.pnlPct ? a : worst, { pnlPct: Infinity });

  return {
    tradeId: trade.id || `${trade.symbol}_${trade.entryTime}`,
    symbol: trade.symbol,
    regime,
    real: { entry, exit: trade.exit, pnl: realPnl, pnlPct: realPnlPct, exitReason: trade.exitReason },
    alternatives,
    bestAlternative: bestAlt.name,
    worstAlternative: worstAlt.name,
    opportunityCost: bestAlt.pnlPct - realPnlPct,
    learnings: generateLearnings(realPnlPct, alternatives),
  };
}

function simulateAlternativeEntry(entry, stop, target, qty, candles, name) {
  if (!candles || !candles.length) return null;
  for (const c of candles) {
    if (c.low <= stop) {
      const pnl = (stop - entry) * qty;
      return { name, entry, exit: stop, pnl, pnlPct: (stop - entry) / entry, exitReason: 'stop' };
    }
    if (c.high >= target) {
      const pnl = (target - entry) * qty;
      return { name, entry, exit: target, pnl, pnlPct: (target - entry) / entry, exitReason: 'target' };
    }
  }
  const lastClose = candles[candles.length - 1].close;
  return {
    name, entry, exit: lastClose,
    pnl: (lastClose - entry) * qty,
    pnlPct: (lastClose - entry) / entry,
    exitReason: 'end',
  };
}

function findRSI70Exit(entry, qty, candles) {
  const closes = candles.map(c => c.close);
  for (let i = 14; i < candles.length; i++) {
    const rsi = calcRSI(closes.slice(0, i + 1));
    if (rsi >= 70) {
      const exitPrice = candles[i].close;
      return {
        name: 'rsi70_exit',
        entry,
        exit: exitPrice,
        pnl: (exitPrice - entry) * qty,
        pnlPct: (exitPrice - entry) / entry,
        exitReason: 'rsi70',
      };
    }
  }
  return null;
}

function generateLearnings(realPnlPct, alternatives) {
  const learnings = [];
  const better = alternatives.filter(a => a.pnlPct > realPnlPct + 0.005);
  const worse = alternatives.filter(a => a.pnlPct < realPnlPct - 0.005);

  if (better.some(a => a.name === 'tight_stop_1atr'))
    learnings.push('Stop más estrecho habría mejorado resultado en este trade.');
  if (better.some(a => a.name === 'wide_stop_3atr'))
    learnings.push('Stop más amplio habría evitado stop prematuro.');
  if (better.some(a => a.name === 'later_entry_5bars'))
    learnings.push('Esperar confirmación adicional habría dado mejor entrada.');
  if (better.some(a => a.name === 'rsi70_exit'))
    learnings.push('Salida en RSI 70 habría capturado más ganancia.');
  if (better.some(a => a.name === 'double_target'))
    learnings.push('Target más ambicioso era alcanzable en este movimiento.');
  if (worse.some(a => a.name === 'tight_stop_1atr'))
    learnings.push('Stop estrecho habría resultado en pérdida mayor (stop hunting).');

  return learnings.length ? learnings : ['Trade ejecutado cerca del óptimo para este movimiento.'];
}

/**
 * Almacena y agrega resultados contrafactuales para aprendizaje continuo.
 */
class CounterfactualMemory {
  constructor() {
    this.records = []; // últimos N análisis
    this.MAX_RECORDS = 500;
  }

  add(analysis) {
    if (!analysis) return;
    this.records.push({ ...analysis, timestamp: Date.now() });
    if (this.records.length > this.MAX_RECORDS)
      this.records.shift();
  }

  // Cuál estrategia de salida habría sido mejor en promedio
  getBestExitStrategy() {
    const counts = {};
    for (const r of this.records) {
      if (!counts[r.bestAlternative]) counts[r.bestAlternative] = 0;
      counts[r.bestAlternative]++;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }

  // Oportunidad promedio perdida
  getAvgOpportunityCost() {
    if (!this.records.length) return 0;
    return this.records.reduce((s, r) => s + (r.opportunityCost || 0), 0) / this.records.length;
  }

  getSummary() {
    return {
      totalAnalyzed: this.records.length,
      bestExitStrategy: this.getBestExitStrategy(),
      avgOpportunityCost: this.getAvgOpportunityCost(),
      recentLearnings: this.records.slice(-10).flatMap(r => r.learnings || []),
    };
  }

  toJSON() { return { records: this.records.slice(-100), summary: this.getSummary() }; }
  loadJSON(data) { if (data?.records) this.records = data.records; }
}

module.exports = { analyzeCounterfactual, CounterfactualMemory };
