# BAFIR Trading - Decision Log

## D001: Validacion empirica antes de ML
**Contexto:** El bot paper tiene stack completo de ML (DQN, MultiAgent, StrategyEvaluator) pero el live necesita operar con dinero real.
**Opciones:** A) Activar ML en live. B) Usar solo estrategias validadas por backtest.
**Decision:** B — Solo estrategias backtestadas en live.
**Razon:** ML no demostrado con dinero real. Las 8 estrategias tienen 50-228 OOS trades con PF > 1.2. Evidencia empirica > complejidad teorica.

## D002: Half-Kelly en lugar de Kelly completo
**Contexto:** Kelly Criterion da el tamaño optimo de posicion pero asume precision perfecta en los parametros estimados.
**Opciones:** A) Kelly completo. B) Half-Kelly (kelly * 0.5). C) Quarter-Kelly.
**Decision:** B — Half-Kelly.
**Razon:** Errores de estimacion en WR y R amplifican el riesgo. Half-Kelly reduce varianza un 75% sacrificando solo 25% de crecimiento esperado.

## D003: Cap 30% por trade, minimo $10
**Contexto:** Incluso con Half-Kelly, un kelly alto podria invertir demasiado en un solo trade.
**Opciones:** A) Sin cap. B) Cap 30%. C) Cap 20%.
**Decision:** B — Cap 30%, minimo $10.
**Razon:** 30% permite trades significativos con capital bajo ($100) sin sobreexponer. $10 es el minimo de Binance Spot.

## D004: Migracion Railway a Hetzner CX23
**Contexto:** Railway incremento precios y la BD se perdio. Los 7 servicios necesitan servidor dedicado.
**Opciones:** A) Seguir en Railway. B) Hetzner CX23 ($5/mes). C) AWS/GCP.
**Decision:** B — Hetzner CX23.
**Razon:** $5/mes para 2 vCPU, 4GB RAM, 40GB disco. Suficiente para 7 servicios Node.js. PostgreSQL local elimina dependencia externa.

## D005: Kelly Gates separados engine principal vs simpleBot
**Contexto:** El engine principal y el simpleBot son sistemas independientes con metricas diferentes. El engine principal tiene 11 trades viejos con WR bajo.
**Opciones:** A) Kelly Gate compartido. B) Separados con seeds independientes.
**Decision:** B — Separados.
**Razon:** El simpleBot tiene estrategias backtestadas con WR conocido. Seedear su Kelly con datos reales de backtest permite operar desde el primer dia. El engine principal debe acumular WR real organicamente.

## D006: PAPER-LIVE como modo de validacion
**Contexto:** Antes de operar con dinero real, necesitamos validar el pipeline end-to-end.
**Opciones:** A) Activar LIVE directamente. B) Validar en PAPER-LIVE primero.
**Decision:** B — PAPER-LIVE primero.
**Razon:** Detectamos bugs criticos en PAPER-LIVE (sizing $1500, engine viejo activo, USDT/USDC mismatch) que habrian causado perdidas reales.

## D007: dotenv como dependencia obligatoria
**Contexto:** PM2 no carga archivos .env automaticamente. Sin dotenv, todas las variables de entorno son undefined.
**Opciones:** A) Pasar env vars como flags de PM2. B) Usar dotenv. C) Usar ecosystem.config.js.
**Decision:** B — dotenv con require al principio de server.js.
**Razon:** Simple, universal, funciona igual en local y en PM2. Se aplico a los 7 servicios.

## D008: Engine viejo (evaluate) convertido a no-op
**Contexto:** CryptoBotFinal.evaluate() generaba trades en 24 pares con stops de 0.03%. Si LIVE_MODE=true, ejecutaria ordenes reales no autorizadas.
**Opciones:** A) Eliminar engine.js completamente. B) Reparar bugs y mantener desconectado. C) Hacer evaluate() no-op.
**Decision:** C — No-op.
**Razon:** S.bot tiene 67 referencias en server.js incluyendo pipeline de ordenes reales, verificacion de balance, y endpoints API. Eliminarlo requeria reescribir ~200 lineas del sistema de ordenes justo antes de activar LIVE. El no-op es 3 lineas de cambio con 0 riesgo. Backup en rama `backup-engine-viejo`.

## D009: 7 estrategias seleccionadas tras backtesting
**Contexto:** De decenas de combinaciones par/timeframe/tipo, solo 7 pasaron los filtros: PF > 1.2, OOS trades > 50, Kelly > 0.
**Decision:** 4 Capa 1 (corto plazo 30m/1h) + 3 Capa 2 (medio plazo 4h/1d).
**Razon:** Diversificacion temporal (corto + medio plazo) y por activo (BTC, SOL, BNB, XRP). Capital split 60/40 entre capas. ATOM/1h pendiente como 8a estrategia.

## D010: Sin auto-resume en pausa Telegram
**Contexto:** El comando /pausa de Telegram detiene el trading. La pregunta es si debe auto-reanudarse despues de un tiempo.
**Decision:** No auto-resume. Solo /reanudar manual.
**Razon:** Si el usuario pausa, es por una razon. Auto-resume podria reactivar el bot en un momento peligroso.

## D011: Persistencia disco como fallback
**Contexto:** PostgreSQL de Railway dejo de funcionar. El bot necesita persistir estado entre restarts.
**Opciones:** A) Solo PostgreSQL. B) Solo disco. C) PostgreSQL con fallback a disco.
**Decision:** C — Fallback a disco (data/state.json) cuando PostgreSQL no disponible.
**Razon:** El bot no debe crashear por falta de BD. El disco es fiable en Hetzner. PostgreSQL local pendiente de instalar.

## D012: Prefill 250 klines + curBar al arrancar
**Contexto:** El simpleBot necesita 50+ velas para evaluar senales. Sin prefill, tarda 25+ horas en acumular 50 velas de 30min.
**Decision:** Fetch 250 klines de Binance REST API al arrancar. Pop ultima kline como curBar para cierre inmediato en el proximo boundary.
**Razon:** Elimina warmup de horas. La primera vela cierra en minutos despues del restart.

## D013: CryptoPanic desactivado
**Contexto:** CryptoPanic API gratuita rate-limited. Devuelve HTML en vez de JSON. Habia 3 fetchers distintos en el codigo.
**Decision:** Desactivar cryptoPanic.start() en server.js. El objeto sigue existiendo para compatibilidad.
**Razon:** No es critico para trading. Las estrategias backtestadas no usan noticias como input.
