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
  /** 'server' = flux SSE du routeur serveur · 'pipeline' = passe du pipeline local · 'replay' = relecture d'une session */
  source: 'server' | 'pipeline' | 'replay' | 'none'
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
  editLog: EditLogItem[]
  liveRouting: LiveRoutingState
  liveRoutes: Route[]
  /** Vitesse de lecture du flux live : 0.5 | 1 | 2 | 4 */
  liveSpeed: number
  /** Pile d'instantanés de placement — undo multi-niveaux chirurgical (plafonnée à 20) */
  placementHistory: PlacedComponent[][]
  /** Pile miroir du undo — redo (Ctrl+Maj+Z), dépilée par redoSurgical */
  redoStack: PlacedComponent[][]
  /** Une session de routage enregistrée peut être rejouée (mode replay) */
  canReplay: boolean
  /* Timeline de replay seekable — position de lecture dans l'enregistrement */
  replayPos: number
  replayTotal: number
  replayPaused: boolean
  /** Composant en cours de drag & drop souris (null = aucun) */
  dragRef: string | null
  setProject: (id: string) => void
  /** [P1.1] pile de couches cuivre du projet courant (2 ou 4) — copie superficielle de la netlist */
  setLayers: (n: 2 | 4) => void
  addCustomNetlist: (nl: Netlist) => void
  surgicalMove: (ref: string, dx: number, dy: number) => Promise<void>
  log: (stage: LogEntry['stage'], level: LogEntry['level'], msg: string) => void
  run: () => Promise<void>
  cancel: () => void
  reset: () => void
  setViewer: (patch: Partial<StudioState['viewer']>) => void
  loadHistory: () => Promise<void>
  /** Journal d'édition [P2.4] — recharge les derniers gestes journalisés */
  loadEditLog: () => Promise<void>
  /* Routage live [DeepPCB] */
  startLiveRouting: (pacingMs?: number, force?: boolean) => Promise<void>
  stopLiveRouting: (reason?: 'user' | 'nudge') => void
  setLiveSpeed: (v: number) => void
  /** Nudge chirurgical PENDANT un flux live : coupe le flux, déplace, repart en direct */
  liveNudge: (ref: string, dx: number, dy: number) => Promise<void>
  /** Rejoue la dernière session de routage enregistrée, au tempo local choisi */
  replayLastRouting: () => void
  /** Timeline seekable : saute à n'importe quel instant de la session (0..replayTotal) */
  seekReplay: (index: number) => void
  /** Transport replay : pause / reprise de la lecture */
  pauseReplay: () => void
  resumeReplay: () => void
  /** Annule le dernier déplacement chirurgical (multi-niveaux : Ctrl+Z répété) */
  undoSurgical: () => Promise<void>
  /** Rétablit le dernier déplacement annulé (Ctrl+Maj+Z / Ctrl+Y) */
  redoSurgical: () => Promise<void>
  /** Exporte la session de routage enregistrée (JSON base + événements) —
   *  partageable et re-jouable ; compagnon du ring buffer par tranches. */
  exportReplaySession: () => void
  /** [P1.4] Importe une session exportée (JSON nexus-replay v1) : elle devient
   *  la session « dernière » — rejouable, seekable et re-exportable. */
  importReplaySession: (file: File) => void
  /* HOOK DE TEST E2E uniquement : injecte n événements synthétiques dans
   * l'enregistrement replay (éprouve ring buffer, compaction et seeks sans
   * router des milliers de nets). Ne touche ni le HUD ni la carte hors session. */
  testInjectRecording: (n: number) => void
  /* Drag & drop direct [souris] — saisie, déplacement continu, engagement */
  beginDrag: (ref: string) => void
  dragMoveTo: (ref: string, x: number, y: number) => void
  commitDrag: (ref: string) => Promise<void>
  beginLiveRouting: (source: 'server' | 'pipeline' | 'replay') => void
  pushLiveTrace: (ev: TraceEvent) => void
  dropLiveNet: (net: string) => void
  setLiveProgress: (p: { done: number; total: number; net: string; ok: boolean }) => void
  setLivePhase: (phase: LivePhase) => void
  endLiveRouting: () => void
}

let cancelFlag = false
let liveAbort: AbortController | null = null

/* --- Journal d'édition [P2.4] ------------------------------------------------
 * Chaque geste d'édition est journalisé de façon immuable (/api/edits) :
 * kind, ref, positions avant/après, auteur (actor — multi-utilisateurs prêt).
 * Fire-and-forget : la télémétrie ne doit jamais bloquer un geste. */
export interface EditLogItem {
  id: string
  kind: string
  ref: string
  xFrom: number
  yFrom: number
  xTo: number
  yTo: number
  rotFrom: number | null
  rotTo: number | null
  actor: string
  meta: string | null
  createdAt: string
}

function logEdit(
  kind: string,
  ref: string,
  from: { x: number; y: number; rot?: number },
  to: { x: number; y: number; rot?: number },
  meta?: string,
) {
  const s = useStudio.getState()
  void fetch('/api/edits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ netlistId: s.netlistId, kind, ref, from, to, meta }),
  })
    .then(() => s.loadEditLog())
    .catch(() => undefined)
}

/** Diff de deux instantanés : le composant déplacé (le premier détecté). */
function placementDiff(
  before: PlacedComponent[],
  after: PlacedComponent[],
): { ref: string; from: PlacedComponent; to: PlacedComponent } | null {
  for (const a of after) {
    const b = before.find((p) => p.ref === a.ref)
    if (!b) continue
    if (Math.abs(b.x - a.x) > 1e-6 || Math.abs(b.y - a.y) > 1e-6 || b.rot !== a.rot) {
      return { ref: a.ref, from: b, to: a }
    }
  }
  return null
}

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
let liveLastError: string | null = null
/** Génération de session : tout ce qui appartient à une session supplantée
 *  (lecteur SSE attardé, tick de lecture résiduel) perd toute autorité — il
 *  se mute silencieusement au lieu de corrompre la session courante. */
