// dqn.js — Deep Q-Network implementado en Node.js puro (sin dependencias externas)
// Arquitectura: 8 inputs → 64 ReLU → 32 ReLU → 3 outputs (BUY, HOLD, SKIP)

class Matrix {
  constructor(rows, cols, data=null) {
    this.rows = rows; this.cols = cols;
    this.data = data || Array.from({length:rows}, ()=>new Float32Array(cols));
  }
  static zeros(r,c) { return new Matrix(r,c); }
  static random(r,c,scale=0.1) {
    const m = new Matrix(r,c);
    // Xavier initialization
    const std = Math.sqrt(2.0 / (r + c)) * scale;
    for(let i=0;i<r;i++) for(let j=0;j<c;j++) m.data[i][j]=(Math.random()*2-1)*std;
    return m;
  }
  dot(other) {
    if(this.cols!==other.rows) throw new Error(`Dim mismatch: ${this.rows}x${this.cols} · ${other.rows}x${other.cols}`);
    const result = Matrix.zeros(this.rows, other.cols);
    for(let i=0;i<this.rows;i++)
      for(let k=0;k<this.cols;k++) if(this.data[i][k]!==0)
        for(let j=0;j<other.cols;j++) result.data[i][j]+=this.data[i][k]*other.data[k][j];
    return result;
  }
  addBias(bias) {
    const result = Matrix.zeros(this.rows, this.cols);
    for(let i=0;i<this.rows;i++) for(let j=0;j<this.cols;j++) result.data[i][j]=this.data[i][j]+bias.data[0][j];
    return result;
  }
  relu() {
    const r=Matrix.zeros(this.rows,this.cols);
    for(let i=0;i<this.rows;i++) for(let j=0;j<this.cols;j++) r.data[i][j]=Math.max(0,this.data[i][j]);
    return r;
  }
  reluGrad() {
    const r=Matrix.zeros(this.rows,this.cols);
    for(let i=0;i<this.rows;i++) for(let j=0;j<this.cols;j++) r.data[i][j]=this.data[i][j]>0?1:0;
    return r;
  }
  multiply(other) { // element-wise
    const r=Matrix.zeros(this.rows,this.cols);
    for(let i=0;i<this.rows;i++) for(let j=0;j<this.cols;j++) r.data[i][j]=this.data[i][j]*other.data[i][j];
    return r;
  }
  subtract(other) {
    const r=Matrix.zeros(this.rows,this.cols);
    for(let i=0;i<this.rows;i++) for(let j=0;j<this.cols;j++) r.data[i][j]=this.data[i][j]-other.data[i][j];
    return r;
  }
  scale(s) {
    const r=Matrix.zeros(this.rows,this.cols);
    for(let i=0;i<this.rows;i++) for(let j=0;j<this.cols;j++) r.data[i][j]=this.data[i][j]*s;
    return r;
  }
  T() { // transpose
    const r=Matrix.zeros(this.cols,this.rows);
    for(let i=0;i<this.rows;i++) for(let j=0;j<this.cols;j++) r.data[j][i]=this.data[i][j];
    return r;
  }
  max() { return Math.max(...this.data.flatMap(r=>[...r])); }
  argmax() {
    let best=0,bestVal=this.data[0][0];
    for(let j=1;j<this.cols;j++) if(this.data[0][j]>bestVal){bestVal=this.data[0][j];best=j;}
    return best;
  }
  toArray() { return [...this.data[0]]; }
  clip(min,max) {
    const r=Matrix.zeros(this.rows,this.cols);
    for(let i=0;i<this.rows;i++) for(let j=0;j<this.cols;j++) r.data[i][j]=Math.max(min,Math.min(max,this.data[i][j]));
    return r;
  }
}

class DQN {
  constructor({ lr=0.001, gamma=0.95, epsilon=0.15, inputSize=8, hiddenSize=64, hiddenSize2=32 }={}) {
    this.lr = lr;
    this.gamma = gamma;
    this.epsilon = epsilon;
    this.actions = ["BUY","HOLD","SKIP"];
    this.inputSize = inputSize;

    // Network weights (Xavier init)
    this.W1 = Matrix.random(inputSize, hiddenSize);
    this.b1 = Matrix.zeros(1, hiddenSize);
    this.W2 = Matrix.random(hiddenSize, hiddenSize2);
    this.b2 = Matrix.zeros(1, hiddenSize2);
    this.W3 = Matrix.random(hiddenSize2, 3);
    this.b3 = Matrix.zeros(1, 3);

    // Target network (copy of main, updated less frequently for stability)
    this._targetW1 = null; this._targetW2 = null; this._targetW3 = null;
    this._targetB1 = null; this._targetB2 = null; this._targetB3 = null;
    this._targetUpdateFreq = 100; this._trainSteps = 0;

    // Experience replay
    this.replayBuffer = [];
    this.replayBufferSize = 500;
    this.batchSize = 32;
    this.minReplaySize = 50;

    // Stats
    this.totalUpdates = 0;
    this.avgLoss = 0;

    this._initTargetNetwork();
  }

