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

const STAGE_DEFS: { id: StageId; label: string }[] = [
  { id: 'import', label: 'Import' },
  { id: 'constraints', label: 'Contraintes' },
  { id: 'intent', label: 'Intention LLM' },
  { id: 'placement', label: 'Placement RL' },
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
  stages: Record<StageId, StageState>
  logs: LogEntry[]
  running: boolean
  cancelled: boolean
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
  stages: initialStages(),
  logs: [{ ts: Date.now(), stage: 'system', level: 'info', msg: 'NEXUS PCB Studio prêt — sélectionnez un projet et lancez la conception autonome.' }],
  running: false,
  cancelled: false,
  result: {},
  livePlacements: null,
  costHistory: [],
  plan: null,
  constraintsCount: 0,
  viewer: { mode: '3d', showTraces: true, showHeatmap: false, showComponents: true, selectedRef: null },
  history: [],

  setProject: (id) => {
    const nl = getNetlist(id)
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
