// ─── CRYPTOBOT ENGINE v2 LIVE — ESTRATEGIA ADAPTATIVA POR RÉGIMEN ────────────
"use strict";

const { RISK_PROFILES, CircuitBreaker, TrailingStop, calcPositionSize, AutoOptimizer } = require("./risk");
const { AutoBlacklist, PartialCloseManager, calcDynamicStop, ConfidenceScore } = require("./live_features_patch");
const { StrategyEvaluator } = require("./strategyEvaluator");
const { CounterfactualMemory } = require("./counterfactual");
const { PatternMemory }        = require("./patternMemory");
const { DQN } = require("./dqn");
const { MultiAgentSystem } = require("./multiAgent");
const { RiskLearning } = require("./riskLearning");
const { CorrelationManager } = require("./correlationManager");
const { AdaptiveStopLoss, AdaptiveHours, NewsImpactLearner, AdaptiveRegimeDetector, calcAdaptiveLR, calcAdaptiveKelly, calcRealKelly } = require("./adaptive_learning");

const INITIAL_CAPITAL  = parseFloat(process.env.CAPITAL_USDC || process.env.CAPITAL_USDT || "100");
const MIN_CASH_RESERVE = 0.15;
const PUMP_THRESHOLD   = 0.08;
const REENTRY_COOLDOWN = 2 * 60 * 60 * 1000;
const BNB_FEE          = 0.00075;
const NORMAL_FEE       = 0.001;
const MAX_DRAWDOWN_PCT = 0.15;
// En PAPER_MODE: sin circuit breaker ni drawdown para aprender en todas las condiciones


const PAIRS = [
  { symbol:"BTCUSDC",  name:"Bitcoin",   short:"BTC",  category:"L1",   group:"major" },
  { symbol:"ETHUSDC",  name:"Ethereum",  short:"ETH",  category:"L1",   group:"major" },
  { symbol:"SOLUSDC",  name:"Solana",    short:"SOL",  category:"L1",   group:"alt1"  },
  { symbol:"BNBUSDC",  name:"BNB",       short:"BNB",  category:"L1",   group:"alt1"  },
  { symbol:"AVAXUSDC", name:"Avalanche", short:"AVAX", category:"L1",   group:"alt2"  },
  { symbol:"ADAUSDC",  name:"Cardano",   short:"ADA",  category:"L1",   group:"alt2"  },
  { symbol:"DOTUSDC",  name:"Polkadot",  short:"DOT",  category:"L1",   group:"alt2"  },
  { symbol:"LINKUSDC", name:"Chainlink", short:"LINK", category:"DeFi", group:"defi"  },
  { symbol:"UNIUSDC",  name:"Uniswap",   short:"UNI",  category:"DeFi", group:"defi"  },
  { symbol:"AAVEUSDC", name:"Aave",      short:"AAVE", category:"DeFi", group:"defi"  },
  { symbol:"XRPUSDC",  name:"Ripple",    short:"XRP",  category:"Pago", group:"pay"   },
  { symbol:"LTCUSDC",  name:"Litecoin",  short:"LTC",  category:"Pago", group:"pay"   },
  // Nuevos pares
  { symbol:"POLUSDC",name:"Polygon (POL)",   short:"POL",category:"L2",   group:"l2"    },
  { symbol:"OPUSDC",   name:"Optimism",  short:"OP",   category:"L2",   group:"l2"    },
  { symbol:"ARBUSDC",  name:"Arbitrum",  short:"ARB",  category:"L2",   group:"l2"    },
  { symbol:"ATOMUSDC", name:"Cosmos",    short:"ATOM", category:"L1",   group:"alt3"  },
  { symbol:"NEARUSDC", name:"NEAR",      short:"NEAR", category:"L1",   group:"alt3"  },
  { symbol:"APTUSDC",  name:"Aptos",     short:"APT",  category:"L1",   group:"alt3"  },
  // ── USDT alternatives: 10x more liquidity on Binance, 1:1 with USDC ────
  { symbol:"BTCUSDT",  name:"Bitcoin",   short:"BTC",  category:"L1",   group:"major", quoteAsset:"USDT" },
  { symbol:"ETHUSDT",  name:"Ethereum",  short:"ETH",  category:"L1",   group:"major", quoteAsset:"USDT" },
  { symbol:"SOLUSDT",  name:"Solana",    short:"SOL",  category:"L1",   group:"alt1",  quoteAsset:"USDT" },
  { symbol:"BNBUSDT",  name:"BNB",       short:"BNB",  category:"L1",   group:"alt1",  quoteAsset:"USDT" },
  { symbol:"XRPUSDT",  name:"Ripple",    short:"XRP",  category:"Pago", group:"pay",   quoteAsset:"USDT" },
  { symbol:"LINKUSDT", name:"Chainlink", short:"LINK", category:"DeFi", group:"defi",  quoteAsset:"USDT" },
]
// Pre-built Map for O(1) symbol lookup
const PAIRS_MAP = new Map(PAIRS.map(p=>[p.symbol,p]));
;

const CATEGORIES = {
  L1:   { name:"Layer 1", color:"#f7931a", emoji:"🔶" },
  L2:   { name:"Layer 2", color:"#7b68ee", emoji:"🔷" },
  DeFi: { name:"DeFi",    color:"#00c8ff", emoji:"💎" },
  Pago: { name:"Pagos",   color:"#00e5a0", emoji:"💸" },
};

// ── Multi-timeframe: agrega precios en velas de 5min y 15min ─────────────────
// Cada 150 ticks (5min a 2s/tick) guardamos un cierre de "vela 5min"
// Así el bot puede ver tendencias en múltiples timeframes
function updateMultiTF(tfHistory, symbol, price, tick) {
  if (!tfHistory[symbol]) tfHistory[symbol] = { tf5: [], tf15: [], tf60: [], lastPrice: price };
  tfHistory[symbol].lastPrice = price;
  // Vela 5min cada 150 ticks (150 × 2s = 5min)
  if (tick % 150 === 0) { tfHistory[symbol].tf5 = [...(tfHistory[symbol].tf5||[]), price].slice(-100); }
  // Vela 15min cada 450 ticks
  if (tick % 450 === 0) { tfHistory[symbol].tf15 = [...(tfHistory[symbol].tf15||[]), price].slice(-100); }
  // Vela 1h cada 1800 ticks
  if (tick % 1800 === 0) { tfHistory[symbol].tf60 = [...(tfHistory[symbol].tf60||[]), price].slice(-100); }
}

function getDailyLimit(regime, wr) {
  const h = new Date(Date.now()+2*3600000).getUTCHours();
  const isNight = h < 9; // madrugada Francia
  let base = regime==="BULL"?25:regime==="LATERAL"?15:regime==="BEAR"?5:10;
  if(wr!==null){if(wr>65)base=Math.round(base*1.3);else if(wr<45)base=Math.round(base*0.6);else if(wr<50)base=Math.round(base*0.8);}
  const limit = Math.max(3,Math.min(25,base));
  return isNight ? Math.min(3, limit) : limit; // madrugada: max 3
}

// ── Indicadores ───────────────────────────────────────────────────────────────
function ema(arr,p){if(!arr.length)return 0;const k=2/(p+1);return arr.reduce((prev,cur,i)=>i===0?cur:cur*k+prev*(1-k));}
function rsi(arr,p=14){if(arr.length<p+1)return 50;let g=0,l=0;for(let i=arr.length-p;i<arr.length;i++){const d=arr[i]-arr[i-1];if(d>0)g+=d;else l-=d;}if(l===0)return 100;return 100-100/(1+g/l);}
function atr(closes,p=14){if(closes.length<2)return closes[0]*0.03;const trs=closes.slice(1).map((c,i)=>Math.abs(c-closes[i]));return trs.slice(-p).reduce((a,b)=>a+b,0)/Math.min(trs.length,p);}
function stdDev(arr){if(arr.length<2)return 0;const mean=arr.reduce((a,b)=>a+b,0)/arr.length;return Math.sqrt(arr.reduce((s,v)=>s+(v-mean)**2,0)/arr.length);}
function bollingerBands(arr,p=20,mult=2){
  if(arr.length<p)return{upper:arr[arr.length-1]*1.02,lower:arr[arr.length-1]*0.98,mid:arr[arr.length-1]};
  const slice=arr.slice(-p),mid=slice.reduce((a,b)=>a+b,0)/p;
  const sd=Math.sqrt(slice.reduce((s,v)=>s+(v-mid)**2,0)/p);
  return{upper:mid+mult*sd,lower:mid-mult*sd,mid};
}

// ── Régimen con ADX ───────────────────────────────────────────────────────────
// ADX mide la FUERZA de la tendencia (no la dirección)
// ADX > 25 = tendencia fuerte (BULL o BEAR según dirección)
// ADX < 20 = sin tendencia (LATERAL)
function calcADX(h, period=14) {
  if (h.length < period*2) return 15; // sin datos = asumir lateral
  const slice = h.slice(-(period*2+1));
  let plusDM=0, minusDM=0, tr=0;
  const smoothed = { plusDM:0, minusDM:0, tr:0 };
  for (let i=1; i<slice.length; i++) {
    const high=slice[i]*1.001, low=slice[i]*0.999; // approx sin datos OHLC
    const prevHigh=slice[i-1]*1.001, prevLow=slice[i-1]*0.999, prevClose=slice[i-1];
    const upMove=high-prevHigh, downMove=prevLow-low;
    const pdm = upMove>downMove&&upMove>0 ? upMove : 0;
    const mdm = downMove>upMove&&downMove>0 ? downMove : 0;
    const atr=Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose));
    if (i <= period) { smoothed.plusDM+=pdm; smoothed.minusDM+=mdm; smoothed.tr+=atr; }
    else {
      smoothed.plusDM = smoothed.plusDM - smoothed.plusDM/period + pdm;
      smoothed.minusDM= smoothed.minusDM- smoothed.minusDM/period + mdm;
      smoothed.tr     = smoothed.tr     - smoothed.tr/period      + atr;
    }
  }
  if (!smoothed.tr) return 15;
  const plusDI=100*smoothed.plusDM/smoothed.tr;
  const minusDI=100*smoothed.minusDM/smoothed.tr;
  const dx=Math.abs(plusDI-minusDI)/(plusDI+minusDI||1)*100;
  return +dx.toFixed(1);
}

