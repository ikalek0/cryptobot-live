# BAFIR Trading - Operations Manual

## Acceso al servidor
```bash
ssh root@91.98.128.33
```
Todos los servicios corren en /root/ con PM2.

## Verificacion rapida del sistema

### Estado de todos los servicios
```bash
pm2 list
```
Todos deben mostrar "online". Si alguno tiene muchos restarts (>20), investigar logs.

### Estado del bot live
```bash
# Crear script de verificacion
echo '#!/bin/bash' > /tmp/check.sh
echo 'echo === HEALTH ===' >> /tmp/check.sh
echo 'curl -s http://localhost:3001/api/health' >> /tmp/check.sh
echo 'echo' >> /tmp/check.sh
echo 'echo === SIMPLE ===' >> /tmp/check.sh
echo 'curl -s http://localhost:3001/api/simple -o /tmp/s.json' >> /tmp/check.sh
echo 'python3 -c "import json;d=json.load(open(\"/tmp/s.json\"));print(\"capital:\",round(d[\"totalValue\"],2),\"trades:\",len([l for l in d[\"log\"] if l[\"type\"]==\"SELL\"]),\"positions:\",list(d[\"portfolio\"].keys()))"' >> /tmp/check.sh
echo 'echo === ERRORS ===' >> /tmp/check.sh
echo 'pm2 logs live --lines 30 --nostream 2>&1 | grep -c error' >> /tmp/check.sh
bash /tmp/check.sh
```

### Logs del simpleBot
```bash
pm2 logs live --lines 100 --nostream 2>&1 | grep SIMPLE | tail -20
```

## Deploy de cambios desde GitHub

```bash
cd /root/cryptobot-live
git fetch origin && git reset --hard origin/main
npm install
pm2 stop live && pm2 delete live
pm2 start src/server.js --name live --update-env
```

IMPORTANTE: Usar `pm2 delete + start`, NO solo `pm2 restart`. PM2 cachea variables de entorno y solo recarga con delete + start.

### Verificar deploy
```bash
sleep 10
pm2 logs live --lines 20 --nostream 2>&1 | grep BOOT
```
Debe mostrar: `[BOOT] LIVE_MODE=false/true API_KEY=SET API_SECRET=SET`

## Cambio PAPER-LIVE a LIVE

### Activar LIVE real
```bash
nano /root/cryptobot-live/.env
# Cambiar LIVE_MODE=false a LIVE_MODE=true
# Guardar (Ctrl+O, Enter, Ctrl+X)

pm2 stop live && pm2 delete live
cd /root/cryptobot-live && pm2 start src/server.js --name live --update-env
```

### Verificar que esta en LIVE
```bash
pm2 logs live --lines 10 --nostream 2>&1 | grep BOOT
# Debe mostrar: LIVE_MODE=true
```

### Volver a PAPER-LIVE
Mismo proceso pero cambiando LIVE_MODE=true a LIVE_MODE=false.

## Pausa de emergencia

### Via Telegram (preferido)
Enviar `/pausa` al bot. NO hay auto-resume. Solo `/reanudar` lo reactiva.

### Via PM2 (inmediato)
```bash
pm2 stop live
```
Para reanudar: `cd /root/cryptobot-live && pm2 start src/server.js --name live --update-env`

### Nuclear (todo el sistema)
```bash
pm2 stop all
```

## Reset de estado (empezar limpio)

```bash
# 1. Parar el bot PRIMERO (evita que re-guarde el estado viejo)
pm2 stop live

# 2. Borrar estado en disco
rm -f /root/cryptobot-live/data/state.json

# 3. Si PostgreSQL esta activo, borrar en BD tambien
# (requiere que el bot este corriendo para el endpoint)
# Alternativa: usar el endpoint /api/reset-state

# 4. Arrancar limpio
pm2 delete live
cd /root/cryptobot-live && pm2 start src/server.js --name live --update-env
```

## Recuperacion tras crash

### Bot no arranca (crash loop)
```bash
pm2 logs live --lines 50 --nostream
# Buscar el error. Causas comunes:
# - SyntaxError: codigo corrupto -> git reset --hard origin/main
# - Cannot find module: npm install
# - EADDRINUSE: otro proceso en el puerto -> pm2 delete live && pm2 start...
```

