# cryptobot-live

## Qué hace
Bot de trading algorítmico que opera con dinero real en Binance Spot. Ejecuta 7 estrategias validadas por backtest organizadas en dos capas: Capa 1 (corto plazo, 30m/1h) y Capa 2 (medio plazo, 4h/1d). Cada estrategia tiene su propio Kelly Gate rolling que controla si puede operar basándose en su win rate reciente.

El bot recibe precios en tiempo real de Binance via WebSocket, construye velas OHLC internamente, y evalúa señales solo al cierre de cada vela (no en cada tick). Las señales pasan por un pipeline de filtros (CANDLE_MIN, Kelly Gate, correlación entre pares, volatilidad ATR) antes de ejecutar una orden. El sizing usa Half-Kelly con cap del 30% del capital.

Puede operar en modo PAPER-LIVE (simula trades sin ejecutar órdenes reales) o LIVE (ejecuta órdenes reales en Binance). El modo se controla con la variable LIVE_MODE.

## Estrategias validadas

### Capa 1 — Corto plazo (60% del capital)
| ID | Par | Timeframe | Tipo | Kelly | PF | WR |
|----|-----|-----------|------|-------|-----|-----|
| BNB_1h_RSI | BNBUSDC | 1h | RSI_MR_ADX | 0.164 | 1.59 | ~58% |
| SOL_1h_EMA | SOLUSDC | 1h | EMA_CROSS | 0.100 | 1.33 | ~54% |
| BTC_30m_RSI | BTCUSDC | 30m | RSI_MR_ADX | 0.095 | 1.31 | ~55% |
| BTC_30m_EMA | BTCUSDC | 30m | EMA_CROSS | 0.078 | 1.25 | ~52% |

### Capa 2 — Medio plazo (40% del capital)
| ID | Par | Timeframe | Tipo | Kelly | PF | WR |
|----|-----|-----------|------|-------|-----|-----|
| XRP_4h_EMA | XRPUSDC | 4h | EMA_CROSS | 0.155 | 1.55 | ~56% |
| SOL_4h_EMA | SOLUSDC | 4h | EMA_CROSS | 0.070 | 1.23 | ~53% |
| BNB_1d_T200 | BNBUSDC | 1d | TREND_200 | 0.074 | 1.24 | ~54% |

## Pipeline de evaluación
```
Binance WS → updatePrice() → barStart > bar.start → _onCandleClose()
  → CANDLE_MIN check (50 velas mín para 30m/1h/4h, 200 para 1d)
  → Portfolio check (no duplicar posición por estrategia)
  → Kelly Gate (negative && n >= 10 → bloquear)
  → evalSignal() → RSI_MR_ADX / EMA_CROSS / TREND_200
  → Correlation check (máx 2 posiciones por grupo correlacionado)
  → ATR filter (volatilidad > percentil 20)
  → Position sizing (Half-Kelly, cap 30% capital, mín $10)
  → BUY order
```

## Filtros activos
- **Kelly Gate**: por estrategia, rolling window 30 trades. Seedeado con WR backtestado al arrancar.
- **Correlación**: máx 2 posiciones simultáneas por grupo (BTC_GROUP, MAJOR_ALT, MID_CAP).
- **ATR**: no opera si volatilidad está en el percentil más bajo (< 20).
- **CANDLE_MIN**: requiere mínimo 50 velas históricas (200 para 1d) antes de evaluar.

## Sizing
```
kellyFrac = max(0.05, min(0.5, kelly))
invest = totalValue * kellyFrac * 0.5   // Half-Kelly
if (invest > totalValue * 0.30) invest = totalValue * 0.30
if (invest > availCash) invest = availCash
if (invest < 10) skip  // mínimo Binance
```
Para $100 capital con kelly=0.325: invest ~$16.

## Stack técnico
- Node.js 18+ con Express y WebSocket
- Binance WebSocket (miniTicker) para precios en tiempo real
- Binance REST API para klines históricas (prefill) y órdenes (modo LIVE)
- PostgreSQL para persistencia de estado + fallback a disco (data/state.json)
- Telegram bot para alertas y comandos (/estado, /kelly, /posiciones)
- Puerto: 3001