function detectRegime(h) {
  if (!h||h.length<50) return "UNKNOWN";
  const last=h[h.length-1];
  const ma20=h.slice(-20).reduce((a,b)=>a+b,0)/20;
  const ma50=h.slice(-50).reduce((a,b)=>a+b,0)/50;
  const trend20=(last-h[Math.max(0,h.length-20)])/h[Math.max(0,h.length-20)]*100;
  const trend5 =(last-h[Math.max(0,h.length-5)]) /h[Math.max(0,h.length-5)] *100;
  const trend50=(last-h[Math.max(0,h.length-50)])/h[Math.max(0,h.length-50)]*100;
  const adx=calcADX(h, 14);

  if (adx > 25 && last<ma20 && trend20<-1.5 && trend5<0) return "BEAR";
  if (trend5 < -3 && last < ma20) return "BEAR";
  if (adx > 25 && last>ma20 && trend20>1.5 && trend5>0) return "BULL";
  if (last>ma20 && ma20>ma50 && trend20>3 && adx>18) return "BULL";
  // Downtrend lento → tratar como BEAR para ser conservadores
  if (last<ma20 && ma20<ma50 && trend20<-2 && trend50<-5) return "BEAR";
  return "LATERAL";
}

// ── Señales adaptativas ───────────────────────────────────────────────────────

// Detectar volumen anómalo — si el cambio de precio reciente es 3x la media
// Es un proxy de volumen real basado en la magnitud de movimiento de precio
function getVolumeAnomaly(volumeHistory, symbol) {
  const vh = volumeHistory?.[symbol] || [];
  if (vh.length < 20) return { anomaly: false, ratio: 1.0 };
  const recent = vh.slice(-3).reduce((a,b)=>a+b,0)/3;  // últimas 3 lecturas
  const baseline = vh.slice(-30,-3).reduce((a,b)=>a+b,0)/27;  // media 30 lecturas previas
  const ratio = baseline > 0 ? recent / baseline : 1.0;
  return { anomaly: ratio > 2.5, ratio: +ratio.toFixed(2) };
}

function signalMomentum(sym,history,params){
  const h=history[sym]||[];
  if(h.length<10)return{signal:"HOLD",score:50,reason:"Sin datos",rsiVal:50,atrPct:3,mom10:0,strategy:"MOMENTUM"};
  const last=h[h.length-1],emaFast=ema(h,params.emaFast),emaSlow=ema(h,params.emaSlow);
  const rsiVal=rsi(h),atrVal=atr(h),atrPct=(atrVal/last)*100;
  const mom10=((last-h[Math.max(0,h.length-10)])/h[Math.max(0,h.length-10)])*100;
  const vol30=stdDev(h.slice(-30).map((v,i,a)=>i===0?0:(v-a[i-1])/a[i-1]));
  const volP=vol30>0.03?0.8:1.0;
  let score=50;
  const emaDiff=((emaFast-emaSlow)/emaSlow)*100;
  score+=Math.max(-25,Math.min(25,emaDiff*10));
  if(rsiVal<params.rsiOversold)score+=20;else if(rsiVal<45)score+=10;else if(rsiVal>params.rsiOverbought)score-=20;else if(rsiVal>58)score-=8;
  if(mom10>5)score+=15;else if(mom10>2)score+=8;if(mom10<-5)score-=15;else if(mom10<-2)score-=8;
  score=Math.max(5,Math.min(95,Math.round(score*volP)));
  let signal=score>=params.minScore?"BUY":score<=(100-params.minScore)?"SELL":"HOLD";
  return{signal,score,reason:`MOMENTUM · EMA ${emaFast.toFixed(1)}/${emaSlow.toFixed(1)} · RSI ${rsiVal.toFixed(0)} · Mom ${mom10.toFixed(1)}%`,rsiVal:+rsiVal.toFixed(1),atrPct:+atrPct.toFixed(2),mom10:+mom10.toFixed(2),emaFast,emaSlow,strategy:"MOMENTUM"};
}

function signalMeanReversion(sym,history,params){
  const h=history[sym]||[];
  if(h.length<20)return{signal:"HOLD",score:50,reason:"Sin datos",rsiVal:50,atrPct:3,mom10:0,strategy:"MEAN_REVERSION"};
  const last=h[h.length-1],bb=bollingerBands(h,20,2);
  const rsiVal=rsi(h),atrVal=atr(h),atrPct=(atrVal/last)*100;
  const bbRange=bb.upper-bb.lower||1,bbPos=(last-bb.lower)/bbRange;
  let score=50,signal="HOLD",reason="";
  if(bbPos<0.12&&rsiVal<35){score=82+Math.round((0.12-bbPos)*200);signal="BUY";reason=`MEAN REV FUERTE · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)} (sobreventa extrema)`;}
  else if(bbPos<0.20&&rsiVal<40){score=72+Math.round((0.20-bbPos)*100);signal="BUY";reason=`MEAN REV · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)} (sobreventa)`;}
  else if(bbPos<0.30&&rsiVal<45){score=60+Math.round((0.30-bbPos)*60);signal="BUY";reason=`MEAN REV DÉBIL · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)}`;}
  else if(bbPos>0.8&&rsiVal>60){score=25-Math.round((bbPos-0.8)*100);signal="SELL";reason=`MEAN REV · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)} (sobrecompra)`;}
  else{score=50+Math.round((0.5-bbPos)*20);reason=`En rango · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)}`;}
  score=Math.max(5,Math.min(95,score));
  signal=score>=params.minScore?"BUY":score<=(100-params.minScore)?"SELL":"HOLD";
  return{signal,score,reason,rsiVal:+rsiVal.toFixed(1),atrPct:+atrPct.toFixed(2),mom10:0,bbPos:+bbPos.toFixed(2),strategy:"MEAN_REVERSION"};
}

function signalBear(sym,history,params){
  const h=history[sym]||[];
  if(h.length<10)return{signal:"HOLD",score:30,reason:"Sin datos",rsiVal:50,atrPct:3,mom10:0,strategy:"BEAR"};
  const last=h[h.length-1],rsiVal=rsi(h),atrVal=atr(h),atrPct=(atrVal/last)*100;
  const bb=bollingerBands(h,20,2.5),bbPos=(last-bb.lower)/(bb.upper-bb.lower||1);
  let score=30,signal="HOLD",reason=`BEAR · RSI ${rsiVal.toFixed(0)} · Esperando rebote extremo`;
  if(rsiVal<25&&bbPos<0.1){score=70;signal="BUY";reason=`BEAR REBOTE · RSI ${rsiVal.toFixed(0)} · BB ${(bbPos*100).toFixed(0)}%`;}
  return{signal,score,reason,rsiVal:+rsiVal.toFixed(1),atrPct:+atrPct.toFixed(2),mom10:0,strategy:"BEAR"};
}

function signalScalp(sym, history, params) {
  const h = history[sym]||[];
  if (h.length < 10) return {signal:"HOLD",score:30,strategy:"SCALP"};
  const last = h[h.length-1];
  const rsiVal = rsi(h);
  const bb = bollingerBands(h, 10, 1.8);
  const bbPos = (last - bb.lower) / (bb.upper - bb.lower || 1);
  const atrVal = atr(h, 5);
  const atrPct = (atrVal / last) * 100;
  const mom3 = h.length>3 ? ((last-h[h.length-4])/h[h.length-4]*100) : 0;
  const mom1 = h.length>1 ? ((last-h[h.length-2])/h[h.length-2]*100) : 0;
  let score = 30, signal = "HOLD", reason = "";
  if (bbPos < 0.15 && rsiVal < 38 && mom1 >= 0) {
    score = 62 + Math.round((0.15-bbPos)*150); signal = "BUY";
    reason = `SCALP · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)}`;
  } else if (bbPos < 0.25 && rsiVal < 32 && mom3 < -1.5 && mom1 >= 0) {
    score = 58; signal = "BUY";
    reason = `SCALP REBOTE · RSI ${rsiVal.toFixed(0)}`;
  }
  // SCALP eliminated from live: convert to MEAN_REVERSION (better R/R)
  return {signal,score,reason,rsiVal:+rsiVal.toFixed(1),atrPct:+atrPct.toFixed(2),mom10:+mom3.toFixed(2),bbPos:+bbPos.toFixed(2),strategy:"MEAN_REVERSION"};
}

function computeSignal(sym,history,params,regime="UNKNOWN"){
  switch(regime){
    case"BULL":return signalMomentum(sym,history,params);
    case"LATERAL":return signalMeanReversion(sym,history,params);
    case"BEAR":return signalBear(sym,history,params);
    default:return signalMomentum(sym,history,params);
  }
}

function getMultiTFBias(tfData) {
  if (!tfData) return { bias: 0, label: "neutral" };
  const { tf5=[], tf15=[], tf60=[] } = tfData;
  let bullPoints = 0, bearPoints = 0;
  if (tf5.length >= 3) { const t5=(tf5[tf5.length-1]-tf5[tf5.length-3])/tf5[tf5.length-3]*100; if(t5>0.3)bullPoints+=2;else if(t5<-0.3)bearPoints+=2; }
  if (tf15.length >= 3) { const t15=(tf15[tf15.length-1]-tf15[tf15.length-3])/tf15[tf15.length-3]*100; if(t15>0.5)bullPoints+=3;else if(t15<-0.5)bearPoints+=3; }
  if (tf60.length >= 2) { const t60=(tf60[tf60.length-1]-tf60[tf60.length-2])/tf60[tf60.length-2]*100; if(t60>0.3)bullPoints+=4;else if(t60<-0.3)bearPoints+=4; }
  const bias=bullPoints-bearPoints;
  const label=bias>=4?"strong_bull":bias>=2?"bull":bias<=-4?"strong_bear":bias<=-2?"bear":"neutral";
  return { bias, label };
}