  _initTargetNetwork() {
    this._copyWeightsToTarget();
  }

  _copyWeightsToTarget() {
    this._targetW1 = this._copyMatrix(this.W1);
    this._targetW2 = this._copyMatrix(this.W2);
    this._targetW3 = this._copyMatrix(this.W3);
    this._targetB1 = this._copyMatrix(this.b1);
    this._targetB2 = this._copyMatrix(this.b2);
    this._targetB3 = this._copyMatrix(this.b3);
  }

  _copyMatrix(m) {
    const copy = new Matrix(m.rows, m.cols);
    for(let i=0;i<m.rows;i++) copy.data[i]=new Float32Array(m.data[i]);
    return copy;
  }

  // ── Encode market state as input vector (normalized 0-1) ───────────────────
  encodeState({ rsi=50, bbZone="mid", regime="LATERAL", trend="neutral",
                volumeRatio=1, atrLevel=1, fearGreed=50, lsRatio=1 }={}) {
    const rsiN = rsi/100;
    const bbN = {below_lower:0.1, lower_half:0.3, upper_half:0.7, above_upper:0.9}[bbZone]||0.5;
    const regN = {BULL:1.0, LATERAL:0.5, BEAR:0.0, UNKNOWN:0.5}[regime]||0.5;
    const trN = {strong_up:1.0, up:0.75, neutral:0.5, down:0.25, strong_down:0.0}[trend]||0.5;
    const volN = Math.min(1, volumeRatio/3);
    const atrN = Math.min(1, atrLevel/5);
    const fgN = fearGreed/100;
    const lsN = Math.min(1, lsRatio/3);
    return [rsiN, bbN, regN, trN, volN, atrN, fgN, lsN];
  }

  // ── Forward pass ───────────────────────────────────────────────────────────
  forward(stateVec, useTarget=false) {
    const W1=useTarget?this._targetW1:this.W1, b1=useTarget?this._targetB1:this.b1;
    const W2=useTarget?this._targetW2:this.W2, b2=useTarget?this._targetB2:this.b2;
    const W3=useTarget?this._targetW3:this.W3, b3=useTarget?this._targetB3:this.b3;

    const input = new Matrix(1, stateVec.length, [new Float32Array(stateVec)]);
    const h1 = input.dot(W1).addBias(b1).relu();
    const h2 = h1.dot(W2).addBias(b2).relu();
    const out = h2.dot(W3).addBias(b3); // linear output (Q-values)
    return { out, h1, h2, input };
  }

  // ── Choose action (epsilon-greedy) ────────────────────────────────────────
  chooseAction(stateVec) {
    if(Math.random() < this.epsilon) {
      return this.actions[Math.floor(Math.random()*3)];
    }
    const { out } = this.forward(stateVec);
    return this.actions[out.argmax()];
  }

  getQValues(stateVec) {
    const { out } = this.forward(stateVec);
    return { BUY:out.data[0][0], HOLD:out.data[0][1], SKIP:out.data[0][2] };
  }

  // ── Store experience ───────────────────────────────────────────────────────
  remember(state, action, reward, nextState, done=false) {
    this.replayBuffer.push({ state, action: this.actions.indexOf(action), reward, nextState, done });
    if(this.replayBuffer.length > this.replayBufferSize) this.replayBuffer.shift();
  }