## Arquitectura de archivos
```
src/
  server.js          — Express server, endpoints API, inicialización
  engine.js          — Engine principal (24 pares, ML signals, Kelly Gate global)
  engine_simple.js   — SimpleBotEngine (7 estrategias validadas, pipeline completo)
  trading/loop.js    — Main tick loop (setInterval), alimenta precios a ambos engines
  trading/state.js   — Estado global compartido (S.bot, S.simpleBot)
  database.js        — PostgreSQL + fallback disco
  trade_logger.js    — Log estructurado de trades a PostgreSQL
  adaptive_learning.js — Kelly Criterion, adaptive stops, regime detection
  feeds.js           — Fear & Greed, klines históricas, indicadores on-chain
  cryptoPanic.js     — Monitor de noticias (desactivado por rate limiting)
  telegram.js        — Bot de Telegram
  market.js          — Blacklist, MarketGuard, trading score
  risk.js            — Circuit breaker, drawdown alerts
public/
  index.html         — Dashboard web (polling HTTP cada 10s + WebSocket)
```

## Variables de entorno requeridas
- `LIVE_MODE` — "true" para órdenes reales, "false" para paper (default: inferido de API keys)
- `CAPITAL_USDC` — Capital inicial del simpleBot (default: 100)
- `CAPITAL_USDT` — Capital del engine principal (default: 100)
- `BINANCE_API_KEY` — API key de Binance para precios y órdenes
- `BINANCE_API_SECRET` — API secret de Binance
- `BINANCE_SUBACCOUNT` — Sub-cuenta de Binance (opcional)
- `DATABASE_URL` — Connection string PostgreSQL
- `TELEGRAM_TOKEN` — Token del bot de Telegram
- `TELEGRAM_CHAT_ID` — Chat ID para alertas
- `PORT` — Puerto del servidor (default: 3000)
- `TICK_MS` — Intervalo del loop en ms (default: 10000)
- `SYNC_SECRET` — Secret para sincronización paper→live
- `BOT_SECRET` — Secret para endpoints protegidos
- `FX_RATE` — Tasa EUR/USD para display (default: 1.08)

## Endpoints API expuestos
- `GET /api/state` — Estado completo (portfolio, equity, trades, régimen, F&G)
- `GET /api/simple` — Estado del SimpleBotEngine (7 estrategias)
- `GET /api/health` — Health check con uptime y total value
- `GET /api/summary` — Resumen para integraciones
- `GET /api/confidence` — Score de confianza
- `GET /api/sync/history` — Historial de sincronizaciones paper→live
- `GET /api/myip` — IP pública del servidor
- `POST /api/reset-state` — Borrar estado persistido (restart limpio)
- `POST /api/sync/params` — Recibir parámetros optimizados del paper
- `POST /api/sync/daily` — Recibir métricas diarias del paper
- `POST /api/sync/transfer` — Transferir capital entre capas
- `POST /api/shadow/entry` — Paper shadow entry
- `POST /api/shadow/exit` — Paper shadow exit
- `POST /api/set-capital` — Actualizar capital via Telegram
- `POST /api/set-alert-config` — Configurar alertas

## Cómo arrancarlo
```bash
cd /root/cryptobot-live && pm2 start src/server.js --name live --update-env
```

## Rol en el ecosistema BAFIR
- Consume: parámetros del paper bot via /api/sync/params, precios de Binance
- Expone: /api/state al dashboard bafir-trading, equity via bafir-trading /api/bot/equity
- Opera: órdenes reales en Binance Spot (modo LIVE) o simuladas (modo PAPER-LIVE)
- Telegram: comandos /estado /kelly /posiciones /pausa /reanudar

## Estado actual
PAPER-LIVE. Capital $100 USDC. 0 trades. Pipeline validado end-to-end.
Listo para activar LIVE real con LIVE_MODE=true.

## Bugs conocidos
- Dashboard "Todos los pares" selector vacío (cosmético)
- Engine principal bloqueado por Kelly Gate (11 trades viejos, WR insuficiente) — intencional
- CryptoPanic desactivado por rate limiting

## Pendientes
- Activar LIVE_MODE=true cuando el usuario lo autorice
- Migrar DATABASE_URL a PostgreSQL local (en progreso)
- Limpiar logs diagnósticos verbose una vez validado en LIVE
- Añadir ATOM_1h_EMA como 8a estrategia (mencionada pero no implementada)
