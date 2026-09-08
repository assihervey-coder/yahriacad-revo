/**
 * NEXUS PCB — Orchestrateur de workflow
 * Équivalent : backend/orchestrator/ (Prefect) — pipelines/ + tasks/
 *
 * Enchaîne les étapes : import → contraintes → intention (LLM) →
 * placement (RL) → thermique → routage → DRC/DFM → export.
 * Chaque étape émet logs + progression vers le store zustand (temps réel),
 * et supporte l'annulation utilisateur.
 */
import type {
  AgentPlan, Constraint, DesignResult, Netlist, PlacedComponent, StageId,
} from './types'
import { DEFAULT_RULES } from './rules'
import { extractConstraints, parseNetlist } from './parser'
import { requestPlan, ruleBasedPlan } from './llm-agent'
import { optimizePlacement } from './placer'
import { analyzeSi, solveThermal } from './simulator'
import { routeAll } from './router'
import { runDfm, runDrc } from './drc'
import { generateGerber } from './gerber'

export interface PipelineCallbacks {
  onLog: (stage: StageId | 'system', level: 'info' | 'success' | 'warn' | 'error' | 'agent', msg: string) => void
  onStage: (id: StageId, status: 'running' | 'done' | 'error', progress: number, detail: string, durationMs?: number) => void
  onPlan: (p: AgentPlan) => void
  onPlacements: (p: PlacedComponent[]) => void
  onCostHistory: (h: number[]) => void
  shouldCancel: () => boolean
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0))

export async function runPipeline(nl: Netlist, cb: PipelineCallbacks): Promise<DesignResult> {
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
  const plan = await requestPlan(nl, constraints, (m) => cb.onLog('intent', 'agent', m))
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

  /* ---------------------- 5. THERMIQUE ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onStage('thermal', 'running', 0, 'Solveur différences finies…')
  await yieldToUi()
  const thermal = solveThermal(nl, placement.placements)
  cb.onLog('thermal', 'info', `Régime permanent : ${thermal.cols}×${thermal.rows} cellules (1 mm)`)
  cb.onLog('thermal', 'success', `ΔT max ${thermal.maxT.toFixed(1)} °C (amb. ${thermal.minT.toFixed(1)} °C)`)
  for (const h of thermal.hotspots.slice(0, 3)) cb.onLog('thermal', 'info', `Point chaud : ${h.ref} à ${h.t.toFixed(1)} °C`)
  cb.onStage('thermal', 'done', 1, `Max ${thermal.maxT.toFixed(1)} °C`, 0)

  /* ---------------------- 6. ROUTAGE ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onStage('routing', 'running', 0, 'Routeur maze A* multicouche…')
  await yieldToUi()
  const routing = routeAll(nl, placement.placements, rules, constraints, {
    onProgress: ({ done, total, net, ok }) => {
      cb.onStage('routing', 'running', done / total, `Net ${done}/${total} : ${net}${ok ? '' : ' ✗'}`)
      if (done % 5 === 0 || done === total) cb.onLog('routing', ok ? 'info' : 'warn', `${ok ? 'Routé' : 'ÉCHEC'} : ${net} (${done}/${total})`)
    },
    shouldCancel: cb.shouldCancel,
  })
  if (cb.shouldCancel()) throw cancelErr()
  cb.onLog('routing', routing.routedNets === routing.totalNets ? 'success' : 'warn',
    `${routing.routedNets}/${routing.totalNets} nets routés · ${routing.totalLengthMm.toFixed(0)} mm de pistes · ${routing.viaCount} vias (${routing.durationMs} ms)`)
  for (const r of routing.routes.filter((x) => !x.routed)) cb.onLog('routing', 'warn', `Net non routé : ${r.net} — ${r.failureReason}`)
  cb.onStage('routing', 'done', 1, `${routing.routedNets}/${routing.totalNets} nets · ${routing.viaCount} vias`, routing.durationMs)

  /* ---------------------- 6b. INTÉGRITÉ DU SIGNAL ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onLog('routing', 'info', 'Analyse intégrité du signal (impédance microstrip + skew)…')
  await yieldToUi()
  const routeMap = new Map(routing.routes.map((r) => [r.net, r]))
  const si = analyzeSi(nl, routeMap, (cls) => rules.widths[cls as keyof typeof rules.widths] ?? 0.25, constraints)
  cb.onLog('routing', si.pass ? 'success' : 'warn', `SI : ${si.metrics.length} nets analysés — ${si.pass ? 'conforme' : 'écarts signalés'}`)

  /* ---------------------- 7. DRC / DFM ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onStage('drc', 'running', 0, 'Vérification design rules…')
  await yieldToUi()
  const drc = runDrc(nl, placement.placements, routing, thermal, rules, constraints)
  const dfm = runDfm(nl, placement.placements, routing, rules)
  for (const v of drc.violations.slice(0, 10)) cb.onLog('drc', v.severity === 'error' ? 'error' : v.severity === 'warning' ? 'warn' : 'info', `${v.code} — ${v.message}`)
  cb.onLog('drc', drc.pass ? 'success' : 'warn', `DRC : ${drc.errors} erreur(s), ${drc.warnings} avertissement(s) (${drc.durationMs} ms)`)
  cb.onLog('drc', 'info', `DFM score usine : ${dfm.score}/100 — occupation ${dfm.utilizationPct}%`)
  cb.onStage('drc', 'done', 1, `${drc.errors} erreur(s) · DFM ${dfm.score}/100`, drc.durationMs)

  /* ---------------------- 8. EXPORT ---------------------- */
  if (cb.shouldCancel()) throw cancelErr()
  cb.onStage('export', 'running', 0, 'Génération Gerber RS-274X…')
  await yieldToUi()
  const gerber = generateGerber(nl, placement.placements, routing)
  cb.onLog('export', 'success', `Package fabrication : ${gerber.files.length} fichiers — ${gerber.padCount} pads, ${gerber.viaCount} vias, ${gerber.traceCount} pistes`)
  cb.onStage('export', 'done', 1, `${gerber.files.length} fichiers · ${gerber.padCount} pads`, 0)

  return { plan, placement, thermal, si, routing, drc, dfm, gerber }
}
