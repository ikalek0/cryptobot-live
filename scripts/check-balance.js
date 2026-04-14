// ── scripts/check-balance.js — auditoría READ-ONLY del balance Binance ──
// Uso: node scripts/check-balance.js
//
// Lee API keys de .env (mismo path que server.js). NO mueve fondos,
// sólo hace GET /api/v3/account y reporta balances por asset.
//
// Pensado para auditar el estado real tras el incidente del 12 abril
// antes de decidir cómo reconciliar con this.portfolio del simpleBot.
"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const crypto = require("crypto");
const https  = require("https");

const KEY = process.env.BINANCE_API_KEY;
const SEC = process.env.BINANCE_API_SECRET;

if (!KEY || !SEC) {
  console.error("ERROR: BINANCE_API_KEY / BINANCE_API_SECRET no están en .env");
  process.exit(1);
}

// Assets especialmente relevantes: stables, pares del bot, incidente 12 abril
const RELEVANT = new Set([
  "USDC","USDT","BTC","ETH","BNB","SOL","XRP","ADA","LINK","AVAX",
  "DOT","LTC","UNI","AAVE","ATOM","NEAR","ARB","OP","APT","POL",
]);

function get(path, params={}) {
  const ts = Date.now();
  const qs = new URLSearchParams({...params, timestamp: ts}).toString();
  const sig = crypto.createHmac("sha256", SEC).update(qs).digest("hex");
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.binance.com",
      path:     `/api/v3/${path}?${qs}&signature=${sig}`,
      method:   "GET",
      headers:  {"X-MBX-APIKEY": KEY},
    }, res => {
      let d = ""; res.on("data", c => d+=c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed && typeof parsed.code === "number" && parsed.code < 0)
            return reject(new Error(`Binance ${parsed.code}: ${parsed.msg}`));
          resolve(parsed);
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function fetchPrice(symbol) {
  return new Promise((resolve) => {
    https.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, res => {
      let d=""; res.on("data", c=>d+=c);
      res.on("end", () => {
        try { resolve(parseFloat(JSON.parse(d).price) || 0); } catch { resolve(0); }
      });
    }).on("error", () => resolve(0));
  });
}

