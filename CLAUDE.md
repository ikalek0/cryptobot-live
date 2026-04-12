# BAFIR Trading - Master Context

## Que es BAFIR
BAFIR es una plataforma de trading algoritmico de crypto que opera con dinero real en Binance Spot. El objetivo es evolucionar hacia un SaaS donde clientes depositan capital y el sistema lo gestiona automaticamente con copy-trading proporcional. Actualmente opera con $100 USDC de capital propio como validacion.

El stack es Node.js 18+ con Express, WebSocket para datos en tiempo real de Binance, PostgreSQL para persistencia (con fallback a disco), y Telegram para alertas y comandos. Todo corre en un servidor Hetzner CX23 (IP 91.98.128.33) con PM2 como process manager.

## Filosofia y principios
- Validacion empirica antes de complejidad ML: las 8 estrategias fueron seleccionadas por backtest riguroso (70/30 OOS, fees 0.2%, minimo 100 trades)
- Half-Kelly siempre (kelly * 0.5) por seguridad — nunca Kelly completo
- Cap 30% del capital por trade, minimo $10 (limite Binance)
- Paper bot = laboratorio sin restricciones. Live bot = produccion conservadora
- Kelly Gate como circuit breaker matematico: si WR cae, el bot para automaticamente
- No operar en mercados muertos (ATR percentil < 20)
- Maximo 2 posiciones simultaneas por grupo correlacionado

## Arquitectura: 7 servicios PM2 en Hetzner CX23

### cryptobot-live (puerto 3001) — BOT DE PRODUCCION
Bot live que opera con dinero real en Binance Spot. Ejecuta 7 estrategias validadas via SimpleBotEngine. El engine principal (CryptoBotFinal) existe como contenedor de precios y estado pero su evaluate() es un no-op — no genera trades. Solo el simpleBot genera ordenes.
- Capital: $100 USDC
- Modo actual: PAPER-LIVE (LIVE_MODE=false)
- Persistencia: disco (data/state.json), PostgreSQL local pendiente

### cryptobot-paper (puerto 3002) — LABORATORIO ML
Bot paper con stack completo de ML: DQN, MultiAgent por regimen, StrategyEvaluator, PatternMemory, CounterfactualMemory. Opera con $50,000 virtual para optimizar parametros agresivamente. Exporta parametros al live cuando superan umbral durante 7 dias.

### cryptobot-test (puerto 3003) — BASELINE A/B
Bot rule-based sin ML para comparacion A/B contra paper. Si test > paper en WR, el ML no aporta valor. Capital virtual $50,000.

### bafir-trading (puerto 3000) — ADMIN DASHBOARD
Dashboard administrativo central. Gestiona clientes, depositos, retiros, distribuciones. Portal admin con 2FA, portal cliente, deteccion automatica de depositos en Binance, copy-trading.

### bafir-sentiment (puerto 3004) — SENTIMENT SCORE
Score compuesto de 8 indicadores: Fear & Greed, Long/Short Ratio, Funding Rate, Open Interest, Liquidaciones, Dominancia BTC, Coinbase Premium, flujos de exchanges.

### bafir-arbitrage (puerto 3005) — MONITOR SPREADS
Monitor pasivo de oportunidades de arbitraje crypto entre Binance, Coinbase y Kraken. No ejecuta trades — solo reporta spreads significativos.

### bafir-deals (puerto 3006) — RETAIL ARBITRAGE
Scraping de precios en Amazon/Decathlon/PCComponentes vs Wallapop/Vinted/Leboncoin. Detecta oportunidades de arbitraje retail. Independiente del ecosistema crypto.

## Las 8 estrategias validadas

### Capa 1 — Corto plazo (60% del capital)
| ID | Par | TF | Tipo | Kelly | PF | WR | OOS trades |
|----|-----|-----|------|-------|-----|-----|------------|
| BNB_1h_RSI | BNBUSDC | 1h | RSI_MR_ADX | 0.164 | 1.59 | ~58% | 113 |
| SOL_1h_EMA | SOLUSDC | 1h | EMA_CROSS | 0.100 | 1.33 | ~54% | 175 |
| BTC_30m_RSI | BTCUSDC | 30m | RSI_MR_ADX | 0.095 | 1.31 | ~55% | 111 |
| BTC_30m_EMA | BTCUSDC | 30m | EMA_CROSS | 0.078 | 1.25 | ~52% | 166 |

### Capa 2 — Medio plazo (40% del capital)
| ID | Par | TF | Tipo | Kelly | PF | WR | OOS trades |
|----|-----|-----|------|-------|-----|-----|------------|
| XRP_4h_EMA | XRPUSDC | 4h | EMA_CROSS | 0.155 | 1.55 | ~56% | 71 |
| SOL_4h_EMA | SOLUSDC | 4h | EMA_CROSS | 0.070 | 1.23 | ~53% | 50 |
| BNB_1d_T200 | BNBUSDC | 1d | TREND_200 | 0.074 | 1.24 | ~54% | 102 |

