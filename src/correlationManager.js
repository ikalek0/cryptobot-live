// correlationManager.js — Gestión inteligente de correlación entre pares
// Usa la correlación a FAVOR cuando los pares confirman señales alcistas,
// y como PROTECCIÓN cuando uno en pérdida arrastra al otro.
"use strict";

// Grupos de correlación alta (>0.75 históricamente)
const CORRELATION_GROUPS = {
  BTC_CORE:   ["BTCUSDT", "ETHUSDT"],                              // correlación ~0.85
  L1_ALTS:    ["SOLUSDT", "AVAXUSDT", "ADAUSDT", "DOTUSDT", "ATOMUSDT"],  // ~0.80
  L2_DEFI:    ["MATICUSDT", "OPUSDT", "ARBUSDT"],                 // ~0.82
  DEFI:       ["UNIUSDT", "AAVEUSDT", "LINKUSDT"],                // ~0.75
  MEME_MAJOR: ["XRPUSDT", "LTCUSDT"],                             // ~0.70
  APT_NEAR:   ["APTUSDT", "NEARUSDT"],                            // ~0.72
};

// Construir mapa inverso: symbol → grupo
const SYMBOL_TO_GROUP = {};
for (const [group, symbols] of Object.entries(CORRELATION_GROUPS)) {
  for (const sym of symbols) SYMBOL_TO_GROUP[sym] = group;
}

class CorrelationManager {
  constructor() {
    this.priceHistory = {}; // { symbol: [price1, price2, ...] } últimas 60 velas
    this.correlations = {}; // { "BTC-ETH": 0.87 }
    this.lastCalc = 0;
  }

  // Añadir precio actual
  addPrice(symbol, price) {
    if (!this.priceHistory[symbol]) this.priceHistory[symbol] = [];
    this.priceHistory[symbol].push(price);
    if (this.priceHistory[symbol].length > 60) this.priceHistory[symbol].shift();
  }

  // Calcular correlación de Pearson entre dos series
  _pearson(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 10) return 0;
    const ax = a.slice(-n), bx = b.slice(-n);
    const ma = ax.reduce((s,v)=>s+v,0)/n;
    const mb = bx.reduce((s,v)=>s+v,0)/n;
    let num=0, da=0, db=0;
    for (let i=0;i<n;i++) {
      const A=ax[i]-ma, B=bx[i]-mb;
      num+=A*B; da+=A*A; db+=B*B;
    }
    return (da*db)===0 ? 0 : num/Math.sqrt(da*db);
  }

  // Recalcular correlaciones (cada 5 min)
  recalculate() {
    const now = Date.now();
    if (now - this.lastCalc < 5*60*1000) return;
    this.lastCalc = now;
    const symbols = Object.keys(this.priceHistory);
    for (let i=0; i<symbols.length; i++) {
      for (let j=i+1; j<symbols.length; j++) {
        const key = symbols[i]+"_"+symbols[j];
        this.correlations[key] = this._pearson(
          this.priceHistory[symbols[i]],
          this.priceHistory[symbols[j]]
        );
      }
    }
  }

  // Obtener correlación entre dos pares
  getCorrelation(a, b) {
    const key1 = a+"_"+b, key2 = b+"_"+a;
    return this.correlations[key1] ?? this.correlations[key2] ?? 
           (SYMBOL_TO_GROUP[a] && SYMBOL_TO_GROUP[a]===SYMBOL_TO_GROUP[b] ? 0.75 : 0.3);
  }

  // Momentum reciente de un par (% cambio últimas N velas)
  getMomentum(symbol, n=5) {
    const h = this.priceHistory[symbol];
    if (!h || h.length < n+1) return 0;
    const recent = h.slice(-n);
    const prev = h[h.length-n-1];
    return ((recent[recent.length-1]-prev)/prev)*100;
  }

  // ── FUNCIÓN PRINCIPAL: ajuste de tamaño por correlación ──────────────────────
  // Devuelve un multiplicador para el tamaño de posición de `symbol`
  // basándose en lo que están haciendo los pares correlacionados
  //
  // Lógica:
  // 1. Pares correlacionados subiendo juntos  → BOOST  (confirma la señal)
  // 2. Solo este par sube, los correlacionados no → NEUTRO (señal débil)
  // 3. Pares correlacionados bajando         → REDUCIR (riesgo contagio)
  // 4. Un par correlacionado ya está en pérdida → REDUCIR (contagio probable)
  getSizeMultiplier(symbol, portfolio, prices, signalScore) {
    this.recalculate();
    const group = SYMBOL_TO_GROUP[symbol];
    if (!group) return 1.0; // par sin grupo conocido → neutro

    const peers = CORRELATION_GROUPS[group].filter(s => s !== symbol);
    if (!peers.length) return 1.0;

    let bullishPeers = 0;    // peers con momentum positivo
    let bearishPeers = 0;    // peers con momentum negativo
    let peerInLoss = false;  // algún peer en posición abierta con pérdida

    for (const peer of peers) {
      const mom = this.getMomentum(peer, 5);
      if (mom > 0.3)  bullishPeers++;
      if (mom < -0.3) bearishPeers++;

      // ¿Hay posición abierta en este peer con pérdida?
      if (portfolio[peer]) {
        const cp = prices[peer] || portfolio[peer].entryPrice;
        const pnl = (cp - portfolio[peer].entryPrice) / portfolio[peer].entryPrice * 100;
        if (pnl < -1.5) peerInLoss = true;
      }
    }

    const totalPeers = peers.length;
    const bullRatio  = bullishPeers / totalPeers;
    const bearRatio  = bearishPeers / totalPeers;
    const ownMomentum = this.getMomentum(symbol, 5);

    // Caso 1: Peer en pérdida → alto riesgo de contagio → REDUCIR MUCHO
    if (peerInLoss) return 0.5;

    // Caso 2: Mayoría de peers bajando → mercado de ese grupo débil → REDUCIR
    if (bearRatio > 0.5) return 0.6;

    // Caso 3: Mayoría de peers subiendo Y propio momentum positivo → BOOST
    if (bullRatio >= 0.5 && ownMomentum > 0.5) return 1.3;

    // Caso 4: Peers mixtos → señal débil → neutro
    return 1.0;
  }

  // Estado para dashboard
  getStatus(portfolio, prices) {
    this.recalculate();
    return {
      groups: Object.entries(CORRELATION_GROUPS).map(([group, symbols]) => ({
        group,
        symbols: symbols.map(sym => ({
          symbol: sym.replace("USDT",""),
          momentum: +this.getMomentum(sym, 5).toFixed(2),
          inPortfolio: !!portfolio[sym],
          pnl: portfolio[sym] ? +((((prices[sym]||portfolio[sym].entryPrice)-portfolio[sym].entryPrice)/portfolio[sym].entryPrice)*100).toFixed(2) : null,
        }))
      })),
      correlations: Object.entries(this.correlations)
        .filter(([,v]) => Math.abs(v) > 0.6)
        .map(([k,v]) => ({ pair:k, corr:+v.toFixed(2) }))
        .sort((a,b) => Math.abs(b.corr)-Math.abs(a.corr))
        .slice(0,10),
    };
  }

  toJSON() {
    return { correlations: this.correlations, lastCalc: this.lastCalc };
  }

  loadJSON(data) {
    if (!data) return;
    if (data.correlations) this.correlations = data.correlations;
    if (data.lastCalc) this.lastCalc = data.lastCalc;
  }
}

module.exports = { CorrelationManager };
