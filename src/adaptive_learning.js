// adaptive_learning.js — Autoaprendizaje para subsistemas que antes eran estáticos
"use strict";

// ── 1. Stop Loss Adaptativo ───────────────────────────────────────────────────
// Aprende el stop óptimo por par, régimen y hora
// Analiza trades históricos: ¿cuál stop hubiera maximizado P&L?
class AdaptiveStopLoss {
  constructor() {
    // { "BTCUSDC_LATERAL_14": { optimalPct: 0.025, samples: 12, lastUpdate: ts } }
    this.stops = {};
    this.defaultStop = 0.03; // 3% por defecto
    this.minSamples = 8;     // mínimo para confiar en la estimación
  }

  _key(symbol, regime, hour) {
    return `${symbol}_${regime}_${hour}`;
  }

  // Llamar al cerrar cada trade para aprender
  recordTrade(trade, regime, entryHour) {
    if(!trade.symbol || trade.pnl == null) return;
    const key = this._key(trade.symbol, regime, entryHour);
    if(!this.stops[key]) this.stops[key] = { samples:[], optimalPct:this.defaultStop };

    // Calcular qué stop hubiera sido óptimo para este trade
    // Si fue pérdida por stop → el stop era demasiado estrecho (o entrada mala)
    // Si fue ganancia → el stop era adecuado
    const wasStopLoss = trade.reason === "STOP LOSS";
    const wasTrailing = trade.reason === "TRAILING STOP";
    const isWin = trade.pnl > 0;

    // Estimación simple: si el stop saltó con pérdida pequeña (<0.2%), era demasiado estrecho
    const pnlAbs = Math.abs(trade.pnl);
    let suggestedStop = this.stops[key].optimalPct;
    if(wasStopLoss && !isWin && pnlAbs < 0.25) {
      // Stop demasiado estrecho → ampliar un 10%
      suggestedStop = Math.min(0.08, suggestedStop * 1.10);
    } else if(wasStopLoss && !isWin && pnlAbs > 1.5) {
      // Stop demasiado amplio → estrechar
      suggestedStop = Math.max(0.01, suggestedStop * 0.92);
    } else if(isWin && wasTrailing) {
      // Stop funcionó bien → mantener con pequeño ajuste
      suggestedStop = suggestedStop * 0.98;
    }

    this.stops[key].samples.push(suggestedStop);
    if(this.stops[key].samples.length > 30) this.stops[key].samples.shift();

    // Actualizar como media de las últimas sugerencias
    if(this.stops[key].samples.length >= this.minSamples) {
      const mean = this.stops[key].samples.reduce((s,v)=>s+v,0) / this.stops[key].samples.length;
      this.stops[key].optimalPct = +mean.toFixed(4);
      this.stops[key].lastUpdate = Date.now();
    }
  }

  // Obtener stop recomendado para una nueva entrada
  getStop(symbol, regime, hour, fallback = this.defaultStop) {
    const key = this._key(symbol, regime, hour);
    const entry = this.stops[key];
    if(entry && entry.samples.length >= this.minSamples) {
      return entry.optimalPct;
    }
    // Si no hay datos para este par+régimen+hora, usar el promedio del régimen
    const regimeKeys = Object.keys(this.stops).filter(k=>k.includes(`_${regime}_`));
    if(regimeKeys.length >= 3) {
      const avg = regimeKeys.reduce((s,k)=>s+(this.stops[k].optimalPct||fallback),0)/regimeKeys.length;
      return +avg.toFixed(4);
    }
    return fallback;
  }

  getStats() {
    const entries = Object.entries(this.stops);
    return {
      learnedPairs: entries.length,
      avgStop: entries.length ? +(entries.reduce((s,[,v])=>s+v.optimalPct,0)/entries.length).toFixed(4) : this.defaultStop,
      mostTuned: entries.sort((a,b)=>b[1].samples.length-a[1].samples.length).slice(0,3).map(([k,v])=>({key:k,stop:v.optimalPct,samples:v.samples.length})),
    };
  }

  serialize() { return this.stops; }
  restore(data) { if(data) this.stops = data; }
}

