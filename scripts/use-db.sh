#!/usr/bin/env bash
# NEXUS PCB — Bascule du provider Prisma (sqlite ↔ postgresql) [Sprint 2 — M3]
# Bascule COMPLÈTE : provider du schéma + DATABASE_URL du .env + client
# régénéré — sans quoi le serveur applicatif resterait silencieusement sur
# l'ancien moteur.
#
# Usage :
#   bash scripts/use-db.sh postgres                 # instance embarquée (:5433)
#   NEXUS_PG_URL="postgresql://…managée…" bash scripts/use-db.sh postgres
#   bash scripts/use-db.sh sqlite                   # retour au local (défaut)
#
# Après bascule : créer le schéma si besoin (`bunx prisma db push`) puis
# redémarrer le serveur Next.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-sqlite}"
ENV_FILE=".env"
EMBEDDED_URL="postgresql://nexus@127.0.0.1:5433/nexus"
SQLITE_URL="file:$(pwd)/db/custom.db"

set_url() {
  local url="$1"
  if [ -f "$ENV_FILE" ] && grep -q '^DATABASE_URL=' "$ENV_FILE"; then
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$url|" "$ENV_FILE"
  else
    echo "DATABASE_URL=$url" >> "$ENV_FILE"
  fi
}

case "$MODE" in
  postgres)
    sed -i.bak 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma
    set_url "${NEXUS_PG_URL:-$EMBEDDED_URL}"
    echo "→ provider = postgresql"
    echo "  DATABASE_URL = ${NEXUS_PG_URL:-$EMBEDDED_URL}"
    ;;
  sqlite)
    sed -i.bak 's/provider = "postgresql"/provider = "sqlite"/' prisma/schema.prisma
    set_url "$SQLITE_URL"
    echo "→ provider = sqlite (local mono-utilisateur)"
    echo "  DATABASE_URL = $SQLITE_URL"
    ;;
  *)
    echo "Usage : $0 [sqlite|postgres]  (NEXUS_PG_URL=… pour une instance managée)" >&2
    exit 1
    ;;
esac
rm -f prisma/schema.prisma.bak
bunx prisma generate
echo "✔ Client Prisma régénéré ($MODE) — créer le schéma puis redémarrer le serveur Next"
