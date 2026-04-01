// multiAgent.js — Sistema multi-agente especializado por régimen de mercado
// Cada agente tiene su propio DQN y PatternMemory especializada
// Solo aprende cuando opera en su régimen, por lo que aprende MÁS RÁPIDO

const { DQN } = require("./dqn");

class RegimeAgent {
  constructor(regime, options={}) {
    this.regime = regime;
    this.dqn = new DQN({ lr:0.001, gamma:0.95, epsilon:0.20, ...options });
    this.trades = 0;
    this.wins = 0;
    this.totalPnl = 0;
    this.active = false; // true cuando es el régimen actual
    // Estadísticas de aprendizaje
    this.learningCurve = []; // [{step, loss, wr}]
  }

  get winRate() { return this.trades>0 ? Math.round(this.wins/this.trades*100) : 0; }
  get avgPnl()  { return this.trades>0 ? +(this.totalPnl/this.trades).toFixed(2) : 0; }

  recordTrade(pnl) {
    this.trades++;
    if(pnl>0) this.wins++;
    this.totalPnl+=pnl;
  }

  // Acumula experiencia y entrena (solo cuando es el régimen activo)
  learn(stateVec, action, reward, nextVec) {
    this.dqn.remember(stateVec, action, reward, nextVec);
    if(this.dqn.replayBuffer.length >= 30) {
      const loss = this.dqn.trainBatch();
      // Guardar curva de aprendizaje cada 50 updates
      if(this.dqn.totalUpdates%50===0) {
        this.learningCurve.push({
          step:this.dqn.totalUpdates, loss:+loss.toFixed(5), wr:this.winRate
        });
        if(this.learningCurve.length>100) this.learningCurve.shift();
      }
      return loss;
    }
    return 0;
  }

  chooseAction(stateVec) { return this.dqn.chooseAction(stateVec); }
  getQValues(stateVec)   { return this.dqn.getQValues(stateVec); }

  decayEpsilon(totalTrades) { this.dqn.decayEpsilon(0.03, totalTrades); }

  getStats() {
    return {
      regime: this.regime,
      trades: this.trades,
      winRate: this.winRate,
      avgPnl: this.avgPnl,
      active: this.active,
      dqn: this.dqn.getStats(),
      learningCurve: this.learningCurve.slice(-10),
    };
  }

  toJSON() {
    return {
      regime:this.regime, trades:this.trades, wins:this.wins,
      totalPnl:this.totalPnl, dqn:this.dqn.toJSON(),
      learningCurve:this.learningCurve,
    };
  }

  loadJSON(data) {
    if(!data) return;
    this.trades=data.trades||0; this.wins=data.wins||0;
    this.totalPnl=data.totalPnl||0;
    if(data.dqn) this.dqn.loadJSON(data.dqn);
    if(data.learningCurve) this.learningCurve=data.learningCurve;
    console.log(`[AGENT-${this.regime}] Loaded: ${this.trades} trades, WR:${this.winRate}%`);
  }
}

class MultiAgentSystem {
  constructor() {
    // Cada agente tiene parámetros optimizados para su régimen
    this.agents = {
      BULL:    new RegimeAgent("BULL",    { lr:0.0008, gamma:0.97, epsilon:0.12 }), // más conservador, aprende que los ganadores siguen
      LATERAL: new RegimeAgent("LATERAL", { lr:0.001,  gamma:0.90, epsilon:0.18 }), // más exploratorio, MR es ruidoso
      BEAR:    new RegimeAgent("BEAR",    { lr:0.0015, gamma:0.85, epsilon:0.25 }), // aprende rápido, mercado cambia deprisa
      UNKNOWN: new RegimeAgent("UNKNOWN", { lr:0.001,  gamma:0.90, epsilon:0.20 }),
    };
    this.currentRegime = "UNKNOWN";
    this.regimeSwitches = 0;
  }

