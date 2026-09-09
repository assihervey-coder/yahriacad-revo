// NEXUS PCB — CLI de calage P2.3 : coefficients du noyau latent sur cartes MESURÉES.
//
//   bun run scripts/calibrate_measured.ts --project nexus-core --data scripts/measured-boards.example.json --out scripts/measured-calibration.json
//
// Le fichier de données suit scripts/measured-boards.example.json :
//   { "project": "nexus-core", "boards": [ { label, ambientC, placements, measurements, source } ] }
// Sortie : coefficient (slope °C/unité latente) + intercept + r + RMSE,
// horodatés et versionnés avec leur source → scripts/measured-calibration.json.
import { resolve, dirname } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { NETLISTS } from '../src/lib/engine/netlists'
import { extractConstraints } from '../src/lib/engine/parser'
import { calibrateFromMeasuredBoards, type MeasuredBoardSample } from '../src/lib/engine/calibration'
import { ruleBasedPlan } from '../src/lib/engine/llm-agent'

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

const projectKey = arg('project', 'nexus-core')
const dataPath = resolve(arg('data', 'scripts/measured-boards.example.json'))
const outPath = resolve(arg('out', 'scripts/measured-calibration.json'))

const nl = NETLISTS.find((n) => n.id === projectKey)
if (!nl) {
  console.error(`✗ projet inconnu « ${projectKey} » — attendu : ${NETLISTS.map((n) => n.id).join(', ')}`)
  process.exit(2)
}

type DataFile = { project?: string; boards: MeasuredBoardSample[] }
let data: DataFile
try {
  data = JSON.parse(readFileSync(dataPath, 'utf8')) as DataFile
} catch (e) {
  console.error(`✗ fichier de mesures illisible (${dataPath}) :`, (e as Error).message)
  process.exit(2)
}
if (!Array.isArray(data.boards) || data.boards.length === 0) {
  console.error('✗ aucune carte dans data.boards')
  process.exit(2)
}

const plan = ruleBasedPlan(nl)
const constraints = extractConstraints(nl)
const cal = calibrateFromMeasuredBoards(nl, plan, constraints, data.boards)

console.log('══ P2.3 — Calage du noyau latent sur cartes mesurées ══')
console.log(`  projet        : ${nl.id} (${nl.components.length} composants)`)
console.log(`  relevés       : ${cal.usedSamples}/${cal.samples} exploités, ${cal.skippedSamples} écarté(s) par validation sanitaire`)
console.log(`  refs couvertes: ${cal.matchedRefs.join(', ') || 'aucune'}`)
if (cal.missingRefs.length) console.log(`  refs manquantes: ${cal.missingRefs.join(', ')}`)
console.log(`  ambiance      : ${cal.ambientMinC} → ${cal.ambientMaxC} °C`)
console.log(`  corrélation r : ${cal.r.toFixed(3)}`)
console.log(`  PENTE (calage): ${cal.slope.toFixed(4)} °C / unité latente`)
console.log(`  intercept     : ${cal.intercept.toFixed(3)} °C`)
console.log(`  RMSE / err max: ${cal.rmse.toFixed(2)} °C / ${cal.maxErr.toFixed(2)} °C`)
if (cal.sources.length) console.log(`  sources       : ${cal.sources.join(' ; ')}`)

if (cal.usedSamples < 2) {
  console.error('\n✗ moins de 2 relevés exploitables — coefficients NON produits (aucun calage silencieux)')
  process.exit(1)
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(
  outPath,
  JSON.stringify(
    {
      engine: 'nexus-pcb',
      kind: 'measured-thermal-calibration',
      project: nl.id,
      coefficients: { slope: cal.slope, intercept: cal.intercept },
      statistics: { r: cal.r, rmse: cal.rmse, maxErr: cal.maxErr, usedSamples: cal.usedSamples, skippedSamples: cal.skippedSamples },
      coverage: { matchedRefs: cal.matchedRefs, missingRefs: cal.missingRefs, ambientMinC: cal.ambientMinC, ambientMaxC: cal.ambientMaxC },
      sources: cal.sources,
      calibratedAt: cal.at,
    },
    null,
    2,
  ) + '\n',
)
console.log(`\n✔ coefficients versionnés → ${outPath}`)
