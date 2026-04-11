// ── ENGINE SIMPLE v3 — Portfolio completo validado por backtester ─────────
// 7 estrategias, 6 pares, 4 timeframes — ~790 trades/año combinados
//
// CAPA 1 (corto plazo, 30m/1h) — target 1.6%, stop 0.8%:
//   BNB/1h  RSI_MR_ADX — Kelly=0.164, PF=1.59 ⭐
//   SOL/1h  EMA_CROSS  — Kelly=0.100, PF=1.33
//   BTC/30m RSI_MR_ADX — Kelly=0.095, PF=1.31
//   BTC/30m EMA_CROSS  — Kelly=0.078, PF=1.25
//
// CAPA 2 (medio plazo, 4h/1d) — target 6%, stop 3%:
//   XRP/4h EMA_CROSS   — Kelly=0.155, PF=1.55 (+37pp alpha vs BnH en bajada)
//   SOL/4h EMA_CROSS   — Kelly=0.070, PF=1.23 (+37pp alpha vs SOL -30%)
//   BNB/1d TREND_200   — Kelly=0.074, PF=1.24 (102 trades OOS)
//
// Arquitectura clave (Opus 4):
// - Señales evaluadas SOLO al cierre de cada vela (no en cada tick)
// - Kelly gate rolling de 30 trades por estrategia
// - Capa 1 y Capa 2 con capital separado (60/40)
"use strict";
const https = require("https");

const INITIAL_CAPITAL = parseFloat(process.env.CAPITAL_USDC||"10000");
const FEE = 0.001;

// Capital split entre capas
const CAPA1_PCT = 0.60; // 60% para estrategias corto plazo
const CAPA2_PCT = 0.40; // 40% para estrategias medio plazo

const STRATEGIES = [
  // ── CAPA 1 ─────────────────────────────────────────────────────────────
  { id:"BNB_1h_RSI",  pair:"BNBUSDC", tf:"1h",  capa:1, type:"RSI_MR_ADX",
    stop:0.008, target:0.016, kelly:0.164, pf:1.59 },
  { id:"SOL_1h_EMA",  pair:"SOLUSDC", tf:"1h",  capa:1, type:"EMA_CROSS",
    stop:0.008, target:0.016, kelly:0.100, pf:1.33 },
  { id:"BTC_30m_RSI", pair:"BTCUSDC", tf:"30m", capa:1, type:"RSI_MR_ADX",
    stop:0.008, target:0.016, kelly:0.095, pf:1.31 },
  { id:"BTC_30m_EMA", pair:"BTCUSDC", tf:"30m", capa:1, type:"EMA_CROSS",
    stop:0.008, target:0.016, kelly:0.078, pf:1.25 },
  // ── CAPA 2 ─────────────────────────────────────────────────────────────
  { id:"XRP_4h_EMA",  pair:"XRPUSDC", tf:"4h",  capa:2, type:"EMA_CROSS",
    stop:0.030, target:0.060, kelly:0.155, pf:1.55 },
  { id:"SOL_4h_EMA",  pair:"SOLUSDC", tf:"4h",  capa:2, type:"EMA_CROSS",
    stop:0.030, target:0.060, kelly:0.070, pf:1.23 },
  { id:"BNB_1d_T200", pair:"BNBUSDC", tf:"1d",  capa:2, type:"TREND_200",
    stop:0.030, target:0.060, kelly:0.074, pf:1.24 },
];

const TF_MS = { "30m":30*60*1000, "1h":60*60*1000, "4h":4*60*60*1000, "1d":24*60*60*1000 };

// ── Correlation groups (Opus 4: evitar doble exposición) ──────────────────
// Pares que se mueven juntos — máx 2 posiciones simultáneas del mismo grupo
const CORRELATION_GROUPS = {
  "BTC_GROUP":  ["BTCUSDC"],
  "MAJOR_ALT":  ["ETHUSDC","SOLUSDC","BNBUSDC"],
  "MID_CAP":    ["XRPUSDC","LINKUSDC","ADAUSDC","AVAXUSDC"],
};
const MAX_PER_CORR_GROUP = 2; // máx 2 posiciones del mismo grupo

// ── ATR volatility filter (Opus 4: no operar en mercado muerto) ───────────
// Si ATR de las últimas 24h < percentil 20 histórico → skip
const ATR_WINDOW = 24;      // velas para calcular ATR actual
const ATR_HIST_WINDOW = 200; // velas históricas para percentil
const ATR_MIN_PERCENTILE = 20; // no operar por debajo del percentil 20

