#!/usr/bin/env bash
# ── scripts/reset-state.sh — reset atómico del estado del bot ────────────
# Hace BACKUP con timestamp de data/state.json y data/simple_state.json,
# luego los resetea a {} para que el próximo arranque empiece limpio.
#
# Uso: bash scripts/reset-state.sh --yes-i-am-sure
#
# IMPORTANTE: No ejecuta syncCapitalFromBinance() — el bot está parado
# cuando se corre este script. La sincronización se hace automáticamente
# en initBot() del siguiente pm2 start gracias a T0 (capital dinámico).
set -euo pipefail

if [[ "${1:-}" != "--yes-i-am-sure" ]]; then
  cat <<USAGE
Uso: bash scripts/reset-state.sh --yes-i-am-sure

Hace backup atómico de data/state.json y data/simple_state.json con
timestamp en data/backups/, y los resetea a estado limpio.

Después del reset, al arrancar el bot con pm2, T0 (capital dinámico)
sincroniza automáticamente capa1Cash/capa2Cash con el balance real de
Binance (min(declarado, real)).

Por seguridad, este script requiere el flag --yes-i-am-sure.
USAGE
  exit 1
fi

cd "$(dirname "$0")/.."
REPO="$(pwd)"
TS="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="data/backups"
mkdir -p "$BACKUP_DIR"

echo "[RESET] repo:     $REPO"
echo "[RESET] backupdir: $BACKUP_DIR"
echo "[RESET] timestamp: $TS"
echo ""

# Backup + reset de cada fichero en orden atómico
for f in data/state.json data/simple_state.json; do
  if [[ -f "$f" ]]; then
    cp -p "$f" "$BACKUP_DIR/$(basename "$f").$TS.bak"
    bytes="$(wc -c < "$f")"
    echo "[BACKUP] $f ($bytes bytes) -> $BACKUP_DIR/$(basename "$f").$TS.bak"
  else
    echo "[BACKUP] $f no existe — skip"
  fi
done

echo ""
# Reset atómico: escribir a tmp + mv (no deja ventana con fichero truncado)
for f in data/state.json data/simple_state.json; do
  echo '{}' > "${f}.tmp"
  mv "${f}.tmp" "$f"
  echo "[RESET] $f -> {}"
done

echo ""
echo "Reset completado. Próximos pasos manuales:"
echo ""
echo "  1. pm2 stop live && pm2 delete live"
echo "  2. cd $REPO && pm2 start src/server.js --name live --update-env"
echo "  3. pm2 logs live --lines 50 --nostream | grep -E 'BOOT|CAPITAL-SYNC'"
echo "     Debe aparecer [SIMPLE][CAPITAL-SYNC] con valores reales de Binance."
echo "  4. curl -s http://localhost:3001/api/simpleBot/state | jq '.capitalEfectivo,.capViolation,.capitalSync'"
echo ""
echo "Backups en: $BACKUP_DIR"
ls -la "$BACKUP_DIR" | tail -n +2
