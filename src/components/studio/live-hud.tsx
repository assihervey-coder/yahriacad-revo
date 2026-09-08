'use client'
/**
 * NEXUS PCB — HUD du routage live [DeepPCB live_routing]
 * -------------------------------------------------------
 * Superposé au viewer pendant un flux de routage temps réel :
 * phase du moteur, progression net par net, net courant,
 * compteur de traces, vitesse réglable en plein vol, interruption.
 * Hors flux : barre « replay » pour rejouer la dernière session enregistrée
 * [DeepPCB ×2] — même moteur de lecture, même tempo réglable, zéro serveur.
 */
import { RotateCcw, Square } from 'lucide-react'
import { useStudio } from '@/lib/studio-store'

const PHASE_LABEL: Record<string, string> = {
  greedy: 'Routeur A* — pose des pistes, trait par trait',
  ripup: 'Rip-up & reroute — déblocage des nets coincés',
  'via-min': 'Minimisation des vias [DeepPCB]',
  pour: 'Plan de masse synthétique',
  done: 'Finalisation…',
  idle: '',
}

const SPEEDS = [0.5, 1, 2, 4] as const
const SPEED_TITLE: Record<number, string> = {
  0.5: 'Ralenti — admire chaque piste se poser',
  1: 'Vitesse normale (tempo DeepPCB)',
  2: 'Accéléré ×2',
  4: 'Turbo ×4 — timelapse',
}

function SpeedSelector({ liveSpeed, setLiveSpeed }: { liveSpeed: number; setLiveSpeed: (v: number) => void }) {
  return (
    <div className="flex gap-0.5">
      {SPEEDS.map((v) => (
        <button
          key={v}
          onClick={() => setLiveSpeed(v)}
          title={SPEED_TITLE[v]}
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
            Math.abs(liveSpeed - v) < 0.01
              ? 'bg-sky-600/80 text-white'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-sky-200'
          }`}
        >
          ×{v}
        </button>
      ))}
    </div>
  )
}

export function LiveRoutingHud() {
  const live = useStudio((s) => s.liveRouting)
  const liveSpeed = useStudio((s) => s.liveSpeed)
  const setLiveSpeed = useStudio((s) => s.setLiveSpeed)
  const stopLiveRouting = useStudio((s) => s.stopLiveRouting)
  const canReplay = useStudio((s) => s.canReplay)
  const replayLastRouting = useStudio((s) => s.replayLastRouting)

  /* ---------- Hors flux : barre replay de la dernière session ---------- */
  if (!live.active) {
    if (!canReplay) return null
    return (
      <div
        data-testid="replay-bar"
        className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-violet-800/60 bg-black/85 px-3 py-2 shadow-[0_0_24px_rgba(139,92,246,0.18)] backdrop-blur"
      >
        <button
          onClick={replayLastRouting}
          title="Rejouer la dernière session de routage, trait par trait — vitesse réglable avant et pendant la lecture"
          className="flex items-center gap-1.5 rounded border border-violet-700/60 bg-violet-950/40 px-2 py-0.5 text-[11px] font-bold tracking-wide text-violet-300 transition-colors hover:bg-violet-900/40"
        >
          <RotateCcw className="h-3 w-3" /> REPLAY
        </button>
        <span className="text-[10px] text-neutral-500">dernière session · vitesse</span>
        <div className="border-l border-neutral-800 pl-2">
          <SpeedSelector liveSpeed={liveSpeed} setLiveSpeed={setLiveSpeed} />
        </div>
      </div>
    )
  }

  const pct = live.netsTotal > 0 ? Math.min(100, Math.round((live.netsDone / live.netsTotal) * 100)) : 0
  const sourceLabel = live.source === 'server' ? 'FLUX SERVEUR' : live.source === 'replay' ? 'REPLAY' : 'MOTEUR LOCAL'

  return (
    <div
      data-testid="live-routing-hud"
      className="absolute left-1/2 top-3 z-10 w-72 -translate-x-1/2 rounded-lg border border-sky-800/60 bg-black/85 p-3 shadow-[0_0_24px_rgba(56,189,248,0.15)] backdrop-blur"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-bold tracking-wide text-sky-300">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
          </span>
          ROUTAGE LIVE <span className="text-[9px] font-medium text-sky-600">· {sourceLabel}</span>
        </div>
        <button
          onClick={() => stopLiveRouting()}
          title="Interrompre le flux de routage"
          className="flex items-center gap-1 rounded border border-red-800/60 bg-red-950/40 px-1.5 py-0.5 text-[10px] text-red-300 transition-colors hover:bg-red-900/40"
        >
          <Square className="h-2.5 w-2.5" /> interrompre
        </button>
      </div>

      <div className="mt-1 text-[10px] text-neutral-400">{PHASE_LABEL[live.phase] ?? live.phase}</div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-400 transition-all duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px]">
        <span className="text-neutral-500">
          nets <span className="text-neutral-300">{live.netsDone}/{live.netsTotal || '…'}</span>
          {' · '}{live.traces} traces jouées
        </span>
        <span className="max-w-[45%] truncate font-mono text-sky-300" title={live.currentNet}>
          {live.currentNet}
        </span>
      </div>

      {/* Vitesse du flux réglable en plein vol — la lecture est cadencée localement */}
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-sky-900/40 pt-2">
        <span className="text-[9px] uppercase tracking-wider text-neutral-500">vitesse</span>
        <SpeedSelector liveSpeed={liveSpeed} setLiveSpeed={setLiveSpeed} />
      </div>

      {live.source === 'server' && (
        <div className="mt-1.5 text-[9px] leading-snug text-neutral-500">
          Nudge live : sélectionnez un composant puis les flèches du clavier —
          le routeur repart <span className="text-sky-400">en direct</span> sur la nouvelle position.
        </div>
      )}
      {live.source === 'replay' && (
        <div className="mt-1.5 text-[9px] leading-snug text-neutral-500">
          Replay : relecture locale de la session enregistrée — aucun serveur sollicité.
          À la fin, retour à l&apos;état final canonique.
        </div>
      )}
    </div>
  )
}
