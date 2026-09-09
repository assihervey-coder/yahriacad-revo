// NEXUS PCB — Sauvegarde de la base au format archive JSON [Sprint 2 — M3].
//
//   bun run scripts/db-dump.ts --out backups/nexus-2026-09-09.json
//
// Archive `nexus-db-archive` v1 : toutes les lignes Project/Run/EditEvent
// avec leurs identifiants et horodatages d'origine + empreinte SHA-256 du
// contenu. Fonctionne sur les DEUX providers (sqlite et postgresql) : c'est
// aussi l'étape d'extraction de la migration SQLite → PostgreSQL
// (docs/migration-sqlite-postgresql.md). La restauration se fait avec
// scripts/db-restore.ts.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const SCHEMA_VERSION = 1

/** Provider COURANT lu dans prisma/schema.prisma — fait foi (le client est
 *  généré pour ce provider). `SELECT version()` n'existe pas sur SQLite. */
function currentProvider(): string {
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  const m = schema.match(/provider\s*=\s*"(sqlite|postgresql)"/)
  if (!m) throw new Error('provider introuvable dans prisma/schema.prisma')
  return m[1]
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  if (!v) {
    if (fallback !== undefined) return fallback
    console.error(`✗ argument --${name} requis`)
    process.exit(2)
  }
  return v
}

async function main() {
  const out = resolve(arg('out', `backups/nexus-archive-${new Date().toISOString().slice(0, 10)}.json`))
  const provider = currentProvider()

  const projects = await db.project.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      runs: { orderBy: { createdAt: 'asc' } },
      edits: { orderBy: { createdAt: 'asc' } },
    },
  })

  const data = { projects }
  const sha256 = createHash('sha256').update(JSON.stringify(data)).digest('hex')
  const archive = {
    engine: 'nexus-pcb',
    kind: 'nexus-db-archive',
    schemaVersion: SCHEMA_VERSION,
    provider,
    takenAt: new Date().toISOString(),
    counts: {
      projects: projects.length,
      runs: projects.reduce((s, p) => s + p.runs.length, 0),
      edits: projects.reduce((s, p) => s + p.edits.length, 0),
    },
    sha256,
    data,
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(archive, null, 2) + '\n')
  console.log(`✔ archive écrite → ${out}`)
  console.log(`  provider : ${provider}`)
  console.log(`  contenu  : ${archive.counts.projects} projets, ${archive.counts.runs} runs, ${archive.counts.edits} événements de journal`)
  console.log(`  sha256   : ${sha256.slice(0, 16)}…`)
  await db.$disconnect()
}

main().catch(async (e) => {
  console.error('✗ Échec de la sauvegarde :', e)
  await db.$disconnect()
  process.exit(1)
})