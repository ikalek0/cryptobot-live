// live_features_patch.js
// PARCHE PARA cryptobot-live — Todas las nuevas funcionalidades
// ─────────────────────────────────────────────────────────────────────────────
// Contiene módulos listos para importar + instrucciones de integración

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO 1: Blacklist automática (3 pérdidas consecutivas → 24h cooldown)
// ══════════════════════════════════════════════════════════════════════════════
class AutoBlacklist {
  constructor(maxConsecutiveLosses = 3, cooldownMs = 24 * 60 * 60 * 1000) {
    this.maxLosses = maxConsecutiveLosses;
    this.cooldownMs = cooldownMs;
    this.consecutiveLosses = {}; // { [symbol]: count }
    this.blacklistedUntil = {};  // { [symbol]: timestamp }
  }

  recordResult(symbol, win) {
    if (win) {
      this.consecutiveLosses[symbol] = 0;
    } else {
      this.consecutiveLosses[symbol] = (this.consecutiveLosses[symbol] || 0) + 1;
      if (this.consecutiveLosses[symbol] >= this.maxLosses) {
        this.blacklistedUntil[symbol] = Date.now() + this.cooldownMs;
        console.log(`[Blacklist] ${symbol} bloqueado por ${this.cooldownMs / 3600000}h tras ${this.maxLosses} pérdidas consecutivas`);
      }
    }
  }

  isBlacklisted(symbol) {
    const until = this.blacklistedUntil[symbol];
    if (!until) return false;
    if (Date.now() >= until) {
      // Cooldown expirado — reset
      delete this.blacklistedUntil[symbol];
      this.consecutiveLosses[symbol] = 0;
      console.log(`[Blacklist] ${symbol} desbloqueado`);
      return false;
    }
    return true;
  }

  getStatus() {
    return Object.entries(this.blacklistedUntil).map(([symbol, until]) => ({
      symbol,
      blacklistedUntil: new Date(until).toISOString(),
      remainingHours: Math.max(0, (until - Date.now()) / 3600000).toFixed(1),
      consecutiveLosses: this.consecutiveLosses[symbol] || 0,
    }));
  }