Nota: ATOM_1h_EMA (PF=1.26, Kelly=0.079, 228 OOS) esta pendiente de implementar como 8a estrategia.

## Pipeline de evaluacion
```
Binance WS -> S.bot.updatePrice() -> S.bot.prices
  -> loop.js -> S.simpleBot.updatePrice(sym, price)
    -> normaliza USDT->USDC (SOLUSDT -> SOLUSDC)
    -> barStart > bar.start -> _onCandleClose(cfg, key)
      -> CANDLE_MIN check (50 para 30m/1h/4h, 200 para 1d)
      -> Portfolio check (no duplicar posicion por estrategia)
      -> Kelly Gate (negative && n >= 10 -> bloquear)
      -> evalSignal() -> RSI_MR_ADX / EMA_CROSS / TREND_200
      -> Correlation check (max 2 por grupo)
      -> ATR filter (volatilidad > percentil 20)
      -> Position sizing (Half-Kelly, cap 30%, min $10)
      -> BUY order (solo si LIVE_MODE=true)
```

## Filtros de riesgo activos
- **Kelly Gate**: por estrategia, rolling window 30 trades. Seedeado con WR backtestado al arrancar. Se auto-reemplaza con trades reales.
- **Correlacion**: max 2 posiciones simultaneas por grupo:
  - BTC_GROUP: BTCUSDC
  - MAJOR_ALT: ETHUSDC, SOLUSDC, BNBUSDC
  - MID_CAP: XRPUSDC, LINKUSDC, ADAUSDC, AVAXUSDC
- **ATR**: no opera si volatilidad esta en percentil < 20
- **CANDLE_MIN**: requiere 50 velas historicas (200 para 1d) antes de evaluar
- **Stops fijos**: Capa 1 stop=0.8% target=1.6%, Capa 2 stop=3% target=6%
- **Time stop**: 48h maximo por posicion

## Sizing
```
kellyFrac = max(0.05, min(0.5, kelly))
invest = totalValue * kellyFrac * 0.5   // Half-Kelly
if (invest > totalValue * 0.30) invest = totalValue * 0.30
if (invest > availCash) invest = availCash
if (invest < 10) skip  // minimo Binance
```
Para $100 capital con kelly=0.325: invest ~$16.

## Variables de entorno requeridas (.env)
- `LIVE_MODE` — "true" para ordenes reales, "false" para paper
- `CAPITAL_USDC` — Capital inicial del simpleBot (default: 100)
- `CAPITAL_USDT` — Capital del engine principal (default: 100)
- `BINANCE_API_KEY` — API key de Binance
- `BINANCE_API_SECRET` — API secret de Binance
- `BINANCE_SUBACCOUNT` — Sub-cuenta de Binance (opcional)
- `DATABASE_URL` — Connection string PostgreSQL
- `TELEGRAM_TOKEN` — Token del bot de Telegram
- `TELEGRAM_CHAT_ID` — Chat ID para alertas
- `PORT` — Puerto del servidor (default: 3000, PM2 usa 3001)
- `TICK_MS` — Intervalo del loop en ms (default: 10000)
- `SYNC_SECRET` — Secret para sincronizacion paper->live
- `BOT_SECRET` — Secret para endpoints protegidos
- `FX_RATE` — Tasa EUR/USD para display (default: 1.08)

CRITICO: server.js usa require('dotenv') al principio. Sin esto, NINGUNA variable se carga y el bot opera con defaults incorrectos (capital $10000, API keys vacias, LIVE_MODE=false).

## Arquitectura de archivos
```
src/
  server.js          — Express server, endpoints API, inicializacion, dotenv
  engine.js          — CryptoBotFinal (evaluate es no-op, solo contenedor de precios/estado)
  engine_simple.js   — SimpleBotEngine (7 estrategias validadas, pipeline completo)
  trading/loop.js    — Main tick loop (setInterval), alimenta precios a ambos engines
  trading/state.js   — Estado global compartido (S.bot, S.simpleBot)
  database.js        — PostgreSQL + fallback disco (data/state.json)
  trade_logger.js    — Log estructurado de trades a PostgreSQL
  adaptive_learning.js — Kelly Criterion, adaptive stops, regime detection
  feeds.js           — Fear & Greed, klines historicas, indicadores on-chain
  cryptoPanic.js     — Monitor de noticias (DESACTIVADO por rate limiting)
  telegram.js        — Bot de Telegram (/estado /kelly /posiciones /pausa)
  market.js          — Blacklist, MarketGuard, trading score
  risk.js            — Circuit breaker, drawdown alerts
  clientManager.js   — Copy trading a clientes (BAFIR desactivado)
  live_features_patch.js — Features avanzadas del engine viejo (no usadas por simpleBot)
public/
  index.html         — Dashboard web (HTTP polling cada 10s + WebSocket como plus)
data/
  state.json         — Persistencia en disco (fallback cuando PostgreSQL no disponible)
```

