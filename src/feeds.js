// ─── EXTERNAL FEEDS v2 ────────────────────────────────────────────────────────
// Fear & Greed + CryptoPanic + Klines históricos de Binance
"use strict";

const https = require("https");

// ── Fear & Greed Index ────────────────────────────────────────────────────────
// Fear & Greed con cadena de fuentes:
// 1. CoinMarketCap (tiempo real) → 2. CNN Business (tiempo real) → 3. alternative.me (fallback)
function fetchFearGreed() {
  const labelES = v => v<25?"😱 Pánico extremo":v<45?"😟 Miedo":v<55?"😐 Neutral":v<75?"😊 Codicia":"🤑 Codicia extrema";

  const tryCMC = () => new Promise((resolve, reject) => {
    const req = https.get({
      hostname:"api.coinmarketcap.com", path:"/data-api/v3/fear-and-greed/latest",
      headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"}, timeout:6000,
    }, res => {
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{
        try {
          const j=JSON.parse(d);
          const score=j?.data?.fear_greed_index?.score??j?.data?.score;
          if(score==null) return reject(new Error("no score"));
          const publishedAt=j?.data?.fear_greed_index?.update_time
            ?new Date(j.data.fear_greed_index.update_time*1000).toISOString():new Date().toISOString();
          resolve({value:Math.round(score),label:labelES(score),publishedAt,source:"CMC"});
        } catch(e){reject(e);}
      });
    });
    req.on("error",reject); req.on("timeout",()=>{req.destroy();reject(new Error("timeout"));});
  });

  const tryCNN = () => new Promise((resolve, reject) => {
    const req = https.get({
      hostname:"production.dataviz.cnn.io", path:"/index/fearandgreed/graphdata",
      headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"}, timeout:6000,
    }, res => {
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{
        try {
          const j=JSON.parse(d);
          const score=j?.fear_and_greed?.score;
          if(score==null) return reject(new Error("no score"));
          resolve({value:Math.round(score),label:labelES(score),publishedAt:new Date().toISOString(),source:"CNN"});
        } catch(e){reject(e);}
      });
    });
    req.on("error",reject); req.on("timeout",()=>{req.destroy();reject(new Error("timeout"));});
  });

  const tryAltMe = () => new Promise((resolve, reject) => {
    const req = https.get("https://api.alternative.me/fng/?limit=1", res => {
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{
        try {
          const j=JSON.parse(d),pt=j.data[0];
          const publishedAt=pt.timestamp?new Date(parseInt(pt.timestamp)*1000).toISOString():null;
          resolve({value:parseInt(pt.value),label:labelES(parseInt(pt.value)),publishedAt,source:"alternative.me"});
        } catch(e){reject(e);}
      });
    });
    req.on("error",reject); req.setTimeout(5000,()=>{req.destroy();reject(new Error("timeout"));});
  });

  return tryCMC()
    .catch(e=>{ console.log(`[F&G] CMC falló: ${e.message} → probando CNN`); return tryCNN(); })
    .catch(e=>{ console.log(`[F&G] CNN falló: ${e.message} → usando alternative.me`); return tryAltMe(); })
    .catch(e=>{ console.log(`[F&G] Todos fallaron: ${e.message} → fallback 50`); return {value:50,label:"😐 Neutral",publishedAt:null,source:"fallback"}; });
}

// ── CryptoPanic news ──────────────────────────────────────────────────────────
const CRYPTOPANIC_KEY = process.env.CRYPTOPANIC_KEY || "";
const NEG_KW = ["hack","exploit","breach","stolen","ban","crash","collapse","bankrupt","fraud","scam","rug","arrested","shutdown","lawsuit","sec","seizure","suspended"];
const POS_KW = ["etf","approved","partnership","launch","upgrade","institutional","adoption","record","bull","rally","listing"];
let lastNewsCheck=0, cachedNews=null;

async function fetchNewsAlert(symbols=["BTC","ETH","SOL"]) {
  if (Date.now()-lastNewsCheck<10*60*1000) return cachedNews;
  lastNewsCheck=Date.now();
  if (!CRYPTOPANIC_KEY) return null;
  return new Promise(resolve=>{
    const req=https.get(`https://cryptopanic.com/api/v1/posts/?auth_token=${CRYPTOPANIC_KEY}&currencies=${symbols.join(",")}&filter=important&public=true`,res=>{
      let d="";res.on("data",c=>d+=c);
      res.on("end",()=>{
        try {
          const posts=JSON.parse(d).results||[];
          if(!posts.length){cachedNews=null;resolve(null);return;}
          const t=(posts[0].title||"").toLowerCase();
          cachedNews={title:posts[0].title,url:posts[0].url,negative:NEG_KW.some(k=>t.includes(k)),positive:POS_KW.some(k=>t.includes(k)),ts:posts[0].published_at,currencies:(posts[0].currencies||[]).map(c=>c.code)};
          resolve(cachedNews);
        }catch{resolve(null);}
      });
    });
    req.on("error",()=>resolve(null));
    req.setTimeout(5000,()=>{req.destroy();resolve(null);});
  });
}

