/**
 * NEXUS PCB — Store d'état global (zustand)
 * Équivalent : frontend/src/stores/ + services API WebSocket (live updates)
 */
import { create } from 'zustand'
import type {
  AgentPlan, DesignResult, LogEntry, Netlist, PlacedComponent, Route, RoutingSolution,
  StageId, StageState, TraceSegment, Via,
} from '@/lib/engine/types'
import type { RouterPhase, TraceEvent } from '@/lib/engine/router'
import { NETLISTS, getNetlist } from '@/lib/engine/netlists'
import { runPipeline } from '@/lib/engine/orchestrator'
import { extractConstraints } from '@/lib/engine/parser'
import { routeAll } from '@/lib/engine/router'
import { analyzeSi, solveThermal } from '@/lib/engine/simulator'
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

/* ---------------- Routage live [DeepPCB live_routing] ---------------- */

export type LivePhase = RouterPhase | 'idle' | 'done'

export interface LiveRoutingState {
  active: boolean
  phase: LivePhase
  netsTotal: number
  netsDone: number
  currentNet: string
  traces: number
  /** 'server' = flux SSE du routeur serveur · 'pipeline' = passe de routage du pipeline local */
  source: 'server' | 'pipeline' | 'none'
  /** Dernier point posé — la « tête » du routeur, affichée avec une lueur */
  lastPoint: { x: number; y: number } | null
}

const idleLive = (): LiveRoutingState => ({
  active: false, phase: 'idle', netsTotal: 0, netsDone: 0,
  currentNet: '—', traces: 0, source: 'none', lastPoint: null,
})

type LiveSseEvent =
  | { t: 'hello'; total: number }
  | { t: 'phase'; phase: RouterPhase }
  | { t: 'progress'; done: number; total: number; net: string; ok: boolean }
  | { t: 'segment'; net: string; segment: TraceSegment }
  | { t: 'via'; net: string; via: Via }
  | { t: 'complete'; result: RoutingSolution }
  | { t: 'error'; message: string }

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
  liveRouting: LiveRoutingState
  liveRoutes: Route[]
  /** Vitesse de lecture du flux live : 0.5 | 1 | 2 | 4 */
  liveSpeed: number
  setProject: (id: string) => void
  addCustomNetlist: (nl: Netlist) => void
  surgicalMove: (ref: string, dx: number, dy: number) => Promise<void>
  log: (stage: LogEntry['stage'], level: LogEntry['level'], msg: string) => void
  run: () => Promise<void>
  cancel: () => void
  reset: () => void
  setViewer: (patch: Partial<StudioState['viewer']>) => void
  loadHistory: () => Promise<void>
  /* Routage live [DeepPCB] */
  startLiveRouting: (pacingMs?: number) => Promise<void>
  stopLiveRouting: (reason?: 'user' | 'nudge') => void
  setLiveSpeed: (v: number) => void
  /** Nudge chirurgical PENDANT un flux live : coupe le flux, déplace, repart en direct */
  liveNudge: (ref: string, dx: number, dy: number) => Promise<void>
  beginLiveRouting: (source: 'server' | 'pipeline') => void
  pushLiveTrace: (ev: TraceEvent) => void
  dropLiveNet: (net: string) => void
  setLiveProgress: (p: { done: number; total: number; net: string; ok: boolean }) => void
  setLivePhase: (phase: LivePhase) => void
  endLiveRouting: () => void
}

let cancelFlag = false
let liveAbort: AbortController | null = null

/* --- Moteur de lecture du flux live [DeepPCB] --------------------------------
 * Le réseau pousse les événements à son rythme filaire ; le DESSIN, lui, est
 * cadencé localement : un événement joué toutes les BASE_TICK_MS / liveSpeed.
 * La vitesse (×0.5 → ×4) se règle donc EN PLEIN VOL sans toucher au serveur,
 * et la file garantit que traces / phases / progression restent cohérents. */
const BASE_TICK_MS = 14 // tempo visuel à ×1 — le rythme DeepPCB d'origine

type LiveQueued =
  | { k: 'trace'; ev: TraceEvent }
  | { k: 'progress'; p: { done: number; total: number; net: string; ok: boolean } }
  | { k: 'phase'; phase: LivePhase }
  | { k: 'hello'; total: number }
  | { k: 'complete'; result: RoutingSolution }

let liveQueue: LiveQueued[] = []
let liveTimer: ReturnType<typeof setTimeout> | null = null
let liveStreamDone = false
let liveSawComplete = false
let liveStopReason: 'user' | 'nudge' | null = null
let liveT0 = 0

/** Joue un événement de la file : trace visible, métadonnées HUD, ou finalisation. */
function liveApplyQueued(q: LiveQueued) {
  const st = useStudio.getState()
  if (q.k === 'trace') { st.pushLiveTrace(q.ev); return }
  if (q.k === 'progress') {
    st.setLiveProgress(q.p)
    if (!q.p.ok) st.dropLiveNet(q.p.net) // retire les traces fantômes d'un net en échec
    return
  }
  if (q.k === 'phase') { st.setLivePhase(q.phase); return }
  if (q.k === 'hello') { st.setLiveProgress({ done: 0, total: q.total, net: '—', ok: true }); return }
  /* k === 'complete' — finalisation canonique : la solution intègre déjà le
   * via-minimizer et le plan de masse ; on régénère SI + DRC/DFM + export. */
  liveSawComplete = true
  const routing = q.result
  const nl = st.netlist
  const placements = st.livePlacements ?? []
  const constraints = extractConstraints(nl)
  const routeMap = new Map(routing.routes.map((r) => [r.net, r]))
  const si = analyzeSi(nl, routeMap, (cls) => DEFAULT_RULES.widths[cls as keyof typeof DEFAULT_RULES.widths] ?? 0.25, constraints)
  const thermal = st.result.thermal ?? solveThermal(nl, placements)
  const drc = runDrc(nl, placements, routing, thermal, DEFAULT_RULES, constraints)
  const dfm = runDfm(nl, placements, routing, DEFAULT_RULES)
  const gerber = generateGerber(nl, placements, routing)
  gerber.files.push(...generateFirmwareBridge(nl).files)
  useStudio.setState((s2) => ({ result: { ...s2.result, routing, si, thermal, drc, dfm, gerber } }))
  useStudio.getState().log('system', 'success',
    `[DEEPPCB] Routage live terminé en ${((Date.now() - liveT0) / 1000).toFixed(1)} s — ${routing.routedNets}/${routing.totalNets} nets · ${routing.viaCount} vias${routing.viasRemoved ? ` (−${routing.viasRemoved})` : ''} · DFM ${dfm.score}/100 — analyse + export régénérés`)
}

/** Cadence la lecture : 1 événement toutes les BASE_TICK_MS / liveSpeed. */
function livePump() {
  if (liveTimer || liveQueue.length === 0) return
  const speed = useStudio.getState().liveSpeed || 1
  liveTimer = setTimeout(() => {
    liveTimer = null
    const q = liveQueue.shift()
    if (q && useStudio.getState().liveRouting.active) liveApplyQueued(q)
    if (liveQueue.length > 0) livePump()
    else if (liveStreamDone) liveFinish()
  }, Math.max(4, BASE_TICK_MS / speed))
}

function liveEnqueue(q: LiveQueued) {
  liveQueue.push(q)
  livePump()
}

function liveFinish() {
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null }
  liveQueue = []
  useStudio.getState().endLiveRouting()
}

function liveNoteStreamEnd() {
  liveStreamDone = true
  if (liveQueue.length === 0) liveFinish()
}

function liveFlush() {
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null }
  liveQueue = []
}

/** Attend (borné) que la lecture locale ait tout joué — utilisé par le pipeline. */
async function liveDrained() {
  const t0 = Date.now()
  while ((liveQueue.length > 0 || liveTimer) && Date.now() - t0 < 20000) {
    await new Promise((r) => setTimeout(r, 40))
  }
}

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
  liveRouting: idleLive(),
  liveRoutes: [],
  liveSpeed: 1,

  setProject: (id) => {
    const nl = get().customNetlists.find((x) => x.id === id) ?? getNetlist(id)
    liveFlush()
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
      liveRouting: idleLive(),
      liveRoutes: [],
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
      const routing = await routeAll(nl, clamped, DEFAULT_RULES, constraints)
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

  /* ---------------- Routage live [DeepPCB live_routing] ----------------
   * Deux sources de flux : le routeur SERVEUR (SSE, rythmé pacingMs) ou la
   * passe de routage du pipeline local. Les traces s'accumulent net par
   * net dans liveRoutes — les viewers les dessinent au fil de l'eau. */
  beginLiveRouting: (source) =>
    set((s) => (s.liveRouting.active
      ? {}
      : { liveRoutes: [], liveRouting: { active: true, phase: 'greedy' as LivePhase, netsTotal: 0, netsDone: 0, currentNet: '—', traces: 0, source, lastPoint: null } })),

  pushLiveTrace: (ev) =>
    set((s) => {
      if (!s.liveRouting.active) return {}
      const routes = [...s.liveRoutes]
      const i = routes.findIndex((r) => r.net === ev.net)
      const base: Route = i >= 0
        ? { ...routes[i], segments: [...routes[i].segments], vias: [...routes[i].vias] }
        : { net: ev.net, segments: [], vias: [], lengthMm: 0, routed: true }
      if (ev.type === 'segment') base.segments.push(ev.segment)
      else base.vias.push(ev.via)
      if (i >= 0) routes[i] = base
      else routes.push(base)
      const last = ev.type === 'segment' ? ev.segment.pts[ev.segment.pts.length - 1] : { x: ev.via.x, y: ev.via.y }
      return { liveRoutes: routes, liveRouting: { ...s.liveRouting, traces: s.liveRouting.traces + 1, lastPoint: last } }
    }),

  dropLiveNet: (net) =>
    set((s) => (s.liveRouting.active ? { liveRoutes: s.liveRoutes.filter((r) => r.net !== net) } : {})),

  setLiveProgress: (p) =>
    set((s) => ({ liveRouting: { ...s.liveRouting, netsDone: p.done, netsTotal: p.total || s.liveRouting.netsTotal, currentNet: p.net } })),

  setLivePhase: (phase) =>
    set((s) => ({ liveRouting: { ...s.liveRouting, phase } })),

  endLiveRouting: () =>
    set({ liveRouting: idleLive(), liveRoutes: [] }),

  stopLiveRouting: (reason = 'user') => {
    liveStopReason = reason
    liveFlush()
    liveAbort?.abort()
  },

  setLiveSpeed: (v) => {
    const sp = Math.min(4, Math.max(0.25, Number.isFinite(v) ? v : 1))
    set({ liveSpeed: sp })
    // la nouvelle tempo s'applique dès le prochain événement joué
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; livePump() }
  },

  /* ---------------- Nudge chirurgical PENDANT le live [Flux.ai × DeepPCB] ------
   * On regarde le routeur poser ses pistes ; un passage ne nous plaît pas ? On
   * sélectionne le composant fautif, on le pousse de 2 mm — le flux est coupé
   * proprement et le routeur REPART EN DIRECT sur la nouvelle géométrie. */
  liveNudge: async (ref, dx, dy) => {
    const s = get()
    if (s.running || s.surgicalBusy || !s.livePlacements) return
    set({ surgicalBusy: true })
    get().log('system', 'agent', `[NUDGE LIVE] ${ref} déplacé de (${dx > 0 ? '+' : ''}${dx}, ${dy > 0 ? '+' : ''}${dy}) mm — coupure du flux puis re-routage en direct…`)
    if (s.liveRouting.active) get().stopLiveRouting('nudge')
    // laisse le lecteur SSE s'arrêter (abort asynchrone → endLiveRouting)
    const t0 = Date.now()
    while (get().liveRouting.active && Date.now() - t0 < 2000) {
      await new Promise((r) => setTimeout(r, 20))
    }
    // déplacement borné dans la carte (même règle que la chirurgie classique)
    const nl = get().netlist
    const clamped = get().livePlacements!.map((p) => {
      if (p.ref !== ref) return p
      const c = nl.components.find((x) => x.ref === ref)
      if (!c) return p
      const swap = p.rot === 90 || p.rot === 270
      const w = swap ? c.footprint.h : c.footprint.w
      const h = swap ? c.footprint.w : c.footprint.h
      return {
        ...p,
        x: Math.min(nl.board.w - w / 2 - 0.4, Math.max(w / 2 + 0.4, p.x + dx)),
        y: Math.min(nl.board.h - h / 2 - 0.4, Math.max(h / 2 + 0.4, p.y + dy)),
      }
    })
    set({ livePlacements: clamped, surgicalBusy: false })
    void get().startLiveRouting() // le routeur repart EN DIRECT, trait par trait
  },

  startLiveRouting: async (pacingMs = 3) => {
    const s = get()
    if (s.running || s.liveRouting.active) return
    const placements = s.livePlacements ?? s.result.placement?.placements
    if (!placements || placements.length === 0) {
      get().log('system', 'warn', '[LIVE] Aucun placement disponible — lancez d’abord la conception : le routage live réutilise le placement existant.')
      return
    }
    const nl = s.netlist
    liveAbort = new AbortController()
    liveFlush()
    liveStreamDone = false
    liveSawComplete = false
    liveT0 = Date.now()
    get().beginLiveRouting('server')
    get().log('system', 'agent', '[DEEPPCB] Flux de routage live ouvert — le routeur serveur diffuse chaque piste au fil de sa pose…')
    /* pacingMs = simple rythme FILAIRE (3 ms) : le tempo visuel, lui, est donné
     * par la lecture locale à BASE_TICK_MS / liveSpeed — d'où une vitesse
     * réglable ×0.5 … ×4 en plein vol, sans négocier avec le serveur. */
    let failed = false
    try {
      const res = await fetch('/api/routing/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ netlist: nl, placements, pacingMs }),
        signal: liveAbort.signal,
      })
      if (!res.ok || !res.body) throw new Error(`flux indisponible (HTTP ${res.status})`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          const line = frame.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          let ev: LiveSseEvent
          try { ev = JSON.parse(line.slice(6)) as LiveSseEvent } catch { continue }
          if (ev.t === 'segment' || ev.t === 'via') {
            const trace: TraceEvent = ev.t === 'segment'
              ? { type: 'segment', net: ev.net, segment: ev.segment }
              : { type: 'via', net: ev.net, via: ev.via }
            liveEnqueue({ k: 'trace', ev: trace })
          } else if (ev.t === 'progress') {
            liveEnqueue({ k: 'progress', p: ev })
          } else if (ev.t === 'phase') {
            liveEnqueue({ k: 'phase', phase: ev.phase })
          } else if (ev.t === 'hello') {
            liveEnqueue({ k: 'hello', total: ev.total })
          } else if (ev.t === 'complete') {
            liveEnqueue({ k: 'complete', result: ev.result })
          } else if (ev.t === 'error') {
            throw new Error(ev.message)
          }
        }
      }
    } catch (e) {
      failed = true
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      get().log('system', aborted ? 'warn' : 'error',
        aborted
          ? (liveStopReason === 'nudge'
              ? '[NUDGE LIVE] Flux coupé — re-routage en direct avec la nouvelle position…'
              : '[DEEPPCB] Flux de routage live interrompu par l’utilisateur.')
          : `[DEEPPCB] Échec du flux live : ${e instanceof Error ? e.message : 'erreur inconnue'}`)
    } finally {
      liveAbort = null
      liveStopReason = null
      if (failed) liveFinish() // flux mort → session fermée immédiatement
      else liveNoteStreamEnd() // la lecture locale peut encore drainer la file
    }
  },

  reset: () => {
    cancelFlag = false
    liveAbort?.abort()
    liveAbort = null
    liveFlush()
    liveStreamDone = false
    set({ stages: initialStages(), result: {}, livePlacements: null, costHistory: [], plan: null, running: false, cancelled: false, liveRouting: idleLive(), liveRoutes: [] })
  },

  cancel: () => {
    cancelFlag = true
    set({ cancelled: true })
    get().log('system', 'warn', 'Annulation demandée — arrêt propre du pipeline…')
  },

  run: async () => {
    if (get().running || get().liveRouting.active) return
    cancelFlag = false
    const nl = get().netlist
    set({
      running: true, cancelled: false,
      stages: initialStages(), result: {}, livePlacements: null, costHistory: [], plan: null,
      liveRouting: idleLive(), liveRoutes: [],
    })
    const t0 = Date.now()
    get().log('system', 'info', `═══ DÉBUT DE CONCEPTION AUTONOME — ${nl.name} ═══`)

    try {
      const result = await runPipeline(nl, {
        onLog: (stage, level, msg) => get().log(stage, level, msg),
        onStage: (id, status, progress, detail, durationMs) => {
          if (id === 'routing' && status === 'running') get().beginLiveRouting('pipeline')
          set((s) => ({
            stages: { ...s.stages, [id]: { ...s.stages[id], status, progress, detail, durationMs } },
          }))
        },
        onPlan: (p) => set({ plan: p }),
        onPlacements: (p) => set({ livePlacements: [...p] }),
        onCostHistory: (h) => { if (h.length) set({ costHistory: h }) },
        shouldCancel: () => cancelFlag,
        onRoutingTrace: (ev) => liveEnqueue({ k: 'trace', ev }),
        onRoutingPhase: (phase) => liveEnqueue({ k: 'phase', phase }),
        onRoutingProgress: (p) => liveEnqueue({ k: 'progress', p }),
      })

      // Laisse la lecture locale finir de dessiner le flux avant de clore la session
      await liveDrained()

      const routeRate = result.routing.routedNets / Math.max(1, result.routing.totalNets)
      const status = result.drc.errors === 0 && routeRate >= 0.98 ? 'success' : routeRate > 0.8 ? 'partial' : 'error'
      set({ result, running: false, liveRouting: idleLive(), liveRoutes: [] })
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
      liveFlush()
      set({ running: false, cancelled, liveRouting: idleLive(), liveRoutes: [] })
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
