// NEXUS PCB — Test de persistance réelle sur PostgreSQL [audit P2.4 — prototype]
// Pré-requis : bash scripts/pg-lifecycle.sh start
//   && bash scripts/use-db.sh postgres
//   && DATABASE_URL=postgresql://nexus@127.0.0.1:5433/nexus bunx prisma db push
// Exécution :
//   DATABASE_URL=postgresql://nexus@127.0.0.1:5433/nexus bun run scripts/pg_persistence_test.ts
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
let failures = 0
function check(label: string, cond: boolean, detail = '') {
  const mark = cond ? '✓' : '✗'
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

async function main() {
  console.log('══ P2.4 — Persistance PostgreSQL réelle ══')

  // 1. Le moteur de stockage EST PostgreSQL
  const ver = await db.$queryRaw<Array<{ version: string }>>`SELECT version()`
  const isPg = (ver[0]?.version ?? '').includes('PostgreSQL')
  check('moteur = PostgreSQL', isPg, (ver[0]?.version ?? '').split(',')[0])
  const tables = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
  const names = tables.map((t) => t.table_name)
  check('tables Prisma présentes sur PG', ['Project', 'Run', 'EditEvent'].every((t) => names.includes(t)), names.join(', '))

  // 2. Écriture Project + Run, relecture
  const stamp = Date.now()
  const proj = await db.project.create({
    data: { netlistId: `pg-proto-${stamp}`, name: `Prototype PG ${stamp}` },
  })
  const run = await db.run.create({
    data: {
      projectId: proj.id,
      status: 'success',
      planSource: 'llm',
      dfmScore: 91,
      routedNets: 28,
      totalNets: 28,
      viaCount: 41,
      totalLengthMm: 491.2,
      maxTempC: 57.4,
      drcErrors: 0,
      drcWarnings: 3,
      costHpwl: 610.5,
      costThermal: 5.1,
      costConstraint: 1105.0,
      durationMs: 42000,
    },
  })
  const runBack = await db.run.findUnique({ where: { id: run.id }, include: { project: true } })
  check('Run écrit puis relu', !!runBack && runBack.status === 'success' && runBack.dfmScore === 91, `id=${run.id.slice(0, 8)} dfm=${runBack?.dfmScore}`)
  check('relation Run→Project intègre', !!runBack?.project && runBack.project.netlistId === `pg-proto-${stamp}`)

  // 3. Journal d'édition multi-acteurs (2 auteurs concurrents sur le même projet)
  await db.editEvent.createMany({
    data: [
      { projectId: proj.id, actor: 'alice@bureau', kind: 'move', ref: 'U1', xFrom: 10, yFrom: 20, rotFrom: 0, xTo: 10.5, yTo: 20, rotTo: 0, meta: 'surgical' },
      { projectId: proj.id, actor: 'bob@bureau', kind: 'nudge-live', ref: 'C3', xFrom: 30, yFrom: 12, rotFrom: 90, xTo: 30, yTo: 12.5, rotTo: 90, meta: 'live' },
      { projectId: proj.id, actor: 'alice@bureau', kind: 'undo', ref: 'U1', xFrom: 10.5, yFrom: 20, xTo: 10, yTo: 20, meta: 'annulation (miroir exact)' },
    ],
  })
  const edits = await db.editEvent.findMany({
    where: { projectId: proj.id },
    orderBy: { createdAt: 'asc' },
  })
  check('3 EditEvent persistés', edits.length === 3, `acteurs=${[...new Set(edits.map((e) => e.actor))].join(' + ')}`)
  check('journal multi-utilisateurs distingué', new Set(edits.map((e) => e.actor)).size === 2)
  check('delta avant/après conservé', edits[0].xTo === 10.5 && edits[0].xFrom === 10)

  // 4. Transactions concurrentes : 10 écritures parallèles de runs
  const results = await db.$transaction(
    Array.from({ length: 10 }, (_, i) =>
      db.run.create({
        data: { projectId: proj.id, status: 'partial', planSource: 'rules', dfmScore: 70 + i, routedNets: i, totalNets: 28, viaCount: i * 2, totalLengthMm: i * 10, maxTempC: 50 + i, drcErrors: 0, drcWarnings: 0, costHpwl: i, costThermal: i, costConstraint: i, durationMs: i * 100 },
      }),
    ),
  )
  check('10 écritures concurrentes transactionnelles', results.length === 10)
  const runCount = await db.run.count({ where: { projectId: proj.id } })
  check('intégrité comptage runs', runCount === 11, `runs=${runCount}`)

  // 5. Réversibilité : nettoyage du prototype (la base peut être vidée sans dégâts)
  await db.project.delete({ where: { id: proj.id } }) // cascade runs + edits
  const left = await db.run.count({ where: { projectId: proj.id } })
  check('suppression en cascade', left === 0)

  console.log(failures === 0 ? '\n✔ PROTOCOLE PG RÉUSSI — persistance PostgreSQL opérationnelle' : `\n✗ ${failures} ÉCHEC(S)`)
  await db.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('✗ Erreur fatale :', e)
  await db.$disconnect()
  process.exit(1)
})
