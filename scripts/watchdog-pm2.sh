#!/bin/bash
# ── BAFIR watchdog v2 ─────────────────────────────────────────────────────────
# Vigila:
#   1. PM2 services (7 apps) — restart si caídos
#   2. cryptobot-live invariante cap estricto $100 (via /api/simpleBot/state)
#   3. totalValue > CAPITAL_USDT * 1.005 → alerta crítica
#   4. capViolation=true → alerta crítica (sum posiciones > cap)
#
# Desplegar: copiar a /root/watchdog-pm2.sh (chmod +x) y añadir a crontab:
#   */5 * * * * /root/watchdog-pm2.sh >> /var/log/bafir-watchdog.log 2>&1
#
# ENV vars requeridas:
#   TELEGRAM_TOKEN, TELEGRAM_CHAT_ID (opcional — sin ellas solo loggea)
#   CAPITAL_USDT (default 100)

set -u
LIVE_HOST="${LIVE_HOST:-http://localhost:3001}"
CAP="${CAPITAL_USDT:-100}"
CAP_LIMIT=$(awk -v c="$CAP" 'BEGIN{printf "%.4f", c*1.005}')
PM2_APPS=("live" "paper" "test" "bafir" "sentiment" "arbitrage" "deals")
STATE_FILE="/tmp/bafir-watchdog.state"
DEDUP_WINDOW_SEC=1800   # 30 minutes — FIX-M6
LOG_PREFIX="[WATCHDOG $(date -u +%Y-%m-%dT%H:%M:%SZ)]"

# ── Helpers ───────────────────────────────────────────────────────────────────
log() { echo "${LOG_PREFIX} $*"; }

# FIX-M6: Dedup de alertas con ventana de 30 min por tipo.
# Sin esto, cada cron tick (cada 5 min) re-envía la misma alerta si el
# problema persiste — spam Telegram insostenible. Con dedup: la primera
# alerta para un key se envía, las siguientes dentro de 30 min se descartan.
# State file: /tmp/bafir-watchdog.state con líneas "key timestamp".
# Fail-safe: si la escritura del state file falla por cualquier razón,
# dejamos pasar la alerta (prefer occasional spam a silencio total).
should_alert() {
  local key="$1"
  local now last age
  now=$(date +%s)
  last=""
  if [ -f "$STATE_FILE" ]; then
    last=$(awk -v k="$key" '$1==k {print $2}' "$STATE_FILE" 2>/dev/null | tail -1)
  fi
  if [ -n "$last" ]; then
    age=$((now - last))
    if [ "$age" -lt "$DEDUP_WINDOW_SEC" ]; then
      return 1   # dentro de ventana → deduplicar
    fi
  fi
  # Actualizar state file atómicamente: borrar línea previa del key, añadir nueva
  local tmp="${STATE_FILE}.tmp.$$"
  {
    if [ -f "$STATE_FILE" ]; then
      grep -v "^${key} " "$STATE_FILE" 2>/dev/null || true
    fi
    echo "${key} ${now}"
  } > "$tmp" 2>/dev/null || {
    log "should_alert: no pude escribir ${tmp} — fail-safe allow alert"
    return 0
  }
  mv -f "$tmp" "$STATE_FILE" 2>/dev/null || {
    log "should_alert: mv ${tmp} → ${STATE_FILE} falló — fail-safe allow alert"
    return 0
  }
  return 0
}

# alert_tg <dedup_key> <msg>
# Si key es cadena vacía, se omite la dedup (alerta siempre). En uso normal
# pasar un key único por tipo de condición: pm2_down_${app}, cap_breach,
# totalvalue_over_cap, drawdown_crit, live_api_down, health_api_down, etc.
alert_tg() {
  local key="$1"
  local msg="$2"
  if [ -n "$key" ]; then
    if ! should_alert "$key"; then
      log "DEDUP: ${key} (within ${DEDUP_WINDOW_SEC}s window) — alert skipped"
      return 0
    fi
  fi
  log "ALERT: $msg"
  if [ -n "${TELEGRAM_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -sS --max-time 10 \
      -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      -d "parse_mode=HTML" \
      -d "text=🚨 <b>[WATCHDOG]</b> ${msg}" >/dev/null || true
  fi
}

# ── 1. PM2 services check ─────────────────────────────────────────────────────
check_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    log "pm2 no instalado — skip service check"
    return
  fi
  local pm2_json
  pm2_json=$(pm2 jlist 2>/dev/null || echo "[]")
  for app in "${PM2_APPS[@]}"; do
    local status
    status=$(echo "$pm2_json" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    found=False
    for a in d:
        if a.get('name')=='$app':
            print(a.get('pm2_env',{}).get('status','unknown'))
            found=True
            break
    if not found:
        print('missing')
except Exception:
    print('error')
")
    case "$status" in
      online) ;;  # OK
      missing) log "service $app no registrado en pm2 (ignorar si es intencional)" ;;
      *)       alert_tg "pm2_down_${app}" "PM2 app <b>$app</b> estado: <code>$status</code>" ;;
    esac
  done
}

