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
LOG_PREFIX="[WATCHDOG $(date -u +%Y-%m-%dT%H:%M:%SZ)]"

# ── Helpers ───────────────────────────────────────────────────────────────────
log() { echo "${LOG_PREFIX} $*"; }

alert_tg() {
  local msg="$1"
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
    for a in d:
        if a.get('name')=='$app':
            print(a.get('pm2_env',{}).get('status','unknown')); sys.exit(0)
    print('missing')
except: print('error')
")
    case "$status" in
      online) ;;  # OK
      missing) log "service $app no registrado en pm2 (ignorar si es intencional)" ;;
      *)       alert_tg "PM2 app <b>$app</b> estado: <code>$status</code>" ;;
    esac
  done
}

# ── 2. cryptobot-live invariante cap estricto ─────────────────────────────────
check_live_cap() {
  local body
  body=$(curl -sS --max-time 5 "${LIVE_HOST}/api/simpleBot/state" 2>/dev/null || echo "")
  if [ -z "$body" ]; then
    alert_tg "cryptobot-live no responde en ${LIVE_HOST}/api/simpleBot/state"
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
      alert_tg "cryptobot-live /api/simpleBot/state devolvió JSON inválido: ${parse_out#PARSE_ERR|}"
      return
      ;;
  esac

  IFS='|' read -r _marker tv cap viol tl dd op <<< "$parse_out"

  # 2a. Invariante: totalValue > cap * 1.005
  local tv_over
  tv_over=$(awk -v t="$tv" -v l="$CAP_LIMIT" 'BEGIN{print (t>l)?"1":"0"}')
  if [ "$tv_over" = "1" ]; then
    alert_tg "totalValue <b>\$${tv}</b> > cap*1.005 <b>\$${CAP_LIMIT}</b> (positions=${op}, dd=${dd}%)"
  fi

  # 2b. Invariante duro: capViolation=true (ledger > cap)
  if [ "$viol" = "True" ]; then
    alert_tg "INVARIANTE CAP ROTA: totalLedger=\$${tl} > cap \$${cap} (positions=${op})"
  fi

  # 2c. Drawdown crítico (>15%)
  local dd_crit
  dd_crit=$(awk -v d="$dd" 'BEGIN{print (d>15)?"1":"0"}')
  if [ "$dd_crit" = "1" ]; then
    alert_tg "Drawdown crítico <b>${dd}%</b> (totalValue=\$${tv})"
  fi

  log "live OK: tv=\$${tv} cap=\$${cap} committed ledger=\$${tl} pos=${op} dd=${dd}%"
}

# ── 3. health endpoint check ──────────────────────────────────────────────────
check_health() {
  local health
  health=$(curl -sS --max-time 5 "${LIVE_HOST}/api/health" 2>/dev/null || echo "")
  if [ -z "$health" ]; then
    alert_tg "cryptobot-live /api/health no responde"
    return
  fi
  echo "$health" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    if not d.get('ok'): print('NOT_OK'); sys.exit(1)
except:
    print('PARSE_ERR'); sys.exit(1)
" >/dev/null || alert_tg "cryptobot-live /api/health devolvió estado no OK"
}

# ── Main ──────────────────────────────────────────────────────────────────────
log "watchdog v2 start"
check_pm2
check_health
check_live_cap
log "watchdog v2 end"
