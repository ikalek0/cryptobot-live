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

// ── A8: CAPITAL viene del single source of truth (src/config.js). Antes
// estaba duplicado aquí con la misma cadena que en trading/state.js —
// cualquier refactor divergente rompía el invariante S.CAPITAL_USDT ===
// INITIAL_CAPITAL. Los tests que setean process.env.CAPITAL_USDC antes del
// require siguen funcionando porque hacen delete require.cache, lo que
// provoca una relectura del env en config.js en la siguiente carga.
const { CAPITAL: INITIAL_CAPITAL } = require("./config");
const FEE = 0.001;

// ── T0-FEE: fees con "Use BNB for fees" activo ────────────────────────────
// Binance aplica 0.1% sobre USDC por defecto; si el usuario tiene "Use BNB
// for fees" activado en su cuenta, las fees se cobran del balance BNB con
// 25% de descuento (0.075% efectivo) y el activo del trade queda íntegro.
// Si BNB se agota, Binance hace fallback automático a 0.1% sobre el asset.
const FEE_RATE_USDC = 0.001;  // 0.1% default Binance spot
const BNB_DISCOUNT  = 0.75;   // 25% descuento con BNB fee mode

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
    // F2: paused flag persisted on disk. Source of truth for /pausa /reanudar.
    // Sin esto, un PM2 restart tras /pausa reanuda el bot silenciosamente.
    this.paused     = saved.paused     === true;
    // ── T0: Capital dinámico sincronizado con Binance ────────────────────
    // DECLARADO = valor máximo del bot (env CAPITAL_USDC/USDT). REAL = lo que
    // Binance reporta ahora (usdc libre + MTM de las posiciones GESTIONADAS
    // por el simpleBot — NO de todos los assets). EFECTIVO = min(DECLARADO, REAL).
    // Regla: el bot jamás opera con más que DECLARADO. Si Binance tiene
    // menos, opera con menos. Si tiene más, el resto es invisible.
    // Posiciones fuera de this.portfolio (incidente 12 abril) NO cuentan.
    this._capitalDeclarado      = INITIAL_CAPITAL;
    this._capitalReal           = saved.capitalReal     ?? INITIAL_CAPITAL;
    this._capitalEfectivo       = saved.capitalEfectivo ?? INITIAL_CAPITAL;
    this._usdcLibre             = saved.usdcLibre       ?? null;
    this._valorPosiciones       = saved.valorPosiciones ?? null;
    // H6 persist: sync state sobrevive PM2 restart. Sin esto, un restart
    // durante una pausa por fallo de sync arrancaba como si todo estuviera
    // bien. Con H7 fail-closed encima (Math.max), la pausa NUNCA baja por
    // debajo de now+10min en el boot: si el saved pausedUntil es menor (o
    // cero), se impone el default fail-closed.
    this._lastCapitalSyncTs     = saved.lastCapitalSyncTs     || 0;
    this._lastCapitalSyncOk     = saved.lastCapitalSyncOk     !== false;
    this._capitalSyncFailCount  = saved.capitalSyncFailCount  || 0;
    this._capitalSyncPausedUntil = Math.max(
      saved.capitalSyncPausedUntil || 0,
      Date.now() + 10*60*1000  // H7 fail-closed default si no había uno en disco
    );
    // ── C2: pausa por stream-dead (WebSocket Binance sin ticks > 30s) ────
    // Distinto semánticamente de _capitalSyncPausedUntil: uno es "no tengo
    // datos de capital", otro es "no tengo datos de precios". Los logs de
    // _onCandleClose los distinguen explícitamente. Sobrevive restarts via
    // saveState (H6 pattern) — una pausa de 60s post-stream-dead no se pierde
    // si el proceso reinicia dentro de la ventana.
    this._streamDeadPausedUntil = saved.streamDeadPausedUntil || 0;
    // ── M14: peak totalValue para drawdown clásico ────────────────────────
    // Antes: drawdownPct y returnPct usaban INITIAL_CAPITAL/S.CAPITAL_USDT
    // como denominador. Con capital real ($14) < declarado ($100), reportaba
    // drawdown=86% desde el primer tick aunque no hubiera pérdidas reales.
    // Fix: drawdownPct contra peak histórico, returnPct contra _capitalEfectivo
    // (fallback INITIAL_CAPITAL si aún no hubo sync). null como sentinela
    // hasta el primer tick de getState() que llama totalValue().
    this._peakTv = saved.peakTv ?? null;
    // ── T0-FEE: estado de "Use BNB for fees" ─────────────────────────────
    // Iñigo confirma que la opción está activa en su cuenta → default true.
    // Se re-detecta en cada syncCapitalFromBinance mirando commissionAsset
    // del último trade real. NUNCA se suma _bnbBalance a _capitalReal:
    // el BNB es combustible para fees, no capital operativo.
    this._bnbFeeEnabled    = saved.bnbFeeEnabled    ?? true;
    this._bnbBalance       = saved.bnbBalance       ?? 0;
    this._bnbLowAlertSent  = saved.bnbLowAlertSent  === true;
    this._lastFeeMode      = saved.lastFeeMode      ?? null; // "BNB" | "USDC"
    // Seed backtested trades per strategy if not enough real data
    this._seedStratTrades();
    // Diagnostic: log loaded state
    const curBarKeys = Object.keys(this._curBar);
    const candleKeys = Object.keys(this._candles);
    console.log(`[SIMPLE][INIT] curBar keys: [${curBarKeys.join(",")}]`);
    console.log(`[SIMPLE][INIT] candle keys: [${candleKeys.map(k=>k+"="+this._candles[k].length).join(",")}]`);
  }

  // Seed backtested trades per strategy so Kelly gate starts positive
  _seedStratTrades() {
    const now = Date.now();
    // WR from backtests: BNB_RSI 58%, SOL_EMA 54%, BTC_RSI 55%, BTC_EMA 52%, XRP_EMA 56%, SOL4h 53%, BNB1d 54%
    const SEED_WR = {
      "BNB_1h_RSI": 0.58, "SOL_1h_EMA": 0.54, "BTC_30m_RSI": 0.55,
      "BTC_30m_EMA": 0.52, "XRP_4h_EMA": 0.56, "SOL_4h_EMA": 0.53, "BNB_1d_T200": 0.54,
    };
    for (const cfg of STRATEGIES) {
      const existing = (this._stratTrades[cfg.id] || []).length;
      if (existing >= 20) continue; // already has enough real trades
      const wr = SEED_WR[cfg.id] || 0.55;
      const trades = [];
      for (let i = 0; i < 20; i++) {
        const isWin = i < Math.round(wr * 20);
        trades.push({ pnl: isWin ? (cfg.target || 0.016) * 100 : -(cfg.stop || 0.008) * 100, ts: now - (20 - i) * 3600000 });
      }
      this._stratTrades[cfg.id] = [...trades, ...(this._stratTrades[cfg.id] || [])];
      const k = calcKelly(this._stratTrades[cfg.id]);
      console.log(`[SIMPLE][KELLY-SEED] ${cfg.id}: ${trades.length} trades sembrados (WR=${(wr*100).toFixed(0)}%) → kelly=${k.kelly} WR=${k.wr}% n=${k.n}`);
    }
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
    // Normalizar USDT → USDC (Binance streams USDT pairs pero strategies usan USDC)
    const sym = symbol.endsWith("USDT") ? symbol.replace(/USDT$/, "USDC") : symbol;
    this.prices[sym] = price;
    // Change 4: log tick reception every 100 ticks
    if(!this._priceTickCount) this._priceTickCount = 0;
    this._priceTickCount++;
    if(this._priceTickCount % 100 === 0)
      console.log(`[SIMPLE] tick ${symbol}→${sym} $${price.toFixed(2)} (tick #${this._priceTickCount})`);
    const now = Date.now();
    // Update candles for all strategies using this symbol
    for(const cfg of STRATEGIES){
      if(cfg.pair !== sym) continue;
      const key = `${sym}_${cfg.tf}`;
      const tfMs = TF_MS[cfg.tf];
      const barStart = Math.floor(now/tfMs)*tfMs;
      if(!this._curBar[key]){
        this._curBar[key]={open:price,high:price,low:price,close:price,start:barStart};
        console.log(`[SIMPLE][BAR-NEW] ${key} creado start=${new Date(barStart).toISOString()} candles=${(this._candles[key]||[]).length}`);
      }
      const bar = this._curBar[key];
      // Diagnostic: log first comparison per key to verify bar timing
      if(!this._barCheckLogged) this._barCheckLogged = {};
      if(!this._barCheckLogged[key]){
        this._barCheckLogged[key] = true;
        console.log(`[SIMPLE][BAR-CMP] ${key} barStart=${new Date(barStart).toISOString()} bar.start=${new Date(bar.start).toISOString()} willClose=${barStart > bar.start}`);
      }
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
    try {
    // ── C1: pause gate a nivel de engine ─────────────────────────────────
    // El comando /pausa antes sólo bloqueaba SELLs (gate antes de evaluate()
    // en trading/loop.js). Los BUYs iban por updatePrice → _onCandleClose →
    // _onBuy → placeLiveBuy sin consultar pausa. Vector: usuario pausa en
    // crisis, bot sigue comprando pero no puede vender. Este gate es la
    // primera guard de _onCandleClose — antes incluso del capital-sync gate.
    if (this.paused === true) {
      console.log(`[SIMPLE][PAUSE] ${cfg.id} bloqueado — bot pausado por usuario`);
      return;
    }
    const candles = this._candles[key]||[];
    const last = candles[candles.length-1];
    console.log(`[SIMPLE][CANDLE] ${cfg.pair}/${cfg.tf} cerrada — O:${last?.open?.toFixed(2)} H:${last?.high?.toFixed(2)} L:${last?.low?.toFixed(2)} C:${last?.close?.toFixed(2)} (${candles.length}/${CANDLE_MIN[cfg.tf]} velas)`);
    if(candles.length < CANDLE_MIN[cfg.tf]) return;
    console.log(`[SIMPLE][EVAL-START] ${cfg.id} ${cfg.pair}/${cfg.tf}/${cfg.type}`);
    // ── T0 capital sync gate: si la sincronización contra Binance falló,
    // bloqueamos NUEVOS BUYs durante 5min. Las SELLs (evaluate() → stops/
    // targets) siguen ejecutándose para no dejar posiciones atrapadas.
    if (Date.now() < (this._capitalSyncPausedUntil || 0)) {
      const remaining = Math.ceil(((this._capitalSyncPausedUntil||0) - Date.now())/1000);
      console.log(`[SIMPLE][CAPITAL-SYNC] ${cfg.id} bloqueado — sync falló hace ${remaining}s restantes`);
      return;
    }
    // ── C2 stream-dead gate: si el WebSocket de Binance no emite ticks
    // reales durante >30s, trading/loop.js setea _streamDeadPausedUntil y
    // aquí bloqueamos BUYs. Distinto del capital sync gate para que los
    // logs distingan "no tengo precio real" de "no tengo balance real".
    if (Date.now() < (this._streamDeadPausedUntil || 0)) {
      const remaining = Math.ceil(((this._streamDeadPausedUntil||0) - Date.now())/1000);
      console.log(`[SIMPLE][STREAM-DEAD] ${cfg.id} bloqueado — WS sin ticks hace ${remaining}s restantes`);
      return;
    }
    if(this.portfolio[cfg.id]){
      console.log(`[SIMPLE][EVAL] ${cfg.id} — posición abierta, skip`);
      return;
    }
    const stratTrades = this._stratTrades[cfg.id]||[];
    const kelly = calcKelly(stratTrades);
    console.log(`[SIMPLE][KELLY] ${cfg.id} kelly=${kelly.kelly} WR=${kelly.wr}% n=${kelly.n} → ${kelly.negative && kelly.n >= 10 ? "BLOQUEADO" : "OK"}`);
    if(kelly.negative && kelly.n >= 10) return;
    const signal = evalSignal(cfg.type, candles);
    console.log(`[SIMPLE][EVAL] ${cfg.id} signal=${signal || "HOLD"}`);
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
    // ── Position sizing (FIX-B + T0: usar min(tv, capRef) para bloquear inflación por mark-to-market,
    // donde capRef = min(declarado, efectivo) — nunca superar lo declarado aunque Binance tenga más)
    const tv = this.totalValue();
    const capDeclaradoLocal = this._capitalDeclarado || INITIAL_CAPITAL;
    const capEfectivoLocal  = this._capitalEfectivo  || capDeclaradoLocal;
    const capRef            = Math.min(capDeclaradoLocal, capEfectivoLocal);
    const sizingBase = Math.min(tv, capRef);
    const kellyFrac = Math.max(0.05, Math.min(0.5, kelly.kelly || 0.1));
    let invest = sizingBase * kellyFrac * 0.5; // Half-Kelly conservador
    if(invest > sizingBase * 0.30) invest = sizingBase * 0.30; // máximo 30% del sizing base
    // T0-FEE: el clamp de cash debe respetar el fee_efectivo del modo actual.
    // Si pagamos en BNB (FEE_efectivo=0) el clamp es invest≤availCash (igual que
    // antes). Si pagamos en USDC (FEE_efectivo=0.001) el cash debitado es
    // invest*(1+FEE_efectivo), así que debemos rebajar invest a
    // availCash/(1+FEE_efectivo) para no dejar la capa en negativo.
    // Nota: la predicción del fee depende de `invest`, y `invest` depende
    // del fee sólo a través del clamp. Basta con calcular la predicción una
    // vez con el invest pre-clamp — FEE_efectivo sólo varía por el modo
    // (BNB vs USDC), que es independiente del tamaño del trade.
    const feePredBuy = this._computeFeePrediction(invest);
    const feeMult    = 1 + feePredBuy.FEE_efectivo;
    if (invest * feeMult > availCash) invest = availCash / feeMult;

    // ── FIX-A + T0 + A4: Global committed cap check ATÓMICO (con fee) ────
    // committed se computa aquí, y portfolio se muta más abajo SÍNCRONAMENTE
    // (antes de cualquier callback async). Eso garantiza que, si varias
    // estrategias cierran vela en el mismo tick, la segunda ve el committed
    // actualizado por la primera. El capLimit usa capRef dinámico.
    //
    // A4 (Opus M12): el invariante real es "dinero comprometido INCLUYENDO
    // fees ≤ cap*1.005". Antes el committed sumaba `p.invest` nominal sin
    // incluir fee, y el check comparaba contra `invest` nominal también,
    // lo que dejaba exactamente el margen del fee (~0.1% en USDC mode, 0
    // en BNB mode) al borde del tolerance de 0.5%. Con 7 estrategias
    // abriendo simultáneamente en USDC mode, el margen se estrecha a ~0.1%,
    // peligroso en pips precisos.
    //
    // Fix:
    //  1. Sumar `p._investWithFee` al committed. Fallback a `p.invest *
    //     (1+FEE_RATE_USDC)` para posiciones legacy sin el campo — upper
    //     bound conservador (peor caso USDC). Esto es regresivo en BNB
    //     mode (sobreestima por 0.1%) pero seguro.
    //  2. Comparar `committed + invest*feeMult` contra capLimit.
    //  3. Shrink path: `invest = headroom / feeMult` (no headroom directo),
    //     para que `invest_new * feeMult + committed <= capLimit`.
    //  4. Check de mínimo $10 sobre el INVEST base (no sobre headroom).
    //
    // En modo BNB (feeMult=1) el comportamiento es idéntico al anterior —
    // divido por 1 y comparo igual. Sólo en modo USDC hay diferencia real.
    const committed = Object.values(this.portfolio).reduce((s,p) => {
      // A4: usar _investWithFee si está (posiciones post-fix), sino
      // fallback conservador con FEE_RATE_USDC como upper bound.
      if (typeof p._investWithFee === "number") return s + p._investWithFee;
      return s + (p.invest || 0) * (1 + FEE_RATE_USDC);
    }, 0);
    const capLimit     = capRef * 1.005; // 0.5% tolerancia para slippage micro
    const investWithFee = invest * feeMult;
    if(committed + investWithFee > capLimit){
      // headroom = capacidad en "valor con fee" restante; invest base
      // resultante = headroom/feeMult para preservar el invariante.
      const headroom = capLimit - committed;
      const investShrunk = headroom / feeMult;
      if(investShrunk < 10){
        console.log(`[SIMPLE][CAP] ${cfg.id} bloqueado — committed(w/fee)=$${committed.toFixed(2)} + new(w/fee)=$${investWithFee.toFixed(2)} > cap=$${capLimit.toFixed(2)} (investShrunk=$${investShrunk.toFixed(2)} < $10)`);
        return;
      }
      console.log(`[SIMPLE][CAP] ${cfg.id} shrink invest $${invest.toFixed(2)} → $${investShrunk.toFixed(2)} (committed(w/fee)=$${committed.toFixed(2)} cap=$${capLimit.toFixed(2)} feeMult=${feeMult.toFixed(4)})`);
      invest = investShrunk;
    }

    console.log(`[SIMPLE][SIZING] ${cfg.id} base=$${sizingBase.toFixed(2)} committed=$${committed.toFixed(2)} kelly=${kellyFrac.toFixed(3)} → invest=$${invest.toFixed(2)}`);
    if(invest < 10){
      console.log(`[SIMPLE][SIZING] ${cfg.id} invest=$${invest.toFixed(2)} < $10 mínimo — skip`);
      return;
    }
    const price = this.prices[cfg.pair];
    if(!price) return;
    // T0-FEE: log del fee predicho (mode BNB vs USDC) y recálculo final.
    // Si el clamp de cash recortó `invest`, recalculamos la predicción
    // con el invest definitivo para que bnbAmount esperado sea exacto.
    const feePred = this._computeFeePrediction(invest);
    this._lastFeeMode = feePred.mode;
    console.log(`[SIMPLE][FEE] ${cfg.id} tradeValue=$${invest.toFixed(2)} mode=${feePred.mode} expectedFee=${feePred.feePaidInBnb ? feePred.expectedBnbFee.toFixed(6)+" BNB" : "$"+feePred.feeUsdcEquivalent.toFixed(4)}`);
    // qty = invest/price (pura): en modo BNB la fee se cobra en BNB separate,
    // el activo llega íntegro; en modo USDC la fee se cobra en el debit de
    // cash más abajo (capa1Cash -= invest*(1+FEE_efectivo)) vía applyRealBuyFill
    // se reconciliará con la realidad contra el fill exacto.
    const qty = invest/price;

    // ── FIX-A atomicidad: mutar portfolio SYNC antes de cualquier _onBuy ──
    // No insertar await/callback entre este bloque y el fin de _onCandleClose.
    // T0-FEE: el debit de cash incluye el fee_efectivo (0 en modo BNB, 0.001
    // en modo USDC). A4: el cap invariant ahora sí incluye fee — committed
    // se suma con _investWithFee y el check usa invest*feeMult.
    const cashDebit = invest * (1 + feePred.FEE_efectivo);
    if(cfg.capa===1) this.capa1Cash -= cashDebit;
    else             this.capa2Cash -= cashDebit;
    this.portfolio[cfg.id]={
      pair:cfg.pair,capa:cfg.capa,type:cfg.type,tf:cfg.tf,
      entryPrice:price,qty,stop:price*(1-cfg.stop),target:price*(1+cfg.target),
      openTs:Date.now(),invest,
      // A4: _investWithFee = invest * (1 + FEE_efectivo). Guarda explícita
      // para el próximo committed sum del cap check. Sin esto, la siguiente
      // estrategia que evalúe en el mismo tick cae al fallback conservador.
      _investWithFee: cashDebit,
      status:"pending", // se convierte en "filled" cuando applyRealFill reconcilia (FASE 3)
      _feePredicted: feePred, // T0-FEE: para _checkFeeDiscrepancy post-fill
    };
    this.log.push({type:"BUY",symbol:cfg.pair,strategy:cfg.id,price,invest,ts:Date.now()});
    console.log(`[SIMPLE][BUY] ${cfg.pair} @ $${price.toFixed(4)} $${invest.toFixed(0)} [Capa${cfg.capa}] ${cfg.id}`);

    // ── Callback para ejecución real (FASE 3). portfolio ya está actualizado,
    // el committed que vea la próxima estrategia en este mismo tick es correcto.
    if(typeof this._onBuy === "function"){
      try { this._onBuy(cfg.pair, invest, {strategyId: cfg.id, capa: cfg.capa, expectedPrice: price}); }
      catch(e) { console.error(`[SIMPLE][onBuy] ${cfg.id} error:`, e.message); }
    }
    } catch(e) {
      console.error(`[SIMPLE][ERROR] _onCandleClose ${cfg?.id}: ${e.message}`);
      console.error(e.stack?.split("\n").slice(0,3).join("\n"));
    }
  }

  setContext(db, botName, regime, fearGreed) {
    this._db = db;
    this._botName = botName;
    this._regime = regime;
    this._fearGreed = fearGreed;
  }

  // ── T0: Capital dinámico — sincronización contra Binance ───────────────
  // Consulta el balance USDC libre + MTM de las posiciones que el simpleBot
  // gestiona (this.portfolio) y recalcula capa1Cash/capa2Cash para que el
  // ledger virtual refleje la realidad, sin exceder nunca el cap declarado.
  //
  // CRÍTICO: valorPosiciones itera SOLO sobre this.portfolio, NO sobre todos
  // los balances de Binance. Motivo: las posiciones del incidente del 12 abril
  // (SOL/XRP residuales) no están en this.portfolio y el bot no puede
  // gestionarlas (no sabe cerrarlas, no conoce el precio de entrada, etc.).
  // Incluirlas en capital_real sería mentirle al sizing. Se quedan fuera del
  // alcance del bot hasta que el operador las migre explícitamente.
  //
  // Si Binance falla: _capitalSyncPausedUntil se adelanta 5min → _onCandleClose
  // bloquea nuevos BUYs. Las SELLs (stops/targets/time-stop) siguen
  // funcionando en evaluate() para no dejar posiciones atrapadas.
  async syncCapitalFromBinance(deps) {
    // deps = { binanceReadOnlyRequest, telegramSend? }
    try {
      if (typeof deps?.binanceReadOnlyRequest !== "function")
        throw new Error("binanceReadOnlyRequest not provided");
      const account = await deps.binanceReadOnlyRequest("GET", "account", {});
      if (!account || !Array.isArray(account.balances))
        throw new Error("invalid account payload");

      // 1) USDC libre (spot)
      const usdc = account.balances.find(b => b.asset === "USDC");
      const usdcLibre = parseFloat(usdc?.free || "0");

      // 1b) T0-FEE: BNB libre — reserva para fees con "Use BNB for fees".
      //     NUNCA se suma a capitalReal/efectivo — es combustible, no capital.
      const bnb = account.balances.find(b => b.asset === "BNB");
      this._bnbBalance = parseFloat(bnb?.free || "0");

      // 1c) T0-FEE: detección de bnbFeeEnabled vía commissionAsset del último
      //     trade. Se prueba en cascada para funcionar tanto en bots con
      //     historial como en bots recién arrancados:
      //       (a) símbolo del último trade en this.log (si lo hay)
      //       (b) primer par de las estrategias del simpleBot (BNB_1h_RSI→BNBUSDC)
      //       (c) BNBUSDC como último recurso (BNB siempre listado)
      //     Si todas las llamadas fallan o devuelven array vacío, NO se toca
      //     el valor previo (persistente) — el default al boot es true.
      try {
        const prevMode = this._bnbFeeEnabled;
        const detected = await this._detectBnbFeeMode(deps.binanceReadOnlyRequest);
        if (detected !== null) {
          this._bnbFeeEnabled = detected;
          if (prevMode !== detected) {
            console.log(`[SIMPLE][FEE-MODE] cambio detectado: ${prevMode?"BNB":"USDC"} → ${detected?"BNB":"USDC"}`);
          }
        }
      } catch (e) {
        // Detección best-effort — no bloquea el sync
        console.warn(`[SIMPLE][FEE-MODE] detección falló (no crítico): ${e.message}`);
      }

      // 1d) T0-FEE: alerta BNB bajo con latch (evita spam). Umbral ≈ $3.
      const UMBRAL_BNB_BAJO = 0.005;
      if (this._bnbBalance < UMBRAL_BNB_BAJO && !this._bnbLowAlertSent) {
        if (typeof deps?.telegramSend === "function") {
          try {
            deps.telegramSend(`⚠️ <b>BNB BAJO</b>\nBalance: ${this._bnbBalance.toFixed(6)} BNB\nPróximas operaciones pagarán fee en USDC (0.1%).\nConsidera añadir BNB.`);
          } catch {}
        }
        this._bnbLowAlertSent = true;
        console.warn(`[SIMPLE][FEE] BNB bajo (${this._bnbBalance.toFixed(6)} < ${UMBRAL_BNB_BAJO}) — alerta Telegram enviada`);
      }
      if (this._bnbBalance >= UMBRAL_BNB_BAJO && this._bnbLowAlertSent) {
        this._bnbLowAlertSent = false;
        console.log(`[SIMPLE][FEE] BNB recuperado (${this._bnbBalance.toFixed(6)}) — latch de alerta reseteado`);
      }

      // 2) Valor MTM de las posiciones GESTIONADAS por el simpleBot.
      //    Usamos los precios cacheados en this.prices (ya normalizados USDC).
      //    Si falta el precio de algún par, loguear pero seguir (partial OK —
      //    la próxima sync lo corregirá cuando el precio esté disponible).
      let valorPosiciones = 0;
      const missingPrices = [];
      for (const [stratId, pos] of Object.entries(this.portfolio || {})) {
        const px = this.prices[pos.pair];
        if (!px || px <= 0) { missingPrices.push(pos.pair); continue; }
        valorPosiciones += (pos.qty || 0) * px;
      }
      if (missingPrices.length > 0) {
        console.warn(`[SIMPLE][CAPITAL-SYNC] precios faltantes para ${[...new Set(missingPrices)].join(",")} — valoración parcial`);
      }

      const real       = usdcLibre + valorPosiciones;
      const declarado  = this._capitalDeclarado || INITIAL_CAPITAL;
      const efectivo   = Math.min(declarado, real);

      // 3) Ajustar capa1Cash / capa2Cash respetando:
      //    - el split 60/40 del EFECTIVO
      //    - el committed de cada capa (no tocar posiciones abiertas)
      //    - nunca valores negativos
      const committedC1 = Object.values(this.portfolio||{})
        .filter(p => p.capa===1).reduce((s,p)=>s+(p.invest||0), 0);
      const committedC2 = Object.values(this.portfolio||{})
        .filter(p => p.capa===2).reduce((s,p)=>s+(p.invest||0), 0);
      const newCapa1Cash = Math.max(0, efectivo*CAPA1_PCT - committedC1);
      const newCapa2Cash = Math.max(0, efectivo*CAPA2_PCT - committedC2);

      // Tolerancia para evitar log spam por fluctuación cents
      const TOL = 0.10;
      const changed = Math.abs(newCapa1Cash - this.capa1Cash) > TOL
                   || Math.abs(newCapa2Cash - this.capa2Cash) > TOL
                   || Math.abs(efectivo - (this._capitalEfectivo||0)) > TOL;

      this._capitalReal     = +real.toFixed(4);
      this._capitalEfectivo = +efectivo.toFixed(4);
      this._usdcLibre       = +usdcLibre.toFixed(4);
      this._valorPosiciones = +valorPosiciones.toFixed(4);
      this.capa1Cash        = +newCapa1Cash.toFixed(4);
      this.capa2Cash        = +newCapa2Cash.toFixed(4);
      this._lastCapitalSyncTs    = Date.now();
      this._lastCapitalSyncOk    = true;
      this._capitalSyncFailCount = 0;
      this._capitalSyncPausedUntil = 0;

      console.log(`[SIMPLE][CAPITAL-SYNC] declarado=$${declarado.toFixed(2)} real=$${real.toFixed(2)} efectivo=$${efectivo.toFixed(2)} usdcLibre=$${usdcLibre.toFixed(2)} valorPos=$${valorPosiciones.toFixed(2)} capa1=$${this.capa1Cash.toFixed(2)} capa2=$${this.capa2Cash.toFixed(2)}${changed?" (ajustado)":""}`);

      return {
        ok: true,
        capitalDeclarado: this._capitalDeclarado,
        capitalReal:      this._capitalReal,
        capitalEfectivo:  this._capitalEfectivo,
        usdcLibre:        this._usdcLibre,
        valorPosiciones:  this._valorPosiciones,
      };
    } catch (err) {
      this._capitalSyncFailCount++;
      this._lastCapitalSyncOk = false;
      this._capitalSyncPausedUntil = Date.now() + 5*60*1000;
      console.error(`[SIMPLE][CAPITAL-SYNC] ERROR (${this._capitalSyncFailCount}/3) — pausing trades 5min: ${err.message}`);
      if (this._capitalSyncFailCount >= 3 && typeof deps?.telegramSend === "function") {
        try {
          deps.telegramSend(`🚨 <b>[LIVE] CAPITAL-SYNC</b>\n3 fallos consecutivos consultando Binance.\nBUYs pausados hasta recuperar conexión.\nÚltimo error: ${err.message}`);
        } catch {}
      }
      return { ok: false, error: err.message };
    }
  }

  // ── T0-FEE: predicción pura de fee antes de ejecutar un trade ─────────
  // Devuelve cómo se PAGARÁ la fee asumiendo el estado actual del bot
  // (_bnbFeeEnabled + _bnbBalance + precio cacheado de BNB). No muta nada.
  // Se llama antes del cálculo virtual de qty/cash en BUY y SELL.
  //
  // Modos posibles:
  //  - "BNB":   hay BNB suficiente y la opción está activa → FEE_efectivo=0
  //             (el fee se cobra en BNB con 25% descuento, invisible para USDC)
  //  - "USDC":  opción desactivada, o BNB insuficiente, o precio BNB no cacheado
  //             → FEE_efectivo=0.001 (Binance cobra 0.1% sobre el activo)
  //
  // Nota: bnbBalancePre se guarda para la verificación post-fill que compara
  // el delta real de BNB contra expectedBnbFee (ver _checkFeeDiscrepancy).
  _computeFeePrediction(tradeValue) {
    const bnbPrice = this.prices["BNBUSDC"] || 0;
    const feeUsdcEquivalent = tradeValue * FEE_RATE_USDC;

    let FEE_efectivo  = FEE_RATE_USDC;
    let feePaidInBnb  = false;
    let expectedBnbFee = 0;

    if (this._bnbFeeEnabled && bnbPrice > 0) {
      expectedBnbFee = (feeUsdcEquivalent / bnbPrice) * BNB_DISCOUNT;
      if ((this._bnbBalance || 0) >= expectedBnbFee) {
        FEE_efectivo = 0;
        feePaidInBnb = true;
      }
    }

    return {
      mode:              feePaidInBnb ? "BNB" : "USDC",
      FEE_efectivo,
      feePaidInBnb,
      expectedBnbFee:    +expectedBnbFee.toFixed(8),
      feeUsdcEquivalent: +feeUsdcEquivalent.toFixed(6),
      bnbBalancePre:     +(this._bnbBalance || 0).toFixed(8),
      bnbPrice:          +bnbPrice.toFixed(4),
      ts:                Date.now(),
    };
  }

  // ── T0-FEE: detección de "Use BNB for fees" vía commissionAsset ────────
  // Prueba GET /api/v3/myTrades en cascada sobre símbolos candidatos.
  // Devuelve true  si el último trade real usó commissionAsset="BNB"
  // Devuelve false si usó otro asset (la fee se pagó en el propio activo)
  // Devuelve null  si todos los candidatos devuelven array vacío o fallan
  //                (el caller mantiene el valor previo en ese caso)
  //
  // Estrategia de cascada:
  //   1. Último símbolo registrado en this.log con type=BUY|SELL
  //   2. Primer par único de this.portfolio (posiciones abiertas)
  //   3. Primer par único de STRATEGIES (pares activos del simpleBot)
  //   4. BNBUSDC como último recurso (BNB siempre listado en Binance)
  //
  // Esto funciona tanto si el bot acaba de arrancar sin historial propio
  // (cae al fallback 3 o 4) como si ya ha operado (usa fallback 1 o 2).
  async _detectBnbFeeMode(binanceReadOnlyRequest) {
    if (typeof binanceReadOnlyRequest !== "function") return null;
    const candidates = [];
    // (1) último symbol del log
    const lastEntry = [...(this.log||[])].reverse()
      .find(l => (l?.type === "BUY" || l?.type === "SELL") && l?.symbol);
    if (lastEntry) candidates.push(lastEntry.symbol);
    // (2) primer pair único del portfolio
    for (const pos of Object.values(this.portfolio || {})) {
      if (pos?.pair && !candidates.includes(pos.pair)) candidates.push(pos.pair);
    }
    // (3) pares de las estrategias activas
    for (const cfg of STRATEGIES) {
      if (cfg?.pair && !candidates.includes(cfg.pair)) candidates.push(cfg.pair);
    }
    // (4) último recurso — siempre BNB
    if (!candidates.includes("BNBUSDC")) candidates.push("BNBUSDC");

    for (const symbol of candidates) {
      try {
        const trades = await binanceReadOnlyRequest("GET", "myTrades", { symbol, limit: 5 });
        if (Array.isArray(trades) && trades.length > 0) {
          const last = trades[trades.length - 1];
          if (last && last.commissionAsset) {
            return last.commissionAsset === "BNB";
          }
        }
      } catch (e) {
        // prueba siguiente candidato — no loguear aquí (lo hace el caller)
      }
    }
    return null;
  }

  // FIX-M9 + C4: limpia posiciones stuck con status="pending".
  // Si el callback _onBuy crashea DESPUÉS de la mutación atómica del portfolio
  // (FIX-A: reservación sync antes del callback async), la posición queda en
  // "pending" para siempre: cuenta en el cap check pero stop/target nunca se
  // recomputan con applyRealBuyFill. Este método rollback la reserva tras 5min.
  // Se ejecuta al inicio de cada evaluate() (cada tick).
  //
  // C4 pre-cleanup verification: si tenemos binanceReadOnlyRequest inyectado
  // (server.js lo setea en this._binanceReadOnlyRequest tras la construcción),
  // ANTES de hacer rollback ciego, preguntamos a Binance si hay fills reales
  // posteriores a pos.openTs. Si los hay, reconciliar vía applyRealBuyFill
  // (el asset está en Binance, solo el callback local se perdió). Si la
  // verificación falla por red/timeout, MANTENER el pending y reintentar en
  // el próximo tick — mejor mantener que borrar un asset real.
  //
  // Sin deps inyectadas (tests, paper-live sin binance): fallback al comportamiento
  // original de rollback inmediato.
  async _cleanupStalePending(){
    const now = Date.now();
    const STALE_MS = 5 * 60 * 1000;
    const stale = [];
    for(const [id, pos] of Object.entries(this.portfolio)){
      if(pos.status === "pending" && (now - (pos.openTs || 0)) > STALE_MS){
        stale.push(id);
      }
    }
    const hasBinance = typeof this._binanceReadOnlyRequest === "function";
    for(const id of stale){
      const pos = this.portfolio[id];
      if(!pos) continue; // mutación concurrente (improbable)

      if (hasBinance) {
        // C4: verificar con Binance si hay fills reales antes de rollback
        let trades;
        try {
          trades = await this._binanceReadOnlyRequest("GET", "myTrades", {
            symbol: pos.pair,
            startTime: Math.max(0, (pos.openTs || 0) - 60*1000),
            limit: 20,
          });
        } catch(e) {
          // Red/timeout: NO rollback. Mantener pending y reintentar al próximo tick.
          console.error(`[SIMPLE][STALE-CHECK] ${id} verificación Binance falló (${e.message}) — mantener pending, reintentar próximo tick`);
          continue;
        }
        if (Array.isArray(trades) && trades.length > 0) {
          // Filtrar solo los buys de ESTA posición (posteriores a openTs-60s).
          // Binance devuelve compras y ventas en myTrades; filtramos isBuyer=true.
          const relevant = trades.filter(t => t.isBuyer === true && (t.time || 0) >= ((pos.openTs || 0) - 60*1000));
          const totalQty  = relevant.reduce((s,t) => s + parseFloat(t.qty||0), 0);
          const totalCost = relevant.reduce((s,t) => s + parseFloat(t.quoteQty||0), 0);
          if (totalQty > 0 && totalCost > 0) {
            console.error(`[SIMPLE][STALE-FILL] ${id} fills reales detectados (qty=${totalQty.toFixed(6)} cost=$${totalCost.toFixed(2)}) — reconciliando en vez de borrar`);
            try {
              this.applyRealBuyFill(id, { realSpent: totalCost, realQty: totalQty });
            } catch(e) {
              console.error(`[SIMPLE][STALE-FILL] ${id} applyRealBuyFill falló: ${e.message}`);
            }
            continue; // no rollback, reconciliado
          }
        }
        // Binance confirmó sin fills → rollback seguro
      }

      // Rollback seguro: sin Binance (no podemos verificar) o Binance confirmó sin fills
      console.warn(`[SIMPLE][CLEANUP] ${id} pending > 5min (stuck) — rollback reservation $${(pos.invest||0).toFixed(2)} → capa${pos.capa}`);
      if(pos.capa === 1) this.capa1Cash += (pos.invest || 0);
      else               this.capa2Cash += (pos.invest || 0);
      delete this.portfolio[id];
    }
  }

  async evaluate(){
    await this._cleanupStalePending(); // FIX-M9 + C4: rollback/reconcile pending stuck
    this.tick++;
    if(this.tick%30===0) this.equity.push({v:this.totalValue(),t:Date.now()});
    // Diagnostic: cada 60 ticks (~10min) mostrar estado de velas
    if(this.tick%60===0){
      const bars = Object.entries(this._curBar).map(([k,b])=>`${k}:${new Date(b.start).toISOString().slice(11,16)}`);
      const candles = Object.entries(this._candles).map(([k,v])=>`${k}:${v.length}`);
      console.log(`[SIMPLE][DIAG] tick=${this.tick} bars=[${bars.join(",")}] candles=[${candles.join(",")}] prices=${Object.keys(this.prices).length}`);
    }
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
        // T0-FEE: usar FEE_efectivo según el modo actual (BNB=0, USDC=0.001).
        // En modo BNB el bot recibe gross íntegro; la fee BNB se verifica
        // post-fill vía _checkFeeDiscrepancy contra el delta real del balance.
        const feePredSell = this._computeFeePrediction(gross);
        this._lastFeeMode = feePredSell.mode;
        console.log(`[SIMPLE][FEE] ${id} SELL gross=$${gross.toFixed(2)} mode=${feePredSell.mode} expectedFee=${feePredSell.feePaidInBnb ? feePredSell.expectedBnbFee.toFixed(6)+" BNB" : "$"+feePredSell.feeUsdcEquivalent.toFixed(4)}`);
        const expectedNet = gross*(1-feePredSell.FEE_efectivo);
        if(pos.capa===1) this.capa1Cash+=expectedNet;
        else             this.capa2Cash+=expectedNet;
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
        // FIX-D: capturar capa/qty ANTES del delete para el callback _onSell.
        // El portfolio ya se borró localmente, pero el callback necesita saber
        // de qué capa restar el delta slippage cuando applyRealSellFill llegue.
        const sellCtx = {
          strategyId: id,
          capa: pos.capa,
          pair: pos.pair,
          qty: pos.qty,
          entryPrice: pos.entryPrice,
          expectedGross: gross,
          expectedNet,
          reason,
          // T0-FEE: predicción usada para el expectedNet; placeLiveSell la usa
          // tras el post-fill sync para llamar _checkFeeDiscrepancy(id,"SELL",...)
          _feePredicted: feePredSell,
        };
        delete this.portfolio[id];
        if(typeof this._onSell === "function"){
          try { this._onSell(pos.pair, pos.qty, sellCtx); }
          catch(e) { console.error(`[SIMPLE][onSell] ${id} error:`, e.message); }
        }
      }
    }
  }

  // ── FIX-A reconciliation: real BUY fill → marca filled + ajusta slippage ──
  // ctx.strategyId, ctx.realSpent (USDC gastado real), ctx.realQty (asset recibido real)
  // Ejecutado DESPUÉS de que placeLiveBuy complete en Binance.
  // FIX-M2: también recomputa entryPrice/stop/target usando el precio real
  // manteniendo los mismos porcentajes originales de stop/target. Sin esto,
  // un slippage de +1% deja el stop anclado al precio estimado y el riesgo
  // real de la posición no coincide con el backtest.
  applyRealBuyFill(strategyId, {realSpent, realQty}){
    const pos = this.portfolio[strategyId];
    if(!pos){
      console.warn(`[SIMPLE][RECONCILE-BUY] ${strategyId} no existe en portfolio — skip`);
      return;
    }
    // Slippage: reservamos `pos.invest` optimista. Si real > reservado, restar extra;
    // si real < reservado, devolver sobrante a la capa.
    const expectedSpent = pos.invest;
    const drift = realSpent - expectedSpent;
    if(pos.capa===1) this.capa1Cash -= drift;
    else             this.capa2Cash -= drift;
    // FIX-M2: recomputar entryPrice/stop/target con precio real.
    // Derivamos los % originales desde el par (estimado) stop/target/entryPrice:
    //   stopPct   = 1 - stop/entryPrice
    //   targetPct = target/entryPrice - 1
    // y los reaplicamos contra el nuevo entryPrice real.
    const realPrice = (realQty > 0 && realSpent > 0) ? (realSpent / realQty) : pos.entryPrice;
    const stopPct   = 1 - (pos.stop   / pos.entryPrice);
    const targetPct = (pos.target / pos.entryPrice) - 1;
    pos.entryPrice = realPrice;
    pos.stop       = realPrice * (1 - stopPct);
    pos.target     = realPrice * (1 + targetPct);
    pos.qty    = realQty  || pos.qty;
    pos.invest = realSpent || pos.invest;
    // A4: recomputar _investWithFee tras reconcile. El fee_efectivo del
    // _feePredicted sigue vigente porque Binance no cambia de modo BNB↔USDC
    // mid-fill — siempre es el mismo mode entre predicción y fill real.
    // Si no hay predicción (legacy), cae al upper bound conservador.
    const feeEfectivoReal = (pos._feePredicted && typeof pos._feePredicted.FEE_efectivo === "number")
      ? pos._feePredicted.FEE_efectivo
      : FEE_RATE_USDC;
    pos._investWithFee = pos.invest * (1 + feeEfectivoReal);
    pos.status = "filled";
    console.log(`[SIMPLE][RECONCILE-BUY] ${strategyId} expected=$${expectedSpent.toFixed(2)} real=$${realSpent.toFixed(2)} drift=${drift>=0?"+":""}${drift.toFixed(4)} entry=$${realPrice.toFixed(4)} stop=$${pos.stop.toFixed(4)} target=$${pos.target.toFixed(4)} qty=${pos.qty.toFixed(6)}`);
  }

  // ── FIX-D reconciliation: real SELL fill → ajusta capa cash por slippage ──
  // ctx trae capa (capturado antes del delete) + realGross (USDC recibido real).
  // La SELL virtual ya añadió expectedNet a la capa; este método añade el delta.
  applyRealSellFill(strategyId, {realGross, capa, expectedNet, feeEfectivo}){
    // T0-FEE: si el caller pasa feeEfectivo (derivado de ctx._feePredicted
    // del sellCtx), usarlo. Si no se pasa (compat/legacy), caer al FEE
    // estático 0.001. En modo BNB (feeEfectivo=0) realNet = realGross porque
    // Binance paga la fee en BNB separado y el USDC recibido es íntegro.
    const fee = (typeof feeEfectivo === "number") ? feeEfectivo : FEE;
    const realNet = (realGross || 0) * (1 - fee);
    const delta = realNet - (expectedNet || 0);
    if(capa===1) this.capa1Cash += delta;
    else         this.capa2Cash += delta;
    console.log(`[SIMPLE][RECONCILE-SELL] ${strategyId} expected=$${(expectedNet||0).toFixed(2)} real=$${realNet.toFixed(2)} delta=${delta>=0?"+":""}${delta.toFixed(4)} capa${capa} fee_efectivo=${fee.toFixed(4)}`);
  }

  // ── T0-FEE: verificación post-fill de la fee pagada ────────────────────
  // Se llama desde placeLiveBuy/placeLiveSell en server.js DESPUÉS del
  // post-fill syncCapitalFromBinance (que ya ha refrescado this._bnbBalance).
  // Compara el delta real de BNB contra la predicción guardada en
  // pos._feePredicted (BUY) o sellCtx._feePredicted (SELL).
  //
  // Regla de oro: esta función NO mueve dinero, sólo lee el balance real
  // y loguea/alerta. La única fuente de verdad para BNB es Binance vía
  // syncCapitalFromBinance. Así garantizamos que el BNB jamás se resta
  // dos veces.
  //
  // Parámetros:
  //   strategyId: id de la estrategia para logs
  //   kind:       "BUY" | "SELL"
  //   predicted:  objeto _feePredicted original con bnbBalancePre + expectedBnbFee + mode
  //   telegramSend: función opcional para enviar alerta si hay mismatch
  _checkFeeDiscrepancy(strategyId, kind, predicted, telegramSend) {
    if (!predicted || typeof predicted !== "object") {
      console.warn(`[SIMPLE][FEE] ${strategyId} ${kind} sin predicción — skip verificación`);
      return { ok: true, skipped: true };
    }
    const bnbBefore = Number(predicted.bnbBalancePre || 0);
    const bnbAfter  = Number(this._bnbBalance || 0);
    const bnbDelta  = bnbBefore - bnbAfter; // positivo si bajó (se consumió BNB)

    if (predicted.mode === "BNB") {
      const expected = Number(predicted.expectedBnbFee || 0);
      const tolerance = Math.max(expected * 0.05, 1e-8); // 5% o epsilon mínimo
      const mismatch  = Math.abs(bnbDelta - expected) > tolerance;

      if (mismatch) {
        console.error(`[SIMPLE][FEE-DISCREPANCY] ${strategyId} ${kind} esperado=${expected.toFixed(6)} real=${bnbDelta.toFixed(6)} diff=${(bnbDelta-expected).toFixed(6)}`);
        if (typeof telegramSend === "function") {
          try {
            telegramSend(`⚠️ <b>[FEE] Discrepancia BNB</b>\n${strategyId} (${kind})\nEsperado: ${expected.toFixed(6)} BNB\nReal: ${bnbDelta.toFixed(6)} BNB\nDiferencia: ${(bnbDelta-expected).toFixed(6)} BNB`);
          } catch {}
        }
      }

      if (bnbDelta < 1e-5) {
        console.warn(`[SIMPLE][FEE] ${strategyId} ${kind} predicho BNB pero BNB no bajó (${bnbDelta.toFixed(8)}) — Binance usó USDC fallback`);
      }

      return { ok: !mismatch, mode: "BNB", expected, deltaReal: bnbDelta, mismatch };
    } else {
      // Modo USDC predicho — BNB NO debería haber bajado.
      if (bnbDelta > 1e-5) {
        console.warn(`[SIMPLE][FEE] ${strategyId} ${kind} predicho USDC pero BNB bajó ${bnbDelta.toFixed(6)}`);
      }
      return { ok: true, mode: "USDC", deltaReal: bnbDelta, mismatch: false };
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
    // ── M14: returnPct y drawdownPct contra baseline honesto ─────────────
    // Baseline = capital efectivo (lo que el bot puede usar realmente,
    // post-sync contra Binance). Fallback a INITIAL_CAPITAL si aún no hubo
    // primer sync. Antes: denominador siempre INITIAL_CAPITAL → con capital
    // real $14 vs declarado $100, el bot reportaba returnPct=-86% y
    // drawdownPct=86% desde el primer tick sin haber perdido nada.
    //
    // El baseline SE ACTUALIZA con cada syncCapitalFromBinance. Si el
    // usuario añade fondos a Binance, _capitalEfectivo sube → returnPct se
    // recalcula sobre la nueva base. Es intencional: el bot reporta "cuánto
    // he ganado/perdido sobre lo que actualmente tengo disponible".
    const baseline = this._capitalEfectivo || INITIAL_CAPITAL;
    // Track peak histórico para drawdown clásico (definición: distancia
    // desde el máximo alcanzado, no desde el capital de partida).
    if (this._peakTv === null || tv > this._peakTv) {
      this._peakTv = tv;
    }
    const returnPct = baseline > 0
      ? +((tv - baseline) / baseline * 100).toFixed(2)
      : 0;
    const drawdownPct = (this._peakTv && this._peakTv > 0)
      ? +((this._peakTv - tv) / this._peakTv * 100).toFixed(3)
      : 0;
    return{
      totalValue:tv,
      capa1Cash:this.capa1Cash,
      capa2Cash:this.capa2Cash,
      portfolio:this.portfolio,
      tick:this.tick,
      winRate:this.globalWR(),
      returnPct,
      drawdownPct,
      peakTv: this._peakTv,
      baseline: +baseline.toFixed(4),
      mode:"SIMPLE_v3_7strategies",
      // ── T0: capital dinámico ─────────────────────────────────────────
      capitalDeclarado: this._capitalDeclarado,
      capitalReal:      this._capitalReal,
      capitalEfectivo:  this._capitalEfectivo,
      usdcLibre:        this._usdcLibre,
      valorPosiciones:  this._valorPosiciones,
      capitalSync: {
        lastTs:      this._lastCapitalSyncTs,
        ok:          this._lastCapitalSyncOk,
        failCount:   this._capitalSyncFailCount,
        pausedUntil: this._capitalSyncPausedUntil,
      },
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
      paused:this.paused === true, // F2: persisted across restarts
      // ── T0: capital dinámico (se re-sincroniza al arrancar de todos modos,
      // pero persistir evita el "ventana" de 5min sin valor conocido)
      capitalReal:     this._capitalReal,
      capitalEfectivo: this._capitalEfectivo,
      usdcLibre:       this._usdcLibre,
      valorPosiciones: this._valorPosiciones,
      // ── T0-FEE: fee mode + BNB balance + latch ────────────────────────
      bnbFeeEnabled:   this._bnbFeeEnabled,
      bnbBalance:      this._bnbBalance,
      bnbLowAlertSent: this._bnbLowAlertSent,
      lastFeeMode:     this._lastFeeMode,
      // ── H6: persistir estado de capital sync entre restarts ──────────
      // Un PM2 restart durante una pausa por fallo de sync debe reanudar
      // pausado, no como si todo estuviera bien. El constructor aplica
      // Math.max con el fail-closed default de H7 al restaurar.
      capitalSyncFailCount:   this._capitalSyncFailCount   || 0,
      capitalSyncPausedUntil: this._capitalSyncPausedUntil || 0,
      lastCapitalSyncTs:      this._lastCapitalSyncTs      || 0,
      lastCapitalSyncOk:      this._lastCapitalSyncOk !== false,
      // ── C2: persistir pausa por stream-dead ──────────────────────────
      streamDeadPausedUntil:  this._streamDeadPausedUntil  || 0,
      // ── M14: peak totalValue para drawdown clásico ────────────────────
      // Sin persistir, un restart resetea el peak y el drawdownPct vuelve a 0
      // aunque el bot esté realmente en drawdown. Con persistencia, el peak
      // sobrevive PM2 restarts y las alertas de drawdown siguen siendo válidas.
      peakTv:                 this._peakTv,
    };
  }
}

module.exports={SimpleBotEngine, calcKelly, evalSignal, STRATEGIES, INITIAL_CAPITAL, FEE};
