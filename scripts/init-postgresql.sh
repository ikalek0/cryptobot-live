#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# cryptobot-live · PostgreSQL local init (22 abr 2026)
# ═══════════════════════════════════════════════════════════════════════════
#
# Ubuntu 24.04 — PostgreSQL 16 del repo oficial vía apt.
# Idempotente: safe de re-ejecutar. No regenera password a menos que pases
# --reset-password.
#
# Uso:
#   sudo bash scripts/init-postgresql.sh
#   sudo bash scripts/init-postgresql.sh --reset-password
#
# Crea:
#   - role cryptobot con LOGIN + password aleatorio.
#   - database cryptobot_live con OWNER cryptobot.
#   - schema (bot_state + trade_log + 3 indexes) vía init-trade-log-schema.sql.
#
# NO modifica el .env — muestra la DATABASE_URL al final para que la copies
# manualmente. La password NO se persiste en ningún fichero del repo.
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Parse args ─────────────────────────────────────────────────────────────
RESET_PASSWORD=false
for arg in "$@"; do
  case "$arg" in
    --reset-password) RESET_PASSWORD=true ;;
    -h|--help)
      grep '^#' "$0" | head -30
      exit 0
      ;;
    *)
      echo "ERROR: unknown flag '$arg'. Use --reset-password or -h." >&2
      exit 1
      ;;
  esac
done

# ── Guard: requiere root (apt install + sudo -u postgres) ──────────────────
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "ERROR: este script requiere root (sudo)." >&2
  echo "Ejecuta: sudo bash $0 $*" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_SQL="${SCRIPT_DIR}/init-trade-log-schema.sql"
DB_NAME="cryptobot_live"
DB_ROLE="cryptobot"

if [[ ! -f "$SCHEMA_SQL" ]]; then
  echo "ERROR: schema SQL no encontrado en $SCHEMA_SQL" >&2
  exit 1
fi

echo "═══════════════════════════════════════════════════════════════"
echo " cryptobot-live · PostgreSQL init"
echo " Reset password: $RESET_PASSWORD"
echo "═══════════════════════════════════════════════════════════════"

# ── Paso 1: instalar PostgreSQL (idempotente, apt skip si ya presente) ────
echo ""
echo "[1/6] Instalando PostgreSQL + postgresql-contrib..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postgresql postgresql-contrib

# ── Paso 2: systemd enable + start (idempotente) ──────────────────────────
echo ""
echo "[2/6] Habilitando servicio postgresql..."
systemctl enable --now postgresql

# Pausa corta para que el socket Unix esté listo
sleep 1

# ── Paso 3: verificar conectividad local (peer auth vía postgres user) ────
echo ""
echo "[3/6] Verificando servicio..."
if ! sudo -u postgres psql -tAc "SELECT version();" >/dev/null 2>&1; then
  echo "ERROR: PostgreSQL no responde. Revisa:" >&2
  echo "  systemctl status postgresql" >&2
  echo "  journalctl -u postgresql -n 50" >&2
  exit 1
fi
PG_VERSION=$(sudo -u postgres psql -tAc "SELECT version();" | head -1)
echo "   OK: $PG_VERSION"

# ── Paso 4: crear role (con password idempotencia) ────────────────────────
echo ""
echo "[4/6] Creando role '$DB_ROLE'..."
ROLE_EXISTS=$(sudo -u postgres psql -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname='$DB_ROLE';" | tr -d '[:space:]')

GENERATED_PASSWORD=""
if [[ "$ROLE_EXISTS" != "1" ]]; then
  # Role nuevo: generar password fresco
  GENERATED_PASSWORD=$(openssl rand -base64 48 | tr -d '/+=\n' | head -c 32)
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
CREATE ROLE $DB_ROLE WITH LOGIN PASSWORD '$GENERATED_PASSWORD';
SQL
  echo "   OK: role '$DB_ROLE' creado con password fresco"
elif [[ "$RESET_PASSWORD" == "true" ]]; then
  # Role existe + user pidió reset: rotar password
  GENERATED_PASSWORD=$(openssl rand -base64 48 | tr -d '/+=\n' | head -c 32)
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
ALTER ROLE $DB_ROLE WITH PASSWORD '$GENERATED_PASSWORD';
SQL
  echo "   OK: role '$DB_ROLE' existía — password REGENERADA por --reset-password"
else
  # Role existe + sin --reset-password: NO tocar password
  echo "   OK: role '$DB_ROLE' ya existe — password preservada"
  echo ""
  echo "   ℹ️  Si perdiste la password original, re-ejecuta con:"
  echo "       sudo bash $0 --reset-password"
fi

# ── Paso 5: crear database (idempotente) ──────────────────────────────────
echo ""
echo "[5/6] Creando database '$DB_NAME'..."
DB_EXISTS=$(sudo -u postgres psql -tAc \
  "SELECT 1 FROM pg_database WHERE datname='$DB_NAME';" | tr -d '[:space:]')
if [[ "$DB_EXISTS" != "1" ]]; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
CREATE DATABASE $DB_NAME OWNER $DB_ROLE;
SQL
  echo "   OK: database '$DB_NAME' creada (owner=$DB_ROLE)"
else
  echo "   OK: database '$DB_NAME' ya existe"
fi

# ── Paso 6: aplicar schema (CREATE TABLE IF NOT EXISTS + indexes) ─────────
echo ""
echo "[6/6] Aplicando schema desde init-trade-log-schema.sql..."
# Si GENERATED_PASSWORD está vacío (role ya existía sin reset), usamos el
# socket peer auth como postgres user para aplicar el SQL sin password.
if [[ -n "$GENERATED_PASSWORD" ]]; then
  # Conectamos como cryptobot con la password recién generada/rotada
  PGPASSWORD="$GENERATED_PASSWORD" psql -v ON_ERROR_STOP=1 -q \
    -h localhost -U "$DB_ROLE" -d "$DB_NAME" \
    -f "$SCHEMA_SQL"
else
  # Role pre-existente, password no disponible aquí: aplicar schema como
  # postgres via socket. El owner de la DB es cryptobot → tablas creadas
  # por postgres SUPERUSER se crean en el schema public y cryptobot tiene
  # acceso por ser owner del database.
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME" -f "$SCHEMA_SQL"
fi
echo "   OK: schema aplicado (bot_state + trade_log + 3 indexes)"

# ── Verificación final ────────────────────────────────────────────────────
echo ""
echo "[verify] Tablas presentes:"
sudo -u postgres psql -d "$DB_NAME" -c "\dt" || true

# ── Banner final con DATABASE_URL (solo si se generó password) ────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
if [[ -n "$GENERATED_PASSWORD" ]]; then
  cat <<BANNER
 ✅ INIT COMPLETO

 COPIA ESTA LÍNEA A TU .env (y a tu gestor de passwords si usas):

 DATABASE_URL=postgresql://$DB_ROLE:$GENERATED_PASSWORD@localhost:5432/$DB_NAME

 Esta password NO se guarda en ningún sitio. Si la pierdes,
 re-ejecuta el script con --reset-password.
BANNER
else
  cat <<BANNER
 ✅ INIT COMPLETO (sin cambio de password)

 El role '$DB_ROLE' ya existía. Usa la DATABASE_URL con la
 password que guardaste al ejecutar este script la primera vez.

 Si la perdiste, re-ejecuta con:
   sudo bash $0 --reset-password
BANNER
fi
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo " Siguiente paso: añadir la DATABASE_URL al .env del bot y"
echo " reiniciar con: pm2 restart live --update-env"
echo ""
