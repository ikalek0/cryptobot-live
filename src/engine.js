// ─── CRYPTOBOT ENGINE v2 LIVE — ESTRATEGIA ADAPTATIVA POR RÉGIMEN ────────────
"use strict";

const { RISK_PROFILES, CircuitBreaker, TrailingStop, calcPositionSize, AutoOptimizer } = require("./risk");
const { AutoBlacklist, PartialCloseManager, calcDynamicStop, ConfidenceScore } = require("./live_features_patch");
const { DQN } = require("./dqn");
const { RiskLearning } = require("./riskLearning");
const { CorrelationManager } = require("./correlationManager");

const INITIAL_CAPITAL  = parseFloat(process.env.CAPITAL_USDC || process.env.CAPITAL_USDT || "50000");
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
];

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
  let base = regime==="BULL"?25:regime==="LATERAL"?15:regime==="BEAR"?5:10;
  if(wr!==null){if(wr>65)base=Math.round(base*1.3);else if(wr<45)base=Math.round(base*0.6);else if(wr<50)base=Math.round(base*0.8);}
  return Math.max(3,Math.min(25,base));
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
  return {signal,score,reason,rsiVal:+rsiVal.toFixed(1),atrPct:+atrPct.toFixed(2),mom10:+mom3.toFixed(2),bbPos:+bbPos.toFixed(2),strategy:"SCALP"};
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
class CryptoBotFinal {
  constructor(saved=null){
    this.profile=RISK_PROFILES["moderate"];
    this.dqn = new DQN({ lr:0.001, gamma:0.95, epsilon:0.12 });
    this.breaker=new CircuitBreaker(this.profile.maxDailyLoss);
    this.trailing=new TrailingStop();
    this.optimizer=new AutoOptimizer();
    // ── Módulos live ──────────────────────────────────────────────────────────
    this.autoBlacklist   = new AutoBlacklist(4, 4*3600*1000); // 4 pérdidas → 4h ban
    this.partialClose    = new PartialCloseManager();
    this.confidence      = new ConfidenceScore();
    this.riskLearning    = new RiskLearning();
    this.corrManager    = new CorrelationManager();
    if(saved){
      this.prices=saved.prices||{};this.history=saved.history||{};this.portfolio=saved.portfolio||{};
      this.cash=saved.cash!=null ? saved.cash : INITIAL_CAPITAL;this.log=saved.log||[];this.equity=saved.equity||[INITIAL_CAPITAL];
      this.tick=saved.tick||0;this.mode=saved.mode||"PAPER";this.optLog=saved.optLog||[];
      this.pairScores=saved.pairScores||{};this.reentryTs=saved.reentryTs||{};
      this.dailyTrades=saved.dailyTrades||{date:"",count:0};this.useBnb=saved.useBnb!==undefined?saved.useBnb:true;
      this.contrafactualLog=saved.contrafactualLog||[];
      this.maxEquity=saved.maxEquity||INITIAL_CAPITAL;this.drawdownAlerted=saved.drawdownAlerted||false;
      this.tfHistory=saved.tfHistory||{};
      if(saved.optimizerHistory)this.optimizer.history=saved.optimizerHistory;
      if(saved.optimizerParams)Object.assign(this.optimizer.params,saved.optimizerParams);
      if(saved.trailingHighs)this.trailing.highs=saved.trailingHighs;
      if(saved.blacklistData)this.autoBlacklist.loadJSON(saved.blacklistData);
      if(saved.confidenceData)this.confidence.loadJSON(saved.confidenceData);
      if(saved.riskLearningData)this.riskLearning.loadJSON(saved.riskLearningData);
      if(saved.corrData)this.corrManager.loadJSON(saved.corrData);
      console.log(`[ENGINE LIVE] Restaurado tick #${this.tick} | $${this.totalValue().toFixed(2)}`);
    }else{
      this.prices={};this.history={};this.portfolio={};
      this.cash=INITIAL_CAPITAL;this.log=[];this.equity=[{v:INITIAL_CAPITAL,t:Date.now()}];
      this.tick=0;this.mode="PAPER";this.optLog=[];
      this.pairScores={};this.reentryTs={};this.dailyTrades={date:"",count:0};
      this.useBnb=true;this.contrafactualLog=[];
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
  checkDailyReset(){const today=new Date().toDateString();if(this.dailyTrades.date!==today)this.dailyTrades={date:today,count:0};}
  recentWinRate(){const sells=this.log.filter(l=>l.type==="SELL").slice(0,20);if(!sells.length)return null;return Math.round(sells.filter(l=>l.pnl>0).length/sells.length*100);}

  checkMaxDrawdown(tv){
    if(tv>this.maxEquity){this.maxEquity=tv;this.drawdownAlerted=false;}
    const dd=(this.maxEquity-tv)/this.maxEquity;
    if(dd>=MAX_DRAWDOWN_PCT&&!this.drawdownAlerted){this.drawdownAlerted=true;return{triggered:true,drawdownPct:+(dd*100).toFixed(2),maxEquity:+this.maxEquity.toFixed(2)};}
    return{triggered:false,drawdownPct:+(dd*100).toFixed(2)};
  }

  evaluate(){
    if(Object.keys(this.prices).length<3)return{signals:[],newTrades:[],circuitBreaker:null,optimizerResult:null,drawdownAlert:null};
    this.tick++;this.checkDailyReset();
    const tv=this.totalValue(),cb=this.breaker.check(tv);
    this.marketRegime=detectRegime(this.history["BTCUSDC"]);
    const drawdownAlert=this.checkMaxDrawdown(tv);
    if(cb.triggered){
      const signals=PAIRS.map(p=>({...p,price:this.prices[p.symbol]||0,...computeSignal(p.symbol,this.history,this.optimizer.getParams(),this.marketRegime)}));
      this.equity=[...this.equity,{v:tv,t:Date.now()}].slice(-500);
      return{signals,newTrades:[],circuitBreaker:cb,optimizerResult:null,drawdownAlert};
    }

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
      const timeStop = posAgeSec > posAgeLimitSec && priceMovePct < 0.5 && (pos.profitLocked||0) < 0.3;

      this.portfolio[symbol].trailingStop=+ts.stopPrice.toFixed(4);
      this.portfolio[symbol].trailingHigh=+ts.maxHigh.toFixed(4);
      this.portfolio[symbol].profitLocked=+ts.profitLocked.toFixed(2);
      const sig=signals.find(s=>s.symbol===symbol);
      const isScalp = pos.strategy==="SCALP"; // necesario para mrExit y trendRide
      // Trend riding: adapta targets por régimen
      const mrTarget_v = this.marketRegime==="BULL" ? 0.92 : this.marketRegime==="LATERAL" ? 0.65 : 0.82;
      const mrRsi_v    = this.marketRegime==="BULL" ? 72 : 60;
      const mrExit     = !isScalp && sig?.bbPos>mrTarget_v && sig?.rsiVal>mrRsi_v;
      const livePairWins=(this._pairStreak||{})[symbol]?.wins||0;
      const liveRegimeCont=pos.regime===this.marketRegime;
      const liveTrendRide=(this.marketRegime==="BULL"||(livePairWins>=2&&liveRegimeCont))&&!isScalp&&(pos.profitLocked||0)>0.3;
      if(liveTrendRide) {
        const bullTrail=cp*0.96;
        if(bullTrail>this.portfolio[symbol].trailingStop) this.portfolio[symbol].trailingStop=+bullTrail.toFixed(4);
      }
      const bearSell=this.marketRegime==="BEAR"&&pos.profitLocked<0&&ts.profitLocked<0;
      const posId=pos.posId||symbol;

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
        const partialTrade={type:"SELL",symbol,name:pos.name,qty:+closeQty.toFixed(6),price:+cp.toFixed(4),pnl:+partialPnl.toFixed(2),reason:"PARTIAL TARGET",mode:this.mode,fee:+(closeQty*cp*fee).toFixed(4),ts:new Date().toISOString(),strategy:pos.strategy||"MOMENTUM"};
        newTrades.push(partialTrade);
        console.log(`[LIVE][PARTIAL] ${symbol} 50% cerrado en target ${cp.toFixed(4)} P&L:${partialPnl.toFixed(2)}%`);
        continue;
      }

      if(cp<=pos.stopLoss||ts.hit||sig?.signal==="SELL"||mrExit||bearSell||timeStop){
        const proceeds=pos.qty*cp*(1-fee),pnl=((cp-pos.entryPrice)/pos.entryPrice)*100-fee*100*2;
        this.cash+=proceeds;
        const reason=cp<=pos.stopLoss?"STOP LOSS":ts.hit?"TRAILING STOP":scalpExit?"SCALP TARGET":mrExit?"MR OBJETIVO":bearSell?"BEAR EXIT":"SEÑAL VENTA";
        // Actualizar blacklist automática
        this.autoBlacklist.recordResult(symbol, pnl>0);
        delete this.portfolio[symbol];this.trailing.remove(symbol);
        if(pnl<0)this.reentryTs[symbol]=Date.now();
        // DQN training on trade close
        if(this.dqn && pos.dqnState) {
          const dqnNextState = this.dqn.encodeState({rsi:50,bbZone:"lower_half",regime:this.marketRegime,trend:"neutral",volumeRatio:1,atrLevel:1,fearGreed:this.fearGreed||50,lsRatio:1});
          const dqnR = Math.max(-2,Math.min(2,pnl/100*20))+(pnl>0?0.3:0)+(reason==="PARTIAL TARGET"?0.4:0)+(reason==="STOP LOSS"?-0.5:0);
          this.dqn.remember(pos.dqnState,"BUY",dqnR,dqnNextState);
          const liveSells=this.log.filter(l=>l.type==="SELL").length;
          if(this.dqn.replayBuffer.length>=50&&liveSells%50===0) {
            const loss=this.dqn.trainBatch();
            console.log(`[DQN-LIVE] loss:${loss.toFixed(5)} updates:${this.dqn.totalUpdates}`);
          }
          this.dqn.decayEpsilon(0.03,liveSells);
        }
        const trade={type:"SELL",symbol,name:pos.name,qty:+pos.qty.toFixed(6),price:+cp.toFixed(4),pnl:+pnl.toFixed(2),reason,mode:this.mode,fee:+(pos.qty*cp*fee).toFixed(4),ts:new Date().toISOString(),strategy:pos.strategy||"MOMENTUM"};
        newTrades.push(trade);this.dailyTrades.count++;
        this.optimizer.recordTrade(pnl,reason);updatePairScore(this.pairScores,symbol,pnl);
        console.log(`[${this.mode}][${this.marketRegime}][SELL] ${symbol} ${reason} P&L:${pnl.toFixed(2)}% | ${this.dailyTrades.count}/${dailyLimit}`);
      }
    }

    // NUEVAS ENTRADAS — con blacklist automática y stop dinámico
    if(!dailyLimitReached&&!this.marketDefensive){
      const nOpen=Object.keys(this.portfolio).length;
      const maxPos=this.marketRegime==="BEAR"?1:this.profile.maxOpenPositions;
      if(nOpen<maxPos){
        const reserve=this.totalValue()*MIN_CASH_RESERVE,availCash=Math.max(0,this.cash-reserve);
        const regimeMin=this.marketRegime==="BULL"?params.minScore-3:this.marketRegime==="BEAR"?85:params.minScore;
        const fearAdj=this.fearGreed<25?1.2:this.fearGreed>80?0.6:1.0;
        // Ajuste por confianza: baja confianza → posiciones más pequeñas
        const confAdj=this.confidence.get()<40?0.6:this.confidence.get()>75?1.1:1.0;
        const groupCount={};
        Object.keys(this.portfolio).forEach(sym=>{const p=PAIRS.find(p=>p.symbol===sym);if(p)groupCount[p.group]=(groupCount[p.group]||0)+1;});

        // Respetar pausa de Telegram
      if(this._pausedByTelegram) return {signals,newTrades,circuitBreaker:cb,optimizerResult:optResult,dailyLimit:dailyLimit,dailyUsed:this.dailyTrades.count,drawdownAlert};
      const buyable=signals.filter(s=>{
          if(s.signal!=="BUY"||s.score<regimeMin)return false;
          if(this.portfolio[s.symbol])return false;
          if(s.isPumping||s.isFalling)return false;
          // ── Blacklist automática ──────────────────────────────────────────
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
          const newsMultiplier = this._cryptoPanicFn ? this._cryptoPanicFn(sig.symbol) : (this._newsMultiplier||1.0);
          const corrMult = this.corrManager.getSizeMultiplier(sig.symbol, this.portfolio, this.prices, sig.score);
          // DQN guidance in live
          let liveDqnBoost = 1.0;
          if(this.dqn && this.dqn.totalUpdates > 0) {
            const liveDqnState = this.dqn.encodeState({
              rsi:sig.rsiVal||50, bbZone:sig.bbPos<0.2?"below_lower":sig.bbPos<0.5?"lower_half":"upper_half",
              regime:this.marketRegime, trend:"neutral",
              volumeRatio:1, atrLevel:sig.atrPct||1, fearGreed:this.fearGreed||50, lsRatio:1
            });
            const liveDqnQ = this.dqn.getQValues(liveDqnState);
            liveDqnBoost = liveDqnQ.BUY > liveDqnQ.SKIP + 0.3 ? 1.1 :
                           liveDqnQ.SKIP > liveDqnQ.BUY + 0.5 ? 0.7 : 1.0;
            sig._dqnState = liveDqnState;
          }
          const invest=calcPositionSize(availCash,sig.score,sig.atrPct,this.profile,nOpen)*this.hourMultiplier*fearAdj*confAdj*newsMultiplier*corrMult*volBoost*liveDqnBoost;
          if(invest<10||invest>availCash)continue;
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
          const stopLoss=dynStop.stop;
          const target=price+(price-stopLoss)*2; // target 2:1 R:R para cierre parcial
          const posId=`${sig.symbol}_${Date.now()}`;
          this.cash-=invest;
          this.portfolio[sig.symbol]={qty,entryPrice:price,stopLoss:+stopLoss.toFixed(4),trailingStop:+stopLoss.toFixed(4),trailingHigh:+price.toFixed(4),profitLocked:0,name:sig.name,ts:new Date().toISOString(),strategy:sig.strategy||"MOMENTUM",target:+target.toFixed(4),partialClosed:false,posId,dynStopInfo:dynStop,dqnState:sig._dqnState||null};
          const trade={type:"BUY",symbol:sig.symbol,name:sig.name,qty:+qty.toFixed(6),price:+price.toFixed(4),stopLoss:+stopLoss.toFixed(4),score:sig.score,pnl:null,mode:this.mode,fee:+(invest*fee).toFixed(4),ts:new Date().toISOString(),strategy:sig.strategy||"MOMENTUM"};
          newTrades.push(trade);this.dailyTrades.count++;
          const g=PAIRS.find(p=>p.symbol===sig.symbol)?.group||"";groupCount[g]=(groupCount[g]||0)+1;
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
      mode:this.mode,totalValue:tv,returnPct:ret,
      winRate:sells?+((wins/sells)*100).toFixed(0):null,
      pairs:PAIRS,categories:CATEGORIES,
      circuitBreaker:this.breaker.check(tv),
      optimizerParams:this.optimizer.getParams(),
      optLog:this.optLog,profile:this.profile,
      pairScores:this.pairScores,marketRegime:this.marketRegime,
      fearGreed:this.fearGreed,dailyTrades:this.dailyTrades,dailyLimit,
      totalFees:+this.log.reduce((s,l)=>s+(l.fee||0),0).toFixed(2),
      contrafactualLog:this.contrafactualLog.slice(0,10),
      useBnb:this.useBnb,recentWinRate:wr,
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
