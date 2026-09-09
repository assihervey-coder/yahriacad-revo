// NEXUS PCB — Test de sauvegarde/restauration sur PostgreSQL [Sprint 2 — M3].
// Pré-requis : bash scripts/pg-lifecycle.sh start
//   && bash scripts/use-db.sh postgres
//   && DATABASE_URL=postgresql://nexus@127.0.0.1:5433/nexus bunx prisma db push
// Exécution :
//   DATABASE_URL=postgresql://nexus@127.0.0.1:5433/nexus bun run scripts/pg_backup_restore_test.ts
//
// Scénario : seed d'un projet marqué (2 runs + 3 edits, floats/dates précis)
// → ARCHIVE (scripts/db-dump.ts) → MUTATION (suppression du projet, ajout
// d'un autre) → RESTAURATION --wipe (scripts/db-restore.ts) → VÉRIFICATION :
// le projet seedé est revenu à l'identique, la mutation a disparu.
import { PrismaClient } from '@prisma/client'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const db = new PrismaClient()
const ARCHIVE = '/tmp/nexus-backup-restore-test.json'
let failures = 0
function check(label: string, cond: boolean, detail = '') {
  const mark = cond ? '✓' : '✗'
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const run = (cmd: string[]) => {
  const p = spawnSync(cmd[0], cmd.slice(1), { stdio: 'pipe' })
  if (p.status !== 0) {
    console.error(p.stderr.toString())
    throw new Error(`commande échouée : ${cmd.join(' ')}`)
  }
  return p.stdout.toString()
}

async function main() {
  console.log('══ M3 — Sauvegarde/restauration PostgreSQL (archive JSON) ══')
  const stamp = Date.now()
  const marker = `bk-restore-${stamp}`
  const seedDate = new Date('2026-03-14T09:26:53.589Z')

  // 1. Seed
  const proj = await db.project.create({
    data: { netlistId: marker, name: 'Sauvegarde/restauration M3', createdAt: seedDate },
  })
  await db.run.create({
    data: { projectId: proj.id, status: 'success', planSource: 'llm', dfmScore: 88, routedNets: 28, totalNets: 28, viaCount: 41, totalLengthMm: 491.25, maxTempC: 57.4, drcErrors: 0, drcWarnings: 3, costHpwl: 610.5, costThermal: 5.1, costConstraint: 1105.0, durationMs: 42000, createdAt: seedDate },
  })
  await db.run.create({
    data: { projectId: proj.id, status: 'partial', planSource: 'rules', dfmScore: 74, routedNets: 27, totalNets: 28, viaCount: 52, totalLengthMm: 522.75, maxTempC: 61.2, drcErrors: 1, drcWarnings: 0, costHpwl: 702.25, costThermal: 6.6, costConstraint: 1210.5, durationMs: 38000, createdAt: new Date('2026-03-14T10:00:00.000Z') },
  })
  await db.editEvent.createMany({
    data: [
      { projectId: proj.id, actor: 'alice@bureau', kind: 'move', ref: 'U1', xFrom: 10.5, yFrom: 20.25, rotFrom: 0, xTo: 11.0, yTo: 20.25, rotTo: 0, meta: 'surgical', createdAt: seedDate },
      { projectId: proj.id, actor: 'bob@bureau', kind: 'nudge-live', ref: 'C3', xFrom: 30, yFrom: 12, rotFrom: 90, xTo: 30, yTo: 12.5, rotTo: 90, meta: 'live', createdAt: new Date('2026-03-14T09:30:00.000Z') },
      { projectId: proj.id, actor: 'alice@bureau', kind: 'undo', ref: 'U1', xFrom: 11.0, yFrom: 20.25, xTo: 10.5, yTo: 20.25, meta: 'miroir exact', createdAt: new Date('2026-03-14T09:31:00.000Z') },
    ],
  })
  check('seed : 1 projet + 2 runs + 3 edits écrits', true, `marqueur ${marker}`)

  // 2. Archive
  run(['bun', 'run', 'scripts/db-dump.ts', '--out', ARCHIVE])
  const archive = JSON.parse(readFileSync(ARCHIVE, 'utf8'))
  check('archive écrite et typée', archive.kind === 'nexus-db-archive' && archive.schemaVersion === 1)
  check('archive : empreinte SHA-256 présente', typeof archive.sha256 === 'string' && archive.sha256.length === 64)

  // 3. Mutation destructrice après la sauvegarde
  await db.project.delete({ where: { id: proj.id } })
  const stray = await db.project.create({ data: { netlistId: 'post-backup-stray', name: 'écrit APRÈS la sauvegarde' } })
  check('mutation post-sauvegarde effectuée', (await db.project.count({ where: { netlistId: marker } })) === 0 && (await db.project.count({ where: { id: stray.id } })) === 1)

  // 4. Restauration (--wipe)
  run(['bun', 'run', 'scripts/db-restore.ts', '--in', ARCHIVE, '--wipe'])

  // 5. Vérifications de fidélité
  const back = await db.project.findUnique({
    where: { id: proj.id },
    include: { runs: { orderBy: { createdAt: 'asc' } }, edits: { orderBy: { createdAt: 'asc' } } },
  })
  check('projet seedé restauré (même id)', !!back, back?.id.slice(0, 8))
  check('mutation post-sauvegarde disparue (--wipe)', (await db.project.count({ where: { id: stray.id } })) === 0)
  check('runs : 2 restaurés, métriques exactes', back?.runs.length === 2 && back.runs[0].totalLengthMm === 491.25 && back.runs[1].dfmScore === 74 && back.runs[1].viaCount === 52)
  check('edits : 3 restaurés, deltas et acteurs exacts', back?.edits.length === 3 && back.edits[0].xTo === 11.0 && back.edits[0].actor === 'alice@bureau' && new Set(back.edits.map((e) => e.actor)).size === 2)
  check('horodatages préservés à la milliseconde', back?.createdAt.getTime() === seedDate.getTime() && back.runs[0].createdAt.getTime() === seedDate.getTime())

  // 6. Nettoyage du scénario (la base reste utilisable)
  await db.project.delete({ where: { id: proj.id } })
  check('nettoyage du scénario', (await db.project.count({ where: { netlistId: marker } })) === 0)

  console.log(failures === 0 ? '\n✔ SAUVEGARDE/RESTAURATION TESTÉE ET CONFORME [M3]' : `\n✗ ${failures} ÉCHEC(S)`)
  await db.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('✗ Erreur fatale :', e)
  await db.$disconnect()
  process.exit(1)
})
