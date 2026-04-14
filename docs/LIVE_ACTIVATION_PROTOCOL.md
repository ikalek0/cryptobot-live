# LIVE Activation Protocol — cryptobot-live

Protocolo obligatorio para activar `LIVE_MODE=true` en producción.
No saltarse ningún paso. Cada fase debe completarse con éxito antes de
pasar a la siguiente.

Bot objetivo: PM2 process `live` en Hetzner CX23 (91.98.128.33), puerto 3001.
Capital actual declarado: `$100 USDC`.

---

## Fase 0 — Contexto

El bot tiene dos modos:

- `LIVE_MODE=false` (PAPER-LIVE): ejecuta todo el pipeline (prices,
  velas, signals, Kelly, cap, sizing) pero **NO envía órdenes a Binance**.
  El callback `_onBuy` marca la posición como `filled` directamente.
  Es el modo actual.
- `LIVE_MODE=true` (LIVE): cada BUY dispara `placeLiveBuy` que envía un
  `MARKET` order a Binance (o TWAP en 3 partes si el par es ilíquido) y
  reconcilia los fills reales con `applyRealBuyFill`. Dinero real.

Regla crítica: **el bot nunca usa más de `CAPITAL_USDT` declarado en `.env`**.
Si Binance tiene más dinero, el resto es invisible (T0 capital dinámico).

---

## Fase 1 — Pre-checks (ALL must pass)

Ejecutar uno por uno y confirmar manualmente:

```bash
ssh root@91.98.128.33
cd /root/cryptobot-live

# 1. git limpio y actualizado
git fetch origin
git status                       # debe ser "working tree clean"
git log --oneline -5             # verificar el HEAD esperado

# 2. PM2 vivo
pm2 list                         # live debe estar "online"
pm2 logs live --lines 30 --nostream | grep -E "error|ERROR|crash" # vacío

# 3. tests pasando
npm test 2>&1 | tail -10         # # fail 0

# 4. balance Binance real
node scripts/check-balance.js    # USDC libre >= CAPITAL_USDT * 0.9

# 5. invariantes del simpleBot
curl -s http://localhost:3001/api/simpleBot/state | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['capViolation']==False, 'CAP VIOLATION'
assert d['capitalSync']['ok']==True, 'CAPITAL SYNC FAIL'
assert d['capitalSync']['pausedNow']==False, 'SYNC PAUSED'
assert d['capitalEfectivo']<=d['capitalDeclarado'], 'EFECTIVO>DECLARADO'
print('OK capitalEfectivo=',d['capitalEfectivo'],'capa1=',d['capa1Cash'],'capa2=',d['capa2Cash'])
"

# 6. health
curl -s http://localhost:3001/api/health | python3 -m json.tool
# tv > 0, uptime > 300

# 7. telegram activo
# Desde el móvil: enviar /estado al bot → debe responder en <10s
```

**Si cualquier check falla → abortar. Investigar y volver a Fase 1.**

---

## Fase 2 — Decisión sobre posiciones huérfanas

Del incidente del 12 abril quedaron posiciones (SOL, XRP) que el simpleBot
**no gestiona** (no están en `this.portfolio`). Con T0 estas NO cuentan
como capital del bot: el bot opera sólo con `usdc_libre` + MTM de
posiciones propias.

Opciones antes de activar LIVE:

- **A (recomendada)**: cerrar manualmente en Binance las posiciones del
  incidente. Así el USDC libre recupera su valor y el bot tiene margen
  para operar.
- **B**: dejarlas y operar con el USDC libre restante. El bot verá
  `capitalReal < capitalDeclarado` y operará con el menor de los dos.
  Menos capital disponible pero sin tocar las posiciones.

Tomar la decisión **antes** de Fase 3. No activar LIVE si estás en modo
B sin haber verificado que `usdc_libre >= $10` (mínimo Binance).

---

## Fase 3 — Reset de estado (opcional, recomendado)

Si el `data/state.json` o `data/simple_state.json` tiene residuos del
incidente o del paper-live largo, hacer reset limpio:

```bash
pm2 stop live
cd /root/cryptobot-live
bash scripts/reset-state.sh --yes-i-am-sure
# Backups en data/backups/ con timestamp
```

Dejar el bot PARADO hasta Fase 4.

---

## Fase 4 — Activación

**Sólo después de Fases 1-3 exitosas.**

```bash
cd /root/cryptobot-live

# 1. Editar .env: cambiar la línea LIVE_MODE
nano .env                        # LIVE_MODE=false → LIVE_MODE=true

# 2. Re-arrancar con delete+start (pm2 restart NO recarga env vars)
pm2 delete live 2>/dev/null || true
pm2 start src/server.js --name live --update-env

# 3. Verificar primeros logs (5-10 segundos)
pm2 logs live --lines 60 --nostream | grep -E "BOOT|LIVE_MODE|CAPITAL-SYNC|verifyLiveBalance|SECURITY"
```

