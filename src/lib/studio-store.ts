/**
 * NEXUS PCB — Store d'état global (zustand)
 * Équivalent : frontend/src/stores/ + services API WebSocket (live updates)
 */
import { create } from 'zustand'
import type {
  AgentPlan, DesignResult, LogEntry, Netlist, PlacedComponent, StageId, StageState,
} from '@/lib/engine/types'
import { NETLISTS, getNetlist } from '@/lib/engine/netlists'
import { runPipeline } from '@/lib/engine/orchestrator'
import { extractConstraints } from '@/lib/engine/parser'
import { routeAll } from '@/lib/engine/router'
import { analyzeSi } from '@/lib/engine/simulator'
import { runDfm, runDrc } from '@/lib/engine/drc'
import { generateGerber } from '@/lib/engine/gerber'
import { generateFirmwareBridge } from '@/lib/engine/firmware'
import { DEFAULT_RULES } from '@/lib/engine/rules'

const STAGE_DEFS: { id: StageId; label: string }[] = [
  { id: 'import', label: 'Import' },
  { id: 'constraints', label: 'Contraintes' },
  { id: 'intent', label: 'Intention LLM' },
  { id: 'placement', label: 'Placement RL' },
  { id: 'optimize', label: 'Optimisation' },
  { id: 'thermal', label: 'Thermique' },
  { id: 'routing', label: 'Routage' },
  { id: 'drc', label: 'DRC/DFM' },
  { id: 'export', label: 'Export' },
]

const initialStages = (): Record<StageId, StageState> =>
  Object.fromEntries(
    STAGE_DEFS.map((s) => [s.id, { id: s.id, label: s.label, status: 'pending' as const, progress: 0, detail: '' }]),
  ) as Record<StageId, StageState>

export interface RunHistoryItem {
  id: string
  status: string
  planSource: string
  routedNets: number
  totalNets: number
  dfmScore: number
  maxTempC: number
  durationMs: number
  createdAt: string
}

interface StudioState {
  netlistId: string
  netlist: Netlist
  customNetlists: Netlist[]
  stages: Record<StageId, StageState>
  logs: LogEntry[]
  running: boolean
  cancelled: boolean
  surgicalBusy: boolean
  result: Partial<DesignResult>
  livePlacements: PlacedComponent[] | null
  costHistory: number[]
  plan: AgentPlan | null
  constraintsCount: number
  viewer: {
    mode: '3d' | '2d'
    showTraces: boolean
    showHeatmap: boolean
    showComponents: boolean
    selectedRef: string | null
  }
  history: RunHistoryItem[]
  setProject: (id: string) => void
  addCustomNetlist: (nl: Netlist) => void
  surgicalMove: (ref: string, dx: number, dy: number) => Promise<void>
  log: (stage: LogEntry['stage'], level: LogEntry['level'], msg: string) => void
  run: () => Promise<void>
  cancel: () => void
  reset: () => void
  setViewer: (patch: Partial<StudioState['viewer']>) => void
  loadHistory: () => Promise<void>
}

let cancelFlag = false