## Endpoints API principales
- `GET /api/state` — Estado completo (portfolio, equity, trades, regimen, F&G)
- `GET /api/simple` — Estado del SimpleBotEngine (7 estrategias)
- `GET /api/health` — Health check con uptime y total value
- `GET /api/summary` — Resumen para integraciones
- `GET /api/confidence` — Score de confianza
- `POST /api/reset-state` — Borrar estado persistido (restart limpio)
- `POST /api/sync/params` — Recibir parametros optimizados del paper
- `POST /api/set-capital` — Actualizar capital via Telegram

## Comandos criticos

### Deploy de cambios
```bash
cd /root/cryptobot-live
git fetch origin && git reset --hard origin/main
npm install
pm2 stop live && pm2 delete live
pm2 start src/server.js --name live --update-env
```
IMPORTANTE: usar pm2 delete + start, no solo restart. PM2 cachea env vars.

### Cambiar PAPER-LIVE a LIVE
```bash
nano /root/cryptobot-live/.env  # cambiar LIVE_MODE=false a LIVE_MODE=true
pm2 stop live && pm2 delete live
cd /root/cryptobot-live && pm2 start src/server.js --name live --update-env
```

### Verificacion rapida
```bash
pm2 logs live --lines 30 --nostream 2>&1 | grep -E "BOOT|SIMPLE|error"
curl -s http://localhost:3001/api/health
curl -s http://localhost:3001/api/simple -o /tmp/s.json && python3 -c "import json;d=json.load(open('/tmp/s.json'));print('capital:',round(d['totalValue'],2),'trades:',len([l for l in d['log'] if l['type']=='SELL']),'positions:',list(d['portfolio'].keys()))"
```

### Pausa de emergencia
```bash
# Via Telegram: enviar /pausa al bot
# Via PM2:
pm2 stop live
```

## Bugs y lecciones criticas (sesion abril 2026)

### dotenv no estaba instalado
Sin dotenv, TODAS las env vars son undefined. API keys vacias, LIVE_MODE=false por default, capital $10000 en vez de $100. SIEMPRE verificar que dotenv esta en package.json y require('dotenv') al principio de server.js.

### Engine viejo generaba trades no autorizados
CryptoBotFinal.evaluate() generaba BUYs en 24 pares con stops de 0.03% y hasta 15 posiciones. Si LIVE_MODE=true, ejecutaria ordenes reales en Binance. Solucion: evaluate() convertido a no-op. Backup en rama `backup-engine-viejo`.

### USDT/USDC mismatch
Binance streams SOLUSDT (liquido) pero estrategias usan SOLUSDC. Sin normalizacion, las velas nunca se acumulaban. Fix: updatePrice() normaliza USDT->USDC.

### Sizing $1500 en cuenta de $100
INITIAL_CAPITAL defaulteaba a 10000 cuando CAPITAL_USDC no estaba en env (porque dotenv no cargaba). Fix: fallback chain CAPITAL_USDC -> CAPITAL_USDT -> 100.

### Velas no cerraban tras restart
Prefill cargaba 250 klines pero no inicializaba _curBar. Cada restart necesitaba 30min+ de warmup. Fix: pop ultima kline como curBar.

### Variables undefined en engine.js
_holdH, institutionalBoost, flowBoost, reserveBoost se usaban sin declarar. Crasheaban evaluate() en cada tick. Fix: declarar como const = 1.0 (ahora irrelevante con no-op).

### CryptoPanic rate-limited
API gratuita devuelve HTML en vez de JSON cuando rate-limited. Habia 3 fetchers distintos (cryptoPanic.js, feeds.js, live_features_patch.js). Solucion: cryptoPanic.start() desactivado.

### PM2 cachea env vars
pm2 restart NO recarga .env. Solo pm2 delete + start recarga las variables. Esto causaba que cambios en .env no se aplicaran.

## Estado actual (abril 2026)
- Capital: $100 USDC
- Modo: PAPER-LIVE (LIVE_MODE=false)
- Trades: 0 (esperando primera senal)
- Posiciones abiertas: 0
- Pipeline: validado end-to-end (CANDLE -> EVAL -> KELLY -> SIGNAL)
- 0 errores en logs
- Listo para activar LIVE real
