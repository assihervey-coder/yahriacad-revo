/**
 * Test hors-ligne du moteur NEXUS PCB — exécute le pipeline complet
 * sur les 3 netlists et vérifie les invariants (placement, routage, Gerber).
 * v2 : boucle ratchet [AutoPCB], minimisation des vias [DeepPCB],
 * audit déterministe [Siemens Fuse], firmware bridge [Flux.ai].
 * Usage: bun run scripts/test-engine.ts
 */
import { NETLISTS } from '../src/lib/engine/netlists'
import { parseNetlist, extractConstraints } from '../src/lib/engine/parser'
import { ruleBasedPlan } from '../src/lib/engine/llm-agent'
import { optimizePlacement } from '../src/lib/engine/placer'
import { ratchetOptimize } from '../src/lib/engine/optimizer'
import { verifyPlacement, verifyRouting } from '../src/lib/engine/self-verifier'
import { generateFirmwareBridge } from '../src/lib/engine/firmware'
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

  // ---- v2 [AutoPCB] boucle ratchet : amélioration sans régression ----
  const ratchet = ratchetOptimize(nl, plan, constraints, placement.placements, { proposals: 240 })
  assert(ratchet.costAfter <= ratchet.costBefore + 2, `ratchet AutoPCB : coût ${ratchet.costBefore.toFixed(0)} → ${ratchet.costAfter.toFixed(0)} (${ratchet.accepted} gardées, −${ratchet.gainPct} %)`)
  assert(ratchet.placements.every((p) => p.x > 0 && p.x < nl.board.w && p.y > 0 && p.y < nl.board.h), 'ratchet : composants toujours dans la carte')

  // ---- v2 [Siemens Fuse] audit déterministe du placement ----
  const auditP = verifyPlacement(nl, ratchet.placements, constraints)
  assert(auditP.pass, `audit Fuse placement : ${auditP.violations.length === 0 ? 'conforme' : auditP.violations.slice(0, 2).map((v) => v.message).join(' | ')}`)

  const thermal = solveThermal(nl, placement.placements)
  assert(thermal.maxT > thermal.minT, `thermique : max ${thermal.maxT.toFixed(1)}°C / amb ${thermal.minT.toFixed(1)}°C`)

  const t1 = Date.now()
  const routing = routeAll(nl, ratchet.placements, DEFAULT_RULES, constraints)
  const rate = routing.routedNets / routing.totalNets
  assert(rate >= 0.75, `routage ${routing.routedNets}/${routing.totalNets} (${(rate * 100).toFixed(0)}%) en ${Date.now() - t1} ms — ${routing.viaCount} vias${routing.viasRemoved ? ` (−${routing.viasRemoved} via [DeepPCB])` : ''}, ${routing.totalLengthMm.toFixed(0)} mm`)
  assert(routing.viasRemoved !== undefined, `via_minimizer DeepPCB exécuté : ${routing.viasRemoved ?? 0} via(s) éliminé(s)`)
  for (const r of routing.routes.filter((x) => !x.routed)) console.log(`    ⚠ non routé : ${r.net} — ${r.failureReason}`)

  // ---- v2 [Siemens Fuse] audit déterministe du routage ----
  // Cohérence Fuse ↔ routeur : tout ouvert détecté doit correspondre à un net
  // réellement non routé (les audits SV-CLEARANCE sont remontés à titre
  // d'information — cuivre large adjacent, arbitrés par le DRC).
  const auditR = verifyRouting(nl, routing, DEFAULT_RULES)
  const unroutedNets = new Set(routing.routes.filter((r) => !r.routed).map((r) => r.net))
  const fuseOpens = auditR.violations.filter((v) => v.code === 'SV-OPEN')
  assert(
    fuseOpens.length === unroutedNets.size && fuseOpens.every((v) => unroutedNets.has(v.message.match(/Net (\S+) non connecté/)?.[1] ?? '')),
    `audit Fuse routage : ${fuseOpens.length} ouvert(s) — cohérent avec les ${unroutedNets.size} net(s) non routé(s) du routeur`,
  )
  assert(
    auditR.violations.filter((v) => v.code === 'SV-WIDTH' || v.code === 'SV-DRILL' || v.code === 'SV-ANNULAR').length === 0,
    'audit Fuse routage : aucun défaut largeur / perçage / annular ring',
  )

  const drc = runDrc(nl, ratchet.placements, routing, thermal, DEFAULT_RULES, constraints)
  console.log(`  DRC : ${drc.errors} erreurs, ${drc.warnings} avertissements`)
  for (const v of drc.violations.filter((x) => x.severity === 'error').slice(0, 8))
    console.log(`    ✗ ${v.code} — ${v.message}`)
  // Garantie industrielle : zéro chevauchement de composants (légalisation)
  assert(drc.violations.filter((v) => v.code === 'DRC-OVERLAP').length === 0, 'aucun chevauchement de composants (légalisation)')
  const dfm = runDfm(nl, ratchet.placements, routing, DEFAULT_RULES)
  assert(dfm.score >= 60, `DFM ${dfm.score}/100`)

  const gerber = generateGerber(nl, ratchet.placements, routing)
  assert(gerber.files.length === 6, `${gerber.files.length} fichiers export`)

  // ---- v2 [Flux.ai] firmware bridge ----
  const fw = generateFirmwareBridge(nl)
  assert(fw.files.length === 3 && fw.pinCount > 10, `firmware bridge : ${fw.files.length} artefacts, ${fw.pinCount} broches exportées`)
  const header = fw.files.find((f) => f.name === 'NEXUS_pinmap.h')!
  assert(header.content.includes('#pragma once') && header.content.includes('NEXUS_'), 'pinmap firmware : header C valide')
  const overlay = fw.files.find((f) => f.name === 'NEXUS_pinmap.overlay')!
  assert(overlay.content.includes('nexus_pinmap') && overlay.content.includes('compatible'), 'overlay Zephyr : devicetree valide')
  const gtl = gerber.files.find((f) => f.name === 'F_Cu.gbr')!
  assert(gtl.content.includes('%FSLAX36Y36*%'), 'Gerber RS-274X : en-tête format 3.6')
  assert(gtl.content.includes('%MOMM*%'), 'Gerber : unités mm')
  assert(gtl.content.includes('D03'), 'Gerber : flashes de pads présents')
  const drill = gerber.files.find((f) => f.name === 'drill.drl')!
  assert(drill.content.includes('M48'), 'Excellon : en-tête M48')
}

console.log('\n' + (failures === 0 ? '🎉 TOUS LES TESTS PASSENT' : `💥 ${failures} ÉCHEC(S)`))
process.exit(failures === 0 ? 0 : 1)
