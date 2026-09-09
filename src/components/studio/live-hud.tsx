'use client'
/**
 * NEXUS PCB — HUD du routage live [DeepPCB live_routing]
 * -------------------------------------------------------
 * Superposé au viewer pendant un flux de routage temps réel :
 * phase du moteur, progression net par net, net courant,
 * compteur de traces, vitesse réglable en plein vol, interruption.
 * Hors flux : barre « replay » pour rejouer la dernière session enregistrée
 * [DeepPCB ×2] — même moteur de lecture, même tempo réglable, zéro serveur,
 * et TIMELINE seekable : scrub, avance, recul, pause — dans la session.
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Pause, Play, RotateCcw, SkipBack, SkipForward, Square } from 'lucide-react'
import { useStudio } from '@/lib/studio-store'

/* [audit P0.1] Les conteneurs du HUD sont TRAVERSAUX aux événements pointeur
 * (pointer-events-none) — seuls les contrôles récupèrent les clics (auto).
 * L'arrière-plan et les libellés laissent passer les gestes vers la carte :
 * on peut saisir/dragger un composant sous le HUD. Repli compact : une pilule
 * minimale (auto sur fenêtre contrainte, bascule manuelle sinon). */

function CollapseButton({ compact, onToggle }: { compact: boolean; onToggle: () => void }) {
  return (
    <button
      data-testid={compact ? 'hud-expand' : 'hud-collapse'}
      onClick={onToggle}
      title={compact ? 'Déplier le HUD (timeline, vitesse, détails)' : 'Replier le HUD en pilule — libère la carte sous le HUD'}
      className="pointer-events-auto rounded p-0.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
    >
      {compact ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
    </button>
  )
}

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
    <div className="pointer-events-auto flex gap-0.5">
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

/** Timeline seekable du replay : scrub au slider + transport (début, recul,
 *  pause/lecture, avance, fin). Le scrub est débouné — chaque seek reconstruit
 *  instantanément l'état de la session à l'instant visé. Depuis le repos, un
 *  scrub ouvre la session en pause ; ▶ lit, ⏸ fige, à n'importe quel instant. */
function ReplayTimeline() {
  const replayPos = useStudio((s) => s.replayPos)
  const replayTotal = useStudio((s) => s.replayTotal)
  const replayPaused = useStudio((s) => s.replayPaused)
  const seekReplay = useStudio((s) => s.seekReplay)
  const pauseReplay = useStudio((s) => s.pauseReplay)
  const resumeReplay = useStudio((s) => s.resumeReplay)
  const replayLastRouting = useStudio((s) => s.replayLastRouting)
  const liveActive = useStudio((s) => s.liveRouting.active)
  const [local, setLocal] = useState<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
  if (replayTotal === 0) return null
  const value = local ?? replayPos
  const step = Math.max(1, Math.round(replayTotal / 50))
  const onScrub = (v: number) => {
    const clamped = Math.max(0, Math.min(replayTotal, Math.round(v)))
    setLocal(clamped)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      seekReplay(clamped)
      setLocal(null)
    }, 90)
  }
  const transportCls = 'rounded border border-neutral-700 bg-black/50 p-1 text-neutral-300 transition-colors hover:bg-sky-900/40 hover:text-sky-200 disabled:opacity-30'
  const onPlayPause = () => {
    if (!liveActive) replayLastRouting() // depuis le repos : lire depuis le début
    else if (replayPaused) resumeReplay()
    else pauseReplay()
  }
  return (
    <div className="mt-2 border-t border-sky-900/40 pt-2">
      <div className="pointer-events-auto flex items-center gap-1" data-testid="replay-timeline">
        <button className={transportCls} title="Retour au début de la session" onClick={() => onScrub(0)}>
          <SkipBack className="h-3 w-3" />
        </button>
        <button className={transportCls} title={`Reculer (${step * 5} événements)`} onClick={() => onScrub(value - step * 5)}>
          <span className="px-0.5 text-[10px] font-mono">◀◀</span>
        </button>
        <button
          className={`${transportCls} ${replayPaused && liveActive ? 'border-sky-600/70 text-sky-300' : ''}`}
          title={!liveActive ? 'Lire la session depuis le début' : replayPaused ? 'Reprendre la lecture' : 'Mettre en pause'}
          onClick={onPlayPause}
          data-testid="replay-playpause"
        >
          {!liveActive || replayPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        </button>
        <button className={transportCls} title={`Avancer (${step * 5} événements)`} onClick={() => onScrub(value + step * 5)}>
          <span className="px-0.5 text-[10px] font-mono">▶▶</span>
        </button>
        <button className={transportCls} title="Aller à la fin de la session" onClick={() => onScrub(replayTotal)}>
          <SkipForward className="h-3 w-3" />
        </button>
        <input
          type="range"
          min={0}
          max={replayTotal}
          value={value}
          onChange={(e) => onScrub(Number(e.target.value))}
          title="Timeline de la session — glissez pour naviguer (avancer / reculer)"
          className="min-w-0 flex-1 accent-sky-400"
          aria-label="Position dans la session de routage"
        />
      </div>
      <div className="mt-0.5 flex items-center justify-between text-[9px] text-neutral-500">
        <span className="font-mono">{value}/{replayTotal} évts</span>
        <span>glissez pour naviguer · pause/lecture à tout instant</span>
      </div>
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
  const replayTotal = useStudio((s) => s.replayTotal)

  /* Repli compact — automatique sur fenêtre contrainte [audit P0.1],
   * bascule manuelle via le chevron sinon. */
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    if (window.innerHeight < 560 || window.innerWidth < 640) setCompact(true)
  }, [])

  /* ---------- Hors flux : barre replay de la dernière session ---------- */
  if (!live.active) {
    if (!canReplay) return null
    if (compact) {
      return (
        <div data-testid="replay-bar" className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2">
          <div className="flex items-center gap-1.5 rounded-full border border-violet-800/60 bg-black/85 px-2.5 py-1 shadow-[0_0_18px_rgba(139,92,246,0.18)] backdrop-blur">
            <button
              onClick={replayLastRouting}
              title="Rejouer la dernière session de routage — vitesse réglable pendant la lecture"
              className="pointer-events-auto flex items-center gap-1 rounded-full border border-violet-700/60 bg-violet-950/40 px-2 py-0.5 text-[10px] font-bold tracking-wide text-violet-300 transition-colors hover:bg-violet-900/40"
            >
              <RotateCcw className="h-3 w-3" /> REPLAY
            </button>
            <span className="font-mono text-[9px] text-neutral-500">{replayTotal} évts</span>
            <CollapseButton compact onToggle={() => setCompact(false)} />
          </div>
        </div>
      )
    }
    return (
      <div
        data-testid="replay-bar"
        className="pointer-events-none absolute left-1/2 top-3 z-10 w-80 -translate-x-1/2 rounded-lg border border-violet-800/60 bg-black/85 px-3 py-2 shadow-[0_0_24px_rgba(139,92,246,0.18)] backdrop-blur"
      >
        <div className="flex items-center gap-2">
          <button
            onClick={replayLastRouting}
            title="Rejouer la dernière session de routage, trait par trait — vitesse réglable avant et pendant la lecture"
            className="pointer-events-auto flex items-center gap-1.5 rounded border border-violet-700/60 bg-violet-950/40 px-2 py-0.5 text-[11px] font-bold tracking-wide text-violet-300 transition-colors hover:bg-violet-900/40"
          >
            <RotateCcw className="h-3 w-3" /> REPLAY
          </button>
          <span className="text-[10px] text-neutral-500">dernière session · vitesse</span>
          <div className="border-l border-neutral-800 pl-2">
            <SpeedSelector liveSpeed={liveSpeed} setLiveSpeed={setLiveSpeed} />
          </div>
          <div className="ml-auto">
            <CollapseButton compact={false} onToggle={() => setCompact(true)} />
          </div>
        </div>
        {/* Timeline seekable : scrubber dans la session sans la relancer */}
        <ReplayTimeline />
      </div>
    )
  }

  const pct = live.netsTotal > 0 ? Math.min(100, Math.round((live.netsDone / live.netsTotal) * 100)) : 0
  const sourceLabel = live.source === 'server' ? 'FLUX SERVEUR' : live.source === 'replay' ? 'REPLAY' : 'MOTEUR LOCAL'

  /* Pilule compacte : l'essentiel (état, progression, arrêt) tient sur une ligne */
  if (compact) {
    return (
      <div data-testid="live-routing-hud" className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2">
        <div className="flex items-center gap-1.5 rounded-full border border-sky-800/60 bg-black/85 px-2.5 py-1 shadow-[0_0_18px_rgba(56,189,248,0.15)] backdrop-blur">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
          </span>
          <span className="text-[10px] font-bold tracking-wide text-sky-300">
            {live.source === 'replay' ? 'REPLAY' : 'LIVE'} · {pct}%
          </span>
          <CollapseButton compact onToggle={() => setCompact(false)} />
          <button
            onClick={() => stopLiveRouting()}
            title="Interrompre le flux de routage"
            className="pointer-events-auto flex items-center rounded-full border border-red-800/60 bg-red-950/40 px-1.5 py-0.5 text-[10px] text-red-300 transition-colors hover:bg-red-900/40"
          >
            <Square className="h-2.5 w-2.5" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="live-routing-hud"
      className="pointer-events-none absolute left-1/2 top-3 z-10 w-72 -translate-x-1/2 rounded-lg border border-sky-800/60 bg-black/85 p-3 shadow-[0_0_24px_rgba(56,189,248,0.15)] backdrop-blur"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-bold tracking-wide text-sky-300">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
          </span>
          ROUTAGE LIVE <span className="text-[9px] font-medium text-sky-600">· {sourceLabel}</span>
        </div>
        <div className="flex items-center gap-1">
          <CollapseButton compact={false} onToggle={() => setCompact(true)} />
          <button
            onClick={() => stopLiveRouting()}
            title="Interrompre le flux de routage"
            className="pointer-events-auto flex items-center gap-1 rounded border border-red-800/60 bg-red-950/40 px-1.5 py-0.5 text-[10px] text-red-300 transition-colors hover:bg-red-900/40"
          >
            <Square className="h-2.5 w-2.5" /> interrompre
          </button>
        </div>
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
          Nudge live : glissez un composant à la souris ou sélectionnez-le puis utilisez les flèches du clavier —
          le routeur repart <span className="text-sky-400">en direct</span> sur la nouvelle position.
        </div>
      )}
      {live.source === 'replay' && (
        <>
          {/* Timeline seekable — avancer/reculer dans la session rejouée */}
          <ReplayTimeline />
          <div className="mt-1 text-[9px] leading-snug text-neutral-500">
            Replay : relecture locale de la session enregistrée — aucun serveur sollicité.
            À la fin, retour à l&apos;état final canonique.
          </div>
        </>
      )}
    </div>
  )
}