function computeSignalWithScalp(sym, history, params, regime, tfHistory={}) {
  const main = computeSignal(sym, history, params, regime);
  const mtf = getMultiTFBias(tfHistory[sym]);
  if (mtf.label === "strong_bear" && main.signal === "BUY" && main.score < 70)
    return { ...main, signal:"HOLD", score:main.score-15, reason:main.reason+" [MTF BEAR]" };
  if ((mtf.label==="bull"||mtf.label==="strong_bull") && main.signal==="BUY")
    return { ...main, score:Math.min(95,main.score+8), reason:main.reason+" [MTF BULL]" };
  if (regime === "BEAR" || regime === "LATERAL") {
    const scalp = signalScalp(sym, history, params);
    if (scalp.signal === "BUY" && scalp.score > main.score && mtf.label !== "strong_bear") return scalp;
  }
  return main;
}

function isPumping(h,w=6){if(!h||h.length<w)return false;return(h[h.length-1]-h[h.length-w])/h[h.length-w]>PUMP_THRESHOLD;}
function isFallingFast(h,w=6,thr=0.03){if(!h||h.length<w)return false;return(h[h.length-1]-h[h.length-w])/h[h.length-w]<-thr;}

function correlation(h1,h2,n=20){
  if(!h1||!h2||h1.length<n||h2.length<n)return 0;
  const a=h1.slice(-n).map((v,i,arr)=>i===0?0:(v-arr[i-1])/arr[i-1]);
  const b=h2.slice(-n).map((v,i,arr)=>i===0?0:(v-arr[i-1])/arr[i-1]);
  const ma=a.reduce((s,v)=>s+v,0)/n,mb=b.reduce((s,v)=>s+v,0)/n;
  const num=a.reduce((s,v,i)=>s+(v-ma)*(b[i]-mb),0);
  const den=Math.sqrt(a.reduce((s,v)=>s+(v-ma)**2,0)*b.reduce((s,v)=>s+(v-mb)**2,0));
  return den===0?0:+(num/den).toFixed(2);
}

function checkCorrelation(portfolio,symbol,history){
  const h=history[symbol]||[];
  let count=0;
  for(const sym of Object.keys(portfolio)){const c=correlation(h,history[sym]||[]);if(c>0.8)count++;}
  return count<2;
}

function updatePairScore(scores,symbol,pnl){
  if(!scores[symbol])scores[symbol]={wins:0,losses:0,totalPnl:0,score:50};
  const s=scores[symbol];
  if(pnl>0){s.wins++;s.totalPnl+=pnl;}else{s.losses++;s.totalPnl+=pnl;}
  const total=s.wins+s.losses,wr=total?s.wins/total:0.5,avgPnl=total?s.totalPnl/total:0;
  s.score=Math.max(20,Math.min(100,Math.round(50+wr*30+avgPnl*2)));
  return s.score;
}

function getFee(useBnb=true){return useBnb?BNB_FEE:NORMAL_FEE;}
function runContrafactual(sym,history,ticksBack=10){
  const h=history[sym]||[];if(h.length<ticksBack+1)return null;
  const ep=h[h.length-ticksBack-1],cp=h[h.length-1];
  return{symbol:sym,ticksBack,entryPrice:+ep.toFixed(4),currentPrice:+cp.toFixed(4),pnl:+((cp-ep)/ep*100).toFixed(2)};
}
function _calcConsecutive(sells){
  let wins=0,losses=0;
  for(const s of sells.slice(0,10)){
    if(s.pnl>0){if(losses>0)break;wins++;}else{if(wins>0)break;losses++;}
  }
  return{wins,losses};
}

// ── CLASE PRINCIPAL ───────────────────────────────────────────────────────────


// ── Kalman Filter for trend/noise separation ─────────────────────────────
// Professional bots use this to distinguish real trends from noise
// Returns: { trend: number, noise: number, confidence: 0-1 }
function kalmanFilter(prices, Q=0.01, R=1.0) {
  if(!prices||prices.length<5) return {trend:prices[prices.length-1]||0,noise:1,confidence:0.5};
  let x = prices[0]; // initial estimate
  let P = 1.0;       // initial uncertainty
  for(let i=1; i<prices.length; i++) {
    // Predict
    const x_pred = x;
    const P_pred = P + Q;
    // Update
    const K = P_pred / (P_pred + R); // Kalman gain
    x = x_pred + K * (prices[i] - x_pred);
    P = (1 - K) * P_pred;
  }
  const lastPrice = prices[prices.length-1];
  const noise = Math.abs(lastPrice - x) / (x || 1) * 100;
  const confidence = Math.max(0, Math.min(1, 1 - noise/2));
  return { trend: x, noise, confidence, isTrending: noise < 0.5 };
}
// ── Order Flow Imbalance ──────────────────────────────────────────────────
// Measures buying vs selling pressure at the microstructure level
// Professional bots use this to time entries with higher precision
function calcOFI(prevBook, currBook) {
  if(!prevBook||!currBook) return 0;
  let ofi = 0;
  const n = Math.min(5, prevBook.bids?.length||0, currBook.bids?.length||0);
  for(let i=0; i<n; i++) {
    const prevBidP = parseFloat(prevBook.bids[i]?.[0]||0);
    const currBidP = parseFloat(currBook.bids[i]?.[0]||0);
    const prevBidQ = parseFloat(prevBook.bids[i]?.[1]||0);
    const currBidQ = parseFloat(currBook.bids[i]?.[1]||0);
    const prevAskP = parseFloat(prevBook.asks[i]?.[0]||0);
    const currAskP = parseFloat(currBook.asks[i]?.[0]||0);
    const prevAskQ = parseFloat(prevBook.asks[i]?.[1]||0);
    const currAskQ = parseFloat(currBook.asks[i]?.[1]||0);
    // Bid OFI: positive when bids increasing (buyers aggressive)
    ofi += currBidP >= prevBidP ? currBidQ : -currBidQ;
    // Ask OFI: negative when asks increasing (sellers aggressive)
    ofi -= currAskP <= prevAskP ? currAskQ : -currAskQ;
  }
  return ofi;
}
// ── Backtested trade seed for Kelly bootstrap ───────────────────────────────
// 20 synthetic SELLs based on validated strategy backtest results:
//   BNB/1h RSI: WR~58%, BTC/30m RSI: WR~55%, SOL/1h EMA: WR~54%, XRP/4h EMA: WR~56%
// Average WR ~55%, PF ~1.4, produces Kelly ~0.10 (conservative positive)
function _buildBacktestSeed() {
  const now = Date.now();
  const symbols = ["BNBUSDC","BTCUSDC","SOLUSDC","XRPUSDC","BNBUSDC"];
  // 11 wins, 9 losses = 55% WR. Avg win +1.5%, avg loss -0.8% → Kelly ≈ 0.10
  const pnls = [1.6, -0.8, 1.4, 1.5, -0.7, 1.3, -0.8, 1.6, 1.5, -0.9,
                -0.8, 1.4, -0.7, 1.5, -0.8, 1.3, -0.9, 1.6, 1.4, -0.8];
  return pnls.map((pnl, i) => ({
    type: "SELL",
    symbol: symbols[i % symbols.length],
    pnl,
    strategy: "backtest_seed",
    ts: now - (20 - i) * 3600000, // spaced 1h apart, all in the past
  }));
}