// ── Klines históricos de Binance (datos reales de velas) ─────────────────────
// Descarga hasta 500 velas de 1h por par para enriquecer el replay nocturno
// API gratuita, sin autenticación
function fetchKlines(symbol, interval="1h", limit=500) {
  return new Promise(resolve=>{
    const url=`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const req=https.get(url,res=>{
      let d="";res.on("data",c=>d+=c);
      res.on("end",()=>{
        try {
          const klines=JSON.parse(d);
          // Cada kline: [openTime, open, high, low, close, volume, ...]
          // Devolvemos array de precios de cierre
          const closes=klines.map(k=>parseFloat(k[4]));
          resolve(closes);
        }catch{resolve([]);}
      });
    });
    req.on("error",()=>resolve([]));
    req.setTimeout(8000,()=>{req.destroy();resolve([]);});
  });
}

// Descargar klines para todos los pares principales
async function fetchAllKlines(pairs=["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT"], interval="1h", limit=200) {
  const results={};
  for(const symbol of pairs){
    try{
      const closes=await fetchKlines(symbol,interval,limit);
      if(closes.length>0){results[symbol]=closes;console.log(`[KLINES] ${symbol}: ${closes.length} velas ${interval}`);}
      // Pequeña pausa para no saturar la API
      await new Promise(r=>setTimeout(r,200));
    }catch(e){console.warn(`[KLINES] Error ${symbol}:`,e.message);}
  }
  return results;
}

// ── Replay nocturno con klines reales ─────────────────────────────────────────
function emaCalc(arr, period) {
  if (!arr.length) return 0;
  const k = 2/(period+1);
  return arr.reduce((p,c,i) => i===0 ? c : c*k + p*(1-k));
}

function rsiCalc(arr, p=14) {
  if (arr.length < p+1) return 50;
  let g=0, l=0;
  for (let i=arr.length-p; i<arr.length; i++) {
    const d = arr[i]-arr[i-1];
    if (d>0) g+=d; else l-=d;
  }
  return l===0 ? 100 : 100-100/(1+g/l);
}

function bbCalc(arr, p=20, mult=2) {
  if (arr.length < p) return {upper:arr[arr.length-1]*1.02, lower:arr[arr.length-1]*0.98, mid:arr[arr.length-1]};
  const slice=arr.slice(-p), mid=slice.reduce((a,b)=>a+b,0)/p;
  const sd=Math.sqrt(slice.reduce((s,v)=>s+(v-mid)**2,0)/p);
  return {upper:mid+mult*sd, lower:mid-mult*sd, mid};
}

function runNightlyReplay(history, optimizerParams, externalKlines={}) {
  const combinedHistory={...externalKlines};
  for(const [sym,prices] of Object.entries(history)){
    if(!combinedHistory[sym]||combinedHistory[sym].length<prices.length)
      combinedHistory[sym]=prices;
  }

  // Más variantes de parámetros para explorar más el espacio
  const variants=[
    {emaFast:7,  emaSlow:18, minScore:58, rsiOversold:32},
    {emaFast:9,  emaSlow:21, minScore:62, rsiOversold:30},
    {emaFast:9,  emaSlow:21, minScore:68, rsiOversold:35},
    {emaFast:11, emaSlow:26, minScore:63, rsiOversold:32},
    {emaFast:7,  emaSlow:14, minScore:60, rsiOversold:28},
    {emaFast:12, emaSlow:26, minScore:66, rsiOversold:33},
    {emaFast:5,  emaSlow:13, minScore:62, rsiOversold:30},
    {emaFast:8,  emaSlow:21, minScore:65, rsiOversold:35},
    {...optimizerParams}, // params actuales
  ];

  const results=[];
  const FEE = 0.00075 * 2; // BNB fee round-trip

  for(const params of variants){
    let wins=0, losses=0, totalPnl=0, pnls=[];
    for(const [symbol,prices] of Object.entries(combinedHistory)){
      if(prices.length<50) continue;
      let inTrade=false, entryPrice=0;
      for(let i=30; i<prices.length-1; i++){
        const slice = prices.slice(Math.max(0,i-50), i+1);
        const emaF = emaCalc(slice, params.emaFast||9);
        const emaS = emaCalc(slice, params.emaSlow||21);
        const rsiVal = rsiCalc(slice);
        const bb = bbCalc(slice);
        const bbPos = (prices[i]-bb.lower)/(bb.upper-bb.lower||1);

        // Entry: EMA cross + RSI oversold + BB low
        const buyScore = (emaF>emaS?35:0) + (rsiVal<(params.rsiOversold||32)?30:0) + (bbPos<0.25?20:0);
        const sellScore = (emaF<emaS?35:0) + (rsiVal>68?25:0) + (bbPos>0.75?15:0);

        if(!inTrade && buyScore>=(params.minScore||60)){
          inTrade=true; entryPrice=prices[i];
        } else if(inTrade && (sellScore>=55 || prices[i]<entryPrice*0.96)){
          const pnl = (prices[i]-entryPrice)/entryPrice*100 - FEE*100;
          if(pnl>0) wins++; else losses++;
          totalPnl+=pnl; pnls.push(pnl); inTrade=false;
        }
      }
    }
    const total=wins+losses;
    if(total<3){results.push({params,winRate:0,avgPnl:0,trades:0,sharpe:0});continue;}
    const wr=+(wins/total*100).toFixed(0);
    const avgPnl=+(totalPnl/total).toFixed(2);
    // Sharpe ratio simplificado
    const mean=totalPnl/total;
    const variance=pnls.reduce((s,p)=>s+(p-mean)**2,0)/total;
    const sharpe=variance>0?+(mean/Math.sqrt(variance)).toFixed(2):0;
    results.push({params,winRate:wr,avgPnl,trades:total,sharpe});
  }

  // Ordenar por combinación de WR, avgPnl y Sharpe
  const best=results
    .filter(r=>r.trades>=5)
    .sort((a,b)=>(b.winRate*0.4+b.avgPnl*0.4+b.sharpe*0.2)-(a.winRate*0.4+a.avgPnl*0.4+a.sharpe*0.2))[0]
    || results[0];

  console.log(`[REPLAY] Mejor: EMA${best.params.emaFast}/${best.params.emaSlow} score${best.params.minScore} RSI<${best.params.rsiOversold||32} | WR:${best.winRate}% avgPnl:${best.avgPnl}% Sharpe:${best.sharpe} (${best.trades} trades)`);
  return best;
}

// ── Binance Futures: Long/Short ratio + Funding Rate ──────────────────────────
async function fetchLongShortRatio(symbol="BTCUSDT") {
  return new Promise(resolve => {
    const https2=require("https");
    const req=https2.get({hostname:"fapi.binance.com",
      path:`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`,
      headers:{"User-Agent":"Mozilla/5.0"}
    }, res=>{
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{
        try{
          const arr=JSON.parse(d); const latest=Array.isArray(arr)?arr[0]:arr;
          const ratio=parseFloat(latest?.longShortRatio||1);
          resolve({ratio:+ratio.toFixed(3),
            longPct:+(ratio/(1+ratio)*100).toFixed(1),
            signal:ratio>1.8?"OVERLEVERAGED_LONG":ratio<0.6?"OVERLEVERAGED_SHORT":"NEUTRAL",ts:Date.now()});
        }catch{resolve({ratio:1,signal:"NEUTRAL",ts:Date.now()});}
      });
    });
    req.on("error",()=>resolve({ratio:1,signal:"NEUTRAL",ts:Date.now()}));
    req.setTimeout(5000,()=>{req.destroy();resolve({ratio:1,signal:"NEUTRAL",ts:Date.now()});});
  });
}

async function fetchFundingRate(symbol="BTCUSDT") {
  return new Promise(resolve=>{
    const https2=require("https");
    const req=https2.get({hostname:"fapi.binance.com",
      path:`/fapi/v1/premiumIndex?symbol=${symbol}`,
      headers:{"User-Agent":"Mozilla/5.0"}
    }, res=>{
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{
        try{
          const data=JSON.parse(d);
          const rate=parseFloat(data?.lastFundingRate||0)*100;
          resolve({rate:+rate.toFixed(4),
            signal:rate>0.05?"LONGS_PAYING":rate<-0.01?"SHORTS_PAYING":"NEUTRAL"});
        }catch{resolve({rate:0,signal:"NEUTRAL"});}
      });
    });
    req.on("error",()=>resolve({rate:0,signal:"NEUTRAL"}));
    req.setTimeout(5000,()=>{req.destroy();resolve({rate:0,signal:"NEUTRAL"});});
  });
}

// ── Reddit r/CryptoCurrency sentiment (gratis, sin API key) ─────────────────
async function fetchRedditSentiment() {
  return new Promise(resolve => {
    const https2 = require("https");
    const req = https2.get({
      hostname: "www.reddit.com",
      path: "/r/CryptoCurrency/hot.json?limit=25",
      headers: { "User-Agent": "BafirTradingBot/1.0" }
    }, res => {
      let d = ""; res.on("data", c => d+=c);
      res.on("end", () => {
        try {
          const posts = JSON.parse(d)?.data?.children || [];
          let bullCount=0, bearCount=0, mentions={};
          const BULL_WORDS = ["bull","surge","rally","moon","pump","breakout","ath","green","gain","buy"];
          const BEAR_WORDS = ["bear","crash","dump","drop","fall","fear","sell","red","loss","recession"];
          const COINS = {BTC:["btc","bitcoin"],ETH:["eth","ethereum"],SOL:["sol","solana"],
                         BNB:["bnb"],XRP:["xrp","ripple"],ADA:["ada","cardano"]};
          for(const {data:p} of posts) {
            const text = ((p.title||"")+" "+(p.selftext||"")).toLowerCase();
            BULL_WORDS.forEach(w => { if(text.includes(w)) bullCount++; });
            BEAR_WORDS.forEach(w => { if(text.includes(w)) bearCount++; });
            Object.entries(COINS).forEach(([coin,words]) => {
              if(words.some(w=>text.includes(w))) mentions[coin]=(mentions[coin]||0)+1;
            });
          }
          const total = bullCount + bearCount || 1;
          const score = Math.round(bullCount/total*100); // 0-100, >55=bullish, <45=bearish
          resolve({
            score, bullCount, bearCount,
            signal: score>60?"BULLISH":score<40?"BEARISH":"NEUTRAL",
            mentions, postCount:posts.length, ts:Date.now(), source:"reddit"
          });
        } catch(e) { resolve({score:50,signal:"NEUTRAL",mentions:{},postCount:0,source:"reddit"}); }
      });
    });
    req.on("error", ()=>resolve({score:50,signal:"NEUTRAL",mentions:{},source:"reddit_error"}));
    req.setTimeout(8000, ()=>{req.destroy();resolve({score:50,signal:"NEUTRAL",mentions:{},source:"timeout"});});
  });
}

// ── Open Interest de Binance Futures (gratis, sin auth) ────────────────────
async function fetchOpenInterest(symbol="BTCUSDT") {
  return new Promise(resolve => {
    const https2=require("https");
    // OI histórico últimas 4h para ver si está creciendo o cayendo
    const req=https2.get({
      hostname:"fapi.binance.com",
      path:`/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=4`,
      headers:{"User-Agent":"Mozilla/5.0"}
    }, res=>{
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{
        try {
          const arr=JSON.parse(d);
          if(!Array.isArray(arr)||!arr.length) return resolve({trend:"NEUTRAL",change:0});
          const first=parseFloat(arr[0].sumOpenInterest);
          const last=parseFloat(arr[arr.length-1].sumOpenInterest);
          const change=(last-first)/first*100;
          // OI creciendo + precio subiendo = tendencia fuerte (confirma BULL)
          // OI cayendo + precio subiendo = short squeeze (oportunidad)
          // OI creciendo + precio cayendo = tendencia bajista fuerte
          resolve({
            openInterest:+last.toFixed(0),
            change:+change.toFixed(2),
            trend: change>2?"GROWING": change<-2?"DECLINING":"STABLE",
            ts:Date.now()
          });
        } catch { resolve({trend:"NEUTRAL",change:0,ts:Date.now()}); }
      });
    });
    req.on("error",()=>resolve({trend:"NEUTRAL",change:0,ts:Date.now()}));
    req.setTimeout(5000,()=>{req.destroy();resolve({trend:"NEUTRAL",change:0,ts:Date.now()});});
  });
}

// ── Taker Buy/Sell Volume (muy predictivo de dirección) ────────────────────
// Si compradores agresivos > vendedores agresivos → presión alcista real
async function fetchTakerVolume(symbol="BTCUSDT") {
  return new Promise(resolve => {
    const https2=require("https");
    const req=https2.get({
      hostname:"fapi.binance.com",
      path:`/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=4`,
      headers:{"User-Agent":"Mozilla/5.0"}
    }, res=>{
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{
        try {
          const arr=JSON.parse(d);
          if(!Array.isArray(arr)||!arr.length) return resolve({ratio:1,signal:"NEUTRAL"});
          // Promedio de las últimas 4h
          const avgRatio=arr.reduce((s,r)=>s+parseFloat(r.buySellRatio),0)/arr.length;
          resolve({
            ratio:+avgRatio.toFixed(3),
            signal: avgRatio>1.15?"BUYERS_DOMINANT": avgRatio<0.85?"SELLERS_DOMINANT":"NEUTRAL",
            ts:Date.now()
          });
        } catch { resolve({ratio:1,signal:"NEUTRAL",ts:Date.now()}); }
      });
    });
    req.on("error",()=>resolve({ratio:1,signal:"NEUTRAL",ts:Date.now()}));
    req.setTimeout(5000,()=>{req.destroy();resolve({ratio:1,signal:"NEUTRAL",ts:Date.now()});});
  });
}



// ── F&G Calibration: aprende a ajustar el sintético vs el oficial ─────────────
// Cada vez que llega un F&G oficial, guarda el par (sintético, oficial)
// Con 10+ observaciones, ajusta los pesos del modelo sintético via regresión simple

class FearGreedCalibrator {
  constructor() {
    this.observations = []; // [{synthetic, official, ts, scores}]
    this.maxObs = 90;       // 90 días máximo
    // Pesos iniciales por componente (suman 1.0)
    this.weights = {
      momentum:  0.30,
      trend:     0.20,
      sentiment: 0.20,
      funding:   0.15,
      oi:        0.10,
      social:    0.05,
    };
    this.officialBlend = 0.60; // cuánto peso al oficial vs sintético
    this.calibrated = false;
    this.lastCalibration = null;
    this.rmse = null; // error cuadrático medio del modelo
  }

  // Registrar observación cuando llega el F&G oficial
  recordObservation(syntheticScores, syntheticValue, officialValue) {
    this.observations.push({
      synthetic: syntheticValue,
      official: officialValue,
      scores: {...syntheticScores},
      ts: Date.now(),
    });
    // Mantener solo últimos 90 días
    if(this.observations.length > this.maxObs) this.observations.shift();
    // Recalibrar si tenemos suficientes datos
    if(this.observations.length >= 10) this.calibrate();
  }

  // Regresión lineal simple por componente
  // Minimiza MSE entre weighted_sum(scores) y official
  calibrate() {
    const obs = this.observations;
    const components = Object.keys(this.weights);

    // Calcular el error actual con los pesos actuales
    const errors = obs.map(o => {
      const predicted = components.reduce((s, k) => s + (o.scores[k]||50) * this.weights[k], 0);
      return o.official - predicted;
    });
    const currentRMSE = Math.sqrt(errors.reduce((s, e) => s + e*e, 0) / errors.length);

    // Ajuste de pesos por gradiente descendente simple
    const lr = 0.001; // learning rate muy pequeño para estabilidad
    const newWeights = {...this.weights};

    for(const comp of components) {
      // Gradiente del error respecto al peso del componente
      let gradient = 0;
      for(const o of obs) {
        const predicted = components.reduce((s, k) => s + (o.scores[k]||50) * newWeights[k], 0);
        const err = o.official - predicted;
        gradient += -2 * err * (o.scores[comp]||50);
      }
      gradient /= obs.length;
      newWeights[comp] = Math.max(0.02, Math.min(0.60, newWeights[comp] - lr * gradient));
    }

    // Renormalizar para que sumen 1.0
    const total = Object.values(newWeights).reduce((s, v) => s + v, 0);
    for(const k of components) newWeights[k] = +(newWeights[k] / total).toFixed(4);

    // Calcular nuevo RMSE con pesos ajustados
    const newErrors = obs.map(o => {
      const predicted = components.reduce((s, k) => s + (o.scores[k]||50) * newWeights[k], 0);
      return o.official - predicted;
    });
    const newRMSE = Math.sqrt(newErrors.reduce((s, e) => s + e*e, 0) / newErrors.length);

    // Solo adoptar si mejoró
    if(newRMSE < currentRMSE) {
      this.weights = newWeights;
      this.rmse = +newRMSE.toFixed(2);
      console.log(`[FG-CAL] ✅ Pesos ajustados — RMSE: ${currentRMSE.toFixed(2)}→${newRMSE.toFixed(2)} con ${obs.length} obs`);
    } else {
      this.rmse = +currentRMSE.toFixed(2);
    }

    // Ajustar cuánto confiar en oficial vs sintético según error
    // Si el error es bajo → más confianza en el sintético (blend más equilibrado)
    this.officialBlend = newRMSE < 5 ? 0.45 : newRMSE < 10 ? 0.55 : 0.65;
    this.calibrated = true;
    this.lastCalibration = new Date().toISOString();
  }

  getStats() {
    return {
      observations: this.observations.length,
      weights: this.weights,
      officialBlend: this.officialBlend,
      rmse: this.rmse,
      calibrated: this.calibrated,
      lastCalibration: this.lastCalibration,
    };
  }

  serialize() {
    return { observations: this.observations, weights: this.weights, officialBlend: this.officialBlend };
  }

  restore(data) {
    if(data?.observations) this.observations = data.observations;
    if(data?.weights) this.weights = data.weights;
    if(data?.officialBlend) this.officialBlend = data.officialBlend;
    if(this.observations.length >= 10) this.calibrate();
  }
}

// Singleton calibrador
const fgCalibrator = new FearGreedCalibrator();

// Versión mejorada de calcRealtimeFearGreed que usa el calibrador
function calcRealtimeFearGreed(bot, state = {}) {
  const scores = {};

  // 1. BTC momentum
  const btcHistory = bot.history?.["BTCUSDC"] || bot.history?.["BTCUSDT"] || [];
  if(btcHistory.length >= 2) {
    const last = btcHistory[btcHistory.length - 1];
    const shortStart = btcHistory[Math.max(0, btcHistory.length - 12)];
    const shortChange = ((last - shortStart) / shortStart) * 100;
    const longStart = btcHistory[Math.max(0, btcHistory.length - 100)];
    const longChange = ((last - longStart) / longStart) * 100;
    scores.momentum = Math.min(100, Math.max(0, 50 + shortChange * 8 * 0.4 + longChange * 6 * 0.6));
  } else { scores.momentum = 50; }

  // 2. BTC vs MA50
  if(btcHistory.length >= 50) {
    const ma50 = btcHistory.slice(-50).reduce((s, v) => s + v, 0) / 50;
    const pctAboveMA = ((btcHistory[btcHistory.length-1] - ma50) / ma50) * 100;
    scores.trend = Math.min(100, Math.max(0, 50 + pctAboveMA * 5));
  } else { scores.trend = 50; }

  // 3. Long/Short ratio
  if(state.longShortRatio?.ratio) {
    const ls = parseFloat(state.longShortRatio.ratio);
    scores.sentiment = Math.min(100, Math.max(0, (ls / 2.5) * 100));
  } else { scores.sentiment = 50; }

  // 4. Funding rate
  if(state.fundingRate?.rate != null) {
    scores.funding = Math.min(100, Math.max(0, 50 + parseFloat(state.fundingRate.rate) * 400));
  } else { scores.funding = 50; }

  // 5. Open Interest
  const oiMap = { "GROWING": 70, "STABLE": 50, "DECLINING": 30 };
  scores.oi = state.openInterest?.trend ? (oiMap[state.openInterest.trend] || 50) : 50;

  // 6. Reddit
  scores.social = state.redditSentiment?.score ?? 50;

  // Usar pesos calibrados (o defaults si no hay calibración)
  const weights = fgCalibrator.weights;
  const components = Object.keys(weights);
  const totalW = components.reduce((s, k) => s + weights[k], 0);
  let syntheticFG = Math.round(
    components.reduce((s, k) => s + (scores[k]||50) * weights[k], 0) / (totalW||1)
  );
  syntheticFG = Math.min(100, Math.max(0, syntheticFG));

  // Fusionar con oficial usando blend calibrado
  const officialFG = state.officialFearGreed || bot.fearGreed || null;
  const blend = fgCalibrator.officialBlend;
  const finalFG = officialFG != null
    ? Math.min(100, Math.max(0, Math.round(officialFG * blend + syntheticFG * (1-blend))))
    : syntheticFG;

  const label = finalFG<15?"😱 Pánico extremo":finalFG<25?"😨 Miedo extremo":finalFG<40?"😟 Miedo":finalFG<55?"😐 Neutral":finalFG<70?"🙂 Codicia":finalFG<85?"😏 Codicia alta":"🤑 Euforia";

  return { value:finalFG, synthetic:syntheticFG, official:officialFG, scores, blend, source:officialFG!=null?"realtime+official":"realtime", label, calibration:fgCalibrator.getStats(), updatedAt:new Date().toISOString() };
}

module.exports.calcRealtimeFearGreed = calcRealtimeFearGreed;
module.exports.fgCalibrator = fgCalibrator;


// ── CoinGlass liquidations (free, no auth) ──────────────────────────────────
async function fetchLiquidations() {
  try {
    const https = require("https");
    return await new Promise((resolve) => {
      const timer = setTimeout(()=>resolve(null), 5000);
      https.get("https://open-api.coinglass.com/public/v2/liquidation_history?symbol=BTC&time_type=h1",
        { headers: {"coinglassSecret":"","Content-Type":"application/json"} },
        r => {
          let d=""; r.on("data",c=>d+=c);
          r.on("end",()=>{
            clearTimeout(timer);
            try {
              const json = JSON.parse(d);
              const data = json?.data?.slice(-3)||[];
              const longLiqs  = data.reduce((s,x)=>s+(x.longLiquidationUsd||0),0);
              const shortLiqs = data.reduce((s,x)=>s+(x.shortLiquidationUsd||0),0);
              resolve({
                longLiqs, shortLiqs,
                // High short liquidations = short squeeze risk = bullish signal
                signal: shortLiqs > longLiqs*2 ? "SHORT_SQUEEZE_RISK" :
                         longLiqs > shortLiqs*2 ? "LONG_FLUSH_RISK" : "NEUTRAL",
                ratio: shortLiqs/(longLiqs+1)
              });
            } catch { resolve(null); }
          });
        }).on("error",()=>{ clearTimeout(timer); resolve(null); });
    });
  } catch { return null; }
}

// ── Alternative F&G sources (backup chain) ──────────────────────────────────
async function fetchFGAlternative() {
  // Try multiple sources in order
  const sources = [
    { url:"https://api.alternative.me/fng/?limit=1&format=json", parser: d=>({value:+d.data[0].value, label:d.data[0].value_classification, ts:d.data[0].timestamp}) },
    { url:"https://fear-and-greed-index.p.rapidapi.com/v1/fgi", parser: d=>({value:d.now.value, label:d.now.valueText, ts:Date.now()/1000}) },
  ];
  for(const src of sources) {
    try {
      const val = await new Promise((res)=>{
        const https = require("https");
        const timer = setTimeout(()=>res(null),4000);
        https.get(src.url, r=>{
          let d=""; r.on("data",c=>d+=c);
          r.on("end",()=>{ clearTimeout(timer); try{ res(src.parser(JSON.parse(d))); }catch{ res(null); } });
        }).on("error",()=>{ clearTimeout(timer); res(null); });
      });
      if(val?.value) return val;
    } catch {}
  }
  return null;
}


// ── BTC Dominance — señal crítica para altcoin trading ──────────────────────
// Cuando BTC.D sube: altcoins underperform aunque BTC suba
async function fetchBTCDominance() {
  try {
    const https = require("https");
    return await new Promise((resolve) => {
      const timer = setTimeout(()=>resolve(null), 5000);
      // CoinGecko free endpoint - no auth needed
      https.get("https://api.coingecko.com/api/v3/global",
        { headers: {"User-Agent":"Mozilla/5.0"} },
        r => {
          let d=""; r.on("data",c=>d+=c);
          r.on("end",()=>{
            clearTimeout(timer);
            try {
              const json = JSON.parse(d);
              const dom = json?.data?.market_cap_percentage?.btc||50;
              resolve({
                btcDominance: +dom.toFixed(2),
                // Rising dominance = altcoins suffer
                signal: dom > 55 ? "BTC_DOMINANT_AVOID_ALTS" :
                         dom < 45 ? "ALTSEASON_FAVORABLE" : "NEUTRAL",
                altcoinMultiplier: dom > 55 ? 0.7 : dom < 45 ? 1.2 : 1.0
              });
            } catch { resolve(null); }
          });
        }).on("error",()=>{ clearTimeout(timer); resolve(null); });
    });
  } catch { return null; }
}


// ── Coinbase Premium Index ────────────────────────────────────────────────
// BTC price diff between Coinbase (US institutions) and Binance (retail)
// Premium > 0: US institutions buying → bullish signal
// Premium < 0: US institutions selling → bearish signal
async function fetchCoinbasePremium() {
  try {
    const https = require("https");
    const [cbPrice, bnPrice] = await Promise.all([
      new Promise(res => {
        const t = setTimeout(()=>res(null),4000);
        https.get("https://api.exchange.coinbase.com/products/BTC-USD/ticker",
          {headers:{"User-Agent":"Mozilla/5.0"}}, r=>{
            let d=""; r.on("data",c=>d+=c);
            r.on("end",()=>{clearTimeout(t);try{res(parseFloat(JSON.parse(d).price));}catch{res(null);}});
          }).on("error",()=>{clearTimeout(t);res(null);});
      }),
      new Promise(res => {
        const t = setTimeout(()=>res(null),4000);
        https.get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
          r=>{
            let d=""; r.on("data",c=>d+=c);
            r.on("end",()=>{clearTimeout(t);try{res(parseFloat(JSON.parse(d).price));}catch{res(null);}});
          }).on("error",()=>{clearTimeout(t);res(null);});
      })
    ]);
    if(!cbPrice||!bnPrice) return null;
    const premium = ((cbPrice - bnPrice) / bnPrice) * 100;
    return {
      cbPrice, bnPrice, premium: +premium.toFixed(4),
      // >0.1% = strong US institutional buying → BULL signal
      // <-0.1% = US institutions selling → BEAR signal
      signal: premium > 0.15 ? "INSTITUTIONAL_BUY" :
               premium > 0.05 ? "SLIGHT_BUY" :
               premium < -0.15 ? "INSTITUTIONAL_SELL" :
               premium < -0.05 ? "SLIGHT_SELL" : "NEUTRAL",
      bullish: premium > 0.05
    };
  } catch { return null; }
}

// ── Exchange Inflow/Outflow (Binance BTC reserves proxy) ─────────────────
// When BTC flows INTO exchanges → selling pressure incoming
// When BTC flows OUT of exchanges → accumulation (bullish)
// We use order book depth as a proxy (free, no auth)
async function fetchExchangeFlow() {
  try {
    const https = require("https");
    // Use Binance order book depth ratio as flow proxy
    // High ask depth vs bid depth = selling pressure
    const data = await new Promise(res => {
      const t = setTimeout(()=>res(null),5000);
      https.get("https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=100", r=>{
        let d=""; r.on("data",c=>d+=c);
        r.on("end",()=>{clearTimeout(t);try{res(JSON.parse(d));}catch{res(null);}});
      }).on("error",()=>{clearTimeout(t);res(null);});
    });
    if(!data?.bids||!data?.asks) return null;
    const bidVol = data.bids.slice(0,20).reduce((s,[p,q])=>s+parseFloat(q),0);
    const askVol = data.asks.slice(0,20).reduce((s,[p,q])=>s+parseFloat(q),0);
    const ratio = bidVol / (askVol || 1);
    return {
      bidVol: +bidVol.toFixed(3),
      askVol: +askVol.toFixed(3),
      ratio: +ratio.toFixed(3),
      // ratio > 1.2 = more buyers than sellers → accumulation
      // ratio < 0.8 = more sellers → distribution
      signal: ratio > 1.3 ? "ACCUMULATION_STRONG" :
               ratio > 1.1 ? "ACCUMULATION" :
               ratio < 0.7 ? "DISTRIBUTION_STRONG" :
               ratio < 0.9 ? "DISTRIBUTION" : "NEUTRAL",
      bullish: ratio > 1.1
    };
  } catch { return null; }
}

// ── Binance BTC Reserve Change (via CoinGlass public) ────────────────────
// Direct measurement of BTC moving in/out of Binance
async function fetchBinanceReserve() {
  try {
    const https = require("https");
    const data = await new Promise(res => {
      const t = setTimeout(()=>res(null),5000);
      https.get(
        "https://open-api.coinglass.com/public/v2/exchange_reserve?symbol=BTC&exchange=Binance",
        {headers:{"coinglassSecret":"","Content-Type":"application/json"}},
        r=>{
          let d=""; r.on("data",c=>d+=c);
          r.on("end",()=>{clearTimeout(t);try{
            const j=JSON.parse(d);
            const reserves=j?.data?.slice(-2)||[];
            if(reserves.length<2) return res(null);
            const change = reserves[1].exchangeBalance - reserves[0].exchangeBalance;
            res({
              current: reserves[1].exchangeBalance,
              change: +change.toFixed(2),
              // Negative = BTC leaving exchange = accumulation = BULLISH
              // Positive = BTC entering exchange = selling pressure = BEARISH
              signal: change < -500 ? "OUTFLOW_STRONG" :
                       change < -100 ? "OUTFLOW" :
                       change >  500 ? "INFLOW_STRONG" :
                       change >  100 ? "INFLOW" : "NEUTRAL",
              bullish: change < -100
            });
          }catch{res(null);}});
        }).on("error",()=>{clearTimeout(t);res(null);});
    });
    return data;
  } catch { return null; }
}

module.exports={calcRealtimeFearGreed,fetchFearGreed,fetchNewsAlert,fetchAllKlines,runNightlyReplay,
  fetchLongShortRatio,fetchFundingRate,fetchRedditSentiment,
  fetchOpenInterest,fetchTakerVolume,fgCalibrator,fetchLiquidations,fetchFGAlternative,fetchBTCDominance,fetchCoinbasePremium,fetchExchangeFlow,fetchBinanceReserve};