function calcATR(candles, n=14) {
  if(candles.length < n) return 0;
  const sl = candles.slice(-n);
  const trs = sl.map((k,i,a) =>
    i===0 ? k.high-k.low :
    Math.max(k.high-k.low, Math.abs(k.high-a[i-1].close), Math.abs(k.low-a[i-1].close))
  );
  return trs.reduce((s,v)=>s+v,0)/n;
}

function atrPercentile(candles, windowSize=ATR_WINDOW, histSize=ATR_HIST_WINDOW) {
  if(candles.length < histSize) return 50; // not enough data, allow trading
  const recent = candles.slice(-histSize);
  // Calculate ATR for each window in history
  const atrs = [];
  for(let i=windowSize; i<=recent.length; i++) {
    atrs.push(calcATR(recent.slice(i-windowSize, i), windowSize));
  }
  if(!atrs.length) return 50;
  const currentATR = calcATR(candles.slice(-windowSize), windowSize);
  const below = atrs.filter(a => a <= currentATR).length;
  return Math.round(below/atrs.length*100);
}
const CANDLE_MIN = { "30m":50, "1h":50, "4h":50, "1d":200 }; // min candles needed

// ── Indicators ────────────────────────────────────────────────────────────
function rsi(cl,n=14){
  if(cl.length<n+1)return 50;
  let g=0,l=0;
  for(let i=cl.length-n;i<cl.length;i++){const d=cl[i]-cl[i-1];if(d>0)g+=d;else l-=d;}
  return l===0?100:100-100/(1+(g/n)/(l/n));
}
function ema(cl,n){
  if(cl.length<n)return cl[cl.length-1];
  const k=2/(n+1);let e=cl.slice(0,n).reduce((s,v)=>s+v,0)/n;
  for(let i=n;i<cl.length;i++)e=cl[i]*k+e*(1-k);return e;
}
function bb(cl,n=20,k=2){
  if(cl.length<n)return null;
  const sl=cl.slice(-n),mid=sl.reduce((s,v)=>s+v,0)/n;
  const std=Math.sqrt(sl.reduce((s,v)=>s+(v-mid)**2,0)/n);
  return{upper:mid+k*std,mid,lower:mid-k*std,width:2*k*std/mid};
}
function adx(klines,n=14){
  if(klines.length<n*2)return 25;
  const sl=klines.slice(-(n*2));let pDM=0,mDM=0,tr=0;
  for(let i=1;i<sl.length;i++){
    const h=sl[i].high-sl[i-1].high,l=sl[i-1].low-sl[i].low;
    pDM+=h>l&&h>0?h:0;mDM+=l>h&&l>0?l:0;
    tr+=Math.max(sl[i].high-sl[i].low,
      Math.abs(sl[i].high-sl[i-1].close),Math.abs(sl[i].low-sl[i-1].close));
  }
  if(tr===0)return 0;
  const dip=(pDM/tr)*100,dim=(mDM/tr)*100;
  return Math.abs(dip-dim)/(dip+dim)*100;
}

// ── Signal generators ─────────────────────────────────────────────────────
function evalSignal(type, candles){
  const cl=candles.map(c=>c.close);
  switch(type){
    case "RSI_MR_ADX": {
      const r=rsi(cl),b=bb(cl),a=adx(candles);
      if(!b)return null;
      return r<35&&cl[cl.length-1]<b.lower&&a<25?"BUY":null;
    }
    case "EMA_CROSS": {
      if(cl.length<50)return null;
      const e9=ema(cl,9),e21=ema(cl,21),prev=cl.slice(0,-1);
      return ema(prev,9)<ema(prev,21)&&e9>e21?"BUY":null;
    }
    case "TREND_200": {
      if(cl.length<200)return null;
      const e50=ema(cl,50),e200=ema(cl,200),r=rsi(cl),p=cl[cl.length-1];
      return p>e200&&e50>e200&&r>45&&r<65?"BUY":null;
    }
    default: return null;
  }
}

// ── Kelly gate per strategy ───────────────────────────────────────────────
function calcKelly(trades, windowSize=30){
  const recent=trades.slice(-windowSize);
  if(recent.length<20)return{kelly:-1,negative:true,wr:null,n:recent.length};
  const wins=recent.filter(t=>t.pnl>0),losses=recent.filter(t=>t.pnl<0);
  const W=wins.length/recent.length;
  const avgW=wins.length?wins.reduce((s,t)=>s+Math.abs(t.pnl),0)/wins.length:0.016;
  const avgL=losses.length?losses.reduce((s,t)=>s+Math.abs(t.pnl),0)/losses.length:0.008;
  const R=avgL>0?avgW/avgL:2;
  const kelly=W-(1-W)/R;
  return{kelly:+kelly.toFixed(3),negative:kelly<0,wr:+(W*100).toFixed(1),n:recent.length};
}

