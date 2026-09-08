'use client'
/**
 * NEXUS PCB — Studio de conception autonome (page unique)
 *
 * Architecture visuelle :
 *   ┌───────────────────────────────────────────────────┐
 *   │ Header : identité · projet · lancement pipeline    │
 *   ├─────────┬──────────────────────────────┬──────────┤
 *   │ Netlist │  Étapes du pipeline           │ Pipeline │
 *   │ +       │  Viewer 3D (Three.js)         │ Agents   │
 *   │ Contr.  │  Console de logs temps réel   │ Analyse  │
 *   │         │                               │ Export   │
 *   └─────────┴──────────────────────────────┴──────────┘
 */
import dynamic from 'next/dynamic'
import { useEffect } from 'react'
import { StudioHeader } from '@/components/studio/header'
import { StageStrip } from '@/components/studio/stage-strip'
import { LogConsole } from '@/components/studio/log-console'
import { LeftPanel } from '@/components/studio/left-panel'
import { RightPanel } from '@/components/studio/right-panel'
import { useStudio } from '@/lib/studio-store'

const BoardViewer = dynamic(
  () => import('@/components/studio/board-viewer'),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center rounded-xl border border-emerald-900/40 bg-[#05080a]">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-emerald-700 border-t-emerald-400" />
          <p className="mt-3 text-[11px] text-emerald-600">Initialisation du viewer 3D…</p>
        </div>
      </div>
    ),
  },
)

export default function StudioPage() {
  const loadHistory = useStudio((s) => s.loadHistory)

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#070b09] text-emerald-50">
      <StudioHeader />

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[280px_1fr_348px] lg:overflow-hidden">
        {/* ---- Panneau gauche : netlist ---- */}
        <aside className="order-3 h-[560px] shrink-0 border-t border-emerald-900/40 bg-black/20 p-3 lg:order-1 lg:h-auto lg:min-h-0 lg:border-t-0 lg:border-r">
          <LeftPanel />
        </aside>

        {/* ---- Centre : pipeline + viewer + console ---- */}
        <section className="order-1 flex min-h-0 shrink-0 flex-col gap-2 p-3 lg:order-2 lg:min-h-0">
          <StageStrip />
          <div className="h-[52vh] min-h-0 shrink-0 lg:h-auto lg:flex-1 lg:shrink">
            <BoardViewer />
          </div>
          <div className="h-36 shrink-0 lg:h-40">
            <LogConsole />
          </div>
        </section>

        {/* ---- Panneau droit : agents / analyse / export ---- */}
        <aside className="order-2 h-[620px] shrink-0 border-t border-emerald-900/40 bg-black/20 lg:order-3 lg:h-auto lg:min-h-0 lg:border-t-0 lg:border-l">
          <RightPanel />
        </aside>
      </main>
    </div>
  )
}
