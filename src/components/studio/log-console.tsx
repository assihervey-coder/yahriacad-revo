'use client'
/**
 * NEXUS PCB — Console de logs temps réel (flux des agents)
 */
import { useEffect, useRef } from 'react'
import { useStudio } from '@/lib/studio-store'

const LEVEL_STYLE: Record<string, string> = {
  info: 'text-neutral-300',
  success: 'text-emerald-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
  agent: 'text-fuchsia-300',
}

const STAGE_TAG: Record<string, string> = {
  system: 'SYSTÈME',
  import: 'IMPORT',
  constraints: 'CONTRAINTES',
  intent: 'AGENT-LLM',
  placement: 'AGENT-RL',
  optimize: 'RATCHET',
  thermal: 'THERMIQUE',
  routing: 'ROUTEUR',
  drc: 'DRC/DFM',
  export: 'EXPORT',
}

export function LogConsole() {
  const logs = useStudio((s) => s.logs)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <div
      ref={scrollRef}
      data-testid="log-console"
      className="h-full overflow-y-auto rounded-xl border border-emerald-900/40 bg-black/70 p-2.5 font-mono text-[10.5px] leading-relaxed"
      aria-live="polite"
      aria-label="Journal d'exécution des agents"
    >
      {logs.slice(-160).map((l, i) => (
        <div key={`${l.ts}-${i}`} className="flex gap-2">
          <span className="shrink-0 text-neutral-600" suppressHydrationWarning>
            {new Date(l.ts).toLocaleTimeString('fr-FR', { hour12: false })}
          </span>
          <span className={`shrink-0 font-semibold ${
            l.stage === 'intent' || l.stage === 'placement' ? 'text-fuchsia-400/90' : 'text-emerald-700'
          }`}>
            [{STAGE_TAG[l.stage] ?? l.stage.toUpperCase()}]
          </span>
          <span className={`${LEVEL_STYLE[l.level] ?? 'text-neutral-300'} break-all`}>{l.msg}</span>
        </div>
      ))}
    </div>
  )
}