// ── 2. Horas de operación adaptativas ────────────────────────────────────────
// Aprende qué horas son más rentables para cada par y régimen
class AdaptiveHours {
  constructor() {
    // { "BTCUSDC_LATERAL": { 14: {wins:5,total:8}, 15: {wins:3,total:6}, ... } }
    this.hourStats = {};
    this.minSamples = 5;
  }

  _key(symbol, regime) { return `${symbol}_${regime}`; }

  recordTrade(trade, regime) {
    if(!trade.symbol || !trade.ts) return;
    const hour = new Date(trade.ts).getUTCHours();
    const key = this._key(trade.symbol, regime);
    if(!this.hourStats[key]) this.hourStats[key] = {};
    if(!this.hourStats[key][hour]) this.hourStats[key][hour] = {wins:0, total:0, pnlSum:0};
    this.hourStats[key][hour].total++;
    this.hourStats[key][hour].pnlSum += trade.pnl||0;
    if((trade.pnl||0) > 0) this.hourStats[key][hour].wins++;
  }

  // Retorna un multiplicador 0.3-1.5 para la hora actual
  getHourMultiplier(symbol, regime, currentHour) {
    const key = this._key(symbol, regime);
    const stats = this.hourStats[key]?.[currentHour];
    if(!stats || stats.total < this.minSamples) return 1.0; // sin datos → neutral

    const wr = stats.wins / stats.total;
    const avgPnl = stats.pnlSum / stats.total;

    // Score combinado: WR + P&L promedio
    const score = wr * 0.6 + (avgPnl > 0 ? Math.min(1, avgPnl/2) : 0) * 0.4;
    // Mapear score 0-1 a multiplicador 0.4-1.4
    return Math.max(0.4, Math.min(1.4, 0.4 + score * 1.0));
  }

  // Mejor hora del día para un par/régimen
  getBestHours(symbol, regime, topN=3) {
    const key = this._key(symbol, regime);
    const stats = this.hourStats[key]||{};
    return Object.entries(stats)
      .filter(([,s])=>s.total>=this.minSamples)
      .map(([h,s])=>({hour:parseInt(h), wr:+(s.wins/s.total*100).toFixed(0), avgPnl:+(s.pnlSum/s.total).toFixed(2), total:s.total}))
      .sort((a,b)=>b.wr-a.wr)
      .slice(0,topN);
  }

  getStats() {
    const allKeys = Object.keys(this.hourStats);
    return { learnedCombinations: allKeys.length, totalObservations: Object.values(this.hourStats).reduce((s,h)=>s+Object.values(h).reduce((s2,v)=>s2+v.total,0),0) };
  }

  serialize() { return this.hourStats; }
  restore(data) { if(data) this.hourStats = data; }
}

// ── 3. CryptoPanic: aprender qué noticias importan ───────────────────────────
// Registra si una noticia negativa fue seguida de caída real de precio
class NewsImpactLearner {
  constructor() {
    // { "BTC": { truePositives:5, falsePositives:12, avgImpact:-2.3 } }
    this.coinStats = {};
    this.keywordStats = {}; // { "hack": { tp:3, fp:8 } }
    this.minSamples = 5;
  }

  // Registrar cuándo una noticia no causó movimiento real (falso positivo)
  recordOutcome(symbol, wasNegative, priceChangePct, keywords=[]) {
    const coin = symbol.replace("USDC","").replace("USDT","");
    if(!this.coinStats[coin]) this.coinStats[coin] = {tp:0,fp:0,impact:[]};
    const actuallyMoved = Math.abs(priceChangePct) > 1.0;
    if(wasNegative && actuallyMoved && priceChangePct < 0) this.coinStats[coin].tp++;
    else if(wasNegative && !actuallyMoved) this.coinStats[coin].fp++;
    this.coinStats[coin].impact.push(priceChangePct);
    if(this.coinStats[coin].impact.length > 50) this.coinStats[coin].impact.shift();

    // Aprender por keyword
    for(const kw of keywords) {
      if(!this.keywordStats[kw]) this.keywordStats[kw] = {tp:0,fp:0};
      if(actuallyMoved && priceChangePct < 0) this.keywordStats[kw].tp++;
      else this.keywordStats[kw].fp++;
    }
  }

