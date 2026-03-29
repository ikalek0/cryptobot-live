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

  return tryCMC().catch(()=>tryCNN()).catch(()=>tryAltMe())
    .catch(()=>({value:50,label:"😐 Neutral",publishedAt:null,source:"fallback"}));
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
function runNightlyReplay(history, optimizerParams, externalKlines={}) {
  // Combinar historial en memoria con klines reales descargados
  const combinedHistory={...externalKlines};
  for(const [sym,prices] of Object.entries(history)){
    if(!combinedHistory[sym]||combinedHistory[sym].length<prices.length){
      combinedHistory[sym]=prices;
    }
  }

  const variants=[
    {emaFast:7, emaSlow:18,minScore:60},
    {emaFast:9, emaSlow:21,minScore:65},
    {emaFast:11,emaSlow:26,minScore:65},
    {emaFast:9, emaSlow:21,minScore:70},
    {emaFast:7, emaSlow:14,minScore:62},
    {emaFast:12,emaSlow:26,minScore:68},
    // Params actuales también
    {...optimizerParams},
  ];

  const results=[];
  for(const params of variants){
    let wins=0,losses=0,totalPnl=0;
    for(const[symbol,prices]of Object.entries(combinedHistory)){
      if(prices.length<50)continue;
      let inTrade=false,entryPrice=0;
      for(let i=Math.max(params.emaSlow,21);i<prices.length-1;i++){
        const slice=prices.slice(0,i+1);
        const k=2/(params.emaFast+1),k2=2/(params.emaSlow+1);
        const emaF=slice.slice(-params.emaFast).reduce((p,c,j)=>j===0?c:c*k+p*(1-k));
        const emaS=slice.slice(-params.emaSlow).reduce((p,c,j)=>j===0?c:c*k2+p*(1-k2));
        const score=emaF>emaS?70:30;
        if(!inTrade&&score>=params.minScore){inTrade=true;entryPrice=prices[i];}
        else if(inTrade&&score<(100-params.minScore)){
          const pnl=(prices[i]-entryPrice)/entryPrice*100;
          if(pnl>0)wins++;else losses++;
          totalPnl+=pnl;inTrade=false;
        }
      }
    }
    const total=wins+losses;
    results.push({params,winRate:total?+(wins/total*100).toFixed(0):0,avgPnl:total?+(totalPnl/total).toFixed(2):0,trades:total});
  }

  const best=results.sort((a,b)=>(b.winRate*0.6+b.avgPnl*0.4)-(a.winRate*0.6+a.avgPnl*0.4))[0];
  console.log(`[REPLAY] Mejor: EMA${best.params.emaFast}/${best.params.emaSlow} score${best.params.minScore} | WR:${best.winRate}% avgPnl:${best.avgPnl}% (${best.trades} trades, ${Object.keys(combinedHistory).length} pares)`);
  return best;
}

module.exports={fetchFearGreed,fetchNewsAlert,fetchAllKlines,runNightlyReplay};