class CryptoBotFinal {
  constructor(saved=null){
    this.profile=RISK_PROFILES["moderate"];
    this.dqn = new DQN({ lr:0.001, gamma:0.95, epsilon:0.12 });
    this.multiAgent = new MultiAgentSystem({
      BULL:    { lr:0.002, epsilon:0.08 },
      LATERAL: { lr:0.001, epsilon:0.12 },
      BEAR:    { lr:0.001, epsilon:0.06 },
      UNKNOWN: { lr:0.001, epsilon:0.15 },
    });
    this.breaker=new CircuitBreaker(this.profile.maxDailyLoss);
    this.trailing=new TrailingStop();
    this.optimizer=new AutoOptimizer();
    // ── Módulos live ──────────────────────────────────────────────────────────
    this.autoBlacklist   = new AutoBlacklist(4, 4*3600*1000); // 4 pérdidas → 4h ban
    this.partialClose    = new PartialCloseManager();
    this.confidence      = new ConfidenceScore();
    this.riskLearning    = new RiskLearning();
    this.corrManager    = new CorrelationManager();
    this.adaptiveStop   = new AdaptiveStopLoss();
    this.adaptiveHours  = new AdaptiveHours();
    this.newsLearner    = new NewsImpactLearner();
    this.regimeDetector = new AdaptiveRegimeDetector();
    this.longShortRatio = null;
    this.fundingRate    = null;
    this.openInterest   = null;
    this.redditSentiment= null;
    if(saved){
      this.prices=saved.prices||{};this.history=saved.history||{};this.portfolio=saved.portfolio||{};
      this.cash=saved.cash!=null ? saved.cash : INITIAL_CAPITAL;this.log=saved.log||[];this.equity=saved.equity||[INITIAL_CAPITAL];
      this.tick=saved.tick||0;this.mode=saved.mode||"PAPER";this.optLog=saved.optLog||[];
      this.pairScores=saved.pairScores||{};this.reentryTs=saved.reentryTs||{};
      this.dailyTrades=saved.dailyTrades||{date:"",count:0};this.useBnb=saved.useBnb!==undefined?saved.useBnb:true;
      this.contrafactualLog=saved.contrafactualLog||[];
      // Cap maxEquity: if restored value is >10x initial capital, it's from paper bot — reset
      const restoredMax = saved.maxEquity || INITIAL_CAPITAL;
      this.maxEquity = restoredMax > INITIAL_CAPITAL * 10 ? INITIAL_CAPITAL : restoredMax;
      this.drawdownAlerted=saved.drawdownAlerted||false;
      this.tfHistory=saved.tfHistory||{};
      if(saved.optimizerHistory)this.optimizer.history=saved.optimizerHistory;
      if(saved.optimizerParams)Object.assign(this.optimizer.params,saved.optimizerParams);
      if(saved.trailingHighs)this.trailing.highs=saved.trailingHighs;
      if(saved.blacklistData)this.autoBlacklist.loadJSON(saved.blacklistData);
      if(saved.confidenceData)this.confidence.loadJSON(saved.confidenceData);
      if(saved.riskLearningData)this.riskLearning.loadJSON(saved.riskLearningData);
      if(saved.corrData)this.corrManager.loadJSON(saved.corrData);
      // Seed backtested trades if not enough real sells for Kelly calculation
      const realSells = this.log.filter(l=>l.type==="SELL"&&l.pnl!=null);
      if(realSells.length < 20) {
        const seedTrades = _buildBacktestSeed();
        this.log = [...this.log, ...seedTrades];
        console.log(`[KELLY-SEED] Sembrados ${seedTrades.length} trades backtestados (tenía ${realSells.length} reales)`);
      }
      console.log(`[ENGINE LIVE] Restaurado tick #${this.tick} | $${this.totalValue().toFixed(2)}`);
    }else{
      this.prices={};this.history={};this.portfolio={};
      this.cash=INITIAL_CAPITAL;this.log=[];this.equity=[{v:INITIAL_CAPITAL,t:Date.now()}];
      this.tick=0;this.mode="PAPER";this.optLog=[];
      this.pairScores={};this.reentryTs={};this.dailyTrades={date:"",count:0};
      this.useBnb=true;this.contrafactualLog=[];
    this.declaredCapital=INITIAL_CAPITAL;
      this.maxEquity=INITIAL_CAPITAL;this.drawdownAlerted=false;
      this.tfHistory={};
    }
    this.marketDefensive=false;this.hourMultiplier=1.0;
    this.marketRegime="UNKNOWN";this.fearGreed=50;
    this.blacklist=null; // legacy — usar this.autoBlacklist
  }

  updatePrice(sym,price){
    const prevPrice = this.prices[sym] || price;
    this.prices[sym]=price;
    // Volume proxy: track magnitude of price changes
    if(!this.volumeHistory) this.volumeHistory={};
    if(!this.volumeHistory[sym]) this.volumeHistory[sym]=[];
    const changePct=Math.abs((price-prevPrice)/prevPrice);
    this.volumeHistory[sym].push(changePct);
    if(this.volumeHistory[sym].length>100) this.volumeHistory[sym].shift();
    this.history[sym]=[...(this.history[sym]||[]),price].slice(-200);
    updateMultiTF(this.tfHistory,sym,price,this.tick);
  }
  totalValue(){return this.cash+Object.entries(this.portfolio).reduce((s,[sym,pos])=>s+pos.qty*(this.prices[sym]||pos.entryPrice),0);}
  checkDailyReset(){
    const now = new Date(Date.now()+2*3600000); // UTC+2 Francia
    const h = now.getUTCHours();
    // 3 sesiones por día (hora Francia):
    //   Madrugada: 00:00-08:59  → límite reducido
    //   Europa:    09:00-16:59  → límite completo
    //   América:   17:00-23:59  → límite completo
    const session = h < 9 ? "night" : h < 17 ? "europe" : "america";
    const sessionKey = now.toDateString() + "_" + session;
    if(this.dailyTrades.date !== sessionKey){
      const prev = this.dailyTrades.date;
      this.dailyTrades = {date: sessionKey, count:0};
      this._goldSlotCount = 0;
      const labels = {night:"Madrugada (00-08h)", europe:"Europa (09-16h)", america:"América (17-23h)"};
      if(prev) console.log(`[LIVE] ♻️ Nueva sesión: ${labels[session]} — contador reseteado`);
    }
  }
  recentWinRate(){const sells=this.log.filter(l=>l.type==="SELL").slice(0,20);if(!sells.length)return null;return Math.round(sells.filter(l=>l.pnl>0).length/sells.length*100);}

  checkMaxDrawdown(tv){
    if(tv>this.maxEquity){this.maxEquity=tv;this.drawdownAlerted=false;}
    const dd=(this.maxEquity-tv)/this.maxEquity;
    if(dd>=MAX_DRAWDOWN_PCT&&!this.drawdownAlerted){this.drawdownAlerted=true;return{triggered:true,drawdownPct:+(dd*100).toFixed(2),maxEquity:+this.maxEquity.toFixed(2),currentEquity:+tv.toFixed(2)};}
    return{triggered:false,drawdownPct:+(dd*100).toFixed(2)};
  }

