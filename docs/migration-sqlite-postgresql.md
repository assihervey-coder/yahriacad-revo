# Migration SQLite → PostgreSQL (Sprint 2, M3)

**Objet :** opérer la base NEXUS PCB sur une instance PostgreSQL (auto-hébergée
ou managée) en préservant l'intégralité des projets, runs et journaux
d'édition, avec sauvegarde/restauration testées.

## 1. Principe

La migration passe par une **archive JSON** (`nexus-db-archive` v1) produite
par `scripts/db-dump.ts` et rejouée par `scripts/db-restore.ts`. L'archive
contient toutes les lignes `Project` / `Run` / `EditEvent` avec leurs
identifiants (cuid) et horodatages d'origine, une empreinte SHA-256 du
contenu et les comptages attendus. Ce chemin fonctionne pour tout couple de
providers — SQLite et PostgreSQL aujourd'hui — et constitue aussi la
sauvegarde/restauration d'exploitation.

Le schéma Prisma est **identique** sur les deux providers : la bascule se
fait par `scripts/use-db.sh` (sed du `provider` + régénération du client),
puis `prisma db push` crée les tables sur la cible.

## 2. Procédure scriptée (recommandée)

```bash
bash scripts/migrate-sqlite-to-pg.sh
```

Le script enchaîne, dans l'ordre, avec arrêt à la première erreur :

1. **Sauvegarde** de la base SQLite → `backups/nexus-migration-<date>.json`
   (refuse de partir si le schéma n'est pas en `sqlite`) ;
2. **Démarrage** de l'instance PostgreSQL (`scripts/pg-lifecycle.sh start`,
   port 5433, base `nexus`) ;
3. **Bascule** du provider + régénération du client Prisma
   (`scripts/use-db.sh postgres`) ;
4. **Création du schéma** sur PostgreSQL (`prisma db push`) ;
5. **Restauration** de l'archive dans PostgreSQL avec `--wipe`
   (validation de l'empreinte, ordre des clés étrangères, préservation des
   identifiants et horodatages) ;
6. **Vérification** des comptages — le script de restauration échoue si un
   comptage diverge.

L'archive de migration est conservée dans `backups/` : elle sert de point de
retour et de preuve de contenu.

## 3. Procédure manuelle (équivalente)

```bash
# 1. Extraction depuis SQLite
bun run scripts/db-dump.ts --out backups/nexus-sqlite.json

# 2. Instance PostgreSQL (auto-hébergée ici ; pour une instance managée,
#    renseigner directement DATABASE_URL ci-dessous)
bash scripts/pg-lifecycle.sh start

# 3. Bascule Prisma
bash scripts/use-db.sh postgres
export DATABASE_URL="postgresql://nexus@127.0.0.1:5433/nexus"   # ou URL managée

# 4. Schéma
bunx prisma db push --accept-data-loss

# 5. Chargement
bun run scripts/db-restore.ts --in backups/nexus-sqlite.json --wipe
```

## 4. Retour arrière (PostgreSQL → SQLite)

La réversibilité a été vérifiée (prototype P2.4) :

```bash
bun run scripts/db-dump.ts --out backups/nexus-pg.json   # depuis PG
bash scripts/use-db.sh sqlite
bunx prisma db push --accept-data-loss
bun run scripts/db-restore.ts --in backups/nexus-pg.json --wipe
```

## 5. Sauvegarde / restauration d'exploitation

| Opération | Commande |
|---|---|
| Sauvegarde à chaud | `bun run scripts/db-dump.ts --out backups/nexus-$(date +%F).json` |
| Restauration | `bun run scripts/db-restore.ts --in backups/<archive>.json --wipe` |
| Test automatisé (PG) | `DATABASE_URL=postgresql://nexus@127.0.0.1:5433/nexus bun run scripts/pg_backup_restore_test.ts` |

Le test automatisé scénarise : seed précis (floats, horodatages à la
milliseconde, acteurs distincts) → archive → mutation destructrice →
restauration `--wipe` → vérification de fidélité bit-à-bit (identifiants,
deltas du journal, acteurs, dates) → nettoyage.

## 6. Deux sessions navigateur partagées

Une fois la plateforme opérée sur PostgreSQL (étapes 2-5, puis redémarrage
du serveur Next), deux sessions navigateur — deux machines ou deux contextes
isolés — partagent projets, historique de runs et journal d'édition :
l'API lit et écrit la même instance PG. La persistance après redémarrage du
serveur applicatif est vérifiée par le protocole `pg_persistence_test.ts`
(POST → kill → restart → relecture).

## 7. État courant

- Instance **auto-hébergée** : PostgreSQL 18.4 embarqué sans root
  (`scripts/pgembed`, port 5433) — substitut réseau d'une instance managée,
  mêmes étapes avec une `DATABASE_URL` distante ;
- Migration scriptée + documentée : `scripts/migrate-sqlite-to-pg.sh` ;
- Sauvegarde/restauration **testées** : `pg_backup_restore_test.ts`, 10/10
  (fidélité complète, `--wipe` ordonné, empreinte SHA-256) ;
- Contrainte connue : le client Prisma est généré pour UN provider à la fois
  — toute bascule impose `use-db.sh` + redémarrage du serveur applicatif.
