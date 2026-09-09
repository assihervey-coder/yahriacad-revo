// NEXUS PCB — CLI de calage P2.3/Sprint 1-M1 : coefficients du noyau latent
// sur cartes MESURÉES, VERSIONNÉS et soumis aux seuils PUBLIÉS.
//
//   bun run scripts/calibrate_measured.ts --project nexus-core --data scripts/measured-boards.demo.json --out src/lib/engine/measured-calibration/nexus-core.json
//
// Le fichier de données suit scripts/measured-boards.example.json :
//   { "project": "nexus-core", "boards": [ { label, ambientC, placements, measurements, source } ] }
// Sortie : coefficients (pente °C/unité latente + IC 95 % + intercept) + r +
// RMSE + verdict contre les seuils publiés + révision SHA-256 (déterministe)
// + empreinte SHA-256 du jeu de relevés. Hors seuil ou < 2 relevés
// exploitables → AUCUNE publication (exit 1) : aucun calage silencieux.
import { resolve, dirname, basename } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { NETLISTS } from '../src/lib/engine/netlists'
import { extractConstraints } from '../src/lib/engine/parser'
import {
  calibrateFromMeasuredBoards, measuredThresholdVerdict, PUBLISHED_THRESHOLDS,
  type MeasuredBoardSample,
} from '../src/lib/engine/calibration'
import { ruleBasedPlan } from '../src/lib/engine/llm-agent'
import { datasetSha256, measuredRevision } from './lib/measured-versioning'

const SCHEMA_VERSION = 1

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

let dataBytes: Buffer
type DataFile = { project?: string; boards: MeasuredBoardSample[] }
let data: DataFile
try {
  dataBytes = readFileSync(dataPath)
  data = JSON.parse(dataBytes.toString('utf8')) as DataFile
} catch (e) {
  console.error(`✗ fichier de mesures illisible (${dataPath}) :`, (e as Error).message)
  process.exit(2)
}
if (!Array.isArray(data.boards) || data.boards.length === 0) {
  console.error('✗ aucune carte dans data.boards')
  process.exit(2)
}

const dataHash = datasetSha256(dataBytes)
const plan = ruleBasedPlan(nl)
const constraints = extractConstraints(nl)
const cal = calibrateFromMeasuredBoards(nl, plan, constraints, data.boards)
const verdict = measuredThresholdVerdict(cal)

// Nature des données : traçabilité honnête — un jeu de DÉMONSTRATION (gabarit,
// synthétique) ne doit jamais passer pour des relevés industriels.
const joinedSources = cal.sources.join(' ; ').toLowerCase()
const dataKind: 'demo' | 'measured' =
  /démo|demo|synthétique|synthetique|exemple|example|gabarit/.test(joinedSources) ? 'demo' : 'measured'

console.log('══ Sprint 1 M1 — Calage du noyau latent sur cartes mesurées ══')
console.log(`  projet        : ${nl.id} (${nl.components.length} composants)`)
console.log(`  relevés       : ${cal.usedSamples}/${cal.samples} exploités, ${cal.skippedSamples} écarté(s) par validation sanitaire`)
console.log(`  refs couvertes: ${cal.matchedRefs.join(', ') || 'aucune'}`)
if (cal.missingRefs.length) console.log(`  refs manquantes: ${cal.missingRefs.join(', ')}`)
console.log(`  ambiance      : ${cal.ambientMinC} → ${cal.ambientMaxC} °C`)
console.log(`  corrélation r : ${cal.r.toFixed(3)}  (seuil ≥ ${PUBLISHED_THRESHOLDS.rMin})`)
const ci = cal.slopeCi95 ? `[${cal.slopeCi95[0].toFixed(4)} ; ${cal.slopeCi95[1].toFixed(4)}]` : 'IC non défini (support de régression insuffisant)'
console.log(`  PENTE (calage): ${cal.slope.toFixed(4)} °C / unité latente  IC95 % ${ci}`)
console.log(`  intercept     : ${cal.intercept.toFixed(3)} °C`)
console.log(`  RMSE / err max: ${cal.rmse.toFixed(2)} °C (≤ ${PUBLISHED_THRESHOLDS.rmseMaxC}) / ${cal.maxErr.toFixed(2)} °C (≤ ${PUBLISHED_THRESHOLDS.maxErrMaxC})`)
console.log(`  sources       : ${cal.sources.join(' ; ') || 'non tracées'}`)
console.log(`  nature        : ${dataKind === 'demo' ? 'DÉMONSTRATION (synthétique — pas des relevés industriels)' : 'relevés déclarés mesurés'}`)
console.log(`  dataset       : ${basename(dataPath)} — sha256 ${dataHash.slice(0, 16)}…`)

if (cal.usedSamples < 2) {
  console.error('\n✗ moins de 2 relevés exploitables — coefficients NON produits (aucun calage silencieux)')
  process.exit(1)
}
if (!verdict.ok) {
  console.error(`\n✗ écart modèle/mesure HORS SEUIL PUBLIÉ — coefficients NON publiés :\n  • ${verdict.failures.join('\n  • ')}`)
  process.exit(1)
}
console.log('  verdict       : CONFORME aux seuils publiés')

const coefficients = { slope: cal.slope, intercept: cal.intercept, slopeCi95: cal.slopeCi95 }
const statistics = { r: cal.r, rmse: cal.rmse, maxErr: cal.maxErr, usedSamples: cal.usedSamples, skippedSamples: cal.skippedSamples }
const coverage = { matchedRefs: cal.matchedRefs, missingRefs: cal.missingRefs, ambientMinC: cal.ambientMinC, ambientMaxC: cal.ambientMaxC }
const revision = measuredRevision({
  project: nl.id, coefficients, statistics, coverage,
  sources: cal.sources, datasetSha256: dataHash, schemaVersion: SCHEMA_VERSION,
})

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(
  outPath,
  JSON.stringify(
    {
      engine: 'nexus-pcb',
      kind: 'measured-thermal-calibration',
      schemaVersion: SCHEMA_VERSION,
      project: nl.id,
      revision,
      verdict: 'CONFORME',
      thresholds: PUBLISHED_THRESHOLDS,
      coefficients,
      statistics,
      coverage,
      sources: cal.sources,
      dataKind,
      provenance: {
        dataset: basename(dataPath),
        datasetSha256: dataHash,
        calibratedAt: cal.at,
      },
    },
    null,
    2,
  ) + '\n',
)
console.log(`\n✔ coefficients versionnés (révision ${revision.slice(0, 16)}…) → ${outPath}`)
