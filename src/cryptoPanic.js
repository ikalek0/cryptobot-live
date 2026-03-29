// cryptoPanic.js — Modo defensivo por noticias negativas de CryptoPanic
// Polling cada 10 min. Sin API key = tier gratuito (limitado pero funcional).
"use strict";

const https = require("https");

const SYMBOL_MAP = {
  BTCUSDT:"BTC", ETHUSDT:"ETH", SOLUSDT:"SOL", BNBUSDT:"BNB",
  AVAXUSDT:"AVAX", ADAUSDT:"ADA", DOTUSDT:"DOT", LINKUSDT:"LINK",
  UNIUSDT:"UNI", AAVEUSDT:"AAVE", XRPUSDT:"XRP", LTCUSDT:"LTC",
  MATICUSDT:"MATIC", OPUSDT:"OP", ARBUSDT:"ARB", ATOMUSDT:"ATOM",
  NEARUSDT:"NEAR", APTUSDT:"APT",
};

class CryptoPanicDefense {
  constructor(apiKey = "") {
    this.apiKey       = apiKey || process.env.CRYPTOPANIC_TOKEN || "";
    this.defensivePairs   = new Set(); // pares con noticia negativa activa
    this.globalDefensive  = false;     // defensivo global (muchas noticias malas)
    this.lastCheck        = 0;
    this.checkIntervalMs  = 10 * 60 * 1000; // cada 10 min
    this.panicExpiryMs    = (this._learnedExpiryHours||2) * 60 * 60 * 1000;
    this.panicTimestamps  = {}; // { symbol: timestamp }
    this.lastHeadlines    = []; // últimas noticias para log
    this._prevGlobal      = false;
    this._prevPairs       = new Set();
  }

  start() {
    this._check();
    setInterval(() => this._check(), this.checkIntervalMs);
    console.log("[CryptoPanic] Monitor de noticias iniciado (cada 10 min)");
  }

  async _check() {
    this.lastCheck = Date.now();
    try {
      const data = await this._fetch();
      this._process(data);
    } catch (e) {
      console.warn("[CryptoPanic] Error:", e.message);
    }
  }

  _fetch() {
    return new Promise((resolve, reject) => {
      // Usar currencies de los pares principales + filter=negative
      const currencies = "BTC,ETH,SOL,BNB,XRP,ADA,AVAX,DOT,LINK,MATIC,OP,ARB";
      const token = this.apiKey ? `auth_token=${this.apiKey}&` : "";
      const url = `https://cryptopanic.com/api/v1/posts/?${token}currencies=${currencies}&filter=important&kind=news&public=true`;
      
      const req = https.get(url, { timeout: 10000, headers: {"User-Agent":"Mozilla/5.0"} }, res => {
        if (res.statusCode === 429) { reject(new Error("rate limited")); return; }
        if (res.statusCode >= 300 && res.statusCode < 400) { reject(new Error("redirect")); return; }
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => {
          try {
            const trimmed = body.trim();
            if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) { reject(new Error("not JSON")); return; }
            resolve(JSON.parse(trimmed));
          } catch (e) { reject(new Error("JSON parse error")); }
        });
      });
      req.on("error", reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    });
  }

  _process(data) {
    if (!data?.results?.length) return;

    const now = Date.now();
    const newDefensive = new Set();
    let negativeCount = 0;
    const headlines = [];

    for (const item of data.results.slice(0, 30)) {
      const votes   = item.votes || {};
      const neg     = (votes.negative || 0) + (votes.important || 0) * 0.5;
      const pos     = votes.positive || 0;
      const netSentiment = pos - neg;
      const currencies = (item.currencies || []).map(c => c.code);
      
      headlines.push({
        title:   item.title,
        sentiment: netSentiment,
        currencies,
        publishedAt: item.published_at,
      });

      if (netSentiment < -2) {
        negativeCount++;
        // Mapear currencies a pares USDT
        for (const code of currencies) {
          const pair = Object.entries(SYMBOL_MAP).find(([,v]) => v === code)?.[0];
          if (pair) {
            newDefensive.add(pair);
            this.panicTimestamps[pair] = now;
          }
        }
        // Noticia sin currency específica = global
        if (!currencies.length) negativeCount += 0.5;
      }
    }

    // Limpiar pares cuyo pánico expiró (expiry ajustado por RiskLearning)
    const currentExpiry = (this._learnedExpiryHours||2) * 60 * 60 * 1000;
    for (const [pair, ts] of Object.entries(this.panicTimestamps)) {
      if (now - ts > currentExpiry) {
        delete this.panicTimestamps[pair];
        newDefensive.delete(pair);
      }
    }

    this.defensivePairs  = newDefensive;
    const globalThresh = this._learnedGlobalThreshold || 5;
    this.globalDefensive = negativeCount >= globalThresh;
    this.lastHeadlines   = headlines.slice(0, 5);

    // Log cambios
    if (this.globalDefensive && !this._prevGlobal) {
      console.log(`[CryptoPanic] 🚨 MODO DEFENSIVO GLOBAL — ${negativeCount} noticias negativas`);
    } else if (!this.globalDefensive && this._prevGlobal) {
      console.log("[CryptoPanic] ✅ Modo defensivo global desactivado");
    }
    for (const p of newDefensive) {
      if (!this._prevPairs.has(p)) console.log(`[CryptoPanic] ⚠️ ${p} en modo defensivo por noticias`);
    }

    this._prevGlobal = this.globalDefensive;
    this._prevPairs  = new Set(newDefensive);
  }

  // Multiplicador de tamaño para un par (1.0 = normal, 0.5 = defensivo)
  getSizeMultiplier(symbol) {
    if (this.globalDefensive)         return 0.3; // global muy negativo = 30%
    if (this.defensivePairs.has(symbol)) return 0.5; // par específico = 50%
    return 1.0;
  }

  isDefensive(symbol) {
    return this.globalDefensive || this.defensivePairs.has(symbol);
  }

  getStatus() {
    return {
      globalDefensive: this.globalDefensive,
      defensivePairs:  [...this.defensivePairs],
      lastCheck:       new Date(this.lastCheck).toISOString(),
      headlines:       this.lastHeadlines,
    };
  }
}

module.exports = { CryptoPanicDefense };