let liveEpoch = 0
let livePumpEpoch = -1

/** Replay seekable : pause de la lecture (la file attend, la timeline reste active) */
let livePaused = false
/** Total d'événements de la session enregistrée (max du slider de timeline) */
let replayTotal = 0
/* Drag & drop : le pointeur a-t-il réellement bougé (commit vs simple clic),
 * et un flux live/replay a-t-il été coupé au passage (→ reprise EN DIRECT) */
let dragMoved = false
let dragWasLive = false
let dragFromPos: PlacedComponent | null = null // journal d'édition [P2.4]

/** Enregistrement de la dernière session de routage (traces, progression,
 *  phases) pour le mode « replay » — rempli à la volée dans liveEnqueue,
 *  vidé à chaque nouvelle session (beginLiveRouting).
 *  [Registre de risques — plafond replay] RING BUFFER PAR TRANCHES : quand
 *  le plafond d'événements bruts est dépassé, la tranche la plus ancienne
 *  n'est plus jetée — elle est COMPACTÉE dans recBase (routes + progression
 *  + phase cumulées), point de départ de toute reconstruction. La tête de
 *  session n'est donc plus tronquée : replay et seeks restent exacts sur des
 *  sessions arbitrairement longues, à mémoire bornée. */
interface RecBase {
  consumed: number // événements compactés — décalage absolu de la timeline
  routes: Route[] // traces déjà posées au front de compactage
  traces: number // compteur de traces cumulé
  netsDone: number
  netsTotal: number
  currentNet: string
  phase: LivePhase
}
const REC_TRANCHE = 1000 // taille d'une tranche compactée à la fois
const REC_CAP = 16000 // événements bruts retenus (×2 vs plafond historique 8 000)
const emptyRecBase = (): RecBase => ({ consumed: 0, routes: [], traces: 0, netsDone: 0, netsTotal: 0, currentNet: '—', phase: 'greedy' })
let liveRecording: LiveQueued[] = []
let recBase = emptyRecBase()
let liveReplaying = false

/** Applique une tranche d'événements au front compacté — mêmes sémantiques que
 *  pushLiveTrace / setLiveProgress / dropLiveNet / setLivePhase, hors store. */
function foldIntoBase(base: RecBase, evts: LiveQueued[]) {
  for (const q of evts) {
    if (q.k === 'trace') {
      const ev = q.ev
      const i = base.routes.findIndex((r) => r.net === ev.net)
      if (i >= 0) {
        const r = { ...base.routes[i], segments: [...base.routes[i].segments], vias: [...base.routes[i].vias] }
        if (ev.type === 'segment') r.segments.push(ev.segment)
        else r.vias.push(ev.via)
        base.routes[i] = r
      } else {
        base.routes.push(
          ev.type === 'segment'
            ? { net: ev.net, segments: [ev.segment], vias: [], lengthMm: 0, routed: true }
            : { net: ev.net, segments: [], vias: [ev.via], lengthMm: 0, routed: true },
        )
      }
      base.traces++
    } else if (q.k === 'progress') {
      base.netsDone = q.p.done
      base.netsTotal = q.p.total || base.netsTotal
      base.currentNet = q.p.net
      if (!q.p.ok) base.routes = base.routes.filter((r) => r.net !== q.p.net) // net réattribué
    } else if (q.k === 'phase') base.phase = q.phase
    else if (q.k === 'hello') { base.netsDone = 0; base.netsTotal = q.total; base.currentNet = '—' }
  }
  base.consumed += evts.length
}

/** Position ABSOLUE de fin de timeline = base compactée + événements bruts. */
function recordingTotal(): number {
  return recBase.consumed + liveRecording.filter((q) => q.k !== 'complete').length
}

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

/** Cadence la lecture : 1 événement toutes les BASE_TICK_MS / liveSpeed.
 *  À épreuve d'exceptions ET de générations : un événement défectueux ne tue
 *  jamais la chaîne, et une session supplantée se mute sans rien toucher.
 *  En fin de flux (EOF), le backlog restant est joué par RAFALES bornées —
 *  la finalisation ne traîne pas des dizaines de secondes derrière le rendu.
 *  En replay, la pause fige la lecture — la timeline reste manipulable. */
function livePump() {
  if (liveTimer || liveQueue.length === 0) return
  if (livePaused && liveReplaying) return // replay en pause — la file attend
  const speed = useStudio.getState().liveSpeed || 1
  liveTimer = setTimeout(() => {
    liveTimer = null
    try {
      const batch = liveStreamDone && !liveReplaying
        ? Math.min(liveQueue.length, Math.max(1, Math.ceil(liveQueue.length / 12)))
        : 1 // replay : tout se joue à l'unité — c'est précisément le but de le regarder
      for (let i = 0; i < batch; i++) {
        const q = liveQueue.shift()
        if (!q) break
        if (livePumpEpoch !== liveEpoch) { liveQueue = []; break }
        if (useStudio.getState().liveRouting.active) liveApplyQueued(q)
      }
    } catch (e) {
      liveLastError = e instanceof Error ? e.message : String(e)
      useStudio.getState().log('system', 'error', `[LIVE] Erreur de lecture du flux : ${liveLastError}`)
    }
    if (livePumpEpoch !== liveEpoch) { liveQueue = []; return } // session remplacée
    if (liveReplaying) {
      // Timeline : la position de lecture = total - ce qui reste en file
      useStudio.setState({ replayPos: Math.max(0, replayTotal - liveQueue.length) })
    }
    if (liveQueue.length > 0) livePump()
    else if (liveStreamDone) {
      if (liveReplaying && livePaused) return // pause sur la dernière frame
      liveFinish()
    }
  }, Math.max(4, BASE_TICK_MS / speed))
}

function liveEnqueue(q: LiveQueued) {
  livePumpEpoch = liveEpoch
  if (!liveReplaying && q.k !== 'complete') {
    // Enregistrement pour le replay — l'événement complete n'est PAS rejoué :
    // à la fin d'un replay le viewer retombe sur result.routing (état canonique).
    liveRecording.push(q)
    if (liveRecording.length > REC_CAP) {
      // Ring buffer par tranches : la tranche la plus ancienne est compactée
      // dans recBase (jamais perdue) — éviction amortie O(1).
      foldIntoBase(recBase, liveRecording.slice(0, REC_TRANCHE))
      liveRecording = liveRecording.slice(REC_TRANCHE)
    }
  }
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

/** Reconstruction INSTANTANÉE de l'état visuel à un instant donné de la
 *  session enregistrée — le cœur du seek de la timeline : on repart de la
 *  base compactée (tranches évacuées, jamais perdues), on rejoue en bloc
 *  les événements [0, upto - consumed) hors pompe (traces, phases,
 *  progression), puis la lecture normale peut reprendre de ce point.
 *  `upto` est une position ABSOLUE dans la timeline [0, replayTotal]. */
function replayRebuild(events: LiveQueued[], upto: number) {
  const local = Math.max(0, Math.min(events.length, upto - recBase.consumed))
  useStudio.setState({
    liveRoutes: recBase.routes.map((r) => ({ ...r, segments: [...r.segments], vias: [...r.vias] })),
    liveRouting: {
      ...idleLive(),
      active: true,
      source: 'replay',
      phase: recBase.phase,
      traces: recBase.traces,
      netsDone: recBase.netsDone,
      netsTotal: recBase.netsTotal,
      currentNet: recBase.currentNet,
    },
  })
  const st = useStudio.getState()
  for (const q of events.slice(0, local)) {
    if (q.k === 'trace') st.pushLiveTrace(q.ev)
    else if (q.k === 'progress') {
      st.setLiveProgress(q.p)
      if (!q.p.ok) st.dropLiveNet(q.p.net)
    } else if (q.k === 'phase') st.setLivePhase(q.phase)
    else if (q.k === 'hello') st.setLiveProgress({ done: 0, total: q.total, net: '—', ok: true })
  }
}

/** Attend (borné) que la lecture locale ait tout joué — utilisé par le pipeline. */
async function liveDrained() {
  const t0 = Date.now()
  while ((liveQueue.length > 0 || liveTimer) && Date.now() - t0 < 20000) {
    await new Promise((r) => setTimeout(r, 40))
  }
}

/** Re-routage incrémental partagé [Flux.ai surgical_editor] : la géométrie de
 *  livePlacements vient d'être éditée (chirurgie, undo) ; on re-route, on
 *  recalcule SI + DRC/DFM + export — SANS toucher au placement ni à la
 *  thermique. Utilisé par surgicalMove ET undoSurgical. */
async function rerouteAfterPlacementEdit(label: string): Promise<boolean> {
  const t0 = Date.now()
  try {
    const st = useStudio.getState()
    const placements = st.livePlacements!
    const nl = st.netlist
    const constraints = extractConstraints(nl)
    const routing = await routeAll(nl, placements, DEFAULT_RULES, constraints)
    const routeMap = new Map(routing.routes.map((r) => [r.net, r]))
    const si = analyzeSi(nl, routeMap, (cls) => DEFAULT_RULES.widths[cls as keyof typeof DEFAULT_RULES.widths] ?? 0.25, constraints)
    const drc = runDrc(nl, placements, routing, st.result.thermal!, DEFAULT_RULES, constraints)
    const dfm = runDfm(nl, placements, routing, DEFAULT_RULES)
    const gerber = generateGerber(nl, placements, routing)
    gerber.files.push(...generateFirmwareBridge(nl).files)
    useStudio.setState((s2) => ({ result: { ...s2.result, routing, si, drc, dfm, gerber } }))
    useStudio.getState().log('system', 'success',
      `${label} Terminé en ${Date.now() - t0} ms — ${routing.routedNets}/${routing.totalNets} nets · ${routing.viaCount} vias${routing.viasRemoved ? ` (−${routing.viasRemoved})` : ''} · DRC ${drc.errors} erreur(s) · placement et thermique préservés`)
    return true
  } catch (e) {
    useStudio.getState().log('system', 'error', `${label} échec : ${e instanceof Error ? e.message : 'erreur inconnue'}`)
    return false
  }
}

/** Pousse l'état de placement courant sur la pile d'undo (plafonnée à 20).
 *  Toute NOUVELLE édition invalide la pile de redo — comportement standard. */
function pushPlacementHistory() {
  const s = useStudio.getState()
  if (!s.livePlacements) return
  useStudio.setState((s2) => ({
    placementHistory: [...s2.placementHistory.slice(-19), s2.livePlacements!.map((p) => ({ ...p }))],
    redoStack: [],
  }))
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
  editLog: [],
  liveRouting: idleLive(),
  liveRoutes: [],
  liveSpeed: 1,
  placementHistory: [],
  redoStack: [],
  canReplay: false,
  replayPos: 0,
  replayTotal: 0,
  replayPaused: false,
  dragRef: null,

  setProject: (id) => {
    const nl = get().customNetlists.find((x) => x.id === id) ?? getNetlist(id)
    liveEpoch++
    liveFlush()
    liveRecording = [] // le replay appartient au projet précédent
    recBase = emptyRecBase()
    set({
      netlistId: id,
      netlist: nl,
      stages: initialStages(),
      result: {},
      livePlacements: null,
      costHistory: [],
      plan: null,
      constraintsCount: extractConstraints(nl).length,
      placementHistory: [],
      redoStack: [],
      canReplay: false,
      replayPos: 0,
      replayTotal: 0,
      replayPaused: false,
      dragRef: null,
      logs: [{ ts: Date.now(), stage: 'system', level: 'info', msg: `Projet chargé : ${nl.name} — ${nl.description}` }],
      viewer: { ...get().viewer, selectedRef: null },
      liveRouting: idleLive(),
      liveRoutes: [],
    })
    void get().loadHistory()
    void get().loadEditLog()
  },

  // [P1.1] pile de couches : copie superficielle — les NETLISTS partagées ne sont jamais mutées
  setLayers: (n) => set((s) => ({ netlist: { ...s.netlist, board: { ...s.netlist.board, layers: n } } })),

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
    const before = s.livePlacements
    pushPlacementHistory() // undo multi-niveaux — l'état AVANT le déplacement
    set({ surgicalBusy: true, livePlacements: s.livePlacements.map((p) => p.ref === ref ? { ...p, x: p.x + dx, y: p.y + dy } : p) })
    get().log('system', 'agent', `[CHIRURGIE] ${ref} déplacé de (${dx > 0 ? '+' : ''}${dx}, ${dy > 0 ? '+' : ''}${dy}) mm — re-routage incrémental…`)
    await new Promise((r) => setTimeout(r, 40)) // laisse le viewer rafraîchir
    // Ramène le composant dans la carte si le déplacement le fait sortir
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
        x: Math.min(nl.board.w - w / 2 - 0.4, Math.max(w / 2 + 0.4, p.x)),
        y: Math.min(nl.board.h - h / 2 - 0.4, Math.max(h / 2 + 0.4, p.y)),
      }
    })
    set({ livePlacements: clamped })
    const moved = placementDiff(before, clamped)
    if (moved) logEdit('move', moved.ref, moved.from, moved.to)
    await rerouteAfterPlacementEdit('[CHIRURGIE]')
    set({ surgicalBusy: false })
  },

  log: (stage, level, msg) =>
    set((s) => ({ logs: [...s.logs.slice(-400), { ts: Date.now(), stage, level, msg }] })),

  /* ---------------- Routage live [DeepPCB live_routing] ----------------
   * Deux sources de flux : le routeur SERVEUR (SSE, rythmé pacingMs) ou la
   * passe de routage du pipeline local. Les traces s'accumulent net par
   * net dans liveRoutes — les viewers les dessinent au fil de l'eau. */
  beginLiveRouting: (source) => {
    // Garde AVANT tout effet de bord : l'orchestrateur ré-émet onStage('routing','running')
    // à CHAQUE progression de net — sans ce garde, l'enregistrement du replay serait
    // effacé à chaque net du pipeline et ne garderait que les 2 derniers événements.
    if (useStudio.getState().liveRouting.active) return
    liveRecording = [] // nouvelle session → l'enregistrement du replay repart à zéro
    recBase = emptyRecBase()
    set((s) => (s.liveRouting.active
      ? {}
      : { liveRoutes: [], liveRouting: { active: true, phase: 'greedy' as LivePhase, netsTotal: 0, netsDone: 0, currentNet: '—', traces: 0, source, lastPoint: null } }))
  },

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

  endLiveRouting: () => {
    liveReplaying = false
    livePaused = false
    const total = recordingTotal() // base compactée + événements bruts
    if (total > 0) replayTotal = total // la timeline reste consultable hors session
    set({
      liveRouting: idleLive(),
      liveRoutes: [],
      canReplay: recBase.traces > 0 || liveRecording.some((q) => q.k === 'trace'), // une session interrompue est rejouable aussi
      replayPos: 0,
      replayTotal,
      replayPaused: false,
    })
  },

  stopLiveRouting: (reason = 'user') => {
    liveStopReason = reason
    liveEpoch++ // la session en cours perd son autorité — son lecteur SSE mourant ne gèrera rien
    liveFlush()
    liveAbort?.abort()
    // clôture immédiate : le HUD se ferme tout de suite, sans attendre le rejet réseau
    if (useStudio.getState().liveRouting.active) {
      useStudio.getState().endLiveRouting()
      if (reason === 'user') {
        useStudio.getState().log('system', 'warn', '[DEEPPCB] Flux de routage live interrompu par l’utilisateur.')
      }
    }
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
    const before = s.livePlacements
    pushPlacementHistory() // undo multi-niveaux — l'état AVANT le nudge
    set({ surgicalBusy: true })
    get().log('system', 'agent', `[NUDGE LIVE] ${ref} déplacé de (${dx > 0 ? '+' : ''}${dx}, ${dy > 0 ? '+' : ''}${dy}) mm — coupure du flux puis re-routage en direct…`)
    // stopLiveRouting révoque la génération en cours : la vieille session ne
    // peut plus ni finaliser ni corrompre l'état — même si sa réponse SSE est
    // déjà fully bufferisée côté navigateur (abort sans effet visible).
    if (s.liveRouting.active) get().stopLiveRouting('nudge')
    await new Promise((r) => setTimeout(r, 60)) // laisse les microtasks mourir
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
    const moved = placementDiff(before, clamped)
    if (moved) logEdit('nudge-live', moved.ref, moved.from, moved.to, 'flux live coupé puis repris en direct')
    void get().startLiveRouting(3, true) // le routeur repart EN DIRECT, trait par trait
  },

  /* ---------------- Replay de la dernière session [DeepPCB ×2] --------------
   * La session (traces, progression, phases) a été enregistrée à la volée ;
   * le replay la rejoue via le MÊME moteur de lecture (file + tempo local),
   * donc au ralenti ou en timelapse, SANS recontacter le routeur. La vitesse
   * reste réglable en plein vol, l'interruption reste propre, et la TIMELINE
   * seekable permet d'avancer/reculer dans la session à volonté. À la fin,
   * le viewer retombe sur result.routing — l'état final canonique. */
  replayLastRouting: () => {
    const s = get()
    if (s.running || s.surgicalBusy || s.liveRouting.active) return
    const events = liveRecording.filter((q) => q.k !== 'complete')
    const base = recBase
    if (!events.some((q) => q.k === 'trace') && base.traces === 0) {
      s.log('system', 'warn', '[REPLAY] Aucune session de routage enregistrée — lancez d’abord un routage (live ou pipeline).')
      return
    }
    liveEpoch++ // révoque toute session résiduelle
    liveFlush()
    liveReplaying = true
    liveStreamDone = false
    liveSawComplete = false
    liveT0 = Date.now()
    get().beginLiveRouting('replay') // vide liveRoutes + repart sur un enregistrement neuf
    liveRecording = events // l'enregistrement survit à la relecture → replay rejouable à volonté
    recBase = base // la base compactée aussi — la tête de session reste rejouée
    replayTotal = base.consumed + events.length
    livePaused = false
    livePumpEpoch = liveEpoch
    liveQueue.push(...events)
    liveStreamDone = true // fin de flux logique : la lecture se clôturera d'elle-même
    set({ replayPos: 0, replayTotal, replayPaused: false })
    s.log('system', 'agent', `[REPLAY] Relecture de la dernière session — ${replayTotal} événements à ×${s.liveSpeed} (réglable en plein vol)…`)
    livePump()
  },

  /* ---------------- Timeline seekable [avancer / reculer] --------------------
   * Saute à n'importe quel instant de l'enregistrement : reconstruction
   * instantanée de l'état [0, index) hors pompe, puis la lecture reprend
   * de ce point (si elle tournait). Depuis le repos, un seek ouvre la
   * session en pause — l'utilisateur scrubbe, puis presse ▶. */
  seekReplay: (index) => {
    const s = get()
    if (s.running || s.surgicalBusy) return
    if (s.liveRouting.active && s.liveRouting.source !== 'replay') return // flux serveur/pipeline : intouchable
    if (!s.liveRouting.active && !s.canReplay) return
    const events = liveRecording.filter((q) => q.k !== 'complete')
    const base = recBase
    if (!events.some((q) => q.k === 'trace') && base.traces === 0) return
    const total = base.consumed + events.length
    const clamped = Math.max(0, Math.min(total, Math.round(index))) // position ABSOLUE
    const local = Math.max(0, clamped - base.consumed) // position dans les événements bruts
    const wasReplaying = s.liveRouting.active && s.liveRouting.source === 'replay'
    liveEpoch++ // révoque la pompe/lecture courante
    liveFlush()
    if (!wasReplaying) {
      // entrée dans le mode replay depuis le repos — en PAUSE (scrub inspectif)
      liveReplaying = true
      liveStreamDone = true
      liveSawComplete = false
      liveT0 = Date.now()
      livePaused = true
      get().beginLiveRouting('replay') // reset liveRoutes + active=true (vide liveRecording)
    }
    liveRecording = events // l'enregistrement survit au seek
    recBase = base // la base compactée aussi
    replayTotal = total
    replayRebuild(events, clamped) // repart de la base, rejoue [0, local)
    livePumpEpoch = liveEpoch
    if (local < events.length) liveQueue.push(...events.slice(local))
    set({ replayPos: clamped, replayTotal, dragRef: null, replayPaused: livePaused })
    if (!livePaused) {
      if (liveQueue.length > 0) livePump()
      else liveFinish() // saut direct à la fin → retour à l'état canonique
    }
  },

  pauseReplay: () => {
    if (!liveReplaying) return
    livePaused = true
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null }
    set({ replayPaused: true })
  },

  resumeReplay: () => {
    if (!liveReplaying) return
    livePaused = false
    set({ replayPaused: false })
    if (liveQueue.length > 0) livePump()
    else if (liveStreamDone) liveFinish() // reprise sur la dernière frame → clôture
  },

  /* ---------------- Export de session [registre de risques] ----------------
   * Compagnon du ring buffer : la session enregistrée (base compactée +
   * événements bruts) part en JSON téléchargeable — partageable, archivable,
   * rejouable ailleurs. L'import fera l'objet d'un chantier dédié (P1.4). */
  exportReplaySession: () => {
    const s = get()
    const events = liveRecording.filter((q) => q.k !== 'complete')
    if (!events.some((q) => q.k === 'trace') && recBase.traces === 0) {
      s.log('system', 'warn', '[REPLAY] Aucune session à exporter — lancez d’abord un routage.')
      return
    }
    const total = recBase.consumed + events.length
    const data = {
      format: 'nexus-replay',
      version: 1,
      exportedAt: new Date().toISOString(),
      project: { id: s.netlistId, name: s.netlist.name, board: s.netlist.board },
      stats: { total, baseCompactee: recBase.consumed, bruts: events.length, traces: recBase.traces },
      base: recBase,
      events,
    }
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `nexus-replay-${s.netlistId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
    s.log('system', 'agent', `[REPLAY] Session exportée — ${total} événements (base ${recBase.consumed} + bruts ${events.length}, ${recBase.traces} traces compactées) — JSON ${a.download}`)
  },

  /* ---------------- Import de session [audit P1.4] -------------------------
   * Compagnon de l'export : un JSON nexus-replay v1 (base compactée +
   * événements bruts) redevient la session « dernière » du studio — la barre
   * REPLAY, la timeline seekable et l'export s'appliquent tel quel. Les
   * événements sont assainis (seuls trace/progress/phase/hello sont
   * rejouables — 'complete' vit dans result.routing, jamais enregistré). */
  importReplaySession: (file) => {
    const s = get()
    if (s.running || s.surgicalBusy || s.liveRouting.active) {
      s.log('system', 'warn', '[REPLAY] Import impossible pendant une session active — interrompez le flux d’abord.')
      return
    }
    file.text()
      .then((txt) => {
        let data: {
          format?: string
          version?: number
          project?: { id?: string; name?: string }
          stats?: { total?: number }
          base?: Partial<RecBase>
          events?: unknown[]
        }
        try {
          data = JSON.parse(txt)
        } catch {
          s.log('system', 'error', '[REPLAY] Import refusé — JSON illisible.')
          return
        }
        if (
          !data || data.format !== 'nexus-replay' || data.version !== 1 ||
          !Array.isArray(data.events) || !data.base || typeof data.base.consumed !== 'number'
        ) {
          s.log('system', 'error', '[REPLAY] Import refusé — format nexus-replay v1 attendu (base + événements).')
          return
        }
        // Assainissement : seuls les événements REJOUABLES ET NUMÉRIQUEMENT
        // SAINS sont retenus — un segment/via corrompu (NaN, champ manquant)
        // produirait une géométrie NaN côté viewer (THREE radius NaN).
        const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
        const segOk = (s: unknown): boolean => {
          if (!s || typeof s !== 'object') return false
          const x = s as { pts?: unknown; width?: unknown; net?: unknown }
          return (
            typeof x.net === 'string' && fin(x.width) && Array.isArray(x.pts) && x.pts.length >= 2 &&
            x.pts.every((p) => p && fin((p as { x?: unknown }).x) && fin((p as { y?: unknown }).y))
          )
        }
        const viaOk = (v: unknown): boolean => {
          if (!v || typeof v !== 'object') return false
          const x = v as { net?: unknown; x?: unknown; y?: unknown; drill?: unknown; diameter?: unknown }
          return typeof x.net === 'string' && fin(x.x) && fin(x.y) && fin(x.drill) && fin(x.diameter)
        }
        const ok: LiveQueued[] = []
        for (const e of data.events as LiveQueued[]) {
          if (!e || typeof e !== 'object') continue
          if (e.k === 'trace' && e.ev) {
            if (e.ev.type === 'segment' && segOk(e.ev.segment)) { ok.push(e); continue }
            if (e.ev.type === 'via' && viaOk(e.ev.via)) { ok.push(e); continue }
            continue
          }
          if (e.k === 'progress' && e.p && typeof e.p.done === 'number') { ok.push(e); continue }
          if (e.k === 'phase' && typeof e.phase === 'string') { ok.push(e); continue }
          if (e.k === 'hello' && typeof e.total === 'number') { ok.push(e); continue }
          // 'complete' et inconnus : ignorés (la finalisation vit dans result.routing)
        }
        const b = data.base
        const hasTraces = ok.some((q) => q.k === 'trace') || (b.traces ?? 0) > 0 || (Array.isArray(b.routes) && b.routes.length > 0)
        if (!hasTraces) {
          s.log('system', 'error', '[REPLAY] Import refusé — la session ne contient aucune trace rejouable.')
          return
        }
        const base: RecBase = {
          consumed: typeof b.consumed === 'number' ? b.consumed : 0,
          routes: Array.isArray(b.routes) ? b.routes : [],
          traces: b.traces ?? 0,
          netsDone: b.netsDone ?? 0,
          netsTotal: b.netsTotal ?? 0,
          currentNet: b.currentNet ?? '—',
          phase: (b.phase ?? 'greedy') as RecBase['phase'],
        }
        // Révoque toute session résiduelle puis installe la session importée
        liveEpoch++
        liveFlush()
        liveReplaying = false
        livePaused = false
        liveRecording = ok
        recBase = base
        const total = base.consumed + ok.length
        set({ canReplay: true, replayPos: 0, replayTotal: total, replayPaused: false, liveRouting: idleLive(), liveRoutes: [] })
        const other = data.project?.id && data.project.id !== s.netlistId
        s.log('system', 'agent',
          `[REPLAY] Session importée « ${file.name} » — ${total} événements (base ${base.consumed} + bruts ${ok.length}, ${base.traces} traces compactées)${other ? ' — projet d’origine différent : relecture visuelle' : ''}. REPLAY ou timeline pour la rejouer.`)
      })
      .catch(() => s.log('system', 'error', '[REPLAY] Import impossible — lecture du fichier échouée.'))
  },

  /* Hook E2E — injection synthétique dans l'enregistrement uniquement : on
   * écrit dans le ring buffer AVEC la même éviction par tranches que
   * liveEnqueue, mais sans passer par la file de lecture (17k événements
   * seraient sinon dépilés à 14 ms/s). Publie canReplay/replayTotal pour
   * rendre la session injectable consultable (barre replay + timeline). */
  testInjectRecording: (n) => {
    for (let i = 0; i < n; i++) {
      const m = i % 5
      let q: LiveQueued
      if (m < 3) {
        const net = `T${Math.floor(i / 5)}`
        const x = 2 + (i % 30)
        q = { k: 'trace', ev: { type: 'segment', net, segment: { net, pts: [{ x, y: 2 }, { x: x + 1, y: 4 }], layer: 0, width: 0.25 } } }
      } else if (m === 3) {
        q = { k: 'progress', p: { done: Math.floor(i / 5), total: Math.ceil(n / 5), net: `T${Math.floor(i / 5)}`, ok: true } }
      } else {
        q = { k: 'phase', phase: 'greedy' }
      }
      liveRecording.push(q)
      if (liveRecording.length > REC_CAP) {
        foldIntoBase(recBase, liveRecording.slice(0, REC_TRANCHE))
        liveRecording = liveRecording.slice(REC_TRANCHE)
      }
    }
    const total = recordingTotal()
    set({ canReplay: true, replayTotal: total, replayPos: 0 })
    get().log('system', 'agent', `[TEST] ${n} événements synthétiques injectés — timeline ${total} évts (base ${recBase.consumed} + bruts ${liveRecording.length}, ${recBase.traces} traces compactées)`)
  },

  /* ---------------- Undo / Redo multi-niveaux chirurgicaux [Flux.ai] --------
   * Chaque déplacement (popup, clavier, drag souris, nudge live) pousse un
   * instantané ; Ctrl+Z ou le bouton remonte la pile et re-route à chaque
   * étape ; Ctrl+Maj+Z rétablit en miroir (pile redo dépilée, l'état courant
   * re-empilé sur la pile undo). Le re-routage réutilise exactement celui de
   * la chirurgie — l'état retrouvé est donc complet (SI + DRC/DFM + export). */
  undoSurgical: async () => {
    const s = get()
    if (s.running || s.surgicalBusy || s.liveRouting.active || !s.livePlacements || !s.result.thermal) return
    const hist = s.placementHistory
    if (hist.length === 0) return
    const before = s.livePlacements
    const prev = hist[hist.length - 1]
    set({
      placementHistory: hist.slice(0, -1),
      redoStack: [...s.redoStack.slice(-19), s.livePlacements.map((p) => ({ ...p }))], // l'état quitté devient rétablissable
      surgicalBusy: true,
      livePlacements: prev.map((p) => ({ ...p })),
    })
    const undone = placementDiff(before, prev)
    if (undone) logEdit('undo', undone.ref, undone.from, undone.to, `annulation (${hist.length - 1} restante(s))`)
    s.log('system', 'agent', `[UNDO] Retour au placement précédent (${hist.length - 1} annulation(s) restante(s)) — re-routage incrémental…`)
    await new Promise((r) => setTimeout(r, 40))
    await rerouteAfterPlacementEdit('[UNDO]')
    set({ surgicalBusy: false })
  },

  redoSurgical: async () => {
    const s = get()
    if (s.running || s.surgicalBusy || s.liveRouting.active || !s.livePlacements || !s.result.thermal) return
    const redo = s.redoStack
    if (redo.length === 0) return
    const before = s.livePlacements
    const next = redo[redo.length - 1]
    set({
      redoStack: redo.slice(0, -1),
      placementHistory: [...s.placementHistory.slice(-19), s.livePlacements.map((p) => ({ ...p }))], // l'état quitté redevient annulable
      surgicalBusy: true,
      livePlacements: next.map((p) => ({ ...p })),
    })
    const redone = placementDiff(before, next)
    if (redone) logEdit('redo', redone.ref, redone.from, redone.to, `rétablissement (${redo.length - 1} restant(s))`)
    s.log('system', 'agent', `[REDO] Déplacement rétabli (${redo.length - 1} rétablissement(s) restant(s)) — re-routage incrémental…`)
    await new Promise((r) => setTimeout(r, 40))
    await rerouteAfterPlacementEdit('[REDO]')
    set({ surgicalBusy: false })
  },

  /* ---------------- Drag & drop direct [souris] ------------------------------
   * Saisir un composant et le faire glisser librement : le premier mouvement
   * pousse l'instantané d'undo (UNE seule fois, quel que soit le nombre de
   * mousemove) et coupe un éventuel flux live/replay ; le relâchement
   * déclenche le re-routage chirurgical — ou la reprise du flux EN DIRECT
   * si un flux tournait. Un simple clic (sans mouvement) reste une sélection. */
  beginDrag: (ref) => {
    const s = get()
    if (s.running || s.surgicalBusy || !s.livePlacements) return
    dragMoved = false
    dragWasLive = false
    dragFromPos = s.livePlacements.find((p) => p.ref === ref) ?? null // journal [P2.4]
    set({ dragRef: ref })
  },

  dragMoveTo: (ref, x, y) => {
    const s = get()
    if (!s.livePlacements || s.dragRef !== ref) return
    if (!dragMoved) {
      // premier vrai mouvement : snapshot d'undo (une seule fois) + coupure propre du flux
      dragMoved = true
      pushPlacementHistory()
      if (s.liveRouting.active) {
        dragWasLive = true
        get().stopLiveRouting('nudge')
      }
    }
    const nl = s.netlist
    const c = nl.components.find((x2) => x2.ref === ref)
    if (!c) return
    const p0 = s.livePlacements.find((p) => p.ref === ref)
    if (!p0) return
    const swap = p0.rot === 90 || p0.rot === 270
    const w = swap ? c.footprint.h : c.footprint.w
    const h = swap ? c.footprint.w : c.footprint.h
    // clamp rotation-aware dans la carte (marge 0,4 mm — même règle que la chirurgie)
    const cx = Math.min(nl.board.w - w / 2 - 0.4, Math.max(w / 2 + 0.4, x))
    const cy = Math.min(nl.board.h - h / 2 - 0.4, Math.max(h / 2 + 0.4, y))
    set({ livePlacements: s.livePlacements.map((p) => (p.ref === ref ? { ...p, x: cx, y: cy } : p)) })
  },

  commitDrag: async (ref) => {
    const s = get()
    const wasMoved = dragMoved
    const wasLive = dragWasLive
    const fromPos = dragFromPos
    dragMoved = false
    dragWasLive = false
    dragFromPos = null
    set({ dragRef: null })
    if (!wasMoved || !s.livePlacements) return // simple clic sans mouvement → sélection seule
    if (s.running) return
    // Journal [P2.4] — le drag est tracé dans tous les cas de re-routage
    const toPos = s.livePlacements.find((p) => p.ref === ref)
    if (fromPos && toPos && (Math.abs(fromPos.x - toPos.x) > 1e-6 || Math.abs(fromPos.y - toPos.y) > 1e-6)) {
      logEdit('drag', ref, fromPos, toPos, wasLive ? 'flux live coupé puis repris en direct' : undefined)
    }
    if (wasLive) {
      // un flux live/replay tournait : le routeur repart EN DIRECT sur la nouvelle géométrie
      void get().startLiveRouting(3, true)
      return
    }
    if (s.liveRouting.active || s.surgicalBusy) return
    if (!s.result.thermal) {
      // pas encore de conception complète : le placement reste tel quel
      s.log('system', 'warn', `[DRAG] ${ref} repositionné — lancez la conception pour obtenir le re-routage complet.`)
      return
    }
    set({ surgicalBusy: true })
    s.log('system', 'agent', `[DRAG] ${ref} repositionné à la souris — re-routage incrémental…`)
    await new Promise((r) => setTimeout(r, 40))
    await rerouteAfterPlacementEdit('[DRAG]')
    set({ surgicalBusy: false })
  },

  startLiveRouting: async (pacingMs = 3, force = false) => {
    const s = get()
    if (s.running) return // le pipeline reste prioritaire absolu
    if (!force && s.liveRouting.active) {
      console.log(`[LIVE] demande ignorée (running=${s.running}, active=${s.liveRouting.active})`)
      return
    }
    const placements = s.livePlacements ?? s.result.placement?.placements
    if (!placements || placements.length === 0) {
      get().log('system', 'warn', '[LIVE] Aucun placement disponible — lancez d’abord la conception : le routage live réutilise le placement existant.')
      return
    }
    const nl = s.netlist
    const epoch = ++liveEpoch // la génération précédente (flux zombie éventuel) est révoquée
    const myAbort = new AbortController()
    liveAbort = myAbort
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
      console.log(`[LIVE] fetch → /api/routing/live (pacing ${pacingMs} ms) — ${placements.length} composants`)
      const res = await fetch('/api/routing/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ netlist: nl, placements, pacingMs }),
        signal: liveAbort.signal,
      })
      console.log(`[LIVE] réponse flux : HTTP ${res.status}, body=${!!res.body}`)
      if (!res.ok || !res.body) throw new Error(`flux indisponible (HTTP ${res.status})`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (epoch !== liveEpoch) return // session supplantée pendant le flux
        buf += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          const line = frame.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          let ev: LiveSseEvent
          try { ev = JSON.parse(line.slice(6)) as LiveSseEvent } catch { continue }
          if (ev.t === 'complete') console.log('[LIVE] événement complete reçu — mise en file pour lecture')
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
      console.log(`[LIVE] flux terminé (EOF) — queue restante : ${liveQueue.length}, complete joué : ${liveSawComplete}`)
    } catch (e) {
      if (epoch !== liveEpoch) return // session supplantée — le nouveau flux gère tout
      failed = true
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      get().log('system', aborted ? 'warn' : 'error',
        aborted
          ? (liveStopReason === 'nudge'
              ? '[NUDGE LIVE] Flux coupé — re-routage en direct avec la nouvelle position…'
              : '[DEEPPCB] Flux de routage live interrompu par l’utilisateur.')
          : `[DEEPPCB] Échec du flux live : ${e instanceof Error ? e.message : 'erreur inconnue'}`)
    } finally {
      console.log(`[LIVE] finally — failed=${failed}, stopReason=${liveStopReason}, queue=${liveQueue.length}, epochOK=${epoch === liveEpoch}`)
      if (liveAbort === myAbort) liveAbort = null // ne touche pas au contrôleur d'une session plus récente
      liveStopReason = null
      if (epoch !== liveEpoch) return // supplanté : la nouvelle session possède l'état
      if (failed) liveFinish() // flux mort → session fermée immédiatement
      else liveNoteStreamEnd() // la lecture locale peut encore drainer la file
    }
  },

  reset: () => {
    cancelFlag = false
    liveEpoch++
    liveAbort?.abort()
    liveAbort = null
    liveFlush()
    liveStreamDone = false
    liveRecording = []
    recBase = emptyRecBase()
    replayTotal = 0
    set({ stages: initialStages(), result: {}, livePlacements: null, costHistory: [], plan: null, running: false, cancelled: false, liveRouting: idleLive(), liveRoutes: [], placementHistory: [], redoStack: [], canReplay: false, replayPos: 0, replayTotal: 0, replayPaused: false, dragRef: null })
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
      liveRouting: idleLive(), liveRoutes: [], placementHistory: [], redoStack: [], canReplay: false,
      replayPos: 0, replayTotal: 0, replayPaused: false, dragRef: null,
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
      const recTotal = recordingTotal() // base compactée + événements bruts
      if (recTotal > 0) replayTotal = recTotal
      set({ result, running: false, liveRouting: idleLive(), liveRoutes: [], canReplay: recBase.traces > 0 || liveRecording.some((q) => q.k === 'trace'), replayPos: 0, replayTotal: recTotal })
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

  loadEditLog: async () => {
    try {
      const res = await fetch(`/api/edits?netlistId=${get().netlistId}&take=12`)
      const data = await res.json() as { edits?: EditLogItem[] }
      set({ editLog: data.edits ?? [] })
    } catch {
      set({ editLog: [] })
    }
  },
}))

/* Hook de diagnostic E2E — introspection du store et du moteur de lecture
 * depuis les tests navigateur (inoffensif en production). */
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__nexusStore = useStudio
  ;(window as unknown as Record<string, unknown>).__liveDebug = () => ({
    queue: liveQueue.length,
    timer: !!liveTimer,
    streamDone: liveStreamDone,
    sawComplete: liveSawComplete,
    abort: !!liveAbort,
    lastError: liveLastError,
    recording: liveRecording.length,
    replaying: liveReplaying,
    paused: livePaused,
    replayTotal,
    dragMoved,
    dragWasLive,
  })
}
