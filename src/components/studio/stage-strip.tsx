'use client'
/**
 * NEXUS PCB — Bandeau des étapes du pipeline (vue macro du workflow)
 */
import {
  CheckCircle2, Circle, FileInput, Layers, Route as RouteIcon,
  ShieldCheck, Sparkles, Thermometer, XCircle, Boxes,
} from 'lucide-react'
import { useStudio } from '@/lib/studio-store'
import type { StageId } from '@/lib/engine/types'
import { Progress } from '@/components/ui/progress'

const ICONS: Record<StageId, React.ComponentType<{ className?: string }>> = {
  import: FileInput,
  constraints: Layers,
  intent: Sparkles,
  placement: Boxes,
  thermal: Thermometer,
  routing: RouteIcon,
  drc: ShieldCheck,
  export: CheckCircle2,
}

export function StageStrip() {
  const stages = useStudio((s) => s.stages)
  const order: StageId[] = ['import', 'constraints', 'intent', 'placement', 'thermal', 'routing', 'drc', 'export']

  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 xl:grid-cols-8" role="list" aria-label="Étapes du pipeline">
      {order.map((id, i) => {
        const st = stages[id]
        const Icon = ICONS[id]
        const running = st.status === 'running'
        return (
          <div
            key={id}
            role="listitem"
            data-testid={`stage-${id}`}
            className={`relative overflow-hidden rounded-lg border px-2.5 py-2 transition-all duration-300 ${
              st.status === 'done'
                ? 'border-emerald-700/60 bg-emerald-950/40'
                : running
                  ? 'border-emerald-500/70 bg-emerald-900/25 shadow-[0_0_14px_rgba(16,185,129,0.25)]'
                  : st.status === 'error'
                    ? 'border-red-800/60 bg-red-950/30'
                    : 'border-neutral-800/60 bg-black/30'
            }`}
          >
            <div className="flex items-center gap-1.5">
              {st.status === 'done' ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              ) : st.status === 'error' ? (
                <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
              ) : running ? (
                <Icon className="h-3.5 w-3.5 shrink-0 animate-pulse text-emerald-400" />
              ) : (
                <Circle className="h-3.5 w-3.5 shrink-0 text-neutral-700" />
              )}
              <span className={`truncate text-[11px] font-medium ${st.status === 'pending' ? 'text-neutral-500' : 'text-emerald-100'}`}>
                {i + 1}. {st.label}
              </span>
            </div>
            <div className={`mt-0.5 truncate text-[10px] ${running ? 'text-emerald-300/90' : 'text-neutral-500'}`}>
              {st.detail || 'en attente'}
            </div>
            {running && (
              <Progress value={st.progress * 100} className="mt-1 h-0.5 bg-emerald-950" />
            )}
          </div>
        )
      })}
    </div>
  )
}
