#!/usr/bin/env bash
# NEXUS PCB — Bascule du provider Prisma (sqlite ↔ postgresql) [audit P2.4]
# Multi-utilisateurs : SQLite reste le mode mono-utilisateur local ; Postgres
# est la cible collaborative (actor du journal d'édition distinguera les
# auteurs, transactions concurrentes, row-level locking).
#
# Usage :
#   bash scripts/use-db.sh postgres   # bascule sur postgresql
#   bash scripts/use-db.sh sqlite     # retour au local (défaut)
#
# Après bascule postgres : renseigner DATABASE_URL puis `bunx prisma db push`.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-sqlite}"
case "$MODE" in
  postgres)
    sed -i.bak 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma
    echo "→ provider = postgresql"
    echo "  1. DATABASE_URL=\"postgresql://user:pass@host:5432/nexus\""
    echo "  2. bunx prisma db push --accept-data-loss"
    ;;
  sqlite)
    sed -i.bak 's/provider = "postgresql"/provider = "sqlite"/' prisma/schema.prisma
    echo "→ provider = sqlite (local mono-utilisateur)"
    ;;
  *)
    echo "Usage : $0 [sqlite|postgres]" >&2
    exit 1
    ;;
esac
rm -f prisma/schema.prisma.bak
bunx prisma generate
echo "✔ Client Prisma régénéré ($MODE)"
