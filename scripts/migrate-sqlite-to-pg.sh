#!/usr/bin/env bash
# NEXUS PCB — Migration SQLite → PostgreSQL scriptée [Sprint 2 — M3].
# Procédure documentée : docs/migration-sqlite-postgresql.md
#
#   bash scripts/migrate-sqlite-to-pg.sh
#
# Étapes : sauvegarde de la base SQLite au format archive JSON → démarrage de
# l'instance PostgreSQL → bascule du provider Prisma + régénération du client
# → création du schéma sur PG → restauration de l'archive (identifiants et
# horodatages préservés) → vérification des comptages.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_URL="postgresql://nexus@127.0.0.1:5433/nexus"
ARCHIVE="backups/nexus-migration-$(date +%Y%m%d-%H%M%S).json"

if grep -q 'provider = "postgresql"' prisma/schema.prisma; then
  echo "✗ le schéma est déjà en provider postgresql — la migration part de SQLite" >&2
  exit 1
fi

echo "═ 1/6 — Sauvegarde SQLite → $ARCHIVE"
bun run scripts/db-dump.ts --out "$ARCHIVE"

echo "═ 2/6 — Démarrage PostgreSQL (port 5433)"
bash scripts/pg-lifecycle.sh start

echo "═ 3/6 — Bascule provider + régénération du client Prisma"
bash scripts/use-db.sh postgres

echo "═ 4/6 — Création du schéma sur PostgreSQL"
DATABASE_URL="$PG_URL" bunx prisma db push --accept-data-loss

echo "═ 5/6 — Restauration de l'archive dans PostgreSQL"
DATABASE_URL="$PG_URL" bun run scripts/db-restore.ts --in "$ARCHIVE" --wipe

echo "═ 6/6 — Terminé"
echo "✔ Migration SQLite → PostgreSQL réussie — archive conservée : $ARCHIVE"
echo "  Pour revenir à SQLite : bash scripts/use-db.sh sqlite && bunx prisma db push --accept-data-loss"
