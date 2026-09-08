/**
 * Test hors-ligne du moteur NEXUS PCB — exécute le pipeline complet
 * sur les 3 netlists et vérifie les invariants (placement, routage, Gerber).
 * Usage: bun run scripts/test-engine.ts
 */
import { NETLISTS } from '../src/lib/engine/netlists'
import { parseNetlist, extractConstraints } from '../src/lib/engine/parser'
import { ruleBasedPlan } from '../src/lib/engine/llm-agent'
import { optimizePlacement } from '../src/lib/engine/placer'
import { solveThermal } from '../src/lib/engine/simulator'
import { routeAll } from '../src/lib/engine/router'
import { runDfm, runDrc } from '../src/lib/engine/drc'
import { generateGerber } from '../src/lib/engine/gerber'
import { DEFAULT_RULES } from '../src/lib/engine/rules'

let failures = 0
const assert = (cond: boolean, label: string) => {
  if (!cond) {
    failures++
    console.error(`  ✗ ÉCHEC : ${label}`)
  } else {
    console.log(`  ✓ ${label}`)
  }
}

for (const nl of NETLISTS) {
  console.log(`\n════════ ${nl.name} (${nl.components.length} composants, ${nl.nets.length} nets) ════════`)

  const parsed = parseNetlist(nl)
  assert(parsed.ok, `netlist valide (${parsed.errors.length} erreurs : ${parsed.errors.slice(0, 3).join(' | ')})`)

  const constraints = extractConstraints(nl)
  assert(constraints.length >= 3, `${constraints.length} contraintes extraites`)

  const plan = ruleBasedPlan(nl)
  assert(plan.zones.length === nl.components.length, `plan : ${plan.zones.length} zones pour ${nl.components.length} composants`)

  const t0 = Date.now()
  const placement = optimizePlacement(nl, plan, constraints, { iterations: 9000 })
  assert(placement.cost.hpwl > 0, `HPWL ${placement.cost.hpwl.toFixed(0)} en ${Date.now() - t0} ms`)
  // Vérifie que tout reste dans la carte
  const inBoard = placement.placements.every((p) =>
    p.x > 0 && p.x < nl.board.w && p.y > 0 && p.y < nl.board.h)
  assert(inBoard, 'tous les composants dans la carte')

  const thermal = solveThermal(nl, placement.placements)
  assert(thermal.maxT > thermal.minT, `thermique : max ${thermal.maxT.toFixed(1)}°C / amb ${thermal.minT.toFixed(1)}°C`)

  const t1 = Date.now()
  const routing = routeAll(nl, placement.placements, DEFAULT_RULES, constraints)
  const rate = routing.routedNets / routing.totalNets
  assert(rate >= 0.75, `routage ${routing.routedNets}/${routing.totalNets} (${(rate * 100).toFixed(0)}%) en ${Date.now() - t1} ms — ${routing.viaCount} vias, ${routing.totalLengthMm.toFixed(0)} mm`)
  for (const r of routing.routes.filter((x) => !x.routed)) console.log(`    ⚠ non routé : ${r.net} — ${r.failureReason}`)

  const drc = runDrc(nl, placement.placements, routing, thermal, DEFAULT_RULES, constraints)
  console.log(`  DRC : ${drc.errors} erreurs, ${drc.warnings} avertissements`)
  for (const v of drc.violations.filter((x) => x.severity === 'error').slice(0, 8))
    console.log(`    ✗ ${v.code} — ${v.message}`)
  // Garantie industrielle : zéro chevauchement de composants (légalisation)
  assert(drc.violations.filter((v) => v.code === 'DRC-OVERLAP').length === 0, 'aucun chevauchement de composants (légalisation)')
  const dfm = runDfm(nl, placement.placements, routing, DEFAULT_RULES)
  assert(dfm.score >= 60, `DFM ${dfm.score}/100`)

  const gerber = generateGerber(nl, placement.placements, routing)
  assert(gerber.files.length === 6, `${gerber.files.length} fichiers export`)
  const gtl = gerber.files.find((f) => f.name === 'F_Cu.gbr')!
  assert(gtl.content.includes('%FSLAX36Y36*%'), 'Gerber RS-274X : en-tête format 3.6')
  assert(gtl.content.includes('%MOMM*%'), 'Gerber : unités mm')
  assert(gtl.content.includes('D03'), 'Gerber : flashes de pads présents')
  const drill = gerber.files.find((f) => f.name === 'drill.drl')!
  assert(drill.content.includes('M48'), 'Excellon : en-tête M48')
}

console.log('\n' + (failures === 0 ? '🎉 TOUS LES TESTS PASSENT' : `💥 ${failures} ÉCHEC(S)`))
process.exit(failures === 0 ? 0 : 1)