  // Llamar cuando cambia el régimen
  setRegime(regime) {
    if(regime !== this.currentRegime) {
      Object.values(this.agents).forEach(a=>a.active=false);
      this.regimeSwitches++;
      this.currentRegime=regime;
    }
    const agent = this.agents[regime]||this.agents.UNKNOWN;
    agent.active=true;
    return agent;
  }

  getActiveAgent() {
    return this.agents[this.currentRegime]||this.agents.UNKNOWN;
  }

  // Elige acción usando el agente especializado + consenso opcional
  chooseAction(stateVec, regime) {
    const agent = this.setRegime(regime||this.currentRegime);
    return agent.chooseAction(stateVec);
  }

  // Aprende del trade (solo el agente del régimen de entrada)
  learnFromTrade(entryRegime, stateVec, action, reward, nextVec, pnl) {
    const agent = this.agents[entryRegime]||this.agents.UNKNOWN;
    agent.recordTrade(pnl);
    return agent.learn(stateVec, action, reward, nextVec);
  }

  // Obtiene Q-values del agente activo
  getQValues(stateVec) {
    return this.getActiveAgent().getQValues(stateVec);
  }

  // Obtiene consenso de todos los agentes (para decisiones de alta confianza)
  getConsensus(stateVec) {
    const votes = { BUY:0, HOLD:0, SKIP:0 };
    Object.values(this.agents).forEach(agent => {
      if(agent.dqn.totalUpdates>20) { // solo agentes que han aprendido algo
        const action = agent.dqn.chooseAction(stateVec);
        votes[action]=(votes[action]||0)+1;
      }
    });
    const total=Object.values(votes).reduce((s,v)=>s+v,0)||1;
    return {
      votes,
      dominant: Object.entries(votes).sort((a,b)=>b[1]-a[1])[0][0],
      confidence: Math.max(...Object.values(votes))/total, // 0-1
    };
  }

  decayEpsilon(totalTrades) {
    Object.values(this.agents).forEach(a=>a.decayEpsilon(totalTrades));
  }

  getAllStats() {
    return {
      currentRegime: this.currentRegime,
      regimeSwitches: this.regimeSwitches,
      agents: Object.fromEntries(Object.entries(this.agents).map(([k,v])=>[k,v.getStats()])),
    };
  }

  toJSON() {
    return {
      currentRegime:this.currentRegime,
      regimeSwitches:this.regimeSwitches,
      agents:Object.fromEntries(Object.entries(this.agents).map(([k,v])=>[k,v.toJSON()])),
    };
  }

  loadJSON(data) {
    if(!data) return;
    this.currentRegime=data.currentRegime||"UNKNOWN";
    this.regimeSwitches=data.regimeSwitches||0;
    if(data.agents) {
      Object.entries(data.agents).forEach(([regime,agentData])=>{
        if(this.agents[regime]) this.agents[regime].loadJSON(agentData);
      });
    }
  }
}


// ── Methods needed by live engine ─────────────────────────────────────────────
MultiAgentSystem.prototype.getSignalBoost = function(symbol, regime, score) {
  const agent = this.agents[regime] || this.agents["UNKNOWN"];
  if(!agent) return 1.0;
  // Boost based on how well this agent has performed in this regime
  const stats = agent.getStats ? agent.getStats() : null;
  if(!stats || stats.totalTrades < 10) return 1.0;
  const wr = stats.winRate || 0.5;
  // 0.8x if performing badly, 1.0x neutral, 1.2x if performing well
  return Math.max(0.7, Math.min(1.3, 0.8 + wr * 0.8));
};

MultiAgentSystem.prototype.serialize = function() {
  const data = {};
  for(const [regime, agent] of Object.entries(this.agents)) {
    data[regime] = agent.serialize ? agent.serialize() : null;
  }
  return data;
};

MultiAgentSystem.prototype.restore = function(data) {
  if(!data) return;
  for(const [regime, agentData] of Object.entries(data)) {
    if(this.agents[regime] && agentData && this.agents[regime].restore) {
      this.agents[regime].restore(agentData);
    }
  }
};

module.exports = { MultiAgentSystem, RegimeAgent };