  toJSON() {
    return { consecutiveLosses: this.consecutiveLosses, blacklistedUntil: this.blacklistedUntil };
  }
  loadJSON(data) {
    if (!data) return;
    if (data.consecutiveLosses) this.consecutiveLosses = data.consecutiveLosses;
    if (data.blacklistedUntil) this.blacklistedUntil = data.blacklistedUntil;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO 2: Cierre parcial de posiciones (50% al objetivo, 50% sigue corriendo)
// ══════════════════════════════════════════════════════════════════════════════
class PartialCloseManager {
  constructor() {
    // { [positionId]: { partialClosed: bool, originalQty: number } }
    this.state = {};
  }

  initPosition(posId, qty) {
    this.state[posId] = { partialClosed: false, originalQty: qty };
  }

  shouldPartialClose(posId, currentPrice, target) {
    const s = this.state[posId];
    if (!s || s.partialClosed) return false;
    return currentPrice >= target;
  }

  executePartialClose(posId, currentQty) {
    const s = this.state[posId];
    if (!s || s.partialClosed) return null;
    const closeQty = currentQty * 0.5;
    const remainQty = currentQty - closeQty;
    s.partialClosed = true;
    return { closeQty, remainQty };
  }

  // After partial close, trail the stop to breakeven for remaining position
  getTrailedStop(posId, entryPrice) {
    const s = this.state[posId];
    if (s?.partialClosed) return entryPrice; // at least breakeven
    return null;
  }

  hasPartialClosed(posId) {
    return this.state[posId]?.partialClosed || false;
  }

  cleanup(posId) {
    delete this.state[posId];
  }

  toJSON() { return { state: this.state }; }
  loadJSON(data) { if (data?.state) this.state = data.state; }
}

// Integration note for engine.js:
/*
// In your position exit check:
const partial = partialCloseManager;
if (partial.shouldPartialClose(posId, currentPrice, position.target)) {
  const { closeQty, remainQty } = partial.executePartialClose(posId, position.qty);
  // Execute partial sell (closeQty) via Binance
  await binance.sell(symbol, closeQty);
  position.qty = remainQty;
  position.stop = partial.getTrailedStop(posId, position.entry); // trail to breakeven
  console.log(`[PartialClose] ${symbol}: vendido 50% a ${currentPrice}, quedan ${remainQty}`);
}
*/

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO 3: Modo defensivo por noticias (CryptoPanic → reducir tamaño 50%)
// ══════════════════════════════════════════════════════════════════════════════
const https = require('https');

class NewsDefenseMode {
  constructor(cryptoPanicToken) {
    this.token = cryptoPanicToken || process.env.CRYPTOPANIC_TOKEN || '';
    this.defensivePairs = new Set(); // symbols currently under defensive mode
    this.lastCheck = 0;
    this.checkIntervalMs = 15 * 60 * 1000; // check every 15 min
    this.isDefensiveGlobal = false; // global defensive if many negatives
    this.sentimentCache = {}; // { [symbol]: { score, updatedAt } }
  }

  async checkNews() {
    if (Date.now() - this.lastCheck < this.checkIntervalMs) return;
    this.lastCheck = Date.now();

    try {
      const data = await this._fetchCryptoPanic();
      this._processSentiment(data);
    } catch (e) {
      console.warn('[NewsDefense] Error fetching CryptoPanic:', e.message);
    }
  }

  _fetchCryptoPanic() {
    return new Promise((resolve, reject) => {
      const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${this.token}&filter=important&currencies=BTC,ETH,SOL,BNB&kind=news`;
      https.get(url, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  _processSentiment(data) {
    if (!data?.results) return;
    const newDefensive = new Set();
    let negativeCount = 0;

    for (const item of data.results.slice(0, 20)) {
      const votes = item.votes || {};
      const negative = (votes.negative || 0) + (votes.important || 0) * 0.3;
      const positive = votes.positive || 0;
      const score = positive - negative;

      // Extract currencies mentioned
      const currencies = item.currencies?.map(c => c.code + 'USDT') || [];

      if (score < -2) {
        negativeCount++;
        for (const sym of currencies) newDefensive.add(sym);
      }

      for (const sym of currencies) {
        this.sentimentCache[sym] = { score, updatedAt: Date.now() };
      }
    }

    this.defensivePairs = newDefensive;
    this.isDefensiveGlobal = negativeCount >= 5;

    if (this.defensivePairs.size > 0 || this.isDefensiveGlobal) {
      console.log(`[NewsDefense] Modo defensivo: ${[...this.defensivePairs].join(', ')} ${this.isDefensiveGlobal ? '(GLOBAL)' : ''}`);
    }
  }

  // Returns size multiplier (1.0 = normal, 0.5 = defensive)
  getSizeMultiplier(symbol) {
    if (this.isDefensiveGlobal) return 0.5;
    if (this.defensivePairs.has(symbol)) return 0.5;
    return 1.0;
  }

  getStatus() {
    return {
      defensive: [...this.defensivePairs],
      globalDefensive: this.isDefensiveGlobal,
      lastCheck: new Date(this.lastCheck).toISOString(),
      sentiment: this.sentimentCache,
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO 4: Stop loss dinámico por volatilidad (ATR alto → stop más amplio)
// ══════════════════════════════════════════════════════════════════════════════
function calcDynamicStop(entryPrice, atr, regime, options = {}) {
  const {
    minMultiplier = 1.5,
    maxMultiplier = 3.5,
    normalMultiplier = 2.0,
  } = options;

  // ATR as % of price
  const atrPct = atr / entryPrice;

  // Dynamic multiplier based on ATR level
  let multiplier;
  if (atrPct < 0.005) {
    // Very calm market — tighter stop
    multiplier = minMultiplier;
  } else if (atrPct < 0.015) {
    // Normal volatility
    multiplier = normalMultiplier;
  } else if (atrPct < 0.03) {
    // High volatility
    multiplier = 2.5;
  } else {
    // Extreme volatility — wider stop to avoid premature exits
    multiplier = maxMultiplier;
  }

  // Adjust by regime
  if (regime === 'BEAR') multiplier *= 1.2;   // wider in bear (volatile)
  if (regime === 'LATERAL') multiplier *= 0.9; // tighter in lateral

  // Cap multiplier
  multiplier = Math.min(maxMultiplier, Math.max(minMultiplier, multiplier));

  const stop = entryPrice - atr * multiplier;

  return {
    stop,
    multiplier,
    atrPct: (atrPct * 100).toFixed(3) + '%',
    stopPct: ((entryPrice - stop) / entryPrice * 100).toFixed(2) + '%',
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO 5: Walk-forward analysis en backtesting
// ══════════════════════════════════════════════════════════════════════════════
let simulatePeriod;
try { simulatePeriod = require('./historicalSimulation').simulatePeriod; } catch { simulatePeriod = null; }

async function walkForwardAnalysis(symbol, candles, options = {}) {
  if (!simulatePeriod) return null; // no disponible en live bot
  const {
    trainRatio = 0.7,
    windowSize = null,
    numFolds = 5,
  } = options;

  if (candles.length < 100) return null;

  const results = [];

  if (windowSize) {
    // Rolling window walk-forward
    const step = Math.floor((candles.length - windowSize) / numFolds);
    for (let i = 0; i < numFolds; i++) {
      const start = i * step;
      const trainEnd = start + Math.floor(windowSize * trainRatio);
      const testEnd = start + windowSize;
      if (testEnd > candles.length) break;

      const trainCandles = candles.slice(start, trainEnd);
      const testCandles = candles.slice(trainEnd, testEnd);

      const trainResult = simulatePeriod(symbol, trainCandles);
      const testResult = simulatePeriod(symbol, testCandles);

      results.push({
        fold: i + 1,
        trainPeriod: { start: trainCandles[0]?.openTime, end: trainCandles[trainCandles.length - 1]?.closeTime },
        testPeriod: { start: testCandles[0]?.openTime, end: testCandles[testCandles.length - 1]?.closeTime },
        trainReturn: trainResult?.totalReturn,
        testReturn: testResult?.totalReturn,
        trainWinRate: trainResult?.winRate,
        testWinRate: testResult?.winRate,
        overfitRatio: trainResult?.totalReturn && testResult?.totalReturn
          ? testResult.totalReturn / trainResult.totalReturn
          : null,
      });
    }
  } else {
    // Simple train/test split
    const splitIdx = Math.floor(candles.length * trainRatio);
    const trainCandles = candles.slice(0, splitIdx);
    const testCandles = candles.slice(splitIdx);
    const train = simulatePeriod(symbol, trainCandles);
    const test = simulatePeriod(symbol, testCandles);
    results.push({
      fold: 1,
      trainReturn: train?.totalReturn, testReturn: test?.totalReturn,
      trainWinRate: train?.winRate, testWinRate: test?.winRate,
      overfitRatio: train?.totalReturn && test?.totalReturn ? test.totalReturn / train.totalReturn : null,
    });
  }

  const avgOverfit = results.filter(r => r.overfitRatio != null).reduce((s, r) => s + r.overfitRatio, 0) / results.length;
  const isRobust = avgOverfit > 0.5; // test achieves at least 50% of train performance

  return { symbol, folds: results, avgOverfitRatio: avgOverfit, isRobust };
}

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO 6: Score de confianza 0-100
// ══════════════════════════════════════════════════════════════════════════════
class ConfidenceScore {
  constructor() {
    this.score = 50; // start neutral
    this.history = []; // últimos N resultados para calcular score dinámico
    this.MAX_HISTORY = 100;
  }

  // Factors that affect confidence
  update({
    recentWinRate,      // last N trades win rate
    consecutiveWins,
    consecutiveLosses,
    drawdownFromPeak,   // current drawdown 0-1
    dailyPnlPct,        // today's P&L as %
    circuitBreakerActive,
  }) {
    let score = 50;

    // Win rate contribution (0-30 pts)
    if (recentWinRate != null) {
      score += (recentWinRate - 0.5) * 60; // 50% WR → 0, 80% → +18, 30% → -12
      score = Math.max(0, Math.min(100, score));
    }

    // Streaks (+/- 10 pts)
    if (consecutiveWins >= 3) score = Math.min(100, score + consecutiveWins * 3);
    if (consecutiveLosses >= 2) score = Math.max(0, score - consecutiveLosses * 5);

    // Drawdown penalty (up to -30 pts)
    if (drawdownFromPeak != null) {
      score -= drawdownFromPeak * 100; // -10 pts per 10% drawdown
    }

    // Daily P&L (+/- 10 pts)
    if (dailyPnlPct != null) {
      score += Math.max(-10, Math.min(10, dailyPnlPct * 500));
    }

    // Circuit breaker active → floor at 20
    if (circuitBreakerActive) score = Math.min(score, 20);

    this.score = Math.round(Math.max(0, Math.min(100, score)));
    this.history.push({ score: this.score, timestamp: Date.now() });
    if (this.history.length > this.MAX_HISTORY) this.history.shift();
  }

  get() { return this.score; }

  getLabel() {
    if (this.score >= 80) return 'Muy alta';
    if (this.score >= 65) return 'Alta';
    if (this.score >= 45) return 'Moderada';
    if (this.score >= 30) return 'Baja';
    return 'Muy baja';
  }

  getColor() {
    if (this.score >= 80) return '#00c851';
    if (this.score >= 65) return '#33b5e5';
    if (this.score >= 45) return '#ffbb33';
    if (this.score >= 30) return '#ff8800';
    return '#cc0000';
  }

  toJSON() { return { score: this.score, history: this.history.slice(-20) }; }
  loadJSON(data) {
    if (data?.score != null) this.score = data.score;
    if (data?.history) this.history = data.history;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// INSTRUCCIONES DE INTEGRACIÓN EN server.js / engine.js del live bot
// ══════════════════════════════════════════════════════════════════════════════
/*
// 1. Requires:
const { AutoBlacklist } = require('./live_features_patch');
const { PartialCloseManager } = require('./live_features_patch');
const { NewsDefenseMode } = require('./live_features_patch');
const { calcDynamicStop } = require('./live_features_patch');
const { walkForwardAnalysis } = require('./live_features_patch');
const { ConfidenceScore } = require('./live_features_patch');

// 2. Init (en constructor/bot init):
this.blacklist = new AutoBlacklist(3, 24 * 3600 * 1000);
this.partialClose = new PartialCloseManager();
this.newsDefense = new NewsDefenseMode(process.env.CRYPTOPANIC_TOKEN);
this.confidence = new ConfidenceScore();

// 3. En tick():
await this.newsDefense.checkNews();
// Recalcular confidence periódicamente:
this.confidence.update({
  recentWinRate: calcRecentWinRate(this.trades, 20),
  consecutiveWins: this.consecutiveWins,
  consecutiveLosses: this.consecutiveLosses,
  drawdownFromPeak: this.drawdownFromPeak,
  dailyPnlPct: this.dailyPnlPct,
  circuitBreakerActive: this.circuitBreaker?.active || false,
});

// 4. En entrada (antes de comprar):
if (this.blacklist.isBlacklisted(symbol)) continue; // skip blacklisted

const newsMultiplier = this.newsDefense.getSizeMultiplier(symbol);
const finalQty = baseQty * newsMultiplier;

const { stop } = calcDynamicStop(price, atr, regime);
const posId = `${symbol}_${Date.now()}`;
this.partialClose.initPosition(posId, finalQty);

// 5. En salida (exit check):
if (this.partialClose.shouldPartialClose(posId, price, position.target)) {
  const { closeQty, remainQty } = this.partialClose.executePartialClose(posId, position.qty);
  await executeSell(symbol, closeQty, 'partial_target');
  position.qty = remainQty;
  position.stop = this.partialClose.getTrailedStop(posId, position.entry);
}

// 6. En cierre de trade:
this.blacklist.recordResult(symbol, pnl > 0);

// 7. En saveState():
const extraState = {
  blacklist: this.blacklist.toJSON(),
  partialClose: this.partialClose.toJSON(),
  confidence: this.confidence.toJSON(),
};

// 8. API endpoint para confidence:
app.get('/confidence', (req, res) => {
  res.json({
    score: bot.confidence.get(),
    label: bot.confidence.getLabel(),
    color: bot.confidence.getColor(),
    blacklist: bot.blacklist.getStatus(),
    news: bot.newsDefense.getStatus(),
  });
});
*/

module.exports = { AutoBlacklist, PartialCloseManager, NewsDefenseMode, calcDynamicStop, walkForwardAnalysis, ConfidenceScore };
