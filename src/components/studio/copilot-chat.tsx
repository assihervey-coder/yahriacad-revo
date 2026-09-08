'use client'
/**
 * NEXUS PCB — Chat copilote [Flux.ai chat_interface]
 * Brainstorming conversationnel avec le moteur : le copilote connaît
 * les métriques réelles du projet et conseille l'ingénieur.
 */
import { useRef, useState } from 'react'
import { Bot, CornerDownLeft, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStudio } from '@/lib/studio-store'

interface Msg { role: 'user' | 'assistant'; content: string }

const QUICK_PROMPTS = [
  'Fais le diagnostic de cette carte',
  'Où sont les risques DFM ?',
  'Comment réduire encore les vias ?',
  'Explique le plan des agents',
]

export function CopilotChat() {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const netlist = useStudio((s) => s.netlist)
  const result = useStudio((s) => s.result)
  const plan = useStudio((s) => s.plan)
  const running = useStudio((s) => s.running)

  const buildContext = () => {
    const r = result
    const lines = [
      `Projet : ${netlist.name} — ${netlist.description}`,
      `Carte : ${netlist.board.w}×${netlist.board.h} mm, 2 couches, ${netlist.components.length} composants, ${netlist.nets.length} nets`,
    ]
    if (plan) lines.push(`Plan stratégique (${plan.source === 'llm' ? 'LLM' : 'règles'}) : ${plan.strategy}`)
    if (r.placement) lines.push(`Placement : HPWL ${r.placement.cost.hpwl.toFixed(0)}, coût total ${r.placement.cost.total.toFixed(0)}, ${r.placement.iterations} itérations`)
    if (r.optimization) lines.push(`Optimisation ratchet AutoPCB : ${r.optimization.accepted}/${r.optimization.proposals} propositions gardées, gain ${r.optimization.gainPct} %`)
    if (r.verification) lines.push(`Audit Siemens Fuse : placement ${r.verification.placementPass ? 'OK' : 'violations'}, routage ${r.verification.routingPass ? 'OK' : 'écarts'}, rollback ${r.verification.rolledBack ? 'appliqué' : 'non requis'}`)
    if (r.thermal) lines.push(`Thermique : max ${r.thermal.maxT.toFixed(1)} °C (ambiante ${r.thermal.minT.toFixed(1)} °C), points chauds : ${r.thermal.hotspots.slice(0, 3).map((h) => `${h.ref} ${h.t.toFixed(0)}°C`).join(', ')}`)
    if (r.routing) lines.push(`Routage : ${r.routing.routedNets}/${r.routing.totalNets} nets, ${r.routing.viaCount} vias${r.routing.viasRemoved ? ` (−${r.routing.viasRemoved} via minimizer DeepPCB)` : ''}, ${r.routing.totalLengthMm.toFixed(0)} mm de pistes`)
    if (r.si) {
      const bad = r.si.metrics.filter((m) => m.impedanceOk === false || m.crosstalkOk === false)
      const detail = bad
        .map((m) => `${m.net} (${m.crosstalkPct !== undefined ? `diaphonie ${m.crosstalkPct}%` : 'impédance'})`)
        .join(', ')
      lines.push(`SI : ${r.si.pass ? 'conforme' : 'écarts'}${bad.length ? ` — nets en alerte : ${detail}` : ''}`)
    }
    if (r.drc) lines.push(`DRC : ${r.drc.errors} erreurs, ${r.drc.warnings} avertissements — DFM ${r.dfm?.score ?? '?'}/100`)
    if (r.drc && r.drc.violations.length) lines.push(`Violations : ${r.drc.violations.slice(0, 5).map((v) => v.code).join(', ')}`)
    return lines.join('\n')
  }

  const send = async (text: string) => {
    const content = text.trim()
    if (!content || busy) return
    const next: Msg[] = [...messages, { role: 'user', content }]
    setMessages(next)
    setInput('')
    setBusy(true)
    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next, context: buildContext() }),
      })
      const data = await res.json() as { reply?: string; error?: string }
      setMessages((m) => [...m, { role: 'assistant', content: data.reply ?? `⚠ ${data.error ?? 'Erreur du copilote'}` }])
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: '⚠ Copilote injoignable — vérifiez la connexion.' }])
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1 p-3">
        {messages.length === 0 ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-fuchsia-900/40 bg-fuchsia-950/10 p-3">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-fuchsia-400" />
                <span className="text-[11px] font-semibold text-fuchsia-200">Copilote NEXUS — brainstorming [Flux.ai]</span>
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-400">
                Je connais les métriques réelles de votre carte : posez vos questions de diagnostic,
                d&apos;arbitrage technique ou demandez-moi d&apos;expliquer les décisions des agents.
              </p>
            </div>
            <div className="grid gap-1.5">
              {QUICK_PROMPTS.map((q) => (
                <button
                  key={q}
                  onClick={() => void send(q)}
                  className="rounded-md border border-neutral-800 bg-black/30 px-2.5 py-1.5 text-left text-[11px] text-neutral-300 transition-colors hover:border-fuchsia-800/60 hover:bg-fuchsia-950/20 hover:text-fuchsia-200"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`max-w-[92%] rounded-lg px-3 py-2 text-[11px] leading-relaxed ${
                  m.role === 'user'
                    ? 'ml-auto border border-emerald-800/50 bg-emerald-950/30 text-emerald-100'
                    : 'border border-fuchsia-900/40 bg-fuchsia-950/10 text-neutral-200'
                }`}
              >
                <div className="whitespace-pre-wrap">{m.content}</div>
              </div>
            ))}
            {busy && (
              <div className="flex items-center gap-2 px-1 text-[10px] text-fuchsia-400">
                <Loader2 className="h-3 w-3 animate-spin" /> le copilote analyse les métriques…
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      <div className="shrink-0 border-t border-emerald-900/40 p-2.5">
        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            className="mb-1.5 flex items-center gap-1 text-[9px] text-neutral-600 hover:text-neutral-400"
          >
            <RotateCcw className="h-2.5 w-2.5" /> réinitialiser la conversation
          </button>
        )}
        <form
          className="flex gap-1.5"
          onSubmit={(e) => { e.preventDefault(); void send(input) }}
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={running ? 'pipeline en cours…' : 'Posez votre question…'}
            disabled={busy || running}
            className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-black/50 px-2.5 py-1.5 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-fuchsia-800 focus:outline-none disabled:opacity-50"
          />
          <Button
            type="submit"
            size="sm"
            disabled={busy || running || !input.trim()}
            className="h-8 shrink-0 gap-1 bg-fuchsia-700 px-2.5 text-[11px] text-white hover:bg-fuchsia-600 disabled:opacity-40"
          >
            <CornerDownLeft className="h-3 w-3" /> Envoyer
          </Button>
        </form>
      </div>
    </div>
  )
}
