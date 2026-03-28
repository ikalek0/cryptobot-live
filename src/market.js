// ─── MARKET GUARD ────────────────────────────────────────────────────────────
// Detección de tendencia de mercado, mejores horarios y blacklist automática
"use strict";

// ── BLACKLIST ─────────────────────────────────────────────────────────────────
// Si un par pierde X veces seguidas, se ignora temporalmente
class Blacklist {
  constructor(maxLosses = 3, cooldownHours = 24) {
    this.maxLosses     = maxLosses;
    this.cooldownMs    = cooldownHours * 60 * 60 * 1000;
    this.losses        = {}; // { symbol: { count, lastLoss } }
    this.blacklisted   = {}; // { symbol: unbanTs }
  }

  recordLoss(symbol) {
    const now = Date.now();
    if (!this.losses[symbol]) this.losses[symbol] = { count: 0, lastLoss: now };
    this.losses[symbol].count++;
    this.losses[symbol].lastLoss = now;

    if (this.losses[symbol].count >= this.maxLosses) {
      const unbanTs = now + this.cooldownMs;
      this.blacklisted[symbol] = unbanTs;
      console.log(`[BLACKLIST] ${symbol} bloqueado por ${this.cooldownMs/3600000}h (${this.maxLosses} pérdidas seguidas)`);
      this.losses[symbol].count = 0;
    }
  }

  recordWin(symbol) {
    if (this.losses[symbol]) this.losses[symbol].count = 0;
  }

  isBlacklisted(symbol) {
    const unban = this.blacklisted[symbol];
    if (!unban) return false;
    if (Date.now() > unban) {
      delete this.blacklisted[symbol];
      console.log(`[BLACKLIST] ${symbol} desbloqueado`);
      return false;
    }
    return true;
  }

  getStatus() {
    return Object.entries(this.blacklisted).map(([sym, unban]) => ({
      symbol: sym,
      unbanIn: Math.max(0, Math.round((unban - Date.now()) / 60000)) + " min",
    }));
  }

  serialize()        { return { losses: this.losses, blacklisted: this.blacklisted }; }
  restore(data)      { if (data) { this.losses = data.losses || {}; this.blacklisted = data.blacklisted || {}; } }
}

// ── MARKET REGIME ─────────────────────────────────────────────────────────────
// Detecta si el mercado está en modo pánico basándose en la caída de BTC
class MarketGuard {
  constructor() {
    this.defensiveMode  = false;
    this.defensiveStart = null;
    this.btcHighToday   = null;
    this.lastDay        = null;
  }

  // Llama esto en cada tick con el precio actual de BTC
  update(btcPrice) {
    if (!btcPrice) return;

    const today = new Date().toDateString();

    // Reset diario del máximo de BTC
    if (this.lastDay !== today) {
      this.btcHighToday = btcPrice;
      this.lastDay = today;
    }

    if (btcPrice > (this.btcHighToday || btcPrice)) {
      this.btcHighToday = btcPrice;
    }

    // Si BTC cae más del 4% desde el máximo del día → modo defensivo
    const drawdown = this.btcHighToday
      ? (btcPrice - this.btcHighToday) / this.btcHighToday
      : 0;

    if (drawdown < -0.04 && !this.defensiveMode) {
      this.defensiveMode  = true;
      this.defensiveStart = new Date().toISOString();
      console.log(`[MARKET] Modo defensivo activado — BTC drawdown: ${(drawdown*100).toFixed(1)}%`);
    }

    // Sale del modo defensivo si BTC recupera por encima del -2%
    if (drawdown > -0.02 && this.defensiveMode) {
      this.defensiveMode  = false;
      this.defensiveStart = null;
      console.log(`[MARKET] Modo defensivo desactivado — BTC recuperado`);
    }

    return {
      defensive:   this.defensiveMode,
      btcDrawdown: +(drawdown * 100).toFixed(2),
      btcHigh:     this.btcHighToday,
    };
  }

  isDefensive() { return this.defensiveMode; }
}

// ── TRADING HOURS ─────────────────────────────────────────────────────────────
// Cripto tiene más volumen y mejores señales en ciertos horarios UTC
// Mejores: 8-12 UTC (apertura Europa) y 13-17 UTC (apertura USA)
// Peores: 0-6 UTC (madrugada Asia, bajo volumen)
function getTradingScore() {
  const hour = new Date().getUTCHours();

  if (hour >= 8  && hour < 12) return { score: 1.0, label: "Óptimo (Europa)" };   // 100% capital
  if (hour >= 13 && hour < 17) return { score: 1.0, label: "Óptimo (USA)"    };   // 100% capital
  if (hour >= 12 && hour < 13) return { score: 0.8, label: "Transición"      };   // 80%
  if (hour >= 17 && hour < 21) return { score: 0.7, label: "Tarde Europa"    };   // 70%
  if (hour >= 6  && hour < 8 ) return { score: 0.6, label: "Pre-apertura"    };   // 60%
  return                               { score: 0.4, label: "Bajo volumen"    };   // 40% en madrugada
}

module.exports = { Blacklist, MarketGuard, getTradingScore };