export const useStudio = create<StudioState>((set, get) => ({
  netlistId: NETLISTS[0].id,
  netlist: NETLISTS[0],
  customNetlists: [],
  stages: initialStages(),
  logs: [{ ts: Date.now(), stage: 'system', level: 'info', msg: 'NEXUS PCB Studio prêt — sélectionnez un projet et lancez la conception autonome.' }],
  running: false,
  cancelled: false,
  surgicalBusy: false,
  result: {},
  livePlacements: null,
  costHistory: [],
  plan: null,
  constraintsCount: 0,
  viewer: { mode: '3d', showTraces: true, showHeatmap: false, showComponents: true, selectedRef: null },
  history: [],

  setProject: (id) => {
    const nl = get().customNetlists.find((x) => x.id === id) ?? getNetlist(id)
    set({
      netlistId: id,
      netlist: nl,
      stages: initialStages(),
      result: {},
      livePlacements: null,
      costHistory: [],
      plan: null,
      constraintsCount: extractConstraints(nl).length,
      logs: [{ ts: Date.now(), stage: 'system', level: 'info', msg: `Projet chargé : ${nl.name} — ${nl.description}` }],
      viewer: { ...get().viewer, selectedRef: null },
    })
    void get().loadHistory()
  },

  addCustomNetlist: (nl) => {
    set((s) => ({ customNetlists: [...s.customNetlists.filter((x) => x.id !== nl.id), nl] }))
    get().setProject(nl.id)
  },

  /* ---------------- Éditeur chirurgical [Flux.ai] ----------------
   * Modification localisée SANS relancer la conception : déplacement
   * fin d'un composant, puis re-routage + DRC/DFM + ré-export.
   * Le placement des autres composants et la thermique sont préservés. */
  surgicalMove: async (ref, dx, dy) => {
    const s = get()
    if (s.running || s.surgicalBusy || !s.livePlacements || !s.result.thermal) return
    set({ surgicalBusy: true, livePlacements: s.livePlacements.map((p) => p.ref === ref ? { ...p, x: p.x + dx, y: p.y + dy } : p) })
    const t0 = Date.now()
    get().log('system', 'agent', `[CHIRURGIE] ${ref} déplacé de (${dx > 0 ? '+' : ''}${dx}, ${dy > 0 ? '+' : ''}${dy}) mm — re-routage incrémental…`)
    await new Promise((r) => setTimeout(r, 40)) // laisse le viewer rafraîchir
    try {
      const placements = get().livePlacements!
      const nl = get().netlist
      // Ramène le composant dans la carte si le déplacement le fait sortir
      const clamped = placements.map((p) => {
        const c = nl.components.find((x) => x.ref === p.ref)
        if (!c || p.ref !== ref) return p
        const swap = p.rot === 90 || p.rot === 270
        const w = swap ? c.footprint.h : c.footprint.w
        const h = swap ? c.footprint.w : c.footprint.h
        return {
          ...p,
          x: Math.min(nl.board.w - w / 2 - 0.4, Math.max(w / 2 + 0.4, p.x)),
          y: Math.min(nl.board.h - h / 2 - 0.4, Math.max(h / 2 + 0.4, p.y)),
        }
      })
      const constraints = extractConstraints(nl)
      const routing = routeAll(nl, clamped, DEFAULT_RULES, constraints)
      const routeMap = new Map(routing.routes.map((r) => [r.net, r]))
      const si = analyzeSi(nl, routeMap, (cls) => DEFAULT_RULES.widths[cls as keyof typeof DEFAULT_RULES.widths] ?? 0.25, constraints)
      const drc = runDrc(nl, clamped, routing, get().result.thermal!, DEFAULT_RULES, constraints)
      const dfm = runDfm(nl, clamped, routing, DEFAULT_RULES)
      const gerber = generateGerber(nl, clamped, routing)
      gerber.files.push(...generateFirmwareBridge(nl).files)
      set((st) => ({
        livePlacements: clamped,
        result: { ...st.result, routing, si, drc, dfm, gerber },
        surgicalBusy: false,
      }))
      get().log('system', 'success', `[CHIRURGIE] Terminé en ${Date.now() - t0} ms — ${routing.routedNets}/${routing.totalNets} nets · ${routing.viaCount} vias${routing.viasRemoved ? ` (−${routing.viasRemoved})` : ''} · DRC ${drc.errors} erreur(s) · placement et thermique préservés`)
    } catch (e) {
      set({ surgicalBusy: false })
      get().log('system', 'error', `[CHIRURGIE] échec : ${e instanceof Error ? e.message : 'erreur inconnue'}`)
    }
  },

  log: (stage, level, msg) =>
    set((s) => ({ logs: [...s.logs.slice(-400), { ts: Date.now(), stage, level, msg }] })),

  reset: () => {
    cancelFlag = false
    set({ stages: initialStages(), result: {}, livePlacements: null, costHistory: [], plan: null, running: false, cancelled: false })
  },

  cancel: () => {
    cancelFlag = true
    set({ cancelled: true })
    get().log('system', 'warn', 'Annulation demandée — arrêt propre du pipeline…')
  },

  run: async () => {
    if (get().running) return
    cancelFlag = false
    const nl = get().netlist
    set({
      running: true, cancelled: false,
      stages: initialStages(), result: {}, livePlacements: null, costHistory: [], plan: null,
    })
    const t0 = Date.now()
    get().log('system', 'info', `═══ DÉBUT DE CONCEPTION AUTONOME — ${nl.name} ═══`)

    try {
      const result = await runPipeline(nl, {
        onLog: (stage, level, msg) => get().log(stage, level, msg),
        onStage: (id, status, progress, detail, durationMs) =>
          set((s) => ({
            stages: { ...s.stages, [id]: { ...s.stages[id], status, progress, detail, durationMs } },
          })),
        onPlan: (p) => set({ plan: p }),
        onPlacements: (p) => set({ livePlacements: [...p] }),
        onCostHistory: (h) => { if (h.length) set({ costHistory: h }) },
        shouldCancel: () => cancelFlag,
      })

      const routeRate = result.routing.routedNets / Math.max(1, result.routing.totalNets)
      const status = result.drc.errors === 0 && routeRate >= 0.98 ? 'success' : routeRate > 0.8 ? 'partial' : 'error'
      set({ result, running: false })
      get().log('system', status === 'success' ? 'success' : 'warn',
        `═══ CONCEPTION TERMINÉE en ${((Date.now() - t0) / 1000).toFixed(1)} s — DFM ${result.dfm.score}/100, ${result.drc.errors} erreur(s) DRC ═══`)

      // Persistance de l'historique (boucle d'amélioration continue)
      void fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          netlistId: nl.id,
          status,
          planSource: result.plan.source,
          costHpwl: result.placement.cost.hpwl,
          costThermal: result.placement.cost.thermal,
          costConstraint: result.placement.cost.constraint,
          routedNets: result.routing.routedNets,
          totalNets: result.routing.totalNets,
          viaCount: result.routing.viaCount,
          totalLengthMm: result.routing.totalLengthMm,
          drcErrors: result.drc.errors,
          drcWarnings: result.drc.warnings,
          dfmScore: result.dfm.score,
          maxTempC: result.thermal.maxT,
          durationMs: Date.now() - t0,
        }),
      }).then(() => get().loadHistory()).catch(() => undefined)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erreur inconnue'
      const cancelled = msg === 'ANNULÉ'
      set({ running: false, cancelled })
      get().log('system', cancelled ? 'warn' : 'error', cancelled ? '═══ PIPELINE ANNULÉ PAR L’UTILISATEUR ═══' : `═══ ÉCHEC DU PIPELINE : ${msg} ═══`)
      if (!cancelled) {
        set((s) => {
          const stages = { ...s.stages }
          const failing = Object.values(stages).find((st) => st.status === 'running')
          if (failing) stages[failing.id] = { ...failing, status: 'error', detail: msg }
          return { stages }
        })
      }
    }
  },

  setViewer: (patch) => set((s) => ({ viewer: { ...s.viewer, ...patch } })),

  loadHistory: async () => {
    try {
      const res = await fetch(`/api/runs?netlistId=${get().netlistId}`)
      const data = await res.json() as { runs?: RunHistoryItem[] }
      set({ history: data.runs ?? [] })
    } catch {
      set({ history: [] })
    }
  },
}))