  // ¿Cuánto reducir el tamaño por noticias negativas de este coin?
  getNewsMultiplier(symbol) {
    const coin = symbol.replace("USDC","").replace("USDT","");
    const stats = this.coinStats[coin];
    if(!stats || (stats.tp+stats.fp) < this.minSamples) return 0.7; // default conservador

    const precision = stats.tp / (stats.tp + stats.fp); // % de noticias que realmente impactaron
    // Alta precisión → reducir más (las noticias de este coin SÍ importan)
    // Baja precisión → reducir menos (las noticias suelen ser ruido)
    return Math.max(0.4, Math.min(1.0, 0.4 + precision * 0.6));
  }

  getStats() {
    return {
      trackedCoins: Object.keys(this.coinStats).length,
      highImpactCoins: Object.entries(this.coinStats)
        .filter(([,s])=>(s.tp+s.fp)>=this.minSamples)
        .map(([coin,s])=>({coin, precision:+(s.tp/(s.tp+s.fp)*100).toFixed(0)+"%", samples:s.tp+s.fp}))
        .sort((a,b)=>parseInt(b.precision)-parseInt(a.precision))
        .slice(0,5),
    };
  }

  serialize() { return {coinStats:this.coinStats, keywordStats:this.keywordStats}; }
  restore(data) { if(data?.coinStats) this.coinStats=data.coinStats; if(data?.keywordStats) this.keywordStats=data.keywordStats; }
}

// ── 4. Q-Learning learning rate decay ────────────────────────────────────────
// Adapta el learning rate según la experiencia acumulada
function calcAdaptiveLR(baseLR, nTrades, recentWR, targetWR=0.50) {
  // Decaer con trades: menos agresivo cuanta más experiencia
  const decayFactor = Math.max(0.2, 1 / (1 + nTrades / 500));
  // Boost si el WR está por debajo del target (necesita aprender más)
  const errorBoost = recentWR < targetWR ? 1.5 : 0.8;
  return Math.max(0.005, Math.min(0.3, baseLR * decayFactor * errorBoost));
}

// ── 5. Detección de régimen adaptativa (HMM simplificado) ────────────────────
// Aprende cuándo cambiar de régimen basándose en señales múltiples
class AdaptiveRegimeDetector {
  constructor() {
    // Pesos aprendidos para cada señal
    this.weights = {
      ema_cross:    1.0,  // EMA20 vs EMA50 (señal clásica)
      rsi_level:    0.8,  // RSI alto/bajo
      volume_trend: 0.6,  // Volumen creciente/decreciente
      bb_width:     0.5,  // Bandas de Bollinger anchas/estrechas
      ls_ratio:     0.7,  // Long/Short ratio
      fg_level:     0.6,  // Fear & Greed
    };
    this.history = []; // historial de regímenes reales vs predichos
    this.minSamples = 20;
    this.calibrated = false;
  }

  // Calcular régimen usando señales ponderadas
  detect(signals) {
    const { ema20, ema50, rsi, bbWidth, volume, lsRatio, fg } = signals;
    let score = 0; // positivo = BULL, negativo = BEAR

    // Cada señal contribuye ponderada
    if(ema20 != null && ema50 != null) score += this.weights.ema_cross * (ema20 > ema50 ? 1 : -1);
    if(rsi != null) score += this.weights.rsi_level * (rsi < 40 ? -0.5 : rsi > 60 ? 0.5 : 0);
    if(lsRatio != null) score += this.weights.ls_ratio * (lsRatio > 1.5 ? 0.5 : lsRatio < 0.8 ? -0.5 : 0);
    if(fg != null) score += this.weights.fg_level * (fg < 35 ? -0.5 : fg > 65 ? 0.5 : 0);

    const maxScore = Object.values(this.weights).reduce((s,v)=>s+v,0);
    const normalizedScore = score / maxScore; // -1 a +1

    if(normalizedScore > 0.25) return "BULL";
    if(normalizedScore < -0.25) return "BEAR";
    return "LATERAL";
  }

