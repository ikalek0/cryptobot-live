// cryptoPanic.js — Modo defensivo por noticias negativas de CryptoPanic
//
// ⚠️  ESTADO (abril 2026): start() DESACTIVADO en server.js:254 por
// rate-limiting del tier gratuito (API devolvía HTML en vez de JSON, ver
// CLAUDE.md sección "CryptoPanic rate-limited").
//
// El objeto `cryptoPanic` sigue instanciado y consultado por loop.js:
//   - cryptoPanic.globalDefensive  → siempre false (nunca se llama _check)
//   - cryptoPanic.defensivePairs    → siempre Set vacío
//   - cryptoPanic.getStatus()       → devuelve defaults
//   - cpGlobalMult en loop.js:115   → siempre 1.0 en la práctica
//
// Todos los consumers reciben defaults seguros. Bugs latentes (F19-F22)
// sólo aflorarían si Iñigo reactiva start(). Fixes defensivos por ahora.
//
// Polling cada 10 min (cuando esté activo). Sin API key = tier gratuito.
"use strict";

const https = require("https");

// F19: SimpleBot opera USDC pero CryptoPanic indexa por currency code (BTC,
// ETH, etc) y el map se usa en ambas direcciones. Mapeo explícito por symbol
// cubre USDT + USDC — cualquier consumer con BTCUSDC encuentra el par correcto.
const SYMBOL_MAP = {
  BTCUSDT:"BTC", BTCUSDC:"BTC",
  ETHUSDT:"ETH", ETHUSDC:"ETH",
  SOLUSDT:"SOL", SOLUSDC:"SOL",
  BNBUSDT:"BNB", BNBUSDC:"BNB",
  AVAXUSDT:"AVAX", AVAXUSDC:"AVAX",
  ADAUSDT:"ADA", ADAUSDC:"ADA",
  DOTUSDT:"DOT",
  LINKUSDT:"LINK", LINKUSDC:"LINK",
  UNIUSDT:"UNI",
  AAVEUSDT:"AAVE",
  XRPUSDT:"XRP", XRPUSDC:"XRP",
  LTCUSDT:"LTC",
  MATICUSDT:"MATIC",
  OPUSDT:"OP",
  ARBUSDT:"ARB",
  ATOMUSDT:"ATOM", ATOMUSDC:"ATOM",
  NEARUSDT:"NEAR",
  APTUSDT:"APT",
};

class CryptoPanicDefense {
  constructor(apiKey = "") {
    this.apiKey       = apiKey || process.env.CRYPTOPANIC_TOKEN || "";
    this.defensivePairs   = new Set(); // pares con noticia negativa activa
    this.globalDefensive  = false;     // defensivo global (muchas noticias malas)
    this.lastCheck        = 0;
    this.checkIntervalMs  = 10 * 60 * 1000; // cada 10 min
    // F21: panicExpiryMs eliminado — era dead field (nunca se leía). _process()
    // calcula currentExpiry fresh cada vez via this._learnedExpiryHours para
    // permitir que RiskLearning ajuste el valor en caliente.
    this.panicTimestamps  = {}; // { symbol: timestamp }
    this.lastHeadlines    = []; // últimas noticias para log
    this._prevGlobal      = false;
    this._prevPairs       = new Set();
  }

  start() {
    if (this._timer) return; // ya corriendo — no duplicar (F22)
    this._failCount = 0;
    this._backoffUntil = 0;
    this._check();
    this._timer = setInterval(() => this._check(), this.checkIntervalMs);
    // F22: .unref() para no bloquear process exit (tests, hot-reload limpios)
    if (this._timer.unref) this._timer.unref();
    console.log("[CryptoPanic] Monitor de noticias iniciado (cada 10 min)");
  }

  stop() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
    console.log("[CryptoPanic] Monitor de noticias detenido");
  }

  async _check() {
    // Backoff: skip if in cooldown
    if (Date.now() < this._backoffUntil) return;
    this.lastCheck = Date.now();
    try {
      const data = await this._fetch();
      this._failCount = 0; // reset on success
      this._process(data);
    } catch (e) {
      this._failCount++;
      if (this._failCount >= 3) {
        this._backoffUntil = Date.now() + 30 * 60 * 1000; // 30min cooldown
        console.warn(`[CryptoPanic] ${this._failCount} fallos seguidos — cooldown 30min`);
        this._failCount = 0;
      }
      // Silent fail — no log spam for rate limits or HTML responses
    }
  }

  _fetch() {
    return new Promise((resolve, reject) => {
      const currencies = "BTC,ETH,SOL,BNB,XRP,ADA,AVAX,DOT,LINK,MATIC,OP,ARB";
      const token = this.apiKey ? `auth_token=${this.apiKey}&` : "";
      const url = `https://cryptopanic.com/api/v1/posts/?${token}currencies=${currencies}&filter=important&kind=news&public=true`;

      const req = https.get(url, { timeout: 10000, headers: {"User-Agent":"Mozilla/5.0"} }, res => {
        if (res.statusCode === 429 || res.statusCode >= 400) { reject(new Error("http " + res.statusCode)); res.resume(); return; }
        if (res.statusCode >= 300 && res.statusCode < 400) { reject(new Error("redirect")); res.resume(); return; }
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => {
          try {
            const trimmed = body.trim();
            if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) { reject(new Error("not JSON")); return; }
            resolve(JSON.parse(trimmed));
          } catch (e) { reject(new Error("parse")); }
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
        // F19: mapear currency → TODOS los pares del SYMBOL_MAP que matchean
        // (antes sólo el primero via .find(), que siempre era USDT y dejaba
        // USDC sin marcar aunque simpleBot opera en USDC).
        for (const code of currencies) {
          for (const [pair, symCode] of Object.entries(SYMBOL_MAP)) {
            if (symCode === code) {
              newDefensive.add(pair);
              this.panicTimestamps[pair] = now;
            }
          }
        }
        // Noticia sin currency específica = global
        if (!currencies.length) negativeCount += 0.5;
      }
    }

    // F20: primero purgar timestamps expirados, después mergear pairs VIGENTES
    // en newDefensive. Antes: newDefensive sólo contenía detects del poll actual
    // → un pair entraba en defensive y al siguiente poll (sin news nuevas)
    // perdía el estado instantáneamente, violando el contrato "defensive hasta
    // expiry". Ahora: cada pair con timestamp < expiry permanece defensive.
    const currentExpiry = (this._learnedExpiryHours||2) * 60 * 60 * 1000;
    for (const [pair, ts] of Object.entries(this.panicTimestamps)) {
      if (now - ts > currentExpiry) {
        delete this.panicTimestamps[pair];
        newDefensive.delete(pair);
      } else {
        newDefensive.add(pair); // pair aún en ventana de pánico
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