  // ── Train on batch ─────────────────────────────────────────────────────────
  trainBatch() {
    if(this.replayBuffer.length < this.minReplaySize) return 0;

    // Sample random batch
    const batch = [];
    for(let i=0;i<this.batchSize;i++) {
      batch.push(this.replayBuffer[Math.floor(Math.random()*this.replayBuffer.length)]);
    }

    let totalLoss = 0;

    for(const exp of batch) {
      const { out, h1, h2, input } = this.forward(exp.state);

      // Target Q-value using target network
      const { out:nextQ } = this.forward(exp.nextState, true);
      const maxNextQ = Math.max(...nextQ.toArray());
      const targetQ = exp.done ? exp.reward : exp.reward + this.gamma * maxNextQ;

      // Build target output (only update the action taken)
      const targets = new Matrix(1, 3, [new Float32Array(out.toArray())]);
      const oldQ = targets.data[0][exp.action];
      targets.data[0][exp.action] = Math.max(-10, Math.min(10, targetQ)); // clip
      const loss = (targets.data[0][exp.action] - oldQ) ** 2;
      totalLoss += loss;

      // Backpropagation
      // dL/dOut
      const dOut = out.subtract(targets).scale(2/this.batchSize);
      // Layer 3 gradients
      const dW3 = h2.T().dot(dOut);
      const db3 = dOut;
      // Layer 2 gradients
      const dh2 = dOut.dot(this.W3.T()).multiply(h2.reluGrad());
      const dW2 = h1.T().dot(dh2);
      const db2 = dh2;
      // Layer 1 gradients
      const dh1 = dh2.dot(this.W2.T()).multiply(h1.reluGrad());
      const dW1 = input.T().dot(dh1);
      const db1 = dh1;

      // SGD update with gradient clipping
      const clip = (m,v) => m.clip(-v,v);
      const update = (W,dW,b,db) => {
        for(let i=0;i<W.rows;i++) for(let j=0;j<W.cols;j++) {
          W.data[i][j] -= this.lr * Math.max(-1,Math.min(1, dW.data[i][j]||0));
        }
        for(let j=0;j<b.cols;j++) b.data[0][j] -= this.lr * Math.max(-1,Math.min(1, db.data[0][j]||0));
      };
      update(this.W3,dW3,this.b3,db3);
      update(this.W2,dW2,this.b2,db2);
      update(this.W1,dW1,this.b1,db1);
    }

    this._trainSteps++;
    this.totalUpdates++;
    this.avgLoss = 0.95*this.avgLoss + 0.05*(totalLoss/batch.length);

    // Update target network periodically
    if(this._trainSteps % this._targetUpdateFreq === 0) {
      this._copyWeightsToTarget();
    }

    return totalLoss / batch.length;
  }

  decayEpsilon(minEpsilon=0.03, totalTrades=0) {
    const factor = totalTrades > 500 ? 0.999 : 0.9995;
    const minE = totalTrades > 500 ? 0.03 : totalTrades > 200 ? 0.05 : 0.08;
    this.epsilon = Math.max(minE, this.epsilon * factor);
  }

  getStats() {
    return {
      epsilon: +this.epsilon.toFixed(3),
      totalUpdates: this.totalUpdates,
      replaySize: this.replayBuffer.length,
      avgLoss: +this.avgLoss.toFixed(6),
      trainSteps: this._trainSteps,
    };
  }

  toJSON() {
    const serMatrix = m => m.data.map(r=>[...r]);
    return {
      W1:serMatrix(this.W1), b1:serMatrix(this.b1),
      W2:serMatrix(this.W2), b2:serMatrix(this.b2),
      W3:serMatrix(this.W3), b3:serMatrix(this.b3),
      epsilon:this.epsilon, replayBuffer:this.replayBuffer.slice(-200),
      totalUpdates:this.totalUpdates, avgLoss:this.avgLoss,
    };
  }

  loadJSON(data) {
    if(!data) return;
    const loadMatrix = (rows,cols,arr) => {
      const m = new Matrix(rows,cols);
      if(arr) arr.forEach((r,i)=>{ m.data[i]=new Float32Array(r); });
      return m;
    };
    if(data.W1) this.W1 = loadMatrix(this.inputSize,64,data.W1);
    if(data.b1) this.b1 = loadMatrix(1,64,data.b1);
    if(data.W2) this.W2 = loadMatrix(64,32,data.W2);
    if(data.b2) this.b2 = loadMatrix(1,32,data.b2);
    if(data.W3) this.W3 = loadMatrix(32,3,data.W3);
    if(data.b3) this.b3 = loadMatrix(1,3,data.b3);
    if(data.epsilon !== undefined) this.epsilon = data.epsilon;
    if(data.replayBuffer) this.replayBuffer = data.replayBuffer;
    if(data.totalUpdates) this.totalUpdates = data.totalUpdates;
    if(data.avgLoss) this.avgLoss = data.avgLoss;
    this._copyWeightsToTarget();
    console.log(`[DQN] Loaded: ${this.totalUpdates} updates, epsilon=${this.epsilon.toFixed(3)}, loss=${this.avgLoss.toFixed(6)}`);
  }
}

module.exports = { DQN };
