'use client'
/**
 * NEXUS PCB — En-tête du studio : identité, sélection projet, contrôle du pipeline
 */
import { Cpu, Loader2, Play, Square } from 'lucide-react'
import { useStudio } from '@/lib/studio-store'
import { NETLISTS } from '@/lib/engine/netlists'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'

export function StudioHeader() {
  const netlistId = useStudio((s) => s.netlistId)
  const running = useStudio((s) => s.running)
  const cancelled = useStudio((s) => s.cancelled)
  const drcSummary = useStudio((s) => s.result.drc)
  const done = useStudio((s) => Object.values(s.stages).every((st) => st.status === 'done'))
  const run = useStudio((s) => s.run)
  const cancel = useStudio((s) => s.cancel)
  const setProject = useStudio((s) => s.setProject)

  const nl = NETLISTS.find((n) => n.id === netlistId)!

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-emerald-900/40 bg-[#081109]/90 px-4 py-2.5 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 shadow-[0_0_18px_rgba(16,185,129,0.45)]">
          <Cpu className="h-5 w-5 text-white" />
        </div>
        <div>
          <div className="text-sm font-bold tracking-wide text-emerald-100">
            NEXUS <span className="text-emerald-500">PCB</span>
          </div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-emerald-600/90">
            Conception autonome par agents IA
          </div>
        </div>
      </div>

      <div className="ml-2 min-w-[220px]">
        <Select value={netlistId} onValueChange={setProject} disabled={running}>
          <SelectTrigger className="h-8 border-emerald-900/60 bg-black/40 text-xs text-emerald-100" aria-label="Sélection du projet">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-emerald-900 bg-[#0a130d] text-emerald-100">
            {NETLISTS.map((n) => (
              <SelectItem key={n.id} value={n.id} className="text-xs">
                {n.name} — {n.components.length} composants
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="hidden text-[11px] text-neutral-500 md:block">{nl.board.w}×{nl.board.h} mm · 2 couches · FR4</div>

      <div className="ml-auto flex items-center gap-2.5">
        {done && drcSummary && (
          <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
            drcSummary.pass
              ? 'border-emerald-700/60 bg-emerald-900/40 text-emerald-300'
              : 'border-amber-700/60 bg-amber-950/40 text-amber-300'
          }`}>
            {drcSummary.pass ? 'DRC ✓' : `${drcSummary.errors} erreur(s) DRC`}
          </span>
        )}
        {running && !cancelled && (
          <span className="flex items-center gap-1.5 text-[11px] text-emerald-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Pipeline en cours…
          </span>
        )}
        {cancelled && running && (
          <span className="text-[11px] text-amber-400">Arrêt en cours…</span>
        )}
        {running ? (
          <Button size="sm" variant="destructive" className="h-8 gap-1.5 text-xs" onClick={cancel}>
            <Square className="h-3.5 w-3.5" /> Arrêter
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-8 gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-500"
            onClick={run}
          >
            <Play className="h-3.5 w-3.5" /> Lancer la conception
          </Button>
        )}
      </div>
    </header>
  )
}
