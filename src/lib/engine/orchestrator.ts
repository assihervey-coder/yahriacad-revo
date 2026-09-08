/**
 * NEXUS PCB — Orchestrateur de workflow
 * Équivalent : backend/orchestrator/ (Prefect) — pipelines/ + tasks/
 *
 * Enchaîne les étapes : import → contraintes → intention (LLM) →
 * placement (RL) → optimisation ratchet [AutoPCB] → thermique →
 * routage (+ minimisation des vias [DeepPCB]) → DRC/DFM → export
 * (+ firmware bridge [Flux.ai]).
 * Chaque étape émet logs + progression vers le store zustand (temps réel),
 * et supporte l'annulation utilisateur. Les états critiques sont audités
 * par le self-verifier déterministe [Siemens Fuse] avec rollback.
 */
import type {
  AgentPlan, Constraint, DesignResult, Netlist, PlacedComponent, StageId,
} from './types'
import { DEFAULT_RULES } from './rules'
import { extractConstraints, parseNetlist } from './parser'
import { requestPlan, ruleBasedPlan } from './llm-agent'
import { optimizePlacement } from './placer'
import { ratchetOptimize } from './optimizer'
import { verifyPlacement, verifyRouting, rollbackPlacement } from './self-verifier'
import { generateFirmwareBridge } from './firmware'
import { analyzeSi, solveThermal } from './simulator'
import { routeAll } from './router'
import { runDfm, runDrc } from './drc'
import { generateGerber } from './gerber'
import { legalizePlacement } from './placer'

export interface PipelineCallbacks {
  onLog: (stage: StageId | 'system', level: 'info' | 'success' | 'warn' | 'error' | 'agent', msg: string) => void
  onStage: (id: StageId, status: 'running' | 'done' | 'error', progress: number, detail: string, durationMs?: number) => void
  onPlan: (p: AgentPlan) => void
  onPlacements: (p: PlacedComponent[]) => void
  onCostHistory: (h: number[]) => void
  shouldCancel: () => boolean
}

export interface PipelineOptions {
  /** 'llm' (défaut) : consultation de l'agent LLM avec repli règles · 'rules' : direct règles */
  planMode?: 'llm' | 'rules'
  /** Nombre de propositions de la boucle ratchet (défaut 300) */
  ratchetProposals?: number
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0))

