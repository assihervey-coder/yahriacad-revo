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
import { buildOdbJob, buildTar } from '../src/lib/engine/odb'
import {
  FABRICS, checkManufacturability, buildPanel, offsetGerber, generatePanelPackage,
  type FabPreset,
} from '../src/lib/engine/panelizer'
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
  const routing = await routeAll(nl, ratchet.placements, DEFAULT_RULES, constraints)
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

  // ---- P2.1 — Gerber X2 (attributs) + package ODB++ ----
  assert(gtl.content.includes('%TF.GenerationSoftware,NEXUS PCB,Studio,1.0*%'), 'Gerber X2 : TF.GenerationSoftware')
  assert(gtl.content.includes('%TF.FileFunction,Copper,L1,Top*%'), 'Gerber X2 : TF.FileFunction cuivre top')
  assert(gtl.content.includes(`%TF.ProjectId,${nl.id.replace(/[^A-Za-z0-9_.\-+/!]/g, '_')}*%`), 'Gerber X2 : TF.ProjectId')
  assert(gtl.content.includes('%TO.N,'), 'Gerber X2 : attributs %TO.N par net')
  assert(gtl.content.includes('%TO.C,'), 'Gerber X2 : attributs %TO.C par composant')
  const hasVias = routing.routes.some((r) => r.vias.length > 0)
  assert(!hasVias || gtl.content.includes('%TO.V*%'), 'Gerber X2 : attribut %TO.V sur vias')
  const edge = gerber.files.find((f) => f.name === 'Edge_Cuts.gbr')!
  assert(edge.content.includes('%TF.FileFunction,Profile,NP*%'), 'Gerber X2 : contour Profile,NP')

  const odb = buildOdbJob(nl, ratchet.placements, routing)
  assert(odb.files.length >= 2 * odb.layerNames.length + 4, `ODB++ : ${odb.files.length} fichiers (${odb.layerNames.length} couches + outline/drill/netlist/matrix)`)
  const tar = buildTar(odb.files)
  assert(tar.length % 512 === 0, 'ODB++ : archive tar alignée 512 o')
  assert(tar[257] === 0x75 && tar[258] === 0x73 && tar[259] === 0x74 && tar[260] === 0x61 && tar[261] === 0x72, 'ODB++ : magie ustar présente (offset 257)')
  const matrix = odb.files.find((f) => f.path.endsWith('matrix/matrix'))!
  assert(matrix.content.includes('NAME=f_cu') && matrix.content.includes('TYPE=SIGNAL'), 'ODB++ : matrix déclare les couches cuivre')
  const odbNetlist = odb.files.find((f) => f.path.endsWith('steps/step/netlist'))!
  const knownNet = routing.routes[0]?.net ?? ''
  assert(knownNet !== '' && odbNetlist.content.includes(`NETNAME=${knownNet.replace(/[^A-Za-z0-9_.\-+/]/g, '_')}`), 'ODB++ : netlist contient les nets routés')
  const odbDrill = odb.files.find((f) => f.path.endsWith('layers/drill/drill'))
  assert(!!odbDrill === hasVias, 'ODB++ : perçage présent si et seulement si des vias')
  if (odbDrill) {
    assert(odbDrill.content.includes('UNITS=UM') && /TOOL T1 C=\d+/.test(odbDrill.content), 'ODB++ : drill avec outils métriques')
  }
  const odbLines = odb.files.find((f) => f.path.endsWith('layers/f_cu/lines'))!
  assert(/^L \d+ \d+ \d+ \d+ r\d+$/m.test(odbLines.content), 'ODB++ : enregistrements L (pistes) en µm')

  // ---- P2.2 — Panelisation + contraintes fabricant ----
  const jlc = FABRICS[0]
  const fab = checkManufacturability(nl, routing, jlc, DEFAULT_RULES)
  assert(fab.checks.length === 7, 'conformité fabricant : 7 contrôles (piste, perçage, anneau, isolement, bord, dimensions, couches)')
  assert(fab.checks.every((c) => c.measured.length > 0), 'conformité : chaque contrôle porte une valeur mesurée')
  const absurd: FabPreset = { ...jlc, id: 'absurd', name: 'Absurde', minTraceMm: 50, minDrillMm: 50 }
  const fab2 = checkManufacturability(nl, routing, absurd, DEFAULT_RULES)
  assert(!fab2.pass && fab2.checks.find((c) => c.id === 'trace')?.ok === false, 'conformité : préréglage absurde rejeté (piste)')

  const panel = buildPanel(nl, { cols: 2, rows: 2, gapMm: 2, railMm: 5, mode: 'vcut' })
  assert(panel.origins.length === 4, 'panel 2×2 : 4 origines de copies')
  assert(Math.abs(panel.panelW - (2 * nl.board.w + 2)) < 1e-9, 'panel : largeur = 2×carte + gap')
  assert(Math.abs(panel.panelH - (2 * nl.board.h + 2 + 10)) < 1e-9, 'panel : hauteur = 2×carte + gap + 2 rails')
  assert(panel.vcutLines.length === 2, 'panel V-cut : 1 axe vertical + 1 axe horizontal')
  assert(panel.fiducials.length === 4 && panel.toolingHoles.length === 4, 'panel : 4 repères + 4 trous de centrage')
  assert(panel.utilization > 0.5 && panel.utilization < 1, `panel : utilisation matière ${(panel.utilization * 100).toFixed(0)} %`)
  const bites = buildPanel(nl, { cols: 2, rows: 1, gapMm: 2, railMm: 5, mode: 'bites' })
  assert(bites.biteHoles.length > 0 && bites.vcutLines.length === 0, 'panel onglets : trous micro-percés générés, zéro V-cut')
  const shifted = offsetGerber('X1000000Y2000000D01*', 1.5, -0.5)
  assert(shifted.includes('X2500000') && shifted.includes('Y1500000'), 'translation Gerber exacte (µ)')
  const pkg = generatePanelPackage(nl, routing, panel, gerber.files, jlc)
  assert(pkg.some((f) => f.name === 'panel_Edge.gbr') && pkg.some((f) => f.name === 'panel_README.txt') && pkg.some((f) => f.name === 'panel_drill.drl'), 'package panel : contour + perçage + notice')
  const pfcu = pkg.find((f) => f.name === 'panel_F_Cu.gbr')!
  assert((pfcu.content.match(/%TF.GenerationSoftware/g) || []).length === 1, 'panel : attributs TF globaux une seule fois (copies assainies)')
  assert((pfcu.content.match(/M02\*/g) || []).length === 1, 'panel : un seul M02 par fichier de cuivre')
  const baseFcu = gerber.files.find((f) => f.name === 'F_Cu.gbr')!
  assert(pfcu.content.length > baseFcu.content.length * 3, 'panel : cuivre réellement dupliqué (4 copies)')
}