  // Registrar qué régimen fue correcto (basado en P&L de trades en ese régimen)
  recordOutcome(predictedRegime, actualPnlInRegime, signals) {
    this.history.push({ predicted:predictedRegime, pnl:actualPnlInRegime, signals, ts:Date.now() });
    if(this.history.length > 100) this.history.shift();

    // Calibrar pesos si hay suficientes datos (cada 20 observaciones)
    if(this.history.length >= this.minSamples && this.history.length % 20 === 0) {
      this._calibrate();
    }
  }

  _calibrate() {
    // Gradiente simple: si el régimen fue incorrecto (pnl negativo cuando predijo BULL),
    // reducir el peso de la señal que más contribuyó al error
    const recentErrors = this.history.filter(h=>h.pnl<0).slice(-10);
    if(recentErrors.length < 3) return;

    // Identificar qué señal predominaba en los errores
    const lr = 0.05;
    for(const key of Object.keys(this.weights)) {
      const errorRate = recentErrors.filter(h=>h.signals?.[key] != null).length / recentErrors.length;
      if(errorRate > 0.7) {
        // Esta señal predomina en los errores → reducir su peso
        this.weights[key] = Math.max(0.1, this.weights[key] * (1 - lr));
      }
    }
    // Renormalizar
    const total = Object.values(this.weights).reduce((s,v)=>s+v,0);
    for(const k of Object.keys(this.weights)) this.weights[k] = +(this.weights[k]/total*2).toFixed(4);
    this.calibrated = true;
    console.log("[REGIME-HMM] Pesos calibrados:", JSON.stringify(this.weights));
  }

  getStats() {
    return { weights:this.weights, observations:this.history.length, calibrated:this.calibrated };
  }

  serialize() { return { weights:this.weights, history:this.history.slice(-50) }; }
  restore(data) { if(data?.weights) this.weights=data.weights; if(data?.history) this.history=data.history; }
}

// ── 6. Kelly adaptativo por volatilidad del portfolio ────────────────────────
// Ajusta la fracción de Kelly según la correlación actual entre posiciones
function calcAdaptiveKelly(baseFraction, portfolio, prices, history) {
  if(!portfolio || Object.keys(portfolio).length === 0) return baseFraction;

  // Calcular correlación media entre posiciones abiertas
  const syms = Object.keys(portfolio);
  if(syms.length < 2) return baseFraction;

  let corrSum = 0, corrCount = 0;
  for(let i=0; i<syms.length; i++) {
    for(let j=i+1; j<syms.length; j++) {
      const h1 = (history[syms[i]]||[]).slice(-50);
      const h2 = (history[syms[j]]||[]).slice(-50);
      if(h1.length < 10 || h2.length < 10) continue;
      const len = Math.min(h1.length, h2.length);
      const r1 = h1.slice(-len), r2 = h2.slice(-len);
      const mean1 = r1.reduce((s,v)=>s+v,0)/len, mean2 = r2.reduce((s,v)=>s+v,0)/len;
      const cov = r1.reduce((s,v,i)=>s+(v-mean1)*(r2[i]-mean2),0)/len;
      const std1 = Math.sqrt(r1.reduce((s,v)=>s+(v-mean1)**2,0)/len);
      const std2 = Math.sqrt(r2.reduce((s,v)=>s+(v-mean2)**2,0)/len);
      if(std1>0 && std2>0) { corrSum+=cov/(std1*std2); corrCount++; }
    }
  }

  if(corrCount === 0) return baseFraction;
  const avgCorr = corrSum / corrCount; // -1 a +1

  // Alta correlación = más riesgo concentrado → reducir Kelly
  // Baja/negativa correlación = portfolio diversificado → Kelly puede ser más agresivo
  const corrAdj = avgCorr > 0.7 ? 0.5 : avgCorr > 0.5 ? 0.7 : avgCorr > 0.3 ? 0.85 : 1.0;
  return +(baseFraction * corrAdj).toFixed(4);
}

module.exports = {
  AdaptiveStopLoss,
  AdaptiveHours,
  NewsImpactLearner,
  AdaptiveRegimeDetector,
  calcAdaptiveLR,
  calcAdaptiveKelly,
};
