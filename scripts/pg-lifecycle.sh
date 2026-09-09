#!/usr/bin/env bash
# NEXUS PCB — Cycle de vie PostgreSQL embarqué [audit P2.4 — prototype réel]
# Binaires officielles PG 18.4 via @embedded-postgres/linux-x64 (sans root).
#
# Usage :
#   bash scripts/pg-lifecycle.sh start    # init si besoin + démarre sur :5433
#   bash scripts/pg-lifecycle.sh stop     # arrêt propre
#   bash scripts/pg-lifecycle.sh status   # état du serveur
set -euo pipefail
cd "$(dirname "$0")"

BIN="pgembed/node_modules/@embedded-postgres/linux-x64/native/bin"
PGDATA="$HOME/.nexus-pgdata"          # hors dépôt git
SOCKDIR="/tmp/nexus-pg"               # socket unix accessible
PORT=5433
DB="nexus"
USER="nexus"
LOG="/tmp/nexus-pg.log"

mkdir -p "$SOCKDIR"

case "${1:-status}" in
  start)
    if [ ! -s "$PGDATA/PG_VERSION" ]; then
      echo "→ initdb (nouveau cluster $PGDATA)"
      "$BIN/initdb" -D "$PGDATA" -U "$USER" --auth=trust --encoding=UTF8 > /dev/null
    fi
    if "$BIN/pg_ctl" -D "$PGDATA" status > /dev/null 2>&1; then
      echo "→ PostgreSQL déjà démarré (port $PORT)"
    else
      echo "→ démarrage PostgreSQL 18 sur port $PORT"
      "$BIN/pg_ctl" -D "$PGDATA" -l "$LOG" \
        -o "-p $PORT -k $SOCKDIR -c listen_addresses=127.0.0.1" \
        -w -t 60 start > /dev/null
      # crée la base si absente (mode single-user — pas de psql dans le package)
      if ! echo "\\l" | "$BIN/postgres" --single -D "$PGDATA" -E postgres 2>/dev/null | grep -q "$DB"; then
        echo "CREATE DATABASE $DB;" | "$BIN/postgres" --single -D "$PGDATA" postgres > /dev/null 2>&1 \
          && echo "→ base '$DB' créée" \
          || echo "→ création '$DB' incertaine (vérifier via Prisma)"
      fi
    fi
    echo "✔ PostgreSQL 18.4 actif sur 127.0.0.1:$PORT (socket $SOCKDIR)"
    echo "✔ URL : postgresql://$USER@127.0.0.1:$PORT/$DB"
    ;;
  stop)
    "$BIN/pg_ctl" -D "$PGDATA" -m fast stop || true
    echo "→ PostgreSQL arrêté"
    ;;
  status)
    "$BIN/pg_ctl" -D "$PGDATA" status || echo "→ arrêté"
    ;;
  *)
    echo "Usage : $0 [start|stop|status]" >&2; exit 1 ;;
esac