/* ============ [P1.1] Pile 4 couches — signal/signal/masse/alim ============ */
console.log('\n════════ P1.1 — Pile 4 couches (NEXUS-CORE) ════════')
{
  const base = NETLISTS[0]
  const nl4 = { ...base, board: { ...base.board, layers: 4 } }
  const constraints4 = extractConstraints(nl4)
  const plan4 = ruleBasedPlan(nl4)
  const placement4 = optimizePlacement(nl4, plan4, constraints4, { iterations: 9000 })
  const routing4 = await routeAll(nl4, placement4.placements, DEFAULT_RULES, constraints4)
  const rate4 = routing4.routedNets / routing4.totalNets
  assert(rate4 >= 0.75, `routage 4 couches ${routing4.routedNets}/${routing4.totalNets} (${(rate4 * 100).toFixed(0)} %) — ${routing4.viaCount} vias, ${routing4.totalLengthMm.toFixed(0)} mm`)
  assert(!!routing4.planes && routing4.planes.length === 2, `plans cuivre générés : ${routing4.planes?.map((p) => `L${p.layer} ${p.net}`).join(' + ') ?? 'aucun'}`)
  const masse = routing4.planes?.find((p) => p.cls === 'ground')
  const alim = routing4.planes?.find((p) => p.cls === 'power')
  assert(!!masse && masse.layer === 2 && masse.cells.length > 0, `plan de masse sur In2.Cu (L2) — ${masse?.cells.length ?? 0} cellules`)
  assert(!!alim && alim.layer === 3 && alim.cells.length > 0, `plan d'alim sur B.Cu (L3) — ${alim?.cells.length ?? 0} cellules`)
  const gndRoute = routing4.routes.find((r) => r.net === 'GND')
  const pwrRoute = routing4.routes.find((r) => r.net === 'VDD_3V3')
  assert(!!gndRoute?.routed && !!gndRoute.pour, 'masse connectée par son plan dédié (pour)')
  assert(!!pwrRoute?.routed && !!pwrRoute.pour, 'rail principal VDD_3V3 connecté par son plan dédié (pour)')
  for (const r of routing4.routes.filter((x) => !x.routed)) console.log(`    ⚠ non routé : ${r.net} — ${r.failureReason}`)

  const drc4 = runDrc(nl4, placement4.placements, routing4, solveThermal(nl4, placement4.placements), DEFAULT_RULES, constraints4)
  assert(drc4.violations.filter((v) => v.code === 'DRC-OVERLAP').length === 0, '4 couches : aucun chevauchement de composants')
  const dfm4 = runDfm(nl4, placement4.placements, routing4, DEFAULT_RULES)
  assert(dfm4.score >= 60, `DFM 4 couches ${dfm4.score}/100`)
  assert(dfm4.checks.some((c) => c.name.includes('Plans cuivre')), 'DFM : contrôle « plans cuivre dédiés » présent')

  const gerber4 = generateGerber(nl4, placement4.placements, routing4)
  assert(gerber4.files.length === 8, `export 4 couches : ${gerber4.files.length} fichiers (F_Cu, In1_Cu, In2_Cu, B_Cu + contour + drill + BOM + POS)`)
  const in2 = gerber4.files.find((f) => f.name === 'In2_Cu.gbr')!
  assert(!!in2 && in2.content.includes('D03'), 'Gerber In2_Cu.gbr : flashes du plan de masse présents')
  const bcu4 = gerber4.files.find((f) => f.name === 'B_Cu.gbr')!
  assert(!!bcu4 && bcu4.content.includes('D03'), 'Gerber B_Cu.gbr : flashes du plan d\u2019alim présents')
}