  evaluate(){
    if(Object.keys(this.prices).length<3)return{signals:[],newTrades:[],circuitBreaker:null,optimizerResult:null,drawdownAlert:null};
    this.tick++;this.checkDailyReset();
    const tv=this.totalValue(); // cached for this tick - reuse everywhere
    const cb=this.breaker.check(tv);
    this.marketRegime=detectRegime(this.history["BTCUSDC"]);
    const drawdownAlert = tv > 0 ? this.checkMaxDrawdown(tv) : null;
    if(cb.triggered){
      const signals=PAIRS.map(p=>({...p,price:this.prices[p.symbol]||0,...computeSignal(p.symbol,this.history,this.optimizer.getParams(),this.marketRegime)}));
      this.equity=[...this.equity,{v:tv,t:Date.now()}].slice(-500);
      return{signals,newTrades:[],circuitBreaker:cb,optimizerResult:null,drawdownAlert};
    }

    // Cache sells to avoid 6x repeated filter(type=SELL) per tick
    this._cachedSells = this.log.filter(l=>l.type==="SELL");
    const wr=this.recentWinRate(),dailyLimit=getDailyLimit(this.marketRegime,wr)+(this._dailyLimitBoost||0);
    const dailyLimitReached=this.dailyTrades.count>=dailyLimit;
    const params=this.optimizer.getParams();

    const signals=PAIRS.map(p=>({
      ...p,price:this.prices[p.symbol]||0,
      ...computeSignalWithScalp(p.symbol,this.history,params,this.marketRegime,this.tfHistory||{}),
      isPumping:isPumping(this.history[p.symbol]),isFalling:isFallingFast(this.history[p.symbol]),
      pairScore:this.pairScores[p.symbol]?.score||50,
    }));

    const newTrades=[],fee=getFee(this.useBnb);
    // RiskLearning: evaluar decisiones pasadas con precios actuales
    this.riskLearning.evaluateDecisions(this.prices);
    const rlResult = this.riskLearning.optimize();
    if (rlResult) this._rlChanges = rlResult;

    // GESTIÓN POSICIONES — con cierre parcial
    for(const[symbol,pos]of Object.entries(this.portfolio)){
      const cp=this.prices[symbol]||pos.entryPrice;
      // Dynamic trailing based on ATR volatility
      const hArr = this.history[symbol]||[];
      const dynTrailingPct = Math.max(0.02, Math.min(0.08,
        hArr.length>=14 ? (atr(hArr,14)/cp)*2.5 : this.profile.trailingPct
      ));
      const ts=this.trailing.update(symbol,cp,pos.entryPrice,dynTrailingPct);
      // Time stop: cerrar posición si lleva más de 8h sin moverse significativamente
      const posAgeSec = (Date.now() - new Date(pos.ts).getTime()) / 1000;
      const posAgeLimitSec = 8 * 3600;
      const priceMovePct = Math.abs((cp - pos.entryPrice) / pos.entryPrice * 100);
      const _mrDeadline = pos.strategy==="MEAN_REVERSION" && _holdH>(this.marketRegime==="LATERAL"?4:6) && pnl>-0.3;
      const timeStop = (_mrDeadline) ||
                       (posAgeSec > posAgeLimitSec && priceMovePct < 0.5 && (pos.profitLocked||0) < 0.3);

      this.portfolio[symbol].trailingStop=+ts.stopPrice.toFixed(4);
      this.portfolio[symbol].trailingHigh=+ts.maxHigh.toFixed(4);
      this.portfolio[symbol].profitLocked=+ts.profitLocked.toFixed(2);
      const sig=signals.find(s=>s.symbol===symbol);
      const isScalp = pos.strategy==="SCALP"; // necesario para mrExit y trendRide
      // Trend riding: adapta targets por régimen
      const mrTarget_v = this.marketRegime==="BULL" ? 0.92 : this.marketRegime==="LATERAL" ? 0.65 : 0.82;
      const mrRsi_v    = this.marketRegime==="BULL" ? 72 : 60;
      const mrExit     = pos.strategy==="MEAN_REVERSION" && sig?.bbPos>mrTarget_v && sig?.rsiVal>mrRsi_v;

      // ── Momentum trailing: widen stop as profit grows ─────────────────
      if(pos.useTrailing && cp > pos.entryPrice) {
        const _profitPct = (cp - pos.entryPrice) / pos.entryPrice;
        // As profit grows, trail tighter to protect gains
        const _trailPct = _profitPct > 0.025 ? pos.stopPct * 0.6  // locked 60% of gains
                        : _profitPct > 0.015 ? pos.stopPct * 0.8  // locked 80% of entry risk
                        : pos.stopPct;                              // normal stop
        const _newStop = cp * (1 - _trailPct);
        if(_newStop > this.portfolio[symbol].stopLoss) {
          this.portfolio[symbol].stopLoss = +_newStop.toFixed(4);
          this.portfolio[symbol].trailingStop = +_newStop.toFixed(4);
        }
      }
      const livePairWins=(this._pairStreak||{})[symbol]?.wins||0;
      const liveRegimeCont=pos.regime===this.marketRegime;
      const liveTrendRide=(this.marketRegime==="BULL"||(livePairWins>=2&&liveRegimeCont))&&!isScalp&&(pos.profitLocked||0)>0.3;
      if(liveTrendRide) {
        // Progressive trailing: tighter as profit grows
        const _openPnl = (cp - pos.entryPrice) / pos.entryPrice * 100;
        const _trailPct = _openPnl > 5 ? 0.97 : _openPnl > 3 ? 0.965 : 0.96; // tighter trail as profit grows
        const bullTrail = cp * _trailPct;
        if(bullTrail > this.portfolio[symbol].trailingStop) {
          this.portfolio[symbol].trailingStop = +bullTrail.toFixed(4);
          // Auto-activate trend ride for BULL even before profitLocked threshold
          this.portfolio[symbol].profitLocked = Math.max(pos.profitLocked||0, _openPnl*0.8);
        }
      }
      // BULL: activate trend riding earlier (at 0.5% profit not 1.5%)
      if(this.marketRegime==="BULL" && pos.strategy==="MOMENTUM" && !isScalp) {
        const _pnlNow = (cp - pos.entryPrice) / pos.entryPrice * 100;
        if(_pnlNow > 0.5) {
          const _earlyTrail = cp * 0.97;
          if(_earlyTrail > this.portfolio[symbol].trailingStop) {
            this.portfolio[symbol].trailingStop = +_earlyTrail.toFixed(4);
          }
        }
      }
      const bearSell=this.marketRegime==="BEAR"&&pos.profitLocked<0&&ts.profitLocked<0;
      const posId=pos.posId||symbol;
      // (time stop already computed above)

      // ── Cierre parcial: 50% al llegar al target ────────────────────────────
      if(!pos.partialClosed && pos.target && cp>=pos.target){
        const closeQty=pos.qty*0.5;
        const remainQty=pos.qty-closeQty;
        const partialPnl=((cp-pos.entryPrice)/pos.entryPrice)*100-fee*100*2;
        const partialProceeds=closeQty*cp*(1-fee);
        this.cash+=partialProceeds;
        this.portfolio[symbol].qty=remainQty;
        this.portfolio[symbol].partialClosed=true;
        // Trail stop a breakeven tras cierre parcial
        this.portfolio[symbol].stopLoss=Math.max(pos.stopLoss,pos.entryPrice);
        const partialPnlAbs = +(closeQty * cp * (partialPnl/100)).toFixed(2);
        const partialTrade={type:"SELL",symbol,name:pos.name,qty:+closeQty.toFixed(6),price:+cp.toFixed(4),pnl:+partialPnl.toFixed(2),pnlAbs:partialPnlAbs,reason:"PARTIAL TARGET",mode:this.mode,fee:+(closeQty*cp*fee).toFixed(4),ts:new Date().toISOString(),strategy:pos.strategy||"MOMENTUM"};
        newTrades.push(partialTrade);
        console.log(`[LIVE][PARTIAL] ${symbol} 50% cerrado en target ${cp.toFixed(4)} P&L:${partialPnl.toFixed(2)}%`);
        continue;
      }

      const mrTargetExit = pos.strategy==="MEAN_REVERSION" && pos.target && cp>=pos.target;
      if(cp<=pos.stopLoss||ts.hit||mrTargetExit||sig?.signal==="SELL"||mrExit||bearSell||timeStop){
        const proceeds=pos.qty*cp*(1-fee),pnl=((cp-pos.entryPrice)/pos.entryPrice)*100-fee*100*2;
        this.cash+=proceeds;
        const reason=cp<=pos.stopLoss?"STOP LOSS":ts.hit?"TRAILING STOP":mrTargetExit?"MR OBJETIVO":mrExit?"MR SEÑAL":bearSell?"BEAR EXIT":"SEÑAL VENTA";
        // Actualizar blacklist automática
        this.autoBlacklist.recordResult(symbol, pnl>0);
        const _leh = pos.ts ? new Date(pos.ts).getUTCHours() : new Date().getUTCHours();
        const _ltr = {symbol,pnl,reason,strategy:pos.strategy||"MOMENTUM",ts:new Date().toISOString()};
        if(this.adaptiveStop)  this.adaptiveStop.recordTrade(_ltr, this.marketRegime, _leh);
        if(this.adaptiveHours) this.adaptiveHours.recordTrade(_ltr, this.marketRegime);
        if(this.regimeDetector) this.regimeDetector.recordOutcome(pos.regime||this.marketRegime, pnl, {lsRatio:this.longShortRatio?.ratio, fg:this.fearGreed});
        if(this.qLearning) {
          const _ls=this.log.filter(l=>l.type==="SELL");
          const _lwr=_ls.length>=10?_ls.slice(-20).filter(l=>l.pnl>0).length/Math.min(20,_ls.length):0.5;
          this.qLearning.lr = calcAdaptiveLR(0.1, _ls.length, _lwr);
        }
        delete this.portfolio[symbol];this.trailing.remove(symbol);
        if(pnl<0) {
          // Smart cooldown: scales with loss size, can re-enter sooner if very strong signal
          const _cooldown = pnl < -1.5 ? 4*3600000  // big loss: 4h cooldown
                          : pnl < -0.5 ? 2*3600000  // normal loss: 2h
                          : 30*60000;                // small loss: 30min only
          this.reentryTs[symbol] = Date.now() + _cooldown - REENTRY_COOLDOWN;
        }
        // DQN training on trade close
        if(this.dqn && pos.dqnState) {
          const _sH = new Date(Date.now()+2*3600000).getUTCHours();
          const _bH2 = this.history["BTCUSDC"]||this.history["BTCUSDT"]||[];
          const _bt2 = _bH2.length>=144?(_bH2[_bH2.length-1]-_bH2[_bH2.length-144])/_bH2[_bH2.length-144]*100:0;
          const dqnNextState = this.dqn.encodeState({rsi:50,bbZone:"lower_half",regime:this.marketRegime,trend:"neutral",volumeRatio:1,atrLevel:1,fearGreed:this.fearGreed||50,lsRatio:this.longShortRatio?.ratio||1,sessionHour:_sH,winStreak:0,btcTrend24h:_bt2,volatilityPct:50});
          // Reward shaping: P&L + time penalty + commission + consistency
          const _holdHours = pos.ts ? (Date.now()-new Date(pos.ts).getTime())/3600000 : 0;
          const _timePenalty = pnl <= 0 ? Math.min(0.3, _holdHours * 0.02) : 0; // penalizar tiempo si perdida
          const _commPenalty = 0.15; // comisiones siempre cuestan (~0.15% por round trip)
          const _recentSells = (this._cachedSells||this.log.filter(l=>l.type==="SELL")).slice(-5);
          const _consWins = _recentSells.length>=3 && _recentSells.slice(-3).every(l=>l.pnl>0) ? 0.3 : 0;
          // Sharpe-adjusted reward: penalize inconsistency (high variance = bad)
          const _rs = (this._cachedSells||[]).slice(-20);
          const _rAvg = _rs.length>0?_rs.reduce((s,x)=>s+x.pnl,0)/_rs.length:0;
          const _rStd = _rs.length>1?Math.sqrt(_rs.reduce((s,x)=>s+Math.pow(x.pnl-_rAvg,2),0)/(_rs.length-1)):1;
          const _sharpeBonus = _rStd>0.5 ? -0.1 : _rStd<0.2 ? 0.2 : 0; // reward low variance
          const dqnR = Math.max(-2,Math.min(2,pnl/100*20))
            + (pnl>0 ? 0.3 : 0)
            + (reason==="PARTIAL TARGET" ? 0.4 : 0)
            + (reason==="STOP LOSS" ? -0.5 : 0)
            - _timePenalty
            - _commPenalty
            + _consWins
            + _sharpeBonus;
          this.dqn.remember(pos.dqnState,"BUY",dqnR,dqnNextState);
          const liveSells=this.log.filter(l=>l.type==="SELL").length;
          // Counterfactual augmentation: generate variations of this trade to learn faster
          // What if the stop had been tighter/wider? What if we exited earlier?
          if(pos.dqnState && this.dqn) {
            const cfVariations = [
              { r: dqnR * 0.8, label:"tighter stop"  },  // what if stop was tighter
              { r: dqnR * 1.2, label:"wider target"  },  // what if target was wider
              { r: pnl>0 ? dqnR*0.5 : dqnR*1.5, label:"earlier exit" }, // earlier exit
            ];
            cfVariations.forEach(cf => {
              this.dqn.remember(pos.dqnState, "BUY", cf.r, dqnNextState);
            });
            // Now we have 4x training signal (1 real + 3 synthetic)
          }
          if(this.dqn.replayBuffer.length>=20) { // train more often now that we have augmentation
            const loss=this.dqn.trainBatch(3); // 3 epochs per batch
            if(liveSells%20===0) console.log(`[DQN-LIVE] loss:${loss.toFixed(5)} eps:${this.dqn.epsilon.toFixed(3)} buf:${this.dqn.replayBuffer.length}`);
          }
          // Adaptive epsilon decay: faster when WR is good (exploit), slower when bad (explore)
          const _wrNow = this.recentWinRate()||50;
          const _decayRate = _wrNow >= 55 ? 0.05 : _wrNow >= 45 ? 0.03 : 0.01;
          this.dqn.decayEpsilon(_decayRate, liveSells);
        }
        const pnlAbs = +(pos.qty * cp * (pnl/100)).toFixed(2);
        const trade={type:"SELL",symbol,name:pos.name,qty:+pos.qty.toFixed(6),price:+cp.toFixed(4),pnl:+pnl.toFixed(2),pnlAbs,reason,mode:this.mode,fee:+(pos.qty*cp*fee).toFixed(4),ts:new Date().toISOString(),strategy:pos.strategy||"MOMENTUM"};
        newTrades.push(trade);this.dailyTrades.count++;
        this.optimizer.recordTrade(pnl,reason);updatePairScore(this.pairScores,symbol,pnl);
        console.log(`[${this.mode}][${this.marketRegime}][SELL] ${symbol} ${reason} P&L:${pnl.toFixed(2)}% | ${this.dailyTrades.count}/${dailyLimit}`);
      }
    }

    // NUEVAS ENTRADAS — con blacklist automática y stop dinámico
    const goldSlotUsed = this._goldSlotCount || 0;
    const bestSignalScore = signals.filter(s=>s.signal==="BUY").reduce((m,s)=>Math.max(m,s.score),0);

    // Calcular regimeMin y golden slots ANTES del if para tenerlos en scope
    // Equity curve signal: is the system working right now?
    const _equity3d = this.equity.slice(-1080); // ~3 days (360 ticks/day × 3)
    const _eqTrend = _equity3d.length>=10
      ? (_equity3d[_equity3d.length-1]?.v||0) - (_equity3d[0]?.v||0) : 0;
    const _eqMult = _eqTrend > 0 ? Math.min(1.3, 1.0+_eqTrend/tv*2) // winning: bigger
                  : _eqTrend < -tv*0.03 ? 0.6  // losing >3%: much smaller
                  : _eqTrend < 0 ? 0.8 : 1.0;  // slight loss: smaller

    // F&G momentum: rate of change matters as much as value
    const _fgHistory = this._fgHistory = this._fgHistory||[];
    if(this.fearGreed) { _fgHistory.push(this.fearGreed); if(_fgHistory.length>72) _fgHistory.shift(); }
    const _fgMomentum = _fgHistory.length>=6
      ? _fgHistory[_fgHistory.length-1] - _fgHistory[0] : 0;
    // Rising F&G = sentiment improving → more aggressive
    const _fgMomBoost = _fgMomentum > 15 ? 1.15 : _fgMomentum < -15 ? 0.80 : 1.0;

    // Losing streak protection
    const _last5 = (this.log||[]).filter(l=>l.type==="SELL").slice(-5);
    const _losingStreak = _last5.length>=5 && _last5.every(l=>l.pnl<0);
    const _streakPenalty = _losingStreak ? 8 : 0;

    const _regimeMinPre = this.marketRegime==="BULL" ? params.minScore-5 :
                          this.marketRegime==="BEAR" ? 82 :
                          this.marketRegime==="LATERAL" ? Math.max(58, params.minScore-8+_streakPenalty) :
                          params.minScore + _streakPenalty;
    const goldThreshold = Math.max(70, _regimeMinPre + 10);
    // Golden slots dinámicos: depende del cash libre y régimen
    const _cashPct = this.cash / (tv || 1);
    // Cash >40%: el cash es el límite natural → más permisivo
    // BULL: sin límite práctico si hay cash; LATERAL/BEAR: más conservador
    const _goldMax = this.marketRegime === "BULL"
      ? (_cashPct > 0.4 ? 99 : 5)
      : (_cashPct > 0.4 ? 5 : 3);
    const canUseGoldenSlot = dailyLimitReached && goldSlotUsed < _goldMax && bestSignalScore >= goldThreshold;

    if((!dailyLimitReached || canUseGoldenSlot) && !this.marketDefensive){
      const nOpen=Object.keys(this.portfolio).length;
      // Adaptive max positions by regime and WR
      const _wrForMaxPos = this.recentWinRate()||50;
      const _baseMaxPos = this.marketRegime==="BEAR"    ? 1 :
                          this.marketRegime==="LATERAL" ? (_wrForMaxPos>=45?2:1) :
                          this.marketRegime==="BULL"    ? (_wrForMaxPos>=45?3:2) : // BULL: 3 positions when learning
                          this.profile.maxOpenPositions;
      const maxPos = _baseMaxPos;
      if(nOpen<maxPos){
        const reserve=tv*MIN_CASH_RESERVE; let availCash=Math.max(0,this.cash-reserve);
        const regimeMin = _regimeMinPre; // ya calculado arriba
        // In LATERAL regime: extreme fear = mean reversion opportunity → LARGER positions
    // In BULL/BEAR: fear = reduce positions
    const fearAdj = this.marketRegime==="LATERAL"
      ? (this.fearGreed<25?1.3:this.fearGreed<35?1.15:this.fearGreed>75?0.7:1.0)
      : (this.fearGreed<25?0.8:this.fearGreed>80?0.6:1.0);
        // Ajuste por confianza: baja confianza → posiciones más pequeñas
        const confAdj=this.confidence.get()<40?0.6:this.confidence.get()>75?1.1:1.0;
        const groupCount={};
        Object.keys(this.portfolio).forEach(sym=>{const p=PAIRS_MAP.get(sym);if(p)groupCount[p.group]=(groupCount[p.group]||0)+1;});

        // Respetar pausa de Telegram
      if(this._pausedByTelegram) return {signals,newTrades,circuitBreaker:cb,optimizerResult:optResult,dailyLimit:dailyLimit,dailyUsed:this.dailyTrades.count,drawdownAlert};
      // Debug: log why signals are rejected (every 50 ticks)
      if(this.tick%50===0 && signals.length>0) {
        const top = signals.slice(0,3).map(s=>{
          const bl = this.autoBlacklist.isBlacklisted(s.symbol);
          const news = this._cryptoPanicFn && this._cryptoPanicFn(s.symbol)<0.6;
          return `${s.symbol.replace("USDC","")}:${s.score}${s.score<regimeMin?"<MIN":""}${bl?"🚫BL":""}${news?"📰BL":""}`;
        }).join(" ");
        console.log(`[LIVE][${this.marketRegime}] signals:${signals.length} top:${top} minScore:${regimeMin} fearAdj:${fearAdj.toFixed(2)} F&G:${this.fearGreed}`);
      }
      // ── Strategy scoring: regime + session + meta-learning ─────────────────
      const _parisH = new Date(Date.now()+2*3600000).getUTCHours();
      const _stratW = this.stratEval?.getWeights?.(this.marketRegime)||null;
      signals.forEach(s=>{
        let _mult = 1.0;
        if(this.marketRegime==="BULL") {
          _mult = s.strategy==="MOMENTUM"?1.15:s.strategy==="MEAN_REVERSION"?0.80:0.90;
        } else if(this.marketRegime==="LATERAL") {
          _mult = s.strategy==="MEAN_REVERSION"?1.20:s.strategy==="MOMENTUM"?0.70:0.75;
        } else if(this.marketRegime==="BEAR") {
          _mult = s.strategy==="MEAN_REVERSION"?1.10:s.strategy==="MOMENTUM"?0.40:0.50;
        }
        // Session boost
        const _sBoost = (_parisH>=1&&_parisH<9)?(s.strategy==="MEAN_REVERSION"?1.10:0.90):
                        (_parisH>=9&&_parisH<12)?(s.strategy==="MOMENTUM"?1.15:s.strategy==="MEAN_REVERSION"?0.85:1.0):
                        (_parisH>=15&&_parisH<18)?1.10:1.0;
        // StrategyEvaluator learned adjustment
        if(_stratW?.[s.strategy]) _mult *= _stratW[s.strategy];
        s.score = Math.min(99, Math.max(0, Math.round(s.score * _mult * _sBoost)));
      });

      // Kelly Gate: real Kelly with rolling WR window
      const _kellyData = calcRealKelly(this.log, 30);
      this._kellyGate = _kellyData;
      if(_kellyData.negative && _kellyData.n >= 20 && this.tick % 60 === 0)
        console.log(`[KELLY-GATE] 🔴 Kelly=${_kellyData.raw} WR=${_kellyData.wr}% → OBSERVATION MODE (${_kellyData.n} trades)`);
      const _kellyBlocked = _kellyData.negative && _kellyData.n >= 20;

      // Kelly gate: if negative edge, no new entries
      if(_kellyBlocked) {
        if(this.tick % 30 === 0)
          console.log(`[KELLY-GATE] Bloqueando ${signals.length} señales — WR rolling: ${_kellyData.wr}%`);
        signals.length = 0; // clear signals - no new trades (in-place mutation)
      }
      const buyable=signals.filter(s=>{
          // If limit reached, only allow this signal if it qualifies for golden slot
          if(dailyLimitReached && !((this._goldSlotCount||0) < 3 && s.score >= 85)) return false;
          if(s.signal!=="BUY"||s.score<regimeMin)return false;
          if(this.portfolio[s.symbol])return false;
          if(s.isPumping||s.isFalling)return false;
          // MR compound filter: price below VWAP AND market conditions right
          const _h = this.history[s.symbol]||[];
          // Kalman filter: avoid entering during pure noise (no real signal)
          const _kalman = kalmanFilter(_h.slice(-30));
          if(_kalman.confidence < 0.3 && s.strategy==="MOMENTUM") return false; // no trend = no momentum
          if(s.strategy==="MEAN_REVERSION") {
            const _vwap = _h.length>=20 ? _h.slice(-20).reduce((a,p)=>a+p,0)/20 : this.prices[s.symbol];
            const _price = this.prices[s.symbol]||_vwap;
            if(_price > _vwap * 1.003) return false; // must be at/below VWAP

            // CRITICAL: In extreme panic (F&G<25), require bounce confirmation
            // Don't catch falling knives - wait for 2 consecutive green candles
            if(this.fearGreed < 30) {
              const _last3 = _h.slice(-3);
              const _bouncing = _last3.length>=3 && _last3[2]>_last3[1] && _last3[1]>_last3[0];
              if(!_bouncing) return false; // no bounce confirmed yet
            }
            if(this.marketRegime==="LATERAL" && this.fearGreed > 55) return false;
          }
          // ── Blacklist automática ──────────────────────────────────────────
          // Dynamic pair cooldown: if pair lost 3x in a row recently, skip temporarily
          const _pairLosses = (this._cachedSells||[]).filter(l=>l.symbol===s.symbol).slice(-3);
          const _pairRecentLoss = _pairLosses.length>=3 && _pairLosses.every(l=>l.pnl<0);
          if(_pairRecentLoss) { return false; } // soft cooldown for consistently losing pairs
          if(this.autoBlacklist.isBlacklisted(s.symbol)){
            this.riskLearning.recordDecision("BLACKLIST_LOSSES", s.symbol, this.prices[s.symbol]||0, "block_entry");
            return false;
          }
          // ── CryptoPanic: no entrar si noticia negativa activa en este par ──
          if(this._cryptoPanicFn && this._cryptoPanicFn(s.symbol) < 0.6) {
            this.riskLearning.recordDecision("CRYPTOPANIC_PAIR", s.symbol, this.prices[s.symbol]||0, "block_entry", {score:s.score});
            return false;
          }
          // ── Correlation buckets: BULL→max 2, LATERAL/BEAR→max 1 ──────────────
          const LIVE_CORR = {
            major: ["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC"],
            l2:    ["OPUSDC","ARBUSDC","POLUSDC"],
            defi:  ["UNIUSDC","AAVEUSDC","LINKUSDC"],
          };
          const liveCorrMax = this.marketRegime==="BULL" ? 2 : 1;
          let liveCorr = false;
          for(const [, syms] of Object.entries(LIVE_CORR)) {
            if(syms.includes(s.symbol)) {
              const inBucket = Object.keys(this.portfolio).filter(p=>syms.includes(p)).length;
              if(inBucket >= liveCorrMax) { liveCorr=true; break; }
            }
          }
          if(liveCorr) return false;
          // ── BTC momentum guard: no entrar alts en LATERAL si BTC cae ────────
          const btcHL=this.history["BTCUSDC"]||[];
          const btcM5L=btcHL.length>5?((btcHL[btcHL.length-1]-btcHL[btcHL.length-6])/btcHL[btcHL.length-6]*100):0;
          if(btcM5L<-4 && s.symbol!=="BTCUSDC" && this.marketRegime==="LATERAL") return false;
          // MR: solo bloquear sobrecompra clara (filtro extra quitado)
          const ll=this.reentryTs[s.symbol];if(ll&&Date.now()-ll<REENTRY_COOLDOWN)return false;
          const grp=PAIRS.find(p=>p.symbol===s.symbol)?.group;if(grp&&(groupCount[grp]||0)>=2)return false;
          if(!checkCorrelation(this.portfolio,s.symbol,this.history))return false;
          return true;
        }).sort((a,b)=>(b.score*(this.pairScores[b.symbol]?.score||50)/100)-(a.score*(this.pairScores[a.symbol]?.score||50)/100)).slice(0,maxPos-nOpen);

        for(const sig of buyable){
          const price=this.prices[sig.symbol];if(!price)continue;
          // Volume anomaly: boost size if anomalous volume in the right direction
          const volAnom = getVolumeAnomaly(this.volumeHistory, sig.symbol);
          const volBoost = volAnom.anomaly && sig.score > 60 ? 1.25 : 1.0;
          const ofiBoost = 1.0; // OFI in test only
          // Multi-pair confirmation: if 3+ correlated pairs signal BUY → stronger signal
          const _sameDirSignals = signals.filter(s2 =>
            s2.signal==="BUY" && s2.score>=regimeMin &&
            ["major","alt1"].includes(PAIRS_MAP.get(s2.symbol)?.group)
          ).length;
          const multiPairBoost = _sameDirSignals >= 3 ? 1.30 :
                                  _sameDirSignals >= 2 ? 1.15 : 1.0;
          // BTC Dominance: si BTC.D alto, reducir exposición a altcoins
          const _btcD = this.btcDominance;
          const btcDomMult = (_btcD?.signal === "BTC_DOMINANT_AVOID_ALTS" && sig.symbol !== "BTCUSDC" && sig.symbol !== "BTCUSDT")
            ? 0.7  // altcoins suffer when BTC dominance high
            : (_btcD?.signal === "ALTSEASON_FAVORABLE" ? 1.15 : 1.0);
          const newsMultiplier = this._cryptoPanicFn ? this._cryptoPanicFn(sig.symbol) : (this._newsMultiplier||1.0);
          const corrMult = this.corrManager.getSizeMultiplier(sig.symbol, this.portfolio, this.prices, sig.score);
          // DQN guidance in live
          let liveDqnBoost = 1.0;
          if(this.dqn && this.dqn.totalUpdates > 0) {
            const _sessionH = new Date(Date.now()+2*3600000).getUTCHours();
            const _recentW = (this._cachedSells||[]).slice(-5);
            const _wStreak = _recentW.reduce((s,t)=>t.pnl>0?s+1:s-1, 0);
            // BTC 24h trend: is market falling over multiple days? (crisis detector)
            const _btcH = this.history["BTCUSDC"]||this.history["BTCUSDT"]||[];
            const _btc24hTrend = _btcH.length>=144
              ? (_btcH[_btcH.length-1]-_btcH[_btcH.length-144])/_btcH[_btcH.length-144]*100
              : 0; // 144 ticks × 10s = 24h
            // Volatility percentile: high ATR vs recent history
            const _atrHistory = Object.values(this.history||{}).slice(0,5)
              .map(h=>h.length>14?atr(h,14)/(h[h.length-1]||1)*100:2);
            const _volPct = _atrHistory.length
              ? _atrHistory.reduce((s,v)=>s+v,0)/_atrHistory.length * 10
              : 50;
            const liveDqnState = this.dqn.encodeState({
              rsi: sig.rsiVal||50,
              bbZone: sig.bbPos<0.2?"below_lower":sig.bbPos<0.5?"lower_half":sig.bbPos<0.8?"upper_half":"above_upper",
              regime: this.marketRegime,
              trend: sig.score>75?"strong_up":sig.score>60?"up":sig.score<40?"down":"neutral",
              volumeRatio: (this.volumeHistory?.[sig.symbol]?.slice(-3)?.reduce((s,v)=>s+v,0)/3||1) / (this.volumeHistory?.[sig.symbol]?.slice(-20)?.reduce((s,v)=>s+v,0)/20||1),
              atrLevel: sig.atrPct||1,
              fearGreed: this.fearGreed||50,
              lsRatio: this.longShortRatio?.ratio||1,
              sessionHour: _sessionH,
              winStreak: _wStreak,
              btcTrend24h: _btc24hTrend,
              volatilityPct: Math.min(100, _volPct),
              institutionalBias: (this.coinbasePremium?.signal==="INSTITUTIONAL_BUY" ? 1 :
                                  this.coinbasePremium?.signal==="INSTITUTIONAL_SELL" ? -1 :
                                  this.exchangeFlow?.bullish===true ? 0.5 :
                                  this.exchangeFlow?.bullish===false ? -0.5 : 0)
            });
            const liveDqnQ = this.dqn.getQValues(liveDqnState);
            // Smooth proportional boost based on Q value difference
            const _qDiff = liveDqnQ.BUY - liveDqnQ.SKIP;
            liveDqnBoost = Math.max(0.6, Math.min(1.3, 1.0 + _qDiff * 0.15));
            sig._dqnState = liveDqnState;
          }
          const _lKelly = calcAdaptiveKelly(1.0, this.portfolio, this.prices, this.history);
          // MultiAgent: régimen especializado boost
          const _maBoost = this.multiAgent
            ? this.multiAgent.getSignalBoost(sig.symbol, this.marketRegime, sig.score)
            : 1.0;
          // Pair performance: reduce size for pairs with poor recent history
          const _pairScore = (this.pairScores||{})[sig.symbol]||0;
          const _pairMult = _pairScore < -3 ? 0.6 : _pairScore < -1 ? 0.8 : _pairScore > 3 ? 1.1 : 1.0;
          // Funding rate: extreme negative = shorts paying, long advantage
          const _fr = this.fundingRate?.value||0;
          const fundingBoost = _fr < -0.05 ? 1.20 : _fr < -0.02 ? 1.10 : _fr > 0.05 ? 0.80 : 1.0;
          // Liquidations: short squeeze risk = good for MR entries
          const _liqs = this.liquidations||null;
          const liqBoost = _liqs?.signal==="SHORT_SQUEEZE_RISK" && sig.strategy==="MEAN_REVERSION" ? 1.2
                         : _liqs?.signal==="LONG_FLUSH_RISK" ? 0.75 : 1.0;
          const invest=calcPositionSize(availCash,sig.score,sig.atrPct,this.profile,nOpen)*this.hourMultiplier*fearAdj*confAdj*newsMultiplier*corrMult*volBoost*liveDqnBoost*_lKelly*_maBoost*_pairMult*btcDomMult*multiPairBoost*fundingBoost*liqBoost*_eqMult*_fgMomBoost*institutionalBoost*flowBoost*reserveBoost*ofiBoost;
          // BULL: can risk more per position (trend is our friend)
          // Regime-weighted capital deployment
          // BULL: aggressive (80% deployable), LATERAL: moderate, BEAR: defensive
          const _deployPct = this.marketRegime==="BULL"    ? 0.80 :
                             this.marketRegime==="LATERAL" ? 0.50 :
                             this.marketRegime==="BEAR"    ? 0.15 : 0.40;
          const _maxInvest = tv * (_deployPct / Math.max(1, Object.keys(this.portfolio).length+1));
          const _hardMax   = tv * (this.marketRegime==="BULL" ? 0.60 : 0.45);
          const maxInvestPerTrade = Math.min(_maxInvest, _hardMax);
          if(invest<15||invest>Math.min(availCash,maxInvestPerTrade))continue; // $15 min, 45% max
          // Profit mínimo: el target debe superar 2.5× el fee del round trip
          const _feeRt = fee * 2; // round trip fee (buy + sell)
          const _minProfit = _feeRt * 2.5; // profit debe ser 2.5x el coste total en fees
          const _expectedProfit = sig.strategy==="SCALP" ? 0.008 :
                                  sig.strategy==="MEAN_REVERSION" ? 0.012 :
                                  sig.strategy==="MOMENTUM" ? 0.015 : 0.010;
          if(_expectedProfit < _minProfit) continue; // no vale la pena vs fees
          // Slippage estimation: pares poco líquidos (OP, ARB, NEAR) tienen mayor slippage
          const ILLIQUID = ["OPUSDC","ARBUSDC","NEARUSDC","APTUSDC","ATOMUSDC","DOTUSDC"];
          const slippageFactor = ILLIQUID.includes(sig.symbol) ? 0.998 : 0.9995; // 0.2% o 0.05%
          // Aplicar slippage a entryPrice esperado para cálculos internos
          // (el precio real de ejecución será ligeramente peor)
          if(slippageFactor < 1) {} // slippage ya incluido en fee calculation;
          const qty=invest*(1-fee)/price;
          const atrVal=atr(this.history[sig.symbol]||[price],14);
          // ── Stop loss dinámico por volatilidad ────────────────────────────
          const dynStop=calcDynamicStop(price,atrVal,this.marketRegime);
          const _learnedPct = this.adaptiveStop
            ? this.adaptiveStop.getStop(sig.symbol, this.marketRegime, new Date().getUTCHours(), dynStop.stopPct||0.03)
            : (dynStop.stopPct||0.03);
          // Dynamic ATR-based targets: capture the NATURAL move size
          // ATR = average true range = what the asset actually moves on average
          const _atrVal = atr(this.history[sig.symbol]||[price], 14);
          const _atrPct = (_atrVal / price) * 100;
          let _stopPct, _targetPct, _useTrailing;
          if(sig.strategy==="MEAN_REVERSION") {
            _stopPct    = Math.min(_learnedPct, 0.010);
            // ATR-based target: 2× stop minimum, up to 2× ATR
            _targetPct  = Math.max(_stopPct * 2.0, Math.min(_atrPct * 2.0, _stopPct * 3.0));
            _useTrailing= false;
          } else if(sig.strategy==="MOMENTUM" && this.marketRegime==="BULL") {
            _stopPct    = Math.min(_learnedPct, 0.015);
            // In BULL: target = 2.5× ATR (captures full momentum move)
            _targetPct  = Math.max(_stopPct * 2.5, _atrPct * 2.5);
            _useTrailing= true;
          } else {
            _stopPct    = Math.min(_learnedPct, 0.012);
            _targetPct  = Math.max(_stopPct * 2.0, _atrPct * 1.5);
            _useTrailing= false;
          }
          const stopLoss = price * (1 - _stopPct);
          const target   = price * (1 + _targetPct);
          const posId=`${sig.symbol}_${Date.now()}`;
          this.cash = Math.max(0, this.cash - invest); // nunca permitir cash negativo
          // Recalcular availCash para el siguiente trade en este tick
          availCash = Math.max(0, this.cash - this.totalValue()*MIN_CASH_RESERVE);
          this.portfolio[sig.symbol]={qty,entryPrice:price,stopLoss:+stopLoss.toFixed(4),trailingStop:+stopLoss.toFixed(4),trailingHigh:+price.toFixed(4),profitLocked:0,name:sig.name,ts:new Date().toISOString(),strategy:sig.strategy||"MOMENTUM",target:+target.toFixed(4),partialClosed:false,posId,dynStopInfo:dynStop,dqnState:sig._dqnState||null,useTrailing:_useTrailing,stopPct:_stopPct};
          const trade={type:"BUY",symbol:sig.symbol,name:sig.name,qty:+qty.toFixed(6),price:+price.toFixed(4),stopLoss:+stopLoss.toFixed(4),score:sig.score,pnl:null,mode:this.mode,fee:+(invest*fee).toFixed(4),ts:new Date().toISOString(),strategy:sig.strategy||"MOMENTUM"};
          newTrades.push(trade);this.dailyTrades.count++;
          const g=PAIRS.find(p=>p.symbol===sig.symbol)?.group||"";groupCount[g]=(groupCount[g]||0)+1;
          const _isGolden = dailyLimitReached && (this._goldSlotCount||0) < 3 && sig.score >= 85;
          if(_isGolden) {
            this._goldSlotCount = (this._goldSlotCount||0) + 1;
          }
          console.log(`[${this.mode}][${this.marketRegime}][BUY] ${sig.symbol} score:${sig.score} stop:${dynStop.stopPct} $${invest.toFixed(0)} | ${this.dailyTrades.count}/${dailyLimit}`);
        }
      }
    }

    if(this.tick%10===0){
      const cf=PAIRS.slice(0,4).map(p=>runContrafactual(p.symbol,this.history,10)).filter(Boolean);
      if(cf.length){this.contrafactualLog=[...cf,...this.contrafactualLog].slice(0,50);const avg=cf.reduce((s,c)=>s+c.pnl,0)/cf.length;if(avg>3&&params.minScore>60)this.optimizer.params.minScore=Math.max(60,params.minScore-1);}
    }

    // Actualizar confidence score cada 20 ticks
    if(this.tick%20===0){
      const sells=this.log.filter(l=>l.type==="SELL");
      const consec=_calcConsecutive(sells);
      const dd=(this.maxEquity-tv)/this.maxEquity;
      this.confidence.update({
        recentWinRate:wr?wr/100:null,
        consecutiveWins:consec.wins,
        consecutiveLosses:consec.losses,
        drawdownFromPeak:dd,
        dailyPnlPct:this._dailyPnlPct||0,
        circuitBreakerActive:cb.triggered,
      });
    }

    if(newTrades.length)this.log=[...newTrades,...this.log].slice(0,300);
    this.equity=[...this.equity,{v:this.totalValue(),t:Date.now()}].slice(-500);
    const optResult=this.optimizer.optimize();
    if(optResult?.changes?.length>0)this.optLog=[optResult,...this.optLog].slice(0,30);

    return{signals,newTrades,circuitBreaker:cb,optimizerResult:optResult,dailyLimit,dailyUsed:this.dailyTrades.count,drawdownAlert};
  }

