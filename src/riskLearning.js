// riskLearning.js — Aprendizaje automático de la efectividad de las reglas de riesgo
// Cada vez que el bot aplica una regla de riesgo, registra la decisión y evalúa
// retroactivamente si fue correcta comparando con el precio posterior.
"use strict";

// Reglas que el sistema puede aprender a ajustar
const RULES = {
  CRYPTOPANIC_GLOBAL:  { name:"CryptoPanic global",   param:"cpGlobalThreshold",  default:5,   min:2,   max:15,  step:1    },
  CRYPTOPANIC_PAIR:    { name:"CryptoPanic par",       param:"cpPairThreshold",    default:2,   min:1,   max:8,   step:0.5  },
  CRYPTOPANIC_EXPIRY:  { name:"CryptoPanic expiración",param:"cpExpiryHours",      default:2,   min:0.5, max:6,   step:0.5  },
  DEFENSIVE_MODE:      { name:"Modo defensivo BTC",    param:"defensiveDrawdown",  default:3,   min:1,   max:8,   step:0.5  },
  BLACKLIST_LOSSES:    { name:"Blacklist pérdidas",    param:"blacklistLosses",    default:3,   min:2,   max:6,   step:1    },
  BLACKLIST_COOLDOWN:  { name:"Blacklist cooldown",    param:"blacklistCooldownH", default:24,  min:6,   max:48,  step:6    },
  CONFIDENCE_THRESH:   { name:"Umbral confianza",      param:"confidenceMin",      default:40,  min:20,  max:65,  step:5    },
  MOMENTUM_THRESH:     { name:"Momentum umbral",       param:"momentumThresh",     default:3,   min:1,   max:8,   step:1    },
  TRAILING_ACTIVATION: { name:"Trailing activación",  param:"trailingMinPct",     default:2,   min:0.5, max:4,   step:0.25 },
  STOP_MIN_PCT:        { name:"Stop mínimo %",         param:"stopMinPct",         default:2.5, min:1,   max:5,   step:0.25 },
};

class RiskLearning {
  constructor() {
    this.decisions = [];       // historial de decisiones de riesgo
    this.params = {};          // parámetros aprendidos actuales
    this.stats = {};           // estadísticas por regla
    this.lastOptimize = 0;
    this.optimizeIntervalMs = 30 * 60 * 1000; // evaluar cada 30 min

    // Inicializar params con defaults
    for (const [key, rule] of Object.entries(RULES)) {
      this.params[rule.param] = rule.default;
      this.stats[key] = { correct:0, incorrect:0, totalPriceDelta:0, n:0 };
    }
  }

  // Registrar una decisión de riesgo tomada
  // type: nombre de la regla (ej. "CRYPTOPANIC_PAIR")
  // symbol: par afectado (o null si global)
  // priceBefore: precio en el momento de la decisión
  // action: "block_entry", "reduce_size", "force_exit", "skip"
  recordDecision(type, symbol, priceBefore, action, meta={}) {
    if (!RULES[type]) return;
    this.decisions.push({
      id: Date.now()+"_"+Math.random().toString(36).slice(2,6),
      type, symbol, priceBefore, action, meta,
      ts: Date.now(),
      evaluated: false,
      priceAfter: null,
      verdict: null,
    });
    // Mantener solo últimas 500 decisiones
    if (this.decisions.length > 500) this.decisions = this.decisions.slice(-500);
  }