(async () => {
  try {
    console.log("\n=== BINANCE BALANCE (read-only) ===");
    console.log(`timestamp: ${new Date().toISOString()}\n`);

    const acc = await get("account");
    const balances = (acc.balances || [])
      .map(b => ({
        asset:  b.asset,
        free:   parseFloat(b.free),
        locked: parseFloat(b.locked),
      }))
      .filter(b => b.free + b.locked > 0);

    if (!balances.length) {
      console.log("(cuenta vacía — ningún asset con balance > 0)");
      return;
    }

    balances.sort((a,b) => a.asset.localeCompare(b.asset));

    // Valoración en USDC: pedimos el precio spot de cada asset != stable.
    // Spot tickers se piden en paralelo; si uno falla queda a 0.
    const usdcEquivs = {};
    const pricePromises = [];
    for (const b of balances) {
      if (b.asset === "USDC" || b.asset === "USDT" || b.asset === "BUSD") {
        usdcEquivs[b.asset] = b.free + b.locked;
        continue;
      }
      // Intentar {ASSET}USDC primero, si falla {ASSET}USDT
      pricePromises.push((async () => {
        let px = await fetchPrice(`${b.asset}USDC`);
        if (!px) px = await fetchPrice(`${b.asset}USDT`);
        usdcEquivs[b.asset] = (b.free + b.locked) * px;
      })());
    }
    await Promise.all(pricePromises);

    console.log("ASSET   FREE              LOCKED            TOTAL             ≈USDC");
    console.log("─────── ───────────────── ───────────────── ───────────────── ──────────────");
    let totalUsdc = 0;
    for (const b of balances) {
      const marker = RELEVANT.has(b.asset) ? "*" : " ";
      const eq = usdcEquivs[b.asset] || 0;
      totalUsdc += eq;
      console.log(
        `${marker}${b.asset.padEnd(6)} ` +
        `${b.free.toFixed(8).padStart(17)} ` +
        `${b.locked.toFixed(8).padStart(17)} ` +
        `${(b.free+b.locked).toFixed(8).padStart(17)} ` +
        `$${eq.toFixed(2).padStart(12)}`
      );
    }
    console.log("─────── ───────────────── ───────────────── ───────────────── ──────────────");
    console.log(`TOTAL estimado en USDC: ~$${totalUsdc.toFixed(2)}`);
    console.log(`(* = asset relevante para el bot o incidente 12 abril)`);

    const usdc = balances.find(b => b.asset === "USDC");
    const usdt = balances.find(b => b.asset === "USDT");
    console.log(`\nUSDC libre:  $${(usdc?.free || 0).toFixed(2)}`);
    console.log(`USDT libre:  $${(usdt?.free || 0).toFixed(2)}`);

    // ── T0-FEE: sección dedicada a BNB como combustible para fees ────────
    // Binance cobra 0.075% (25% descuento) en BNB cuando "Use BNB for fees"
    // está activo. Si BNB se agota hay fallback automático a 0.1% sobre el
    // asset. El bot necesita saberlo para predecir el coste virtual de cada
    // trade y para alertar cuando BNB baja de umbral.
    const bnb    = balances.find(b => b.asset === "BNB");
    const bnbQty = bnb ? (bnb.free + bnb.locked) : 0;
    const bnbEq  = usdcEquivs["BNB"] || 0;
    const UMBRAL_BNB_BAJO = 0.005;
    const low = bnbQty < UMBRAL_BNB_BAJO;
    console.log(`\n=== BNB (reserva para fees) ===`);
    console.log(`BNB: ${bnbQty.toFixed(8)} (≈$${bnbEq.toFixed(2)}) ← reserva para fees, NO parte del capital del bot`);
    console.log(`Alerta BNB bajo (< ${UMBRAL_BNB_BAJO}): ${low ? "SÍ ⚠️" : "NO"}`);

    // Detección fee mode vía commissionAsset del último trade.
    // Cascada de símbolos candidatos para cubrir cuentas sin historial
    // en un par específico (igual criterio que engine._detectBnbFeeMode).
    const feeModeCandidates = ["BNBUSDC","BTCUSDC","ETHUSDC","SOLUSDC"];
    let feeMode  = "desconocido";
    let feeSrc   = "sin trades recientes";
    for (const sym of feeModeCandidates) {
      try {
        const trades = await get("myTrades", { symbol: sym, limit: 5 });
        if (Array.isArray(trades) && trades.length > 0) {
          const last = trades[trades.length - 1];
          if (last && last.commissionAsset) {
            feeMode = last.commissionAsset === "BNB"
              ? "BNB (25% descuento, 0.075% efectivo)"
              : `${last.commissionAsset} (0.1% sin descuento)`;
            feeSrc = `myTrades:${sym} (${trades.length} trades)`;
            break;
          }
        }
      } catch (e) { /* siguiente candidato */ }
    }
    console.log(`Fee mode detectado: ${feeMode}`);
    console.log(`Fuente detección:   ${feeSrc}`);

    const nonStable = balances.filter(b =>
      b.asset !== "USDC" && b.asset !== "USDT" && b.asset !== "BUSD" && b.asset !== "BNB"
    );
    if (nonStable.length > 0) {
      console.log(`\nAssets no-stable con balance (posibles posiciones huérfanas):`);
      for (const b of nonStable) {
        const eq = usdcEquivs[b.asset] || 0;
        console.log(`  ${b.asset}: ${(b.free+b.locked).toFixed(8)} (≈$${eq.toFixed(2)})`);
      }
    }

    console.log("\nNota: este script es READ-ONLY. No crea ni cancela órdenes.");
    console.log("Decisión humana requerida: qué hacer con posiciones huérfanas");
    console.log("antes de resetear el estado del bot y activar LIVE.\n");
  } catch (e) {
    console.error("\nFAIL:", e.message);
    process.exit(1);
  }
})();
