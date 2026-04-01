// ─── RISK MANAGER v2 ──────────────────────────────────────────────────────────
"use strict";

const RISK_PROFILES = {
  conservative: { maxDailyLoss:0.03, maxPositionSize:0.25, maxOpenPositions:2,  atrMultiplier:1.5, trailingPct:0.04, minScore:70 },
  moderate:     { maxDailyLoss:0.05, maxPositionSize:0.35, maxOpenPositions:3,  atrMultiplier:3.5, trailingPct:0.06, minScore:55 },
  aggressive:   { maxDailyLoss:0.10, maxPositionSize:0.45, maxOpenPositions:5,  atrMultiplier:2.5, trailingPct:0.08, minScore:50 },
  paper:        { maxDailyLoss:1.00, maxPositionSize:0.20, maxOpenPositions:18, atrMultiplier:3.0, trailingPct:0.05, minScore:30 },
};

class CircuitBreaker {
  constructor(maxDailyLoss) {
    this.maxDailyLoss=maxDailyLoss; this.startOfDayVal=null;
    this.triggered=false; this.triggeredAt=null; this.lastResetDay=null;
  }
  reset(newValue) {
    // Hard reset: used after orphan portfolio cleanup
    this.triggered = false;
    this.triggeredAt = null;
    if(newValue) this.startOfDayVal = newValue;
    console.log("[CB] Circuit breaker reseteado manualmente");
  }
  check(currentValue) {
    const today=new Date().toDateString();
    if(this.lastResetDay!==today){this.startOfDayVal=currentValue;this.triggered=false;this.lastResetDay=today;}
    if(!this.startOfDayVal)this.startOfDayVal=currentValue;
    const drawdown=(currentValue-this.startOfDayVal)/this.startOfDayVal;
    if(!this.triggered&&drawdown<-this.maxDailyLoss){this.triggered=true;this.triggeredAt=new Date().toISOString();console.log(`[⚡ CIRCUIT BREAKER] Activado! Pérdida: ${(drawdown*100).toFixed(2)}%`);}
    return{triggered:this.triggered,drawdown,startOfDay:this.startOfDayVal,resetTime:"próxima medianoche"};
  }
}

class TrailingStop {
  constructor(){this.highs={};}
  update(symbol,currentPrice,entryPrice,trailingPct=0.06){
    if(!this.highs[symbol]||currentPrice>this.highs[symbol])this.highs[symbol]=currentPrice;
    const stopPrice=this.highs[symbol]*(1-trailingPct);
    // Solo activar trailing con minimo 2% de beneficio — evita cierres prematuros por ruido de mercado
    const profitPct=(this.highs[symbol]-entryPrice)/entryPrice;
    const trailingMin = this._learnedTrailingMin || 0.02;
    const hit=currentPrice<=stopPrice&&profitPct>=trailingMin;
    const profitLocked=((this.highs[symbol]-entryPrice)/entryPrice)*100;
    return{stopPrice,maxHigh:this.highs[symbol],hit,profitLocked};
  }
  remove(symbol){delete this.highs[symbol];}
}

function calcKellyFraction(winRate, avgWinPct, avgLossPct) {
  // Kelly Criterion: f* = WR/|avgLoss| - (1-WR)/avgWin
  // Acotado entre 0 y maxPositionSize para seguridad
  if(!winRate||!avgWinPct||!avgLossPct||avgLossPct===0) return 0.20; // default conservador
  const wr = Math.min(0.80, Math.max(0.10, winRate));
  const ratio = Math.abs(avgWinPct) / Math.abs(avgLossPct);
  const kelly = wr - (1-wr)/ratio;
  // Half-Kelly para ser conservadores (estrategia estándar en fondos)
  const halfKelly = kelly * 0.5;
  return Math.max(0.05, Math.min(0.40, halfKelly)); // entre 5% y 40%
}

function calcPositionSize(availableCash, score, atrPct, profile, nOpen, kellyData=null) {
  // Base: Kelly Criterion si tenemos suficientes datos, sino usar max% fijo
  let base;
  if(kellyData && kellyData.trades>=20) {
    const kellyFrac = calcKellyFraction(kellyData.winRate/100, kellyData.avgWin, kellyData.avgLoss);
    base = availableCash * kellyFrac;
  } else {
    base = availableCash * profile.maxPositionSize;
  }
  const scoreFactor = 0.6 + ((score-50)/50)*0.8;
  const atrFactor   = atrPct>5 ? 0.5 : atrPct>3 ? 0.75 : 1.0;
  const openFactor  = Math.max(0.4, 1 - nOpen*0.15);
  return Math.min(base, availableCash*0.50) * scoreFactor * atrFactor * openFactor;
}

class AutoOptimizer {
  constructor(){
    this.params={emaFast:9,emaSlow:21,rsiOversold:30,rsiOverbought:70,minScore:55,atrMult:3.5};
    this.history=[];this.lastOptimize=null;
    this.cooldownMs=30*60*1000; // optimizar cada 30 min en paper (más frecuente)
  }
  recordTrade(pnl,reason){this.history.push({ts:Date.now(),pnl,reason});this.history=this.history.slice(-100);}
  optimize(){
    const now=Date.now();
    if(this.lastOptimize&&now-this.lastOptimize<this.cooldownMs)return null;
    if(this.history.length<8)return null;
    this.lastOptimize=now;
    const recent=this.history.slice(-20);
    const avgPnl=recent.reduce((s,t)=>s+t.pnl,0)/recent.length;
    const wins=recent.filter(t=>t.pnl>0).length,winRate=wins/recent.length;
    const slHits=recent.filter(t=>t.reason==="STOP LOSS").length;
    let changes=[];
    if(slHits/recent.length>0.4&&this.params.atrMult<4.0){this.params.atrMult=+(this.params.atrMult+0.25).toFixed(2);changes.push(`ATR→${this.params.atrMult}`);}
    if(winRate<0.4&&this.params.minScore<72){this.params.minScore=Math.min(72,this.params.minScore+2);changes.push(`score→${this.params.minScore}`);}
    if(winRate>0.6&&this.params.minScore>50){this.params.minScore=Math.max(50,this.params.minScore-1);changes.push(`score→${this.params.minScore}`);}
    if(avgPnl<-3&&this.params.emaFast<14){this.params.emaFast=Math.min(14,this.params.emaFast+1);this.params.emaSlow=Math.min(30,this.params.emaSlow+2);changes.push(`EMA→${this.params.emaFast}/${this.params.emaSlow}`);}
    const result={ts:new Date().toISOString(),avgPnl:+avgPnl.toFixed(2),winRate:+(winRate*100).toFixed(0),slHits,changes,params:{...this.params}};
    if(changes.length>0)console.log(`[🧠 OPTIMIZER] ${changes.join(", ")} | WR:${result.winRate}% avgPnl:${avgPnl.toFixed(2)}%`);
    return result;
  }
  getParams(){return this.params;}
  applyParams(p){Object.assign(this.params,p);console.log("[Optimizer] Params aplicados desde sync:",this.params);}
}

module.exports={RISK_PROFILES,CircuitBreaker,TrailingStop,calcPositionSize,AutoOptimizer};