# ── 2. cryptobot-live invariante cap estricto ─────────────────────────────────
check_live_cap() {
  local body
  body=$(curl -sS --max-time 5 "${LIVE_HOST}/api/simpleBot/state" 2>/dev/null || echo "")
  if [ -z "$body" ]; then
    alert_tg "live_api_down" "cryptobot-live no responde en ${LIVE_HOST}/api/simpleBot/state"
    return
  fi

  # Parse con python (más robusto que jq que puede no estar instalado)
  local parse_out
  parse_out=$(echo "$body" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    if d.get('loading'): print('LOADING'); sys.exit(0)
    tv  = float(d.get('totalValue', 0))
    cap = float(d.get('cap', 0))
    viol= d.get('capViolation', False)
    tl  = float(d.get('totalLedger', 0))
    dd  = float(d.get('drawdownPct', 0))
    op  = int(d.get('openPositions', 0))
    print(f'OK|{tv}|{cap}|{viol}|{tl}|{dd}|{op}')
except Exception as e:
    print(f'PARSE_ERR|{e}')
")

  case "$parse_out" in
    LOADING)
      log "live simpleBot todavía cargando — skip"
      return
      ;;
    PARSE_ERR*)
      alert_tg "live_parse_err" "cryptobot-live /api/simpleBot/state devolvió JSON inválido: ${parse_out#PARSE_ERR|}"
      return
      ;;
  esac

  IFS='|' read -r _marker tv cap viol tl dd op <<< "$parse_out"

  # 2a. Invariante: totalValue > cap * 1.005
  local tv_over
  tv_over=$(awk -v t="$tv" -v l="$CAP_LIMIT" 'BEGIN{print (t>l)?"1":"0"}')
  if [ "$tv_over" = "1" ]; then
    alert_tg "totalvalue_over_cap" "totalValue <b>\$${tv}</b> > cap*1.005 <b>\$${CAP_LIMIT}</b> (positions=${op}, dd=${dd}%)"
  fi

  # 2b. Invariante duro: capViolation=true (ledger > cap)
  if [ "$viol" = "True" ]; then
    alert_tg "cap_breach" "INVARIANTE CAP ROTA: totalLedger=\$${tl} > cap \$${cap} (positions=${op})"
  fi

  # 2c. Drawdown crítico (>15%)
  local dd_crit
  dd_crit=$(awk -v d="$dd" 'BEGIN{print (d>15)?"1":"0"}')
  if [ "$dd_crit" = "1" ]; then
    alert_tg "drawdown_crit" "Drawdown crítico <b>${dd}%</b> (totalValue=\$${tv})"
  fi

  log "live OK: tv=\$${tv} cap=\$${cap} committed ledger=\$${tl} pos=${op} dd=${dd}%"
}

# ── 3. health endpoint check ──────────────────────────────────────────────────
check_health() {
  local health
  health=$(curl -sS --max-time 5 "${LIVE_HOST}/api/health" 2>/dev/null || echo "")
  if [ -z "$health" ]; then
    alert_tg "health_api_down" "cryptobot-live /api/health no responde"
    return
  fi
  echo "$health" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    if not d.get('ok'): print('NOT_OK'); sys.exit(1)
except:
    print('PARSE_ERR'); sys.exit(1)
" >/dev/null || alert_tg "health_not_ok" "cryptobot-live /api/health devolvió estado no OK"
}

# ── Main ──────────────────────────────────────────────────────────────────────
log "watchdog v2 start"
check_pm2
check_health
check_live_cap
log "watchdog v2 end"
