'use client'
/**
 * NEXUS PCB — Panneau gauche : netlist, composants, contraintes extraites
 */
import { useStudio } from '@/lib/studio-store'
import { extractConstraints } from '@/lib/engine/parser'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

const CATEGORY_LABEL: Record<string, string> = {
  mcu: 'MCU', memory: 'Mémoire', power: 'Alim', connector: 'Connecteur',
  passive: 'Passif', crystal: 'Quartz', rf: 'RF', sensor: 'Capteur', led: 'LED', interface: 'Interface',
}

const KIND_COLOR: Record<string, string> = {
  differential: 'bg-fuchsia-900/50 text-fuchsia-200 border-fuchsia-800',
  length_match: 'bg-amber-900/50 text-amber-200 border-amber-800',
  impedance: 'bg-pink-900/50 text-pink-200 border-pink-800',
  keepout: 'bg-red-900/50 text-red-200 border-red-800',
  adjacency: 'bg-emerald-900/50 text-emerald-200 border-emerald-800',
  edge: 'bg-teal-900/50 text-teal-200 border-teal-800',
  thermal: 'bg-orange-900/50 text-orange-200 border-orange-800',
  spacing_class: 'bg-yellow-900/50 text-yellow-200 border-yellow-800',
}

export function LeftPanel() {
  const netlist = useStudio((s) => s.netlist)
  const selectedRef = useStudio((s) => s.viewer.selectedRef)
  const multiRefs = useStudio((s) => s.viewer.multiRefs)
  const setViewer = useStudio((s) => s.setViewer)
  const placements = useStudio((s) => s.livePlacements)
  const constraints = extractConstraints(netlist)

  const hardCount = constraints.filter((c) => c.severity === 'hard').length

  return (
    <ScrollArea className="h-full pr-1">
      <div className="space-y-4 pb-6">
        {/* ---- Projet ---- */}
        <section aria-label="Projet">
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-600">
            Projet
          </h3>
          <div className="rounded-lg border border-emerald-900/40 bg-black/30 p-3">
            <div className="text-sm font-semibold text-emerald-100">{netlist.name}</div>
            <p className="mt-1 text-[11px] leading-snug text-neutral-400">{netlist.description}</p>
            <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-emerald-950/40 py-1.5">
                <div className="text-base font-bold text-emerald-300">{netlist.components.length}</div>
                <div className="text-[9px] uppercase text-neutral-500">Composants</div>
              </div>
              <div className="rounded-md bg-emerald-950/40 py-1.5">
                <div className="text-base font-bold text-emerald-300">{netlist.nets.length}</div>
                <div className="text-[9px] uppercase text-neutral-500">Nets</div>
              </div>
              <div className="rounded-md bg-emerald-950/40 py-1.5">
                <div className="text-base font-bold text-emerald-300">{constraints.length}</div>
                <div className="text-[9px] uppercase text-neutral-500">Contraintes</div>
              </div>
            </div>
          </div>
        </section>

        {/* ---- Composants ---- */}
        <section aria-label="Composants">
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-600">
            Composants · {netlist.components.length}
          </h3>
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {netlist.components.map((c) => {
              const pos = placements?.find((p) => p.ref === c.ref)
              const selected = selectedRef === c.ref || multiRefs.includes(c.ref)
              return (
                <button
                  key={c.ref}
                  onClick={(e) => {
                    // [M6] Maj+clic = toggle de la sélection multiple (bloc déplaçable aux flèches)
                    // — l'état est relu à chaque clic (jamais la closure)
                    const cur = useStudio.getState().viewer.multiRefs
                    const multi = e.shiftKey
                      ? (cur.includes(c.ref) ? cur.filter((r) => r !== c.ref) : [...new Set([...cur, c.ref])])
                      : []
                    setViewer({ selectedRef: e.shiftKey ? c.ref : (selected ? null : c.ref), multiRefs: multi })
                  }}
                  className={`w-full rounded-md border px-2 py-1.5 text-left transition-colors ${
                    selected
                      ? 'border-emerald-500/70 bg-emerald-900/30'
                      : 'border-neutral-800/50 bg-black/20 hover:border-emerald-800/60 hover:bg-emerald-950/30'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-emerald-200">{c.ref}</span>
                    <Badge variant="outline" className="h-4 border-neutral-700 px-1 text-[9px] text-neutral-400">
                      {CATEGORY_LABEL[c.category] ?? c.category}
                    </Badge>
                  </div>
                  <div className="truncate text-[10px] text-neutral-500">{c.value}</div>
                  {pos && (
                    <div className="mt-0.5 text-[9px] font-mono text-emerald-700">
                      x={pos.x.toFixed(1)} y={pos.y.toFixed(1)} rot={pos.rot}°
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </section>

        <Separator className="bg-emerald-950" />

        {/* ---- Contraintes ---- */}
        <section aria-label="Contraintes de conception">
          <h3 className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-600">
            <span>Contraintes extraites</span>
            <span className="font-mono text-[10px] text-neutral-500">{hardCount} bloquantes</span>
          </h3>
          <div className="space-y-1.5">
            {constraints.map((c) => (
              <div key={c.id} className={`rounded-md border px-2 py-1.5 ${KIND_COLOR[c.kind] ?? 'border-neutral-800 bg-neutral-900/50'}`}>
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wide">{c.kind}</span>
                  <span className="text-[9px]">{c.severity === 'hard' ? '● bloquante' : '○ souple'}</span>
                </div>
                <p className="mt-0.5 text-[10px] leading-snug opacity-90">{c.rationale}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </ScrollArea>
  )
}
