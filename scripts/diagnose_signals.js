// diagnose_signals.js — Evalúa las 7 estrategias del simpleBot contra datos
// frescos de Binance y reporta exactamente qué condiciones se cumplen/no
// cumplen. READ-ONLY: no toca el bot, no modifica estado.
//
// Uso en el servidor:
//   node /tmp/diagnose_signals.js
"use strict";
const https = require("https");

const STRATEGIES = [
  { id:"BNB_1h_RSI",  pair:"BNBUSDC", tf:"1h",  type:"RSI_MR_ADX" },
  { id:"SOL_1h_EMA",  pair:"SOLUSDC", tf:"1h",  type:"EMA_CROSS"  },
  { id:"BTC_30m_RSI", pair:"BTCUSDC", tf:"30m", type:"RSI_MR_ADX" },
  { id:"BTC_30m_EMA", pair:"BTCUSDC", tf:"30m", type:"EMA_CROSS"  },
  { id:"XRP_4h_EMA",  pair:"XRPUSDC", tf:"4h",  type:"EMA_CROSS"  },
  { id:"SOL_4h_EMA",  pair:"SOLUSDC", tf:"4h",  type:"EMA_CROSS"  },
  { id:"BNB_1d_T200", pair:"BNBUSDC", tf:"1d",  type:"TREND_200"  },
];