/* ============ [P1.2] Appariement strict des paires différentielles ============ */
console.log('\n════════ P1.2 — Paire différentielle USB (NEXUS-CORE, 2 couches) ════════')
{
  const base = NETLISTS[0]
  const constraints2 = extractConstraints(base)
  const plan2 = ruleBasedPlan(base)
  const placement2 = optimizePlacement(base, plan2, constraints2, { iterations: 9000 })
  const routing2 = await routeAll(base, placement2.placements, DEFAULT_RULES, constraints2)
  const dp = routing2.routes.find((r) => r.net === 'USB_DP')
  const dm = routing2.routes.find((r) => r.net === 'USB_DM')
  assert(!!dp?.pair && !!dm?.pair, `paire détectée : ${dp?.pair ? `USB_DP ↔ ${dp.pair.partner}` : '—'} · ${dm?.pair ? `USB_DM ↔ ${dm.pair.partner}` : '—'}`)
  if (dp?.pair && dm?.pair) {
    console.log(`    skew ${dp.pair.skewMm.toFixed(2)} mm · gap ${dp.pair.gapMm.toFixed(2)} mm · matched=${dp.pair.matched}`)
    assert(dp.pair.matched, `appariement de longueur : skew ${dp.pair.skewMm.toFixed(2)} mm ≤ 0,5 mm`)
    assert(dp.pair.gapMm <= 2.5, `espacement contrôlé : gap ${dp.pair.gapMm.toFixed(2)} mm ≤ 2,5 mm`)
    assert(dp.pair.skewMm === dm.pair.skewMm && dp.pair.gapMm === dm.pair.gapMm, 'métadonnées cohérentes entre les deux membres')
  }
}

console.log('\n' + (failures === 0 ? '🎉 TOUS LES TESTS PASSENT' : `💥 ${failures} ÉCHEC(S)`))
process.exit(failures === 0 ? 0 : 1)
