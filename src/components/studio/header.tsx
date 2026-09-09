'use client'
/**
 * NEXUS PCB — En-tête du studio : identité, sélection projet, générateur IA
 * [Circuitron nl_to_skidl], contrôle du pipeline
 */
import { useState } from 'react'
import { Cpu, Loader2, Play, Radio, Sparkles, Square } from 'lucide-react'
import { useStudio } from '@/lib/studio-store'
import { NETLISTS } from '@/lib/engine/netlists'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

const EXAMPLES = [
  'Une carte drone : STM32, IMU, récepteur RC et régulateur 5V',
  'Un capteur LoRa sur batterie avec charge solaire',
  'Une carte de test USB-C avec ESP32 et 8 LED',
]

export function StudioHeader() {
  const netlistId = useStudio((s) => s.netlistId)
  const running = useStudio((s) => s.running)
  const cancelled = useStudio((s) => s.cancelled)
  const drcSummary = useStudio((s) => s.result.drc)
  const done = useStudio((s) => Object.values(s.stages).every((st) => st.status === 'done'))
  const customNetlists = useStudio((s) => s.customNetlists)
  const run = useStudio((s) => s.run)
  const cancel = useStudio((s) => s.cancel)
  const startLiveRouting = useStudio((s) => s.startLiveRouting)
  const liveRouting = useStudio((s) => s.liveRouting)
  const hasPlacement = useStudio((s) => !!(s.livePlacements ?? s.result.placement))
  const setProject = useStudio((s) => s.setProject)
  const setLayers = useStudio((s) => s.setLayers)
  const storeNl = useStudio((s) => s.netlist)
  const addCustomNetlist = useStudio((s) => s.addCustomNetlist)
  const log = useStudio((s) => s.log)

  const [genOpen, setGenOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  const all = [...NETLISTS, ...customNetlists]
  const nl = all.find((n) => n.id === netlistId) ?? NETLISTS[0]

  const generate = async () => {
    if (generating || prompt.trim().length < 10) return
    setGenerating(true)
    setGenError(null)
    try {
      const res = await fetch('/api/agent/netlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim() }),
      })
      const data = await res.json() as { netlist?: import('@/lib/engine/types').Netlist; warnings?: string[]; error?: string }
      if (!res.ok || !data.netlist) {
        setGenError(data.error ?? 'Génération impossible — reformulez.')
        return
      }
      addCustomNetlist(data.netlist)
      for (const w of data.warnings ?? []) log('system', 'warn', `[CIRCUITRON] ${w}`)
      log('system', 'agent', `[CIRCUITRON] Netlist générée : ${data.netlist.name} — ${data.netlist.components.length} composants, ${data.netlist.nets.length} nets (langage naturel → connectivité validée)`)
      setGenOpen(false)
      setPrompt('')
    } catch {
      setGenError('Agent générateur injoignable.')
    } finally {
      setGenerating(false)
    }
  }

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
            Conception autonome par essaim d&apos;agents IA
          </div>
        </div>
      </div>

      <div className="ml-2 min-w-[200px]">
        <Select value={netlistId} onValueChange={setProject} disabled={running}>
          <SelectTrigger className="h-8 border-emerald-900/60 bg-black/40 text-xs text-emerald-100" aria-label="Sélection du projet">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-emerald-900 bg-[#0a130d] text-emerald-100">
            {all.map((n) => (
              <SelectItem key={n.id} value={n.id} className="text-xs">
                {n.name} — {n.components.length} composants{n.id.startsWith('custom-') ? ' ✨' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button
        size="sm"
        variant="outline"
        disabled={running}
        className="h-8 gap-1.5 border-fuchsia-800/60 bg-fuchsia-950/30 px-2.5 text-[11px] text-fuchsia-300 hover:bg-fuchsia-900/40 hover:text-fuchsia-200"
        onClick={() => setGenOpen(true)}
        title="Décrivez votre carte en langage naturel — l'agent Circuitron génère la netlist"
      >
        <Sparkles className="h-3.5 w-3.5" /> Générer par IA
      </Button>

      <Button
        size="sm"
        variant="outline"
        disabled={running || liveRouting.active || !hasPlacement}
        className="h-8 gap-1.5 border-sky-800/60 bg-sky-950/30 px-2.5 text-[11px] text-sky-300 hover:bg-sky-900/40 hover:text-sky-200 disabled:opacity-40"
        onClick={() => void startLiveRouting()}
        title="Routage live façon DeepPCB — le routeur serveur diffuse chaque piste en temps réel (placement existant réutilisé)"
      >
        <Radio className="h-3.5 w-3.5" /> Routage live
      </Button>

      <div className="hidden items-center gap-2 md:flex">
        <div className="text-[11px] text-neutral-500">{nl.board.w}×{nl.board.h} mm · FR4</div>
        <Select
          value={String(storeNl.board.layers >= 4 ? 4 : 2)}
          onValueChange={(v) => setLayers(Number(v) as 2 | 4)}
          disabled={running || liveRouting.active}
        >
          <SelectTrigger
            className="h-7 w-[110px] border-emerald-900/60 bg-black/40 text-[11px] text-emerald-100"
            aria-label="Pile de couches cuivre"
            title="Pile 4 couches [P1.1] : F.Cu signal · In1.Cu signal · In2.Cu masse · B.Cu alim"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-emerald-900 bg-[#0a130d] text-emerald-100">
            <SelectItem value="2" className="text-[11px]">2 couches</SelectItem>
            <SelectItem value="4" className="text-[11px]">4 couches</SelectItem>
          </SelectContent>
        </Select>
      </div>

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
        {!running && liveRouting.active && (
          <span className="flex items-center gap-1.5 text-[11px] text-sky-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Routage live…
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
            disabled={liveRouting.active}
            className="h-8 gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-500 disabled:opacity-40"
            onClick={run}
          >
            <Play className="h-3.5 w-3.5" /> Lancer la conception
          </Button>
        )}
      </div>

      {/* ---------- Générateur de netlist par langage naturel [Circuitron] ---------- */}
      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent className="border-fuchsia-900/50 bg-[#0d0a12] text-emerald-50 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Sparkles className="h-4 w-4 text-fuchsia-400" />
              Décrire une carte — l&apos;IA génère la netlist
            </DialogTitle>
            <DialogDescription className="text-[11px] text-neutral-400">
              L&apos;agent <span className="text-fuchsia-300">Circuitron nl_to_skidl</span> sélectionne les composants
              dans notre bibliothèque d&apos;empreintes réelles et construit la connectivité broche par broche.
              Vous pourrez ensuite lancer la conception autonome complète.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="Ex : une carte télécommande avec nRF52840, joystick analogique, OLED I2C et charge USB-C…"
            className="w-full resize-none rounded-md border border-neutral-800 bg-black/50 px-3 py-2 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-fuchsia-800 focus:outline-none"
          />
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => setPrompt(ex)}
                className="rounded-full border border-neutral-800 bg-black/40 px-2.5 py-1 text-[10px] text-neutral-400 transition-colors hover:border-fuchsia-800/60 hover:text-fuchsia-300"
              >
                {ex}
              </button>
            ))}
          </div>
          {genError && (
            <p className="rounded-md bg-red-950/40 px-2.5 py-1.5 text-[11px] text-red-300">{genError}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="h-8 text-[11px] text-neutral-400" onClick={() => setGenOpen(false)}>
              Annuler
            </Button>
            <Button
              size="sm"
              disabled={generating || prompt.trim().length < 10}
              className="h-8 gap-1.5 bg-fuchsia-700 text-[11px] text-white hover:bg-fuchsia-600 disabled:opacity-40"
              onClick={() => void generate()}
            >
              {generating
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Génération…</>
                : <><Sparkles className="h-3.5 w-3.5" /> Générer la netlist</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  )
}