// Fetch klines desde Binance REST API (usa pares USDT por liquidez)
function fetchKlines(symbol, interval, limit=250) {
  const apiSymbol = symbol.replace(/USDC$/, "USDT");
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${apiSymbol}&interval=${interval}&limit=${limit}`;
    https.get(url, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const raw = JSON.parse(d);
          resolve(raw.map(k => ({
            open: +k[1], high: +k[2], low: +k[3], close: +k[4], start: k[0],
          })));
        } catch(e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// ── Indicators (copia idéntica de src/engine_simple.js) ─────────────────────
function rsi(cl, n=14){
  if(cl.length<n+1) return 50;
  let g=0, l=0;
  for(let i=cl.length-n; i<cl.length; i++){
    const d = cl[i]-cl[i-1];
    if(d>0) g+=d; else l-=d;
  }
  return l===0 ? 100 : 100 - 100/(1+(g/n)/(l/n));
}
function ema(cl, n){
  if(cl.length<n) return cl[cl.length-1];
  const k = 2/(n+1);
  let e = cl.slice(0,n).reduce((s,v)=>s+v,0)/n;
  for(let i=n; i<cl.length; i++) e = cl[i]*k + e*(1-k);
  return e;
}
function bb(cl, n=20, k=2){
  if(cl.length<n) return null;
  const sl = cl.slice(-n);
  const mid = sl.reduce((s,v)=>s+v,0)/n;
  const std = Math.sqrt(sl.reduce((s,v)=>s+(v-mid)**2,0)/n);
  return { upper: mid+k*std, mid, lower: mid-k*std };
}
function adx(klines, n=14){
  if(klines.length<n*2) return 25;
  const sl = klines.slice(-(n*2));
  let pDM=0, mDM=0, tr=0;
  for(let i=1; i<sl.length; i++){
    const h = sl[i].high - sl[i-1].high;
    const l = sl[i-1].low - sl[i].low;
    pDM += h>l && h>0 ? h : 0;
    mDM += l>h && l>0 ? l : 0;
    tr += Math.max(
      sl[i].high - sl[i].low,
      Math.abs(sl[i].high - sl[i-1].close),
      Math.abs(sl[i].low  - sl[i-1].close)
    );
  }
  if(tr===0) return 0;
  const dip = (pDM/tr)*100, dim = (mDM/tr)*100;
  return Math.abs(dip-dim)/(dip+dim)*100;
}
function calcATR(candles, n=14) {
  if(candles.length<n) return 0;
  const sl = candles.slice(-n);
  const trs = sl.map((k,i,a) =>
    i===0 ? k.high-k.low :
    Math.max(k.high-k.low, Math.abs(k.high-a[i-1].close), Math.abs(k.low-a[i-1].close))
  );
  return trs.reduce((s,v)=>s+v,0)/n;
}
function atrPercentile(candles, windowSize=24, histSize=200) {
  if(candles.length<histSize) return 50;
  const recent = candles.slice(-histSize);
  const atrs = [];
  for(let i=windowSize; i<=recent.length; i++) {
    atrs.push(calcATR(recent.slice(i-windowSize, i), windowSize));
  }
  if(!atrs.length) return 50;
  const currentATR = calcATR(candles.slice(-windowSize), windowSize);
  const below = atrs.filter(a => a<=currentATR).length;
  return Math.round(below/atrs.length*100);
}

// ── Diagnose one strategy ───────────────────────────────────────────────────
function diagnose(type, candles) {
  const cl = candles.map(c => c.close);
  const last = cl[cl.length-1];
  const checks = [];
  let allMet = false;

  switch(type){
    case "RSI_MR_ADX": {
      const r = rsi(cl);
      const b = bb(cl);
      const a = adx(candles);
      checks.push(`  RSI = ${r.toFixed(1).padStart(6)}  (<35 ?)  ${r<35 ? "✓" : "✗"}`);
      if(b) {
        checks.push(`  close=${last.toFixed(4).padStart(10)} < BB_lower=${b.lower.toFixed(4)}  ${last<b.lower ? "✓" : "✗"}`);
      } else {
        checks.push(`  BB: no data`);
      }
      checks.push(`  ADX = ${a.toFixed(1).padStart(6)}  (<25 ?)  ${a<25 ? "✓" : "✗"}`);
      allMet = r<35 && b && last<b.lower && a<25;
      break;
    }
    case "EMA_CROSS": {
      if(cl.length<50) { checks.push(`  not enough candles (${cl.length}/50)`); break; }
      const e9 = ema(cl, 9);
      const e21 = ema(cl, 21);
      const prev = cl.slice(0, -1);
      const pe9 = ema(prev, 9);
      const pe21 = ema(prev, 21);
      checks.push(`  prev: EMA9=${pe9.toFixed(4)}  EMA21=${pe21.toFixed(4)}  (EMA9<EMA21?)  ${pe9<pe21 ? "✓" : "✗"}`);
      checks.push(`  now:  EMA9=${e9.toFixed(4)}  EMA21=${e21.toFixed(4)}   (EMA9>EMA21?)  ${e9>e21 ? "✓" : "✗"}`);
      allMet = pe9<pe21 && e9>e21;
      if(!allMet && e9>e21) checks.push(`  note: already in uptrend but NO cross on latest bar`);
      if(!allMet && pe9<pe21 && e9<=e21) checks.push(`  note: still in downtrend (no cross)`);
      break;
    }
    case "TREND_200": {
      if(cl.length<200) { checks.push(`  not enough candles (${cl.length}/200)`); break; }
      const e50 = ema(cl, 50);
      const e200 = ema(cl, 200);
      const r = rsi(cl);
      checks.push(`  close=${last.toFixed(4).padStart(10)} > EMA200=${e200.toFixed(4)}  ${last>e200 ? "✓" : "✗"}`);
      checks.push(`  EMA50=${e50.toFixed(4).padStart(10)} > EMA200=${e200.toFixed(4)}  ${e50>e200 ? "✓" : "✗"}`);
      checks.push(`  RSI = ${r.toFixed(1).padStart(6)}  (45 < RSI < 65 ?)  ${r>45 && r<65 ? "✓" : "✗"}`);
      allMet = last>e200 && e50>e200 && r>45 && r<65;
      break;
    }
  }

  // ATR filter check (informational)
  const atrPct = atrPercentile(candles);
  const atrBlocked = atrPct < 20;
  checks.push(`  ATR percentile = ${atrPct}  (ATR filter: ${atrBlocked ? "BLOCKED (<20)" : "ok"})`);

  return { allMet, checks, atrPct };
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log("═".repeat(72));
  console.log("DIAGNÓSTICO DE SEÑALES — 7 estrategias");
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log("Data source: Binance REST API (fresh klines, USDT pairs)");
  console.log("═".repeat(72));

  let wouldBuy = 0;
  for(const s of STRATEGIES) {
    try {
      const limit = s.tf === "1d" ? 250 : 250;
      const candles = await fetchKlines(s.pair, s.tf, limit);
      console.log(`\n[${s.id}] ${s.pair}/${s.tf}/${s.type}  (${candles.length} velas)`);
      const result = diagnose(s.type, candles);
      result.checks.forEach(c => console.log(c));
      const signal = result.allMet ? "🟢 BUY" : "⚪ HOLD";
      console.log(`  → signal: ${signal}`);
      if(result.allMet) wouldBuy++;
      await new Promise(r => setTimeout(r, 300)); // rate limit
    } catch(e) {
      console.log(`  ERROR: ${e.message}`);
    }
  }

  console.log("\n" + "═".repeat(72));
  console.log(`Resumen: ${wouldBuy}/7 estrategias generarían BUY ahora mismo`);
  console.log("═".repeat(72));
})();