// ── Main Engine ───────────────────────────────────────────────────────────
class SimpleBotEngine {
  constructor(saved={}){
    const cap = INITIAL_CAPITAL;
    this.capa1Cash = saved.capa1Cash ?? cap * CAPA1_PCT;
    this.capa2Cash = saved.capa2Cash ?? cap * CAPA2_PCT;
    this.portfolio  = saved.portfolio  || {};  // key: strategy.id
    this.log        = saved.log        || [];
    this.equity     = saved.equity     || [{v:cap,t:Date.now()}];
    this.tick       = saved.tick       || 0;
    this.prices     = {};
    this._candles   = saved.candles    || {}; // key: "PAIR_tf"
    this._curBar    = saved.curBar     || {}; // key: "PAIR_tf"
    // Per-strategy trade history for Kelly
    this._stratTrades = saved.stratTrades || {};
  }

  // Prefill candles from Binance REST API (250 per pair/tf)
  async prefill(limit=250){
    const seen = new Set();
    for(const cfg of STRATEGIES){
      const key = `${cfg.pair}_${cfg.tf}`;
      if(seen.has(key)) continue;
      seen.add(key);
      // Skip if already have enough candles from saved state
      if((this._candles[key]||[]).length >= CANDLE_MIN[cfg.tf]){
        console.log(`[SIMPLE][PREFILL] ${key}: ya tiene ${this._candles[key].length} velas, skip`);
        continue;
      }
      try {
        const candles = await this._fetchKlinesOHLC(cfg.pair, cfg.tf, limit);
        if(candles.length > 0){
          this._candles[key] = candles;
          console.log(`[SIMPLE][PREFILL] ${key}: ${candles.length} velas cargadas desde Binance`);
        }
      } catch(e){ console.warn(`[SIMPLE][PREFILL] ${key} error:`, e.message); }
      await new Promise(r=>setTimeout(r,200)); // rate limit
    }
  }

