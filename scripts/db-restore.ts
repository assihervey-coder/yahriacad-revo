// NEXUS PCB — Restauration d'une archive `nexus-db-archive` [Sprint 2 — M3].
//
//   DATABASE_URL=postgresql://nexus@127.0.0.1:5433/nexus bun run scripts/db-restore.ts --in backups/nexus-sqlite.json --wipe
//
// Valide l'archive (kind, schemaVersion, empreinte SHA-256), puis réinsère
// les lignes DANS LE PROVIDER COURANT en préservant identifiants et
// horodatages d'origine. --wipe vide d'abord les tables (ordre des clés
// étrangères : EditEvent, Run, Project). C'est l'étape de chargement de la
// migration SQLite → PostgreSQL (docs/migration-sqlite-postgresql.md).
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const SCHEMA_VERSION = 1

/** Provider COURANT lu dans prisma/schema.prisma — fait foi. */
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
  const path = resolve(arg('in'))
  const wipe = process.argv.includes('--wipe')
  let archive: {
    kind?: string
    schemaVersion?: number
    sha256?: string
    counts?: { projects: number; runs: number; edits: number }
    data?: {
      projects: {
        id: string; netlistId: string; name: string; createdAt: string
        runs: Record<string, unknown>[]
        edits: Record<string, unknown>[]
      }[]
    }
  }
  try {
    archive = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    console.error(`✗ archive illisible (${path}) :`, (e as Error).message)
    process.exit(2)
  }
  if (archive.kind !== 'nexus-db-archive' || archive.schemaVersion !== SCHEMA_VERSION || !archive.data) {
    console.error('✗ archive invalide : kind/schemaVersion inattendus')
    process.exit(2)
  }
  const sha = createHash('sha256').update(JSON.stringify(archive.data)).digest('hex')
  if (sha !== archive.sha256) {
    console.error(`✗ empreinte SHA-256 divergente (archive ${archive.sha256?.slice(0, 12)}… vs calculée ${sha.slice(0, 12)}…) — archive corrompue`)
    process.exit(2)
  }
  const projects = archive.data.projects
  const nRuns = projects.reduce((s, p) => s + p.runs.length, 0)
  const nEdits = projects.reduce((s, p) => s + p.edits.length, 0)

  const provider = currentProvider()
  console.log(`═ Restauration ${path.split('/').pop()} → ${provider} ═`)
  console.log(`  contenu validé : ${projects.length} projets, ${nRuns} runs, ${nEdits} edits (sha256 ok)`)

  if (wipe) {
    await db.editEvent.deleteMany()
    await db.run.deleteMany()
    await db.project.deleteMany()
    console.log('  tables vidées (--wipe)')
  }

  for (const p of projects) {
    await db.project.create({
      data: { id: p.id, netlistId: p.netlistId, name: p.name, createdAt: new Date(p.createdAt) },
    })
  }
  if (nRuns > 0) {
    await db.run.createMany({
      data: projects.flatMap((p) =>
        p.runs.map((r) => ({ ...r, createdAt: new Date(r.createdAt as string) })) as never[],
      ),
    })
  }
  if (nEdits > 0) {
    await db.editEvent.createMany({
      data: projects.flatMap((p) =>
        p.edits.map((e) => ({ ...e, createdAt: new Date(e.createdAt as string) })) as never[],
      ),
    })
  }

  const got = {
    projects: await db.project.count(),
    runs: await db.run.count(),
    edits: await db.editEvent.count(),
  }
  console.log(`  restauré  : ${got.projects} projets, ${got.runs} runs, ${got.edits} edits`)
  const ok = got.projects === projects.length && got.runs === nRuns && got.edits === nEdits
  console.log(ok ? '✔ RESTAURATION CONFORME À L’ARCHIVE' : '✗ comptages divergents après restauration')
  await db.$disconnect()
  process.exit(ok ? 0 : 1)
}

main().catch(async (e) => {
  console.error('✗ Échec de la restauration :', e)
  await db.$disconnect()
  process.exit(1)
})