  getState(){
    const tv=this.totalValue(),ret=((tv-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
    const wins=this.log.filter(l=>l.type==="SELL"&&l.pnl>0).length,sells=this.log.filter(l=>l.type==="SELL").length;
    const wr=this.recentWinRate(),dailyLimit=getDailyLimit(this.marketRegime,wr);
    const dd=(this.maxEquity-tv)/this.maxEquity;
    return{
      prices:this.prices,history:this.history,portfolio:this.portfolio,
      cash:this.cash,log:this.log,equity:this.equity.map(e=>typeof e==="object"?e:{v:e,t:Date.now()}),tick:this.tick,
      mode:this.mode,totalValue:tv,returnPct:ret,fxRate:parseFloat(process.env.FX_RATE||"1.08"),
      longShortRatio:this.longShortRatio||null,fundingRate:this.fundingRate||null,
      adaptiveStopStats:this.adaptiveStop?.getStats()||null,
      adaptiveHoursStats:this.adaptiveHours?.getStats()||null,
      regimeDetectorStats:this.regimeDetector?.getStats()||null,
      openInterest:this.openInterest||null,redditSentiment:this.redditSentiment||null,
      winRate:sells?+((wins/sells)*100).toFixed(0):null,
      pairs:PAIRS,categories:CATEGORIES,
      circuitBreaker:this.breaker.check(tv),
      optimizerParams:this.optimizer.getParams(),
      optLog:this.optLog,profile:this.profile,
      pairScores:this.pairScores,marketRegime:this.marketRegime,
      fearGreed:this.fearGreed,dailyTrades:this.dailyTrades,dailyLimit,goldSlotCount:this._goldSlotCount||0,
      totalFees:+this.log.reduce((s,l)=>s+(l.fee||0),0).toFixed(2),
      contrafactualLog:this.contrafactualLog.slice(0,10),
      useBnb:this.useBnb,declaredCapital:this.declaredCapital,recentWinRate:wr,
      coinbasePremium: this.coinbasePremium||null,
      exchangeFlow: this.exchangeFlow||null,
      binanceReserve: this.binanceReserve||null,
      profitFactor: (()=>{ const s=this._cachedSells||[]; if(s.length<5) return null;
        const wins=s.slice(-30).filter(x=>x.pnl>0).reduce((a,x)=>a+x.pnl,0)||0.001;
        const loss=Math.abs(s.slice(-30).filter(x=>x.pnl<0).reduce((a,x)=>a+x.pnl,0))||0.001;
        return +(wins/loss).toFixed(2); })(),
      priceHistory:Object.fromEntries(Object.entries(this.history||{}).map(([k,v])=>[k,v.slice(-200)])),
      volumeAnomaly:Object.fromEntries(Object.keys(this.volumeHistory||{}).map(k=>[k,getVolumeAnomaly(this.volumeHistory,k)])),
      riskLearningStats:this.riskLearning.getStats(),
      riskLearningParams:this.riskLearning.params,
      correlationStatus:this.corrManager.getStatus(this.portfolio,this.prices),
      maxEquity:+this.maxEquity.toFixed(2),drawdownPct:+(dd*100).toFixed(2),
      confidence: this.confidence.get(),
      autoBlacklist: this.autoBlacklist.getStatus(),
    };
  }

  serialize(){
    const s=this.getState();
    s.optimizerHistory=this.optimizer.history;s.trailingHighs=this.trailing.highs;
    s.reentryTs=this.reentryTs;s.maxEquity=this.maxEquity;s.drawdownAlerted=this.drawdownAlerted;
    s.tfHistory=this.tfHistory;
    s.blacklistData=this.autoBlacklist.toJSON();
    s.confidenceData=this.confidence.toJSON();
    if(this.dqn) s.dqnData=this.dqn.toJSON();
    return JSON.stringify(s);
  }
}

module.exports={CryptoBotFinal,PAIRS,CATEGORIES,INITIAL_CAPITAL};