  // Evaluar decisiones pasadas comparando con precio actual
  // prices: { BTCUSDT: 45000, ETHUSDT: 2500, ... }
  evaluateDecisions(prices) {
    const now = Date.now();
    const evalWindowMs = 4 * 60 * 60 * 1000; // evaluar decisiones de las últimas 4h

    for (const d of this.decisions) {
      if (d.evaluated) continue;
      if (now - d.ts < 30 * 60 * 1000) continue; // esperar al menos 30 min antes de evaluar
      if (now - d.ts > evalWindowMs) {
        // Demasiado antigua, marcar como evaluada con precio actual
        d.priceAfter = d.symbol ? (prices[d.symbol] || d.priceBefore) : d.priceBefore;
        d.evaluated = true;
      } else if (d.symbol && prices[d.symbol]) {
        d.priceAfter = prices[d.symbol];
        d.evaluated = true;
      } else if (!d.symbol) {
        // Decisión global — usar BTC como proxy
        d.priceAfter = prices["BTCUSDT"] || d.priceBefore;
        d.evaluated = true;
      }

      if (!d.evaluated) continue;

      // Calcular variación de precio
      const priceDelta = ((d.priceAfter - d.priceBefore) / d.priceBefore) * 100;
      
      // Veredicto: ¿fue buena la decisión?
      // block_entry o reduce_size fue CORRECTA si el precio bajó
      // force_exit fue CORRECTA si el precio siguió bajando
      let correct;
      if (d.action === "block_entry" || d.action === "reduce_size") {
        correct = priceDelta < -0.5; // correcto si bajó más del 0.5%
      } else if (d.action === "force_exit") {
        correct = priceDelta < -0.3;
      } else {
        correct = priceDelta < 0;
      }

      d.verdict = correct ? "correct" : "incorrect";
      d.priceDelta = priceDelta;

      // Actualizar stats
      const stat = this.stats[d.type];
      if (stat) {
        stat.n++;
        stat.totalPriceDelta += priceDelta;
        if (correct) stat.correct++; else stat.incorrect++;
      }
    }
  }

  // Optimizar parámetros basándose en el historial de decisiones
  optimize() {
    const now = Date.now();
    if (now - this.lastOptimize < this.optimizeIntervalMs) return null;
    this.lastOptimize = now;

    const changes = [];

    for (const [ruleKey, stat] of Object.entries(this.stats)) {
      if (stat.n < 5) continue; // necesitar al menos 5 evaluaciones
      const rule = RULES[ruleKey];
      if (!rule) continue;

      const accuracy = stat.correct / stat.n;
      const avgDelta = stat.totalPriceDelta / stat.n;
      const current = this.params[rule.param];

      let newVal = current;

      // Si la regla acierta menos del 40% → está siendo demasiado agresiva → relajarla
      if (accuracy < 0.40) {
        newVal = Math.min(rule.max, current + rule.step);
        changes.push({ rule:rule.name, param:rule.param, from:current, to:newVal, reason:`baja precisión ${(accuracy*100).toFixed(0)}%` });
      }
      // Si acierta más del 70% y el delta promedio es muy negativo → reforzarla
      else if (accuracy > 0.70 && avgDelta < -2) {
        newVal = Math.max(rule.min, current - rule.step);
        changes.push({ rule:rule.name, param:rule.param, from:current, to:newVal, reason:`alta precisión ${(accuracy*100).toFixed(0)}%, delta ${avgDelta.toFixed(1)}%` });
      }

      if (newVal !== current) {
        this.params[rule.param] = newVal;
        // Reset stats parcialmente (decay)
        stat.correct = Math.floor(stat.correct * 0.5);
        stat.incorrect = Math.floor(stat.incorrect * 0.5);
        stat.n = stat.correct + stat.incorrect;
        stat.totalPriceDelta *= 0.5;
      }
    }

    if (changes.length) {
      console.log("[RiskLearning] Parámetros ajustados:");
      changes.forEach(c => console.log(`  ${c.rule}: ${c.param} ${c.from}→${c.to} (${c.reason})`));
    }

    return changes.length ? { changes, params:this.params } : null;
  }

  // Obtener parámetro aprendido
  get(param, fallback=null) {
    return this.params[param] ?? fallback ?? (Object.values(RULES).find(r=>r.param===param)?.default);
  }

  getStats() {
    const result = {};
    for (const [key, stat] of Object.entries(this.stats)) {
      if (stat.n === 0) continue;
      result[key] = {
        name: RULES[key]?.name,
        accuracy: +((stat.correct/stat.n)*100).toFixed(1),
        n: stat.n,
        avgPriceDelta: +(stat.totalPriceDelta/stat.n).toFixed(2),
        currentParam: this.params[RULES[key]?.param],
      };
    }
    return result;
  }

  toJSON() {
    return { decisions:this.decisions.slice(-100), params:this.params, stats:this.stats, lastOptimize:this.lastOptimize };
  }

  loadJSON(data) {
    if (!data) return;
    if (data.decisions) this.decisions = data.decisions;
    if (data.params) Object.assign(this.params, data.params);
    if (data.stats) Object.assign(this.stats, data.stats);
    if (data.lastOptimize) this.lastOptimize = data.lastOptimize;
  }
}

module.exports = { RiskLearning, RULES };