Deben aparecer (en orden):
- `[BOOT] LIVE_MODE=true (env=true) API_KEY=SET API_SECRET=SET`
- `[LIVE] API Binance configurada — verificando balance real...`
- `[LIVE] ✅ Balance USDC real: $...`
- `[SIMPLE][CAPITAL-SYNC] declarado=$100 real=$... efectivo=$...`
- **NO** deben aparecer warnings de `[SECURITY]` (si aparecen, ver al final).

---

## Fase 5 — Verificación post-activación (primeros 5 min)

```bash
# Estado del simpleBot en LIVE
curl -s http://localhost:3001/api/simpleBot/state | python3 -m json.tool | head -40

# Comprobar claves específicas
curl -s http://localhost:3001/api/simpleBot/state | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('instance:        ', d['instance'])
print('capitalDeclarado:', d['capitalDeclarado'])
print('capitalReal:     ', d['capitalReal'])
print('capitalEfectivo: ', d['capitalEfectivo'])
print('usdcLibre:       ', d['usdcLibre'])
print('valorPosiciones: ', d['valorPosiciones'])
print('capa1Cash:       ', d['capa1Cash'])
print('capa2Cash:       ', d['capa2Cash'])
print('capViolation:    ', d['capViolation'])
print('capitalSync:     ', d['capitalSync'])
"
```

**Requisitos**:
- `instance` debe ser `LIVE`
- `capitalEfectivo` <= `capitalDeclarado` (100)
- `capViolation` = `false`
- `capitalSync.ok` = `true`, `pausedNow` = `false`

---

## Fase 6 — Monitoreo primeras 24h

- **Telegram**: confirmar que `/estado`, `/balance`, `/kelly`, `/pausa`
  responden.
- **Watchdog manual**: revisar cada 6h durante el primer día.

```bash
# cron sugerido (cada 5 min) — NO instalar sin validación:
# */5 * * * * curl -s http://localhost:3001/api/simpleBot/state | \
#   python3 -c "import json,sys;d=json.load(sys.stdin); \
#     sys.exit(0 if not d['capViolation'] and d['capitalSync']['ok'] else 1)" \
#   || /usr/bin/curl -X POST http://localhost:3001/api/pause -d 'secret=XXX'
```

- **Primer BUY real**: anotar el `strategyId`, el fill real, el slippage
  vs. expectedPrice. Comparar `[SIMPLE][RECONCILE-BUY]` y
  `[SIMPLE][CAPITAL-SYNC]` consecutivos en los logs.
- **Primer SELL real**: verificar que `applyRealSellFill` acredita el
  delta correcto en la capa correspondiente.

---

## Fase 7 — Rollback (si algo sale mal)

Criterios de rollback inmediato:

- `capViolation=true` en cualquier momento
- Error recurrente en `placeLiveBuy` / `placeLiveSell`
- Drawdown > 10% del capital declarado en las primeras 24h
- `[SIMPLE][CAPITAL-SYNC]` fallando >3 veces consecutivas con Telegram alert
- Posición bloqueada sin SELL durante > `time_stop` (48h)

Procedimiento:

```bash
ssh root@91.98.128.33
cd /root/cryptobot-live

# 1. PAUSA inmediata (Telegram: enviar /pausa al bot) O:
pm2 stop live

# 2. Revisar balance real
node scripts/check-balance.js

# 3. Si el estado del bot está corrupto, reset:
bash scripts/reset-state.sh --yes-i-am-sure

# 4. Volver a PAPER-LIVE
nano .env                        # LIVE_MODE=true → LIVE_MODE=false
pm2 delete live
pm2 start src/server.js --name live --update-env

# 5. Validar que volvió a paper
pm2 logs live --lines 30 --nostream | grep -E "LIVE_MODE|PAPER"
curl -s http://localhost:3001/api/simpleBot/state | python3 -c "import json,sys;print(json.load(sys.stdin)['instance'])"
# Debe imprimir: PAPER-LIVE
```

---

## Notas finales

- **Secrets en default literal**: si `[SECURITY] ⚠️` aparece en el boot,
  exportar `SYNC_SECRET`, `BOT_SECRET`, `BAFIR_SECRET` en el `.env`
  ANTES de activar LIVE. Con defaults hardcoded los endpoints `/api/sync/*`
  y `/api/set-capital` son bypassables desde internet.
- **PM2 cachea env vars**: `pm2 restart` NO recarga `.env`. Usar siempre
  `pm2 delete` + `pm2 start` tras modificar `.env`.
- **CAPITAL_USDT en .env es el TECHO**: el bot jamás opera con más,
  aunque Binance tenga más. Si Binance tiene menos, el bot opera con
  menos (T0 capital dinámico).
- **Posiciones no gestionadas**: el bot sólo conoce las que creó él.
  Cualquier asset preexistente (incidente 12 abril) es invisible hasta
  que se añada explícitamente a `this.portfolio` (proceso manual,
  no automático).
