// strategyEvaluator.js — Meta-learning: evalúa y potencia estrategias en tiempo real
// El bot aprende qué técnicas funcionan en las condiciones actuales
// y adapta sus pesos automáticamente cada hora

class StrategyEvaluator {
  constructor() {
    // Performance tracking por estrategia y régimen
    this.performance = {
      MOMENTUM:      { BULL:{wins:0,total:0,pnl:0}, LATERAL:{wins:0,total:0,pnl:0}, BEAR:{wins:0,total:0,pnl:0} },
      MEAN_REVERSION:{ BULL:{wins:0,total:0,pnl:0}, LATERAL:{wins:0,total:0,pnl:0}, BEAR:{wins:0,total:0,pnl:0} },
      SCALP:         { BULL:{wins:0,total:0,pnl:0}, LATERAL:{wins:0,total:0,pnl:0}, BEAR:{wins:0,total:0,pnl:0} },
      BEAR:          { BULL:{wins:0,total:0,pnl:0}, LATERAL:{wins:0,total:0,pnl:0}, BEAR:{wins:0,total:0,pnl:0} },
      ENSEMBLE:      { BULL:{wins:0,total:0,pnl:0}, LATERAL:{wins:0,total:0,pnl:0}, BEAR:{wins:0,total:0,pnl:0} },
    };

    // Multiplicadores actuales por estrategia (aplicados al score)
    this.weights = {
      MOMENTUM:1.0, MEAN_REVERSION:1.0, SCALP:1.0, BEAR:1.0, ENSEMBLE:1.0
    };

    // Historial de adaptaciones
    this.adaptations = []; // [{ts, change, reason}]
    this.lastEval = 0;
    this.evalIntervalMs = 60*60*1000; // evaluar cada hora
  }

  // Registrar resultado de un trade
  recordTrade(strategy, regime, pnl) {
    const s = strategy?.toUpperCase()||"ENSEMBLE";
    const r = regime||"LATERAL";
    if(!this.performance[s]) this.performance[s]={BULL:{wins:0,total:0,pnl:0},LATERAL:{wins:0,total:0,pnl:0},BEAR:{wins:0,total:0,pnl:0}};
    if(!this.performance[s][r]) this.performance[s][r]={wins:0,total:0,pnl:0};
    this.performance[s][r].total++;
    this.performance[s][r].pnl+=pnl;
    if(pnl>0) this.performance[s][r].wins++;
  }

  // Evaluar y actualizar pesos
  evaluate(currentRegime) {
    const now = Date.now();
    if(now - this.lastEval < this.evalIntervalMs) return null;
    this.lastEval = now;

    const r = currentRegime||"LATERAL";
    const changes = [];

    for(const [strategy, regimes] of Object.entries(this.performance)) {
      const stats = regimes[r]||{wins:0,total:0,pnl:0};
      if(stats.total < 5) continue; // no enough data

      const wr = stats.wins/stats.total;
      const avgPnl = stats.pnl/stats.total;

      // Ajustar peso según WR y P&L promedio en el régimen actual
      const oldWeight = this.weights[strategy]||1.0;
      let newWeight;
      if(wr>0.60&&avgPnl>0.5)       newWeight = Math.min(1.5, oldWeight*1.15);  // muy bueno → boost
      else if(wr>0.50&&avgPnl>0)    newWeight = Math.min(1.3, oldWeight*1.05);  // bueno → leve boost
      else if(wr<0.35||avgPnl<-0.5) newWeight = Math.max(0.3, oldWeight*0.80);  // malo → reducir
      else                           newWeight = oldWeight*0.99; // neutral → decay leve

      if(Math.abs(newWeight-oldWeight)>0.05) {
        this.weights[strategy] = +newWeight.toFixed(2);
        changes.push(`${strategy}: ${oldWeight.toFixed(1)}→${newWeight.toFixed(2)} (WR:${Math.round(wr*100)}% avgPnl:${avgPnl.toFixed(1)}%)`);
      }
    }

    if(changes.length>0) {
      this.adaptations.push({ts:new Date().toISOString(), regime:r, changes});
      if(this.adaptations.length>50) this.adaptations.shift();
      console.log(`[META-LEARN] Régimen ${r} | Adaptaciones: ${changes.join(" | ")}`);
    }

    return changes.length>0 ? {regime:r, changes, weights:this.weights} : null;
  }

  // Obtener multiplicador para una estrategia
  getWeight(strategy) {
    return this.weights[strategy?.toUpperCase()]||1.0;
  }

  getStats() {
    const perf = {};
    for(const [s, regimes] of Object.entries(this.performance)) {
      perf[s]={};
      for(const [r, stats] of Object.entries(regimes)) {
        if(stats.total>0) perf[s][r]={wr:Math.round(stats.wins/stats.total*100),trades:stats.total,avgPnl:+(stats.pnl/stats.total).toFixed(2)};
      }
    }
    return { weights:this.weights, performance:perf, adaptations:this.adaptations.slice(-5) };
  }

  toJSON() { return { performance:this.performance, weights:this.weights, adaptations:this.adaptations }; }
  loadJSON(data) {
    if(!data) return;
    if(data.performance) this.performance=data.performance;
    if(data.weights) this.weights=data.weights;
    if(data.adaptations) this.adaptations=data.adaptations;
    console.log("[META-LEARN] Loaded strategy evaluator");
  }
}

module.exports = { StrategyEvaluator };
