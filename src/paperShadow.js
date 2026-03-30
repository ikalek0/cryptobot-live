// paperShadow.js — Sistema de validación A/B en tiempo real
// Paper abre una posición → Live la "sombrea" (observa sin ejecutar)
// Si la señal gana ≥ CONFIDENCE_THRESHOLD → Live la adopta la próxima vez

const CONFIDENCE_THRESHOLD = 0.65; // 65% win rate para adoptar señal
const MIN_OBSERVATIONS = 5;         // mínimo 5 observaciones antes de decidir
const SHADOW_MAX_HOURS = 24;        // máximo 24h de observación por posición

class PaperShadow {
  constructor() {
    // Señales observadas: {signalKey: {wins, total, avgPnl, lastSeen, adopted}}
    this.signals = {};
    // Señales activas siendo observadas ahora
    this.active = {}; // {symbol: {entryPrice, entryState, ts, strategy, regime}}
    // Señales adoptadas (live las ejecutará)
    this.adopted = new Set();
    this.stats = { totalObserved:0, totalAdopted:0, totalRejected:0 };
  }

  // Paper abre posición → live empieza a observarla
  shadowEntry(symbol, entryPrice, strategy, regime, stateKey) {
    const key = this._makeKey(strategy, regime);
    if(!this.signals[key]) this.signals[key]={ wins:0, total:0, avgPnl:0, lastSeen:0, adopted:false };
    this.active[symbol] = { entryPrice, strategy, regime, stateKey, ts:Date.now(), key };
    console.log(`[SHADOW] Observando ${symbol} (${strategy}/${regime}) → ya tenemos ${this.signals[key].total} obs`);
  }

  // Paper cierra posición → registrar resultado
  shadowExit(symbol, exitPrice, pnl) {
    const obs = this.active[symbol];
    if(!obs) return;
    const key = obs.key;
    const sig = this.signals[key];
    if(!sig) { delete this.active[symbol]; return; }

    sig.total++;
    sig.avgPnl = (sig.avgPnl*(sig.total-1) + pnl) / sig.total;
    if(pnl > 0) sig.wins++;
    sig.lastSeen = Date.now();
    this.stats.totalObserved++;

    const wr = sig.wins/sig.total;
    // Decidir si adoptar
    if(sig.total >= MIN_OBSERVATIONS && !sig.adopted) {
      if(wr >= CONFIDENCE_THRESHOLD && sig.avgPnl > 0.2) {
        sig.adopted = true;
        this.adopted.add(key);
        this.stats.totalAdopted++;
        console.log(`[SHADOW] ✅ ADOPTADA: ${key} WR=${Math.round(wr*100)}% avgPnl=${sig.avgPnl.toFixed(2)}% (${sig.total} obs)`);
      } else if(sig.total >= MIN_OBSERVATIONS*2 && wr < 0.45) {
        this.stats.totalRejected++;
        console.log(`[SHADOW] ❌ RECHAZADA: ${key} WR=${Math.round(wr*100)}% avgPnl=${sig.avgPnl.toFixed(2)}% (${sig.total} obs)`);
      }
    }
    delete this.active[symbol];
  }

  // ¿Debería live ejecutar esta señal?
  shouldExecute(strategy, regime) {
    const key = this._makeKey(strategy, regime);
    // Si nunca observada o rechazada → NO ejecutar (modo conservador)
    return this.adopted.has(key);
  }

  // ¿Cuánta confianza tenemos en esta señal?
  getConfidence(strategy, regime) {
    const key = this._makeKey(strategy, regime);
    const sig = this.signals[key];
    if(!sig || sig.total<3) return 0;
    return sig.wins/sig.total;
  }

  _makeKey(strategy, regime) {
    return `${strategy||"ENSEMBLE"}|${regime||"LATERAL"}`;
  }

  // Limpiar observaciones antiguas (>48h sin nueva observación)
  cleanup() {
    const now = Date.now();
    for(const [sym, obs] of Object.entries(this.active)) {
      if(now - obs.ts > SHADOW_MAX_HOURS*3600000) {
        console.log(`[SHADOW] Timeout ${sym} (${SHADOW_MAX_HOURS}h)`);
        delete this.active[sym];
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      adopted: [...this.adopted],
      signals: Object.fromEntries(
        Object.entries(this.signals).map(([k,v])=>[k,{
          wr:v.total>0?Math.round(v.wins/v.total*100):0,
          total:v.total, avgPnl:+v.avgPnl.toFixed(2), adopted:v.adopted
        }])
      ),
      activeCount: Object.keys(this.active).length,
    };
  }

  toJSON() {
    return { signals:this.signals, adopted:[...this.adopted], stats:this.stats };
  }

  loadJSON(data) {
    if(!data) return;
    if(data.signals) this.signals=data.signals;
    if(data.adopted) this.adopted=new Set(data.adopted);
    if(data.stats) this.stats=data.stats;
    console.log(`[SHADOW] Loaded: ${Object.keys(this.signals).length} señales, ${this.adopted.size} adoptadas`);
  }
}

module.exports = { PaperShadow };