export async function runPipeline(
  nl: Netlist, cb: PipelineCallbacks, opts: PipelineOptions = {},
): Promise<DesignResult> {
  const rules = DEFAULT_RULES
  const cancelErr = () => new Error('ANNULÉ')

  /* ---------------------- 1. IMPORT / PARSING ---------------------- */
  cb.onStage('import', 'running', 0, 'Analyse de la netlist…')
  await yieldToUi()
  const parsed = parseNetlist(nl)
  for (const e of parsed.errors) cb.onLog('import', 'error', e)
  for (const w of parsed.warnings.slice(0, 6)) cb.onLog('import', 'warn', w)
  if (!parsed.ok) {
    cb.onStage('import', 'error', 1, 'Netlist invalide')
    throw new Error('Netlist invalide : corriger les erreurs de références')
  }
  cb.onLog('import', 'info', `Netlist validée : ${parsed.stats.components} composants, ${parsed.stats.nets} nets, ${parsed.stats.connectedPins} broches connectées`)
  cb.onLog('import', 'info', `Carte : ${parsed.stats.boardMm}`)
  const cls = parsed.stats.netClasses
  cb.onLog('import', 'info', `Classes de signaux : ${Object.entries(cls).map(([k, v]) => `${k}×${v}`).join(' · ')}`)
  cb.onStage('import', 'done', 1, `${parsed.stats.components} composants · ${parsed.stats.nets} nets`, 0)

  /* ---------------------- 2. CONTRAINTES ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onStage('constraints', 'running', 0, 'Extraction des contraintes implicites…')
  await yieldToUi()
  const constraints = extractConstraints(nl)
  for (const c of constraints) cb.onLog('constraints', 'info', `[${c.severity === 'hard' ? 'BLOQUANTE' : 'souple'}] ${c.rationale}`)
  cb.onStage('constraints', 'done', 1, `${constraints.length} contraintes extraites`, 0)

  /* ---------------------- 3. INTENTION (LLM) ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onStage('intent', 'running', 0, 'Consultation de l’agent LLM…')
  await yieldToUi()
  const plan = opts.planMode === 'rules' ? ruleBasedPlan(nl) : await requestPlan(nl, constraints, (m) => cb.onLog('intent', 'agent', m))
  cb.onPlan(plan)
  cb.onLog('intent', 'agent', `Plan stratégique reçu (source : ${plan.source === 'llm' ? 'LLM' : 'règles expertes'})`)
  cb.onLog('intent', 'agent', plan.strategy)
  const majorZones = plan.zones.filter((z) => ['U1', 'U2', 'U3', 'U4', 'U5'].includes(z.ref) || nl.components.find((c) => c.ref === z.ref && ['mcu', 'rf', 'power', 'sensor'].includes(c.category)))
  for (const z of majorZones.slice(0, 8)) cb.onLog('intent', 'agent', `  ${z.ref} → ${z.zone} : ${z.rationale}`)
  cb.onStage('intent', 'done', 1, `Plan ${plan.source === 'llm' ? 'LLM' : 'règles'} : ${plan.zones.length} zones`, 0)

  /* ---------------------- 4. PLACEMENT (RL + WORLD MODEL) ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onStage('placement', 'running', 0, 'Recuit simulé en cours…')
  const placement = optimizePlacement(nl, plan, constraints, {
    iterations: 9000,
    onProgress: ({ iter, total, cost, placements }) => {
      cb.onStage('placement', 'running', iter / total, `Itération ${iter}/${total} — coût ${cost.toFixed(0)}`)
      cb.onPlacements(placements)
    },
    shouldCancel: cb.shouldCancel,
  })
  if (cb.shouldCancel()) throw cancelErr()
  cb.onPlacements(placement.placements)
  cb.onCostHistory(placement.history)
  const c = placement.cost
  cb.onLog('placement', 'success', `Convergé en ${placement.iterations} itérations (${placement.durationMs} ms)`)
  cb.onLog('placement', 'info', `Coût final : HPWL ${c.hpwl.toFixed(0)} · chevauchement ${c.overlap.toFixed(0)} · thermique ${c.thermal.toFixed(0)} · contraintes ${c.constraint.toFixed(0)}`)
  cb.onStage('placement', 'done', 1, `Coût ${c.total.toFixed(0)} — ${placement.iterations} itérations`, placement.durationMs)

  /* ---------------- 4b. OPTIMISATION AUTONOME (RATCHET [AutoPCB]) ---------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onStage('optimize', 'running', 0, 'Boucle ratchet : proposer → évaluer → garder…')
  await yieldToUi()
  const ratchet = ratchetOptimize(nl, plan, constraints, placement.placements, {
    proposals: opts.ratchetProposals ?? 300,
    onProgress: ({ round, total, best, accepted, placements }) => {
      cb.onStage('optimize', 'running', round / total, `Proposition ${round + 1}/${total} — coût ${best.toFixed(0)} (${accepted} gardées)`)
      cb.onPlacements(placements)
    },
    shouldCancel: cb.shouldCancel,
  })
  if (cb.shouldCancel()) throw cancelErr()
  cb.onPlacements(ratchet.placements)
  cb.onCostHistory([...placement.history, ...ratchet.history])
  cb.onLog('optimize', 'agent', `[AutoPCB] ${ratchet.accepted}/${ratchet.proposals} propositions retenues — coût ${ratchet.costBefore.toFixed(0)} → ${ratchet.costAfter.toFixed(0)} (−${ratchet.gainPct} %) en ${ratchet.durationMs} ms`)
  cb.onStage('optimize', 'done', 1, `${ratchet.accepted} améliorations · −${ratchet.gainPct} %`, ratchet.durationMs)

  /* ---------------- 4c. AUTO-VÉRIFICATION PHYSIQUE [Siemens Fuse] ---------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onLog('optimize', 'info', '[FUSE] Audit déterministe du placement (moteur indépendant)…')
  await yieldToUi()
  const auditBefore = verifyPlacement(nl, ratchet.placements, constraints)
  const rollback = auditBefore.pass
    ? { placements: ratchet.placements, rolledBack: false, notes: ['Placement conforme d’emblée (audit déterministe)'] }
    : rollbackPlacement(nl, ratchet.placements, constraints, legalizePlacement)
  if (rollback.rolledBack) {
    cb.onPlacements(rollback.placements)
    for (const n of rollback.notes) cb.onLog('optimize', 'warn', `[FUSE] ${n}`)
  } else {
    cb.onLog('optimize', 'success', '[FUSE] Placement conforme : bornes, chevauchements, keepouts, bords ✓')
  }
  const auditP = verifyPlacement(nl, rollback.placements, constraints)
  const finalPlacements = rollback.placements
  const finalPlacement = {
    ...placement,
    placements: finalPlacements,
    iterations: placement.iterations + ratchet.accepted,
    durationMs: placement.durationMs + ratchet.durationMs,
  }

  /* ---------------------- 5. THERMIQUE ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onStage('thermal', 'running', 0, 'Solveur différences finies…')
  await yieldToUi()
  const thermal = solveThermal(nl, finalPlacements)
  cb.onLog('thermal', 'info', `Régime permanent : ${thermal.cols}×${thermal.rows} cellules (1 mm)`)
  cb.onLog('thermal', 'success', `ΔT max ${thermal.maxT.toFixed(1)} °C (amb. ${thermal.minT.toFixed(1)} °C)`)
  for (const h of thermal.hotspots.slice(0, 3)) cb.onLog('thermal', 'info', `Point chaud : ${h.ref} à ${h.t.toFixed(1)} °C`)
  cb.onStage('thermal', 'done', 1, `Max ${thermal.maxT.toFixed(1)} °C`, 0)

  /* ---------------------- 6. ROUTAGE ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onStage('routing', 'running', 0, 'Routeur maze A* multicouche…')
  await yieldToUi()
  const routing = routeAll(nl, finalPlacements, rules, constraints, {
    onProgress: ({ done, total, net, ok }) => {
      cb.onStage('routing', 'running', done / total, `Net ${done}/${total} : ${net}${ok ? '' : ' ✗'}`)
      if (done % 5 === 0 || done === total) cb.onLog('routing', ok ? 'info' : 'warn', `${ok ? 'Routé' : 'ÉCHEC'} : ${net} (${done}/${total})`)
    },
    shouldCancel: cb.shouldCancel,
  })
  if (cb.shouldCancel()) throw cancelErr()
  cb.onLog('routing', routing.routedNets === routing.totalNets ? 'success' : 'warn',
    `${routing.routedNets}/${routing.totalNets} nets routés · ${routing.totalLengthMm.toFixed(0)} mm de pistes · ${routing.viaCount} vias (${routing.durationMs} ms)${routing.viasRemoved ? ` — dont −${routing.viasRemoved} via(s) [DeepPCB]` : ''}`)
  for (const r of routing.routes.filter((x) => !x.routed)) cb.onLog('routing', 'warn', `Net non routé : ${r.net} — ${r.failureReason}`)
  cb.onStage('routing', 'done', 1, `${routing.routedNets}/${routing.totalNets} nets · ${routing.viaCount} vias`, routing.durationMs)

  /* ---------------------- 6b. INTÉGRITÉ DU SIGNAL ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onLog('routing', 'info', 'Analyse intégrité du signal (impédance microstrip + skew)…')
  await yieldToUi()
  const routeMap = new Map(routing.routes.map((r) => [r.net, r]))
  const si = analyzeSi(nl, routeMap, (cls) => rules.widths[cls as keyof typeof rules.widths] ?? 0.25, constraints)
  cb.onLog('routing', si.pass ? 'success' : 'warn', `SI : ${si.metrics.length} nets analysés — ${si.pass ? 'conforme (impédance, skew, diaphonie)' : 'écarts signalés'}`)

  /* ---------------- 6c. AUDIT ROUTAGE [Siemens Fuse] ---------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onLog('routing', 'info', '[FUSE] Audit déterministe du routage (ouverts, largeurs, clearances)…')
  await yieldToUi()
  const auditR = verifyRouting(nl, routing, rules)
  if (auditR.pass) {
    cb.onLog('routing', 'success', '[FUSE] Routage conforme : 0 ouvert, largeurs/perçages/clearances OK ✓')
  } else {
    for (const v of auditR.violations.slice(0, 6)) cb.onLog('routing', 'warn', `[FUSE] ${v.code} : ${v.message}`)
    cb.onLog('routing', 'warn', `[FUSE] ${auditR.violations.length} écart(s) transmis(s) au DRC pour arbitrage`)
  }
  const verification = {
    placementPass: auditP.pass,
    placementViolations: auditP.violations.map((v) => `${v.code} : ${v.message}`),
    routingPass: auditR.pass,
    routingViolations: auditR.violations.map((v) => `${v.code} : ${v.message}`),
    rolledBack: rollback.rolledBack,
    notes: rollback.notes,
  }

  /* ---------------------- 7. DRC / DFM ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onStage('drc', 'running', 0, 'Vérification design rules…')
  await yieldToUi()
  const drc = runDrc(nl, finalPlacements, routing, thermal, rules, constraints)
  const dfm = runDfm(nl, finalPlacements, routing, rules)
  for (const v of drc.violations.slice(0, 10)) cb.onLog('drc', v.severity === 'error' ? 'error' : v.severity === 'warning' ? 'warn' : 'info', `${v.code} — ${v.message}`)
  cb.onLog('drc', drc.pass ? 'success' : 'warn', `DRC : ${drc.errors} erreur(s), ${drc.warnings} avertissement(s) (${drc.durationMs} ms)`)
  cb.onLog('drc', 'info', `DFM score usine : ${dfm.score}/100 — occupation ${dfm.utilizationPct}%`)
  cb.onStage('drc', 'done', 1, `${drc.errors} erreur(s) · DFM ${dfm.score}/100`, drc.durationMs)

  /* ---------------------- 8. EXPORT + FIRMWARE BRIDGE ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onStage('export', 'running', 0, 'Génération Gerber RS-274X + firmware…')
  await yieldToUi()
  const gerber = generateGerber(nl, finalPlacements, routing)
  const fw = generateFirmwareBridge(nl)
  gerber.files.push(...fw.files)
  cb.onLog('export', 'success', `Package fabrication : ${gerber.files.length} fichiers — ${gerber.padCount} pads, ${gerber.viaCount} vias, ${gerber.traceCount} pistes`)
  cb.onLog('export', 'agent', `[FLUX] Firmware bridge : ${fw.pinCount} broches exportées vers NEXUS_pinmap.h / .overlay / .json (HW/SW synchronisés)`)
  cb.onStage('export', 'done', 1, `${gerber.files.length} fichiers · ${fw.pinCount} broches firmware`, 0)

  return {
    plan, placement: finalPlacement, thermal, si, routing, drc, dfm, gerber,
    optimization: {
      proposals: ratchet.proposals,
      accepted: ratchet.accepted,
      costBefore: ratchet.costBefore,
      costAfter: ratchet.costAfter,
      gainPct: ratchet.gainPct,
      durationMs: ratchet.durationMs,
    },
    verification,
  }
}