  _fetchKlinesOHLC(symbol, interval, limit){
    return new Promise(resolve=>{
      const url=`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const req=https.get(url,res=>{
        let d="";res.on("data",c=>d+=c);
        res.on("end",()=>{
          try{
            const raw=JSON.parse(d);
            const candles=raw.map(k=>({
              open:parseFloat(k[1]),high:parseFloat(k[2]),
              low:parseFloat(k[3]),close:parseFloat(k[4]),
              start:k[0]
            }));
            resolve(candles);
          }catch{resolve([]);}
        });
      });
      req.on("error",()=>resolve([]));
      req.setTimeout(10000,()=>{req.destroy();resolve([]);});
    });
  }

  updatePrice(symbol, price){
    this.prices[symbol] = price;
    // Change 4: log tick reception every 100 ticks
    if(!this._priceTickCount) this._priceTickCount = 0;
    this._priceTickCount++;
    if(this._priceTickCount % 100 === 0)
      console.log(`[SIMPLE] tick ${symbol} $${price.toFixed(2)} (tick #${this._priceTickCount})`);
    const now = Date.now();
    // Update candles for all strategies using this symbol
    for(const cfg of STRATEGIES){
      if(cfg.pair !== symbol) continue;
      const key = `${symbol}_${cfg.tf}`;
      const tfMs = TF_MS[cfg.tf];
      const barStart = Math.floor(now/tfMs)*tfMs;
      if(!this._curBar[key]){
        this._curBar[key]={open:price,high:price,low:price,close:price,start:barStart};
      }
      const bar = this._curBar[key];
      if(barStart > bar.start){
        // Candle closed — save and evaluate
        if(!this._candles[key]) this._candles[key]=[];
        this._candles[key].push({open:bar.open,high:bar.high,low:bar.low,
          close:price,start:bar.start});
        if(this._candles[key].length>300) this._candles[key].shift();
        this._curBar[key]={open:price,high:price,low:price,close:price,start:barStart};
        this._onCandleClose(cfg, key);
      } else {
        bar.high=Math.max(bar.high,price);
        bar.low=Math.min(bar.low,price);
        bar.close=price;
      }
    }
  }

  _onCandleClose(cfg, key){
    const candles = this._candles[key]||[];
    const last = candles[candles.length-1];
    console.log(`[SIMPLE][CANDLE] ${cfg.pair}/${cfg.tf} cerrada — O:${last?.open?.toFixed(2)} H:${last?.high?.toFixed(2)} L:${last?.low?.toFixed(2)} C:${last?.close?.toFixed(2)} (${candles.length} velas)`);
    if(candles.length < CANDLE_MIN[cfg.tf]){
      console.log(`[SIMPLE][FILTER] ${cfg.pair}/${cfg.tf} bloqueado — solo ${candles.length}/${CANDLE_MIN[cfg.tf]} velas`);
      return;
    }
    // Already have open position for this strategy
    if(this.portfolio[cfg.id]) return;
    // Kelly gate
    const stratTrades = this._stratTrades[cfg.id]||[];
    const kelly = calcKelly(stratTrades);
    if(kelly.negative && kelly.n >= 10){
      console.log(`[SIMPLE][FILTER][KELLY] ${cfg.pair}/${cfg.tf}/${cfg.type} bloqueado — kelly=${kelly.kelly} WR=${kelly.wr}% n=${kelly.n}`);
      return;
    }
    const signal = evalSignal(cfg.type, candles);
    if(signal === "BUY"){
      console.log(`[SIMPLE][SIGNAL] ${cfg.pair}/${cfg.tf}/${cfg.type} → BUY score OK`);
    }
    if(signal !== "BUY") return;
    // Capital from correct layer
    const availCash = cfg.capa===1 ? this.capa1Cash : this.capa2Cash;
    const maxPositions = cfg.capa===1 ? 3 : 2;
    const openInCapa = Object.values(this.portfolio).filter(p=>p.capa===cfg.capa).length;
    if(openInCapa >= maxPositions) return;

    // ── Correlation check (Opus 4: evitar doble exposición) ──────────────
    for(const [grp, members] of Object.entries(CORRELATION_GROUPS)) {
      if(members.includes(cfg.pair)) {
        const openInGroup = Object.values(this.portfolio)
          .filter(p => members.includes(p.pair)).length;
        if(openInGroup >= MAX_PER_CORR_GROUP) {
          console.log(`[SIMPLE][FILTER][CORR] ${cfg.pair}/${cfg.tf} bloqueado — ${openInGroup}/${MAX_PER_CORR_GROUP} en grupo ${grp}`);
          return;
        }
      }
    }

    // ── ATR volatility filter (Opus 4: no operar en mercado muerto) ──────
    const atrPct = atrPercentile(candles, ATR_WINDOW, ATR_HIST_WINDOW);
    if(atrPct < ATR_MIN_PERCENTILE) {
      console.log(`[SIMPLE][FILTER][ATR] ${cfg.pair}/${cfg.tf} bloqueado — volatilidad percentil ${atrPct} (mín:${ATR_MIN_PERCENTILE})`);
      return;
    }
    const invest = Math.min(availCash*0.33, this.totalValue()*0.15);
    if(invest < 5) return;
    const price = this.prices[cfg.pair];
    if(!price) return;
    const qty = invest*(1-FEE)/price;
    if(cfg.capa===1) this.capa1Cash -= invest;
    else             this.capa2Cash -= invest;
    this.portfolio[cfg.id]={
      pair:cfg.pair,capa:cfg.capa,type:cfg.type,tf:cfg.tf,
      entryPrice:price,qty,stop:price*(1-cfg.stop),target:price*(1+cfg.target),
      openTs:Date.now(),invest,
    };
    this.log.push({type:"BUY",symbol:cfg.pair,strategy:cfg.id,price,invest,ts:Date.now()});
    console.log(`[SIMPLE][${cfg.tf}][${cfg.type}] BUY ${cfg.pair} @ $${price.toFixed(4)} $${invest.toFixed(0)} [Capa${cfg.capa}]`);
  }

  setContext(db, botName, regime, fearGreed) {
    this._db = db;
    this._botName = botName;
    this._regime = regime;
    this._fearGreed = fearGreed;
  }

  evaluate(){
    this.tick++;
    if(this.tick%30===0) this.equity.push({v:this.totalValue(),t:Date.now()});
    // Manage open positions
    for(const [id,pos] of Object.entries(this.portfolio)){
      const price = this.prices[pos.pair];
      if(!price) continue;
      const pnlPct=(price-pos.entryPrice)/pos.entryPrice*100;
      // Track MAE/MFE in real time
      const curMAE=(pos.entryPrice-price)/pos.entryPrice*100;
      const curMFE=(price-pos.entryPrice)/pos.entryPrice*100;
      if(curMAE>0) pos.maxMAE=Math.max(pos.maxMAE||0,curMAE);
      if(curMFE>0) pos.maxMFE=Math.max(pos.maxMFE||0,curMFE);
      const cfg = STRATEGIES.find(s=>s.id===id);
      const hitStop   = price<=pos.stop;
      const hitTarget = price>=pos.target;
      const timeStop  = cfg&&(Date.now()-pos.openTs)>48*3600000&&pnlPct<0.5;
      if(hitStop||hitTarget||timeStop){
        const reason=hitStop?"STOP":hitTarget?"TARGET":"TIME STOP";
        const gross=pos.qty*price;
        if(pos.capa===1) this.capa1Cash+=gross*(1-FEE);
        else             this.capa2Cash+=gross*(1-FEE);
        // Record for Kelly
        if(!this._stratTrades[id]) this._stratTrades[id]=[];
        this._stratTrades[id].push({pnl:pnlPct,ts:Date.now()});
        if(this._stratTrades[id].length>100) this._stratTrades[id].shift();
        this.log.push({type:"SELL",symbol:pos.pair,strategy:id,pnl:pnlPct,reason,ts:Date.now()});
        // Track correlation overlaps
        if(!this._corrStats) this._corrStats = {overlaps:0, total:0};
        this._corrStats.total++;
        const openAtClose = Object.keys(this.portfolio).length;
        if(openAtClose > 1) this._corrStats.overlaps++;
        console.log(`[SIMPLE][${pos.tf}][${reason}] ${pos.pair} P&L:${pnlPct.toFixed(2)}% WR:${this.globalWR()}%`);
        // Structured trade log → PostgreSQL
        // Structured trade log → PostgreSQL (Opus 4: todos los campos)
        if(this._db) {
          const { logTrade: _lt } = require("./trade_logger");
          _lt(this._db, {
            bot: this._botName||"unknown",
            symbol: pos.pair, strategy: id, direction: "long",
            openTs: pos.openTs, closeTs: Date.now(),
            entryPrice: pos.entryPrice, exitPrice: price,
            pnlPct, investUsdc: pos.invest, reason,
            regime: this._regime||"UNKNOWN",
            adx: this._lastADX||null,
            rsiAtEntry: this._lastRSI||null,
            fearGreed: this._fearGreed||null,
            hourUtc: new Date().getUTCHours(),
            kellyRolling: (() => {
              const t=this._stratTrades[id]||[];
              if(t.length<10) return null;
              const w=t.slice(-30).filter(x=>x.pnl>0);
              return +(w.length/Math.min(t.length,30)).toFixed(3);
            })(),
            maeReal: +(pos.maxMAE||0).toFixed(3),
            mfeReal: +(pos.maxMFE||0).toFixed(3),
          }).catch(()=>{});
        }
        delete this.portfolio[id];
      }
    }
  }

  totalValue(){
    return this.capa1Cash + this.capa2Cash +
      Object.values(this.portfolio).reduce((s,pos)=>
        s+pos.qty*(this.prices[pos.pair]||pos.entryPrice),0);
  }

  globalWR(){
    const sells=this.log.filter(l=>l.type==="SELL");
    return sells.length?Math.round(sells.filter(l=>l.pnl>0).length/sells.length*100):0;
  }

  getState(){
    const tv=this.totalValue();
    const sells=this.log.filter(l=>l.type==="SELL");
    const kellyByStrat={};
    for(const cfg of STRATEGIES){
      kellyByStrat[cfg.id]=calcKelly(this._stratTrades[cfg.id]||[]);
    }
    return{
      totalValue:tv,
      capa1Cash:this.capa1Cash,
      capa2Cash:this.capa2Cash,
      portfolio:this.portfolio,
      tick:this.tick,
      winRate:this.globalWR(),
      returnPct:+((tv-INITIAL_CAPITAL)/INITIAL_CAPITAL*100).toFixed(2),
      mode:"SIMPLE_v3_7strategies",
      equity:this.equity.slice(-200),
      log:this.log.slice(-100),
      trades:sells.length,
      kellyByStrategy:kellyByStrat,
      strategies:STRATEGIES.map(c=>({
        ...c,
        active:!!this.portfolio[c.id],
        candles:(this._candles[`${c.pair}_${c.tf}`]||[]).length,
        recentTrades:(this._stratTrades[c.id]||[]).length,
        kelly:calcKelly(this._stratTrades[c.id]||[]),
      })),
    };
  }

  saveState(){
    return{
      capa1Cash:this.capa1Cash,
      capa2Cash:this.capa2Cash,
      portfolio:this.portfolio,
      log:this.log.slice(-500),
      equity:this.equity.slice(-500),
      tick:this.tick,
      candles:this._candles,
      curBar:this._curBar,
      stratTrades:this._stratTrades,
    };
  }
}

module.exports={SimpleBotEngine};
