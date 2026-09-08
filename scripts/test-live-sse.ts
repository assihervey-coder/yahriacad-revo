/**
 * Smoke test du flux de routage live (SSE) — NEXUS PCB
 * 1. Génère un placement réaliste via le moteur (ruleBasedPlan + recuit + ratchet)
 * 2. POST /api/routing/live et lit le flux SSE
 * 3. Vérifie : événements progressifs (horodatés), segments/vias, complete
 * Usage: bun run scripts/test-live-sse.ts
 */
import { NETLISTS } from '../src/lib/engine/netlists'
import { extractConstraints } from '../src/lib/engine/parser'
import { ruleBasedPlan } from '../src/lib/engine/llm-agent'
import { optimizePlacement } from '../src/lib/engine/placer'
import { ratchetOptimize } from '../src/lib/engine/optimizer'

const BASE = process.env.NEXUS_BASE ?? 'http://localhost:3000'

const nl = NETLISTS[0]
const plan = ruleBasedPlan(nl)
const constraints = extractConstraints(nl)
const placement = optimizePlacement(nl, plan, constraints, { iterations: 2500 })
const ratchet = ratchetOptimize(nl, plan, constraints, placement.placements, { proposals: 60 })
console.log(`Placement prêt : ${ratchet.placements.length} composants — netlist ${nl.name}`)

const t0 = Date.now()
const res = await fetch(`${BASE}/api/routing/live`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ netlist: nl, placements: ratchet.placements, pacingMs: 14 }),
})
if (!res.ok) {
  console.error(`HTTP ${res.status} : ${await res.text()}`)
  process.exit(1)
}
console.log(`HTTP ${res.status} ${res.headers.get('content-type')}`)

const reader = res.body!.getReader()
const dec = new TextDecoder()
let buf = ''
let segments = 0, vias = 0, nets = 0, phases: string[] = []
let complete = false
let lastEventAt = 0
let spreadMs = 0

for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  let sep: number
  while ((sep = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, sep)
    buf = buf.slice(sep + 2)
    const line = frame.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    const ev = JSON.parse(line.slice(6))
    const now = Date.now() - t0
    if (lastEventAt && now - lastEventAt > spreadMs) spreadMs = now - lastEventAt
    lastEventAt = now
    if (ev.t === 'segment') {
      segments++
      if (segments <= 3) console.log(`  [${String(now).padStart(5)}ms] segment ${ev.net} → (${ev.segment.pts.map((p: { x: number; y: number }) => `${p.x},${p.y}`).join(' → ')})`)
    } else if (ev.t === 'via') {
      vias++
    } else if (ev.t === 'progress') {
      if (ev.done % 10 === 0 || ev.done === ev.total) console.log(`  [${String(now).padStart(5)}ms] net ${ev.done}/${ev.total} : ${ev.net}${ev.ok ? '' : ' ✗'}`)
      if (ev.ok || !ev.net.includes('(')) nets++
    } else if (ev.t === 'phase') {
      phases.push(ev.phase)
      console.log(`  [${String(now).padStart(5)}ms] phase → ${ev.phase}`)
    } else if (ev.t === 'complete') {
      complete = true
      const r = ev.result
      console.log(`  [${String(now).padStart(5)}ms] COMPLETE — ${r.routedNets}/${r.totalNets} nets, ${r.viaCount} vias (−${r.viasRemoved}), ${r.totalLengthMm} mm, moteur ${r.durationMs} ms`)
    } else if (ev.t === 'error') {
      console.error(`  ERROR : ${ev.message}`)
    }
  }
}

console.log(`\nBilan : ${segments} segments, ${vias} vias, ${phases.length} phases (${phases.join(' → ')}), complete=${complete}`)
console.log(`Étalement temporel max entre 2 événements : ${spreadMs} ms (progressif = > 0 et flux étalé sur plusieurs secondes)`)
if (!complete || segments === 0) {
  console.error('✗ ÉCHEC du smoke test')
  process.exit(1)
}
console.log('✓ Smoke test LIVE OK')
