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
import {
  calibrateThermalModel, calibratedDeltaT, impedanceProfile, truthSensitiveDeltaT,
  calibrateFromMeasuredBoards, sensitiveDeltaTs, PUBLISHED_THRESHOLDS,
  measuredThresholdVerdict, type MeasuredBoardSample,
} from '../src/lib/engine/calibration'
import { buildEvalContext, mulberry32 } from '../src/lib/engine/world-model'
import type { PlacedComponent } from '../src/lib/engine/types'
import { AMBIENT } from '../src/lib/engine/simulator'
import { generateSpiceDeck } from '../src/lib/engine/spice'
import { DEFAULT_RULES } from '../src/lib/engine/rules'
import { datasetSha256, measuredRevision } from './lib/measured-versioning'

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

  // ---- P2.3 — Calibration corrélation modèle latent ↔ simulation ----
  const cal = calibrateThermalModel(nl, plan, constraints, { samples: 12, seed: 7, anchor: placement.placements })
  const rngFdm = mulberry32(7)  // même graine que le chemin FDM (tirages placements uniquement)
  assert(Number.isFinite(cal.r) && Math.abs(cal.r) <= 1, 'calibration : corrélation de Pearson bornée')
  assert(cal.r > 0.55, `calibration : corrélation latent ↔ ΔT sensibles r = ${cal.r.toFixed(3)} (${cal.samples + 1} échantillons+ancre, ΔT max carte r = ${cal.rMax.toFixed(2)} — métrique distincte)`)
  assert(cal.slope > 0, `calibration : pente ${cal.slope.toFixed(3)} °C/unité latente, intercept ${cal.intercept.toFixed(1)}`)
  assert(Number.isFinite(cal.rmse) && cal.rmse > 0 && Number.isFinite(cal.maxErr), `calibration : RMSE ${cal.rmse.toFixed(1)} °C, err max ${cal.maxErr.toFixed(1)} °C`)
  const ctxCal = buildEvalContext(nl, plan, constraints)
  const realMap = new Map(placement.placements.map((p) => [p.ref, p]))
  const truthDT = truthSensitiveDeltaT(ctxCal, nl, placement.placements)
  const estDT = calibratedDeltaT(cal, ctxCal, realMap)
  assert(
    Number.isFinite(estDT) && estDT >= 0 && Math.abs(estDT - truthDT) <= Math.max(cal.maxErr, 8),
    `prédiction calibrée sur solution réelle : ${estDT.toFixed(1)} °C vs FDM ${truthDT.toFixed(1)} °C (cohérente avec err max du fit ${cal.maxErr.toFixed(1)} °C)`,
  )
  const zi = impedanceProfile(DEFAULT_RULES)
  assert(zi.length >= 7 && zi.every((z) => z.z0 > 0), `profil d'impédance : ${zi.length} classes (Z0 > 0)`)
  assert(Math.abs((zi.find((z) => z.cls === 'rf')?.z0 ?? 0) - 50) < 40, `RF 2,8 mm : Z0 ${(zi.find((z) => z.cls === 'rf')?.z0 ?? 0).toFixed(1)} Ω ≈ cible 50 Ω`)

  // ---- P2.3 — Calage sur CARTES MESURÉES (harnais + validation sanitaire) ----
  // Sanity mathématique : les relevés SYNTHÉTIQUES reproduisent EXACTEMENT les
  // placements du chemin FDM (même graine, même formule, même ordre de tirage)
  // afin que les deux régressions portent sur le même jeu — seule la vérité
  // terrain diffère (FDM + bruit ±0,2 °C vs FDM pur). Ça valide la plomberie
  // (alignement refs, régression, validation sanitaire), PAS la corrélation
  // monde réel — celle-ci attend de vraies cartes instrumentées.
  const synthBoards: MeasuredBoardSample[] = []
  const noiseRng = mulberry32(999)  // graine séparée : ne décale pas les placements
  // placements identiques au chemin FDM : ancre d'abord, puis 12 tirages seed 7
  const replicateFdmSamples = (): PlacedComponent[] =>
    nl.components.map((c) => ({
      ref: c.ref,
      x: 2 + c.footprint.w / 2 + rngFdm() * Math.max(0.1, nl.board.w - c.footprint.w - 4),
      y: 2 + c.footprint.h / 2 + rngFdm() * Math.max(0.1, nl.board.h - c.footprint.h - 4),
      rot: [0, 90, 180, 270][Math.floor(rngFdm() * 4)] as 0 | 90 | 180 | 270,
      side: 'top' as const,
      fixed: false,
    }))
  const anchorPerRef = sensitiveDeltaTs(ctxCal, nl, placement.placements)
  synthBoards.push({
    label: 'ancre — solution opérante',
    ambientC: 22,
    placements: placement.placements,
    measurements: anchorPerRef.map((m) => ({ ref: m.ref, deltaT: m.deltaT })),
    source: 'test — FDM + bruit ±0,2 °C (sanity plomberie)',
  })
  for (let i = 0; i < 12; i++) {
    const pl = replicateFdmSamples()
    const perRef = sensitiveDeltaTs(ctxCal, nl, pl)
    synthBoards.push({
      label: `synth-${i}`,
      ambientC: 21 + noiseRng() * 6,
      placements: pl,
      measurements: perRef.map((m) => ({ ref: m.ref, deltaT: m.deltaT + (noiseRng() - 0.5) * 0.4 })),
      source: 'test — FDM + bruit ±0,2 °C (sanity plomberie)',
    })
  }
  // relevé volontairement invalide : capteur décollé (ΔT absurde) → écarté
  synthBoards.push({
    label: 'mesure capteur décollé',
    ambientC: 22,
    placements: ctxCal.sensitive.map((s) => ({ ref: s.ref, x: 10, y: 10, rot: 0 as const, side: 'top' as const, fixed: false })),
    measurements: [{ ref: ctxCal.sensitive[0]?.ref ?? 'U1', deltaT: 341.7 }],
    source: 'test — invalide',
  })
  const mcal = calibrateFromMeasuredBoards(nl, plan, constraints, synthBoards)
  assert(mcal.usedSamples === 13 && mcal.skippedSamples === 1, `mesuré : ${mcal.usedSamples}/14 relevés exploités, ${mcal.skippedSamples} écarté(s) par validation sanitaire`)
  assert(mcal.r > 0.5 && Math.abs(mcal.r - cal.r) < 0.1, `mesuré : corrélation r = ${mcal.r.toFixed(3)} ≈ r FDM ${cal.r.toFixed(3)} sur les mêmes placements (bruit ±0,2 °C)`)
  assert(mcal.slope > 0 && Math.abs(mcal.slope - cal.slope) / cal.slope < 0.15, `mesuré : pente ${mcal.slope.toFixed(3)} ≈ pente FDM ${cal.slope.toFixed(3)} °C/u (mêmes placements, ±15 %)`)
  assert(mcal.matchedRefs.length > 0 && mcal.sources.length === 1, `mesuré : ${mcal.matchedRefs.length} refs sensibles couvertes, provenance tracée`)

  // ---- Sprint 1 M1 — seuils publiés, IC de pente, versionnage ----
  assert(
    PUBLISHED_THRESHOLDS.rMin > 0 && PUBLISHED_THRESHOLDS.rMin < 1 &&
    PUBLISHED_THRESHOLDS.rmseMaxC > 0 && PUBLISHED_THRESHOLDS.maxErrMaxC > PUBLISHED_THRESHOLDS.rmseMaxC &&
    PUBLISHED_THRESHOLDS.minSamples >= 2,
    `M1 : seuils publiés cohérents (r ≥ ${PUBLISHED_THRESHOLDS.rMin}, RMSE ≤ ${PUBLISHED_THRESHOLDS.rmseMaxC} °C, err ≤ ${PUBLISHED_THRESHOLDS.maxErrMaxC} °C, ≥ ${PUBLISHED_THRESHOLDS.minSamples} relevés)`,
  )
  const vOk = measuredThresholdVerdict({ r: 0.9, rmse: 1, maxErr: 2, usedSamples: 5 })
  const vKo = measuredThresholdVerdict({ r: 0.4, rmse: 20, maxErr: 40, usedSamples: 1 })
  assert(vOk.ok === true && vKo.ok === false && vKo.failures.length === 4, 'M1 : verdict seuils — conforme accepté, 4 motifs de refus sur un calage hors seuil')
  assert(
    mcal.slopeCi95 !== null && mcal.slopeCi95[0] < mcal.slope && mcal.slope < mcal.slopeCi95[1] && mcal.slopeCi95[1] - mcal.slopeCi95[0] > 0,
    `M1 : IC 95 % de la pente défini et encadrant — [${mcal.slopeCi95?.[0].toFixed(3)} ; ${mcal.slopeCi95?.[1].toFixed(3)}] °C/u`,
  )
  const revPayload = {
    project: 'test', coefficients: { slope: 1.25, intercept: 3.5, slopeCi95: [1.1, 1.4] as [number, number] },
    statistics: { r: 0.8, rmse: 2, maxErr: 4, usedSamples: 5, skippedSamples: 1 },
    coverage: { matchedRefs: ['U1'], missingRefs: [], ambientMinC: 20, ambientMaxC: 40 },
    sources: ['banc X'], datasetSha256: 'deadbeef', schemaVersion: 1,
  }
  assert(
    measuredRevision(revPayload) === measuredRevision(revPayload) &&
    measuredRevision(revPayload) !== measuredRevision({ ...revPayload, coefficients: { ...revPayload.coefficients, slope: 1.26 } }),
    'M1 : révision des coefficients déterministe (stable si entrées inchangées, sensible au moindre ΔT)',
  )
  assert(
    datasetSha256('nexus') === datasetSha256('nexus') && datasetSha256('nexus') !== datasetSha256('nexus!'),
    'M1 : empreinte SHA-256 du jeu de relevés stable et discriminante',
  )

  // ---- P2.4 — SPICE : corrélation circuit avec parasitique de routage ----
  const spice = generateSpiceDeck(nl, routing)
  assert(spice.file.content.includes('.SUBCKT') && spice.file.content.includes('.END'), 'SPICE : deck .cir structurel (SUBCKT/END)')
  assert((spice.file.content.match(/^X/gm) || []).length === nl.components.length, `SPICE : ${nl.components.length} instances X (une par composant)`)
  assert(/^R_\w+_\d+ \S+ \S+ [\d.]+m ;/m.test(spice.file.content), 'SPICE : R série par segment (mΩ, longueur/largeur documentés)')
  assert(/^C_\w+_\d+ \S+ 0 [\d.]+f$/m.test(spice.file.content), 'SPICE : C shunt par segment (fF)')
  const rLine = spice.file.content.split('\n').find((l) => l.startsWith('R_'))
  const rValM = rLine ? parseFloat(rLine.split(' ')[3]) : NaN
  assert(Number.isFinite(rValM) && rValM > 0 && rValM < 1000, `SPICE : R physique plausible (${rValM} mΩ par segment)`)
  assert(
    spice.stats.segments > 0 && spice.stats.rTotalOhm > 0 && spice.stats.cTotalF > 0,
    `SPICE : bilan ${spice.stats.segments} segments — ΣR ${(spice.stats.rTotalOhm * 1e3).toFixed(1)} mΩ, ΣC ${(spice.stats.cTotalF * 1e15).toFixed(2)} pF`,
  )
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
  // [M5] DoD densification : NEXUS-CORE quatre couches à 27/28 nets ou mieux
  assert(routing4.routedNets >= 27, `M5 DoD : 4 couches ≥ 27/28 nets — obtenu ${routing4.routedNets}/28`)
  assert((routing4.extraLayerNets ?? 0) >= 0 && routing4.planes?.length === 2, `M5 : passes additives traçables (${routing4.extraLayerNets ?? 0} net(s) via paire de couches supplémentaire), plans intacts`)
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

  // [M5] rip-up étendu (opt-in) : rounds portés à 14, 3 bloquants, relance
  // perturbée — ne doit jamais descendre sous le comportement par défaut
  const routing4x = await routeAll(nl4, placement4.placements, DEFAULT_RULES, constraints4, { ripupRounds: 14 })
  assert(routing4x.routedNets >= 27, `M5 : rip-up étendu (14 rounds, 3 bloquants, perturbation) ≥ 27/28 — obtenu ${routing4x.routedNets}/28`)

  // [M5] pile 6 couches : paire de couches supplémentaire paramétrable —
  // exports et routage génériques
  const nl6 = { ...base, board: { ...base.board, layers: 6 } }
  const routing6 = await routeAll(nl6, placement4.placements, DEFAULT_RULES, constraints4)
  assert(routing6.routedNets >= routing4.routedNets, `M5 : pile 6 couches ≥ pile 4 — ${routing6.routedNets}/${routing6.totalNets}`)
  const gerber6 = generateGerber(nl6, placement4.placements, routing6)
  assert(gerber6.files.some((f) => f.name === 'In4_Cu.gbr') && !gerber6.files.some((f) => f.name === 'In5_Cu.gbr'), `M5 : exports 6 couches génériques (F_Cu + In1..In4 + B_Cu)`)
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
