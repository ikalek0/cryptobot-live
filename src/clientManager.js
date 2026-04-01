// clientManager.js — Gestión de copy-trading para clientes SaaS
// Cada cliente tiene sus propias API keys de Binance
// El bot ejecuta las mismas operaciones en todas las cuentas activas
"use strict";

const https = require("https");
const crypto = require("crypto");

// ── Binance order execution per client ───────────────────────────────────────
async function clientRequest(apiKey, apiSecret, method, path, params = {}) {
  const ts = Date.now();
  const queryString = new URLSearchParams({ ...params, timestamp: ts }).toString();
  const signature = crypto.createHmac("sha256", apiSecret).update(queryString).digest("hex");
  const fullQuery = `${queryString}&signature=${signature}`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.binance.com",
      path: `${path}?${fullQuery}`,
      method,
      headers: { "X-MBX-APIKEY": apiKey, "Content-Type": "application/json" },
      timeout: 8000,
    };
    const req = https.request(options, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error(`JSON parse: ${d.slice(0,100)}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function clientGetBalance(apiKey, apiSecret) {
  try {
    const data = await clientRequest(apiKey, apiSecret, "GET", "/api/v3/account");
    if (data.code) throw new Error(data.msg || `Binance error ${data.code}`);
    return data.balances?.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0) || [];
  } catch(e) {
    return null;
  }
}

async function clientPlaceOrder(apiKey, apiSecret, symbol, side, quantity) {
  try {
    const params = {
      symbol, side, type: "MARKET",
      ...(side === "BUY" ? { quoteOrderQty: quantity.toFixed(2) } : { quantity: quantity.toFixed(6) }),
      newOrderRespType: "FULL",
    };
    const data = await clientRequest(apiKey, apiSecret, "POST", "/api/v3/order", params);
    if (data.code) throw new Error(data.msg || `Order error ${data.code}`);
    return { success: true, orderId: data.orderId, fills: data.fills };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ── ClientBotManager ─────────────────────────────────────────────────────────
class ClientBotManager {
  constructor() {
    this.clients = {};      // { clientId: { apiKey, apiSecret, capital, portfolio, log, status } }
    this.bafirUrl = process.env.BAFIR_URL || "";
    this.lastSync = 0;
    this.syncInterval = 5 * 60 * 1000; // sync client list every 5min
  }

  // Load active clients from Bafir API
  async syncClients() {
    if (!this.bafirUrl) return;
    const now = Date.now();
    if (now - this.lastSync < this.syncInterval) return;
    this.lastSync = now;

    try {
      const secret = process.env.SYNC_SECRET || "bafir_sync_secret_2024";
      const body = JSON.stringify({ ts: now });
      const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");

      const data = await new Promise((resolve, reject) => {
        const url = new URL(this.bafirUrl + "/api/internal/client-keys");
        const mod = url.protocol === "https:" ? https : require("http");
        const req = mod.request({
          hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname, method: "POST",
          headers: { "Content-Type": "application/json", "x-signature": sig, "Content-Length": Buffer.byteLength(body) },
        }, res => {
          let d = ""; res.on("data", c => d += c);
          res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        });
        req.on("error", reject);
        req.write(body); req.end();
      });

      if (data.clients) {
        for (const c of data.clients) {
          if (!c.apiKey || !c.apiSecret) continue;
          if (!this.clients[c.id]) {
            this.clients[c.id] = {
              id: c.id, name: c.name,
              apiKey: c.apiKey, apiSecret: c.apiSecret,
              capital: c.capital || 0,   // declared capital
              portfolio: {},              // virtual positions
              log: [],                    // trade history
              status: "active",
              lastCheck: null, lastError: null,
            };
            console.log(`[CLIENT] ✅ ${c.name} conectado (capital: $${c.capital})`);
          } else {
            // Update credentials if changed
            this.clients[c.id].apiKey = c.apiKey;
            this.clients[c.id].apiSecret = c.apiSecret;
            this.clients[c.id].capital = c.capital || this.clients[c.id].capital;
          }
        }
      }
    } catch(e) {
      console.warn("[CLIENT] Sync error:", e.message);
    }
  }

  // Verify client has enough balance before copying trade
  async verifyClientBalance(clientId, neededUSDC) {
    const c = this.clients[clientId];
    if (!c) return false;
    try {
      const balances = await clientGetBalance(c.apiKey, c.apiSecret);
      if (!balances) return false;
      const usdc = parseFloat(balances.find(b => b.asset === "USDC")?.free || 0);
      c.lastCheck = { ts: Date.now(), usdc };
      return usdc >= neededUSDC * 0.9; // 10% tolerance
    } catch(e) {
      c.lastError = e.message;
      return false;
    }
  }

  // Copy a BUY trade to all active clients
  async copyBuy(symbol, masterInvest, masterCapital) {
    const results = [];
    await this.syncClients();

    for (const [clientId, c] of Object.entries(this.clients)) {
      if (c.status !== "active" || !c.apiKey) continue;
      if (c.portfolio[symbol]) continue; // already has this position

      try {
        // Scale investment proportionally to client's capital
        const ratio = masterCapital > 0 ? masterInvest / masterCapital : 0.1;
        const clientInvest = Math.max(10, Math.min(c.capital * 0.4, c.capital * ratio));

        const hasBalance = await this.verifyClientBalance(clientId, clientInvest);
        if (!hasBalance) {
          console.log(`[CLIENT] ${c.name}: sin balance para ${symbol} ($${clientInvest.toFixed(2)})`);
          continue;
        }

        const result = await clientPlaceOrder(c.apiKey, c.apiSecret, symbol, "BUY", clientInvest);
        if (result.success) {
          c.portfolio[symbol] = { investedUSDC: clientInvest, orderId: result.orderId, ts: new Date().toISOString() };
          c.log.push({ type: "BUY", symbol, amount: clientInvest, ts: new Date().toISOString(), orderId: result.orderId });
          console.log(`[CLIENT] ✅ ${c.name} BUY ${symbol} $${clientInvest.toFixed(2)}`);
          results.push({ clientId, success: true });
        } else {
          console.warn(`[CLIENT] ❌ ${c.name} BUY ${symbol}: ${result.error}`);
          c.lastError = result.error;
          results.push({ clientId, success: false, error: result.error });
        }
      } catch(e) {
        console.warn(`[CLIENT] ${c.name} error:`, e.message);
        results.push({ clientId, success: false, error: e.message });
      }
    }
    return results;
  }

  // Copy a SELL trade to all active clients
  async copySell(symbol, masterQty) {
    const results = [];
    await this.syncClients();

    for (const [clientId, c] of Object.entries(this.clients)) {
      if (c.status !== "active" || !c.apiKey) continue;
      if (!c.portfolio[symbol]) continue; // doesn't have this position

      try {
        // Get actual balance of the coin in client's Binance
        const balances = await clientGetBalance(c.apiKey, c.apiSecret);
        const coinBalance = parseFloat(
          balances?.find(b => b.asset === symbol.replace("USDC","").replace("USDT",""))?.free || 0
        );
        if (coinBalance <= 0) {
          delete c.portfolio[symbol];
          continue;
        }

        const result = await clientPlaceOrder(c.apiKey, c.apiSecret, symbol, "SELL", coinBalance);
        if (result.success) {
          const invested = c.portfolio[symbol]?.investedUSDC || 0;
          delete c.portfolio[symbol];
          c.log.push({ type: "SELL", symbol, qty: coinBalance, ts: new Date().toISOString(), orderId: result.orderId });
          console.log(`[CLIENT] ✅ ${c.name} SELL ${symbol}`);
          results.push({ clientId, success: true });

          // Report P&L back to Bafir
          this._reportTrade(clientId, symbol, invested, result);
        } else {
          console.warn(`[CLIENT] ❌ ${c.name} SELL ${symbol}: ${result.error}`);
          results.push({ clientId, success: false, error: result.error });
        }
      } catch(e) {
        console.warn(`[CLIENT] ${c.name} SELL error:`, e.message);
        results.push({ clientId, success: false, error: e.message });
      }
    }
    return results;
  }

  // Report trade result back to Bafir for client dashboard
  _reportTrade(clientId, symbol, investedUSDC, orderResult) {
    if (!this.bafirUrl) return;
    try {
      const secret = process.env.SYNC_SECRET || "bafir_sync_secret_2024";
      const body = JSON.stringify({ clientId, symbol, investedUSDC, ts: new Date().toISOString() });
      const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
      const url = new URL(this.bafirUrl + "/api/internal/trade-report");
      const mod = url.protocol === "https:" ? https : require("http");
      const req = mod.request({
        hostname: url.hostname, path: url.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "x-signature": sig, "Content-Length": Buffer.byteLength(body) },
      }, () => {});
      req.on("error", () => {});
      req.write(body); req.end();
    } catch(e) {}
  }

  getStatus() {
    return Object.values(this.clients).map(c => ({
      id: c.id, name: c.name, status: c.status,
      capital: c.capital, openPositions: Object.keys(c.portfolio).length,
      trades: c.log.length, lastCheck: c.lastCheck, lastError: c.lastError,
    }));
  }
}

module.exports = { ClientBotManager };