### Bot arranca pero no opera
```bash
pm2 logs live --lines 100 --nostream 2>&1 | grep -E "error|BOOT|SIMPLE"
# Verificar:
# - BOOT muestra API_KEY=SET (no EMPTY)
# - SIMPLE muestra ticks (no silencio)
# - No hay errores repetitivos
```

### Posiciones huerfanas tras crash en LIVE
Si el bot crashea con posiciones abiertas en Binance, al reiniciar detecta y limpia posiciones huerfanas automaticamente (server.js verifyLiveBalance).

## Logs comunes y su significado

### Normales (no accion requerida)
```
[SIMPLE][CANDLE] BTCUSDC/30m cerrada     — vela cerro, evaluacion se dispara
[SIMPLE][EVAL-START] BTC_30m_RSI          — evaluando estrategia
[SIMPLE][KELLY] kelly=0.325 WR=55% -> OK  — Kelly gate aprueba
[SIMPLE][EVAL] signal=HOLD                — condiciones no cumplidas, esperando
[SIMPLE] tick SOLUSDT->SOLUSDC $84.15     — precio recibido y normalizado
[BOOT] LIVE_MODE=false API_KEY=SET        — arranque correcto
```

### Warnings (investigar si frecuentes)
```
[DB] Error guardando en PG, usando disco  — PostgreSQL caido, fallback activo
[LIVE] Tick overlap - saltando            — tick anterior no termino, normal si esporadico
```

### Errores criticos (accion inmediata)
```
[BOOT] API_KEY=EMPTY                     — dotenv no carga .env, verificar instalacion
[TG] 401                                  — token de Telegram revocado o incorrecto
[SIMPLE][ERROR] _onCandleClose            — bug en evaluacion, ver stack trace
ReferenceError: X is not defined          — variable no declarada en engine.js
```

## Troubleshooting

### [TG] 401 Unauthorized
**Causa:** Token de Telegram revocado o no cargado por dotenv.
**Fix:** Verificar TELEGRAM_TOKEN en .env. Si fue revocado, crear nuevo token con @BotFather y actualizar .env. pm2 delete + start.

### [BOOT] API_KEY=EMPTY
**Causa:** dotenv no instalado o .env no presente.
**Fix:**
```bash
cd /root/cryptobot-live
grep dotenv package.json  # debe aparecer
head -5 src/server.js     # debe tener require('dotenv')
cat .env | head -3        # debe existir y tener contenido
npm install && pm2 delete live && pm2 start src/server.js --name live --update-env
```

### Sizing $1500 en cuenta de $100
**Causa:** INITIAL_CAPITAL lee CAPITAL_USDC que no esta en .env (defaultea a 10000).
**Fix:** Verificar CAPITAL_USDC=100 en .env. Si no esta, la cadena de fallback es CAPITAL_USDC -> CAPITAL_USDT -> 100.

### Velas no cerrando (no [SIMPLE][CANDLE] en logs)
**Causa 1:** Prefill no inicializo curBar. El bot necesita esperar un periodo completo (30min para 30m).
**Causa 2:** USDT/USDC mismatch. Verificar que los ticks muestran normalizacion: `tick SOLUSDT->SOLUSDC`.
**Fix:** Restart. El prefill actual inicializa curBar correctamente.

### [BAFIR] 404 spam
**Causa:** sendEquityToBafir() llamaba a endpoint eliminado.
**Fix:** Ya es no-op en el codigo actual. Si reaparece, verificar commit.

### CryptoPanic error spam
**Causa:** API rate-limited, devuelve HTML.
**Fix:** cryptoPanic.start() desactivado. Si reaparece, verificar que la linea esta comentada en server.js.

## Monitoreo diario recomendado

1. `pm2 list` — todos online, restarts bajos
2. `pm2 logs live --lines 30 --nostream` — sin errores repetitivos
3. Telegram `/estado` — capital, WR, posiciones
4. Dashboard http://91.98.128.33:3001 — curva de capital, estrategias

## Crontab sugerido (no implementado aun)
```bash
# Reinicio preventivo cada domingo 04:00 UTC
0 4 * * 0 cd /root/cryptobot-live && pm2 restart live --update-env
```
