'use client'
/**
 * NEXUS PCB — Panneau droit : détails pipeline, agents IA, analyses, export fabrication
 * + cartes v2 : optimiseur ratchet [AutoPCB], audit [Siemens Fuse], diaphonie [AuraStack]
 * + comparaison de runs historiques [audit P1.3]
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Bot, CheckCircle2, Download, FileDown, Gauge, GitCompare, LayoutGrid, Minus, Package, Plus, Repeat, ShieldCheck,
  Thermometer, TriangleAlert, X, Zap,
} from 'lucide-react'
import { useStudio } from '@/lib/studio-store'
import { FABRICS, checkManufacturability, buildPanel, generatePanelPackage } from '@/lib/engine/panelizer'
import { DEFAULT_RULES } from '@/lib/engine/rules'
import { extractConstraints } from '@/lib/engine/parser'
import { ruleBasedPlan } from '@/lib/engine/llm-agent'
import {
  calibrateThermalModel, calibratedDeltaT, impedanceProfile,
  type ThermalCalibration,
} from '@/lib/engine/calibration'
import { buildEvalContext } from '@/lib/engine/world-model'
import { AMBIENT } from '@/lib/engine/simulator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Sparkline } from './sparkline'
import { CopilotChat } from './copilot-chat'

function download(name: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** Métrique comparée renvoyée par /api/runs/compare [audit P1.3] */
type RunComparisonMetric = {
  key: string
  label: string
  unit: string
  decimals?: number
  a: number
  b: number
  delta: number
  pct: number | null
  verdict: 'better' | 'worse' | 'equal'
}

/** Réponse de l'API de comparaison de runs [audit P1.3] */
type RunComparison = {
  a: { createdAt: string; status: string; planSource: string }
  b: { createdAt: string; status: string; planSource: string }
  sameProject: boolean
  summary: { improved: number; regressed: number; unchanged: number }
  metrics: RunComparisonMetric[]
}

/** Formatage fr-FR compact pour les valeurs de comparaison */
function fmtNum(v: number, decimals?: number) {
  return v.toLocaleString('fr-FR', { minimumFractionDigits: decimals ?? 0, maximumFractionDigits: decimals ?? 2 })
}

export function RightPanel() {
  const stages = useStudio((s) => s.stages)
  const result = useStudio((s) => s.result)
  const plan = useStudio((s) => s.plan)
  const costHistory = useStudio((s) => s.costHistory)
  const running = useStudio((s) => s.running)
  const history = useStudio((s) => s.history)
  const netlist = useStudio((s) => s.netlist)
  const setViewer = useStudio((s) => s.setViewer)

  const gerber = result.gerber
  const placement = result.placement
  const thermal = result.thermal
  const drc = result.drc
  const dfm = result.dfm
  const si = result.si
  const routing = result.routing

  const gerberDir = useMemo(() => `${netlist.id.replace(/-/g, '_')}_fab`, [netlist.id])

  // --- Comparaison de runs historiques [audit P1.3] ---
  const [compareMode, setCompareMode] = useState(false)
  const [selA, setSelA] = useState<string | null>(null)
  const [selB, setSelB] = useState<string | null>(null)
  const [comparison, setComparison] = useState<RunComparison | null>(null)

  // Changement de projet : réinitialise la sélection
  useEffect(() => {
    setSelA(null)
    setSelB(null)
    setComparison(null)
  }, [netlist.id])

  // Les deux runs sont choisis : récupère le delta métrique par métrique
  useEffect(() => {
    if (!selA || !selB || selA === selB) return
    let alive = true
    fetch(`/api/runs/compare?a=${selA}&b=${selB}`)
      .then((r) => r.json())
      .then((d: unknown) => {
        if (!alive) return
        const data = d as RunComparison
        setComparison(data && Array.isArray(data.metrics) ? data : null)
      })
      .catch(() => { if (alive) setComparison(null) })
    return () => { alive = false }
  }, [selA, selB])

  // Export ODB++ en cours (compression tar+gz async)
  const [odbBusy, setOdbBusy] = useState(false)

  // --- Panelisation production [P2.2] ---
  const [fabId, setFabId] = useState(FABRICS[0].id)
  const [panelCols, setPanelCols] = useState(2)
  const [panelRows, setPanelRows] = useState(2)
  const [panelMode, setPanelMode] = useState<'vcut' | 'bites'>('vcut')
  const fabPreset = FABRICS.find((f) => f.id === fabId) ?? FABRICS[0]
  const fabReport = useMemo(() => {
    if (!result.routing) return null
    return checkManufacturability(netlist, result.routing, fabPreset, DEFAULT_RULES)
  }, [result.routing, fabPreset, netlist])
  const panelGeo = useMemo(
    () => buildPanel(netlist, { cols: panelCols, rows: panelRows, gapMm: 2, railMm: 5, mode: panelMode }),
    [netlist, panelCols, panelRows, panelMode],
  )
  const [panelBusy, setPanelBusy] = useState(false)

  // --- Calibration corrélation modèle ↔ simulation [P2.3] ---
  const [calBusy, setCalBusy] = useState(false)
  const [thermalCal, setThermalCal] = useState<ThermalCalibration | null>(null)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`nexus-cal-${netlist.id}`)
      setThermalCal(raw ? (JSON.parse(raw) as ThermalCalibration) : null)
    } catch {
      setThermalCal(null)
    }
  }, [netlist.id])
  const calCtx = useMemo(
    () => buildEvalContext(netlist, plan ?? ruleBasedPlan(netlist), extractConstraints(netlist)),
    [netlist, plan],
  )
  const calEst = useMemo(() => {
    if (!thermalCal || !result.placement) return null
    const map = new Map(result.placement.placements.map((p) => [p.ref, p]))
    return calibratedDeltaT(thermalCal, calCtx, map)
  }, [thermalCal, result.placement, calCtx])
  const ziProfile = useMemo(() => impedanceProfile(DEFAULT_RULES), [])
  const runCalibration = () => {
    if (calBusy) return
    setCalBusy(true)
    // Laisse le badge « calibration… » se peindre avant le blocage FDM (sync)
    setTimeout(() => {
      try {
        const anchor = result.placement?.placements
        const cal = calibrateThermalModel(netlist, plan ?? ruleBasedPlan(netlist), extractConstraints(netlist), {
          samples: 16,
          anchor,
        })
        setThermalCal(cal)
        try {
          localStorage.setItem(`nexus-cal-${netlist.id}`, JSON.stringify(cal))
        } catch {
          /* quota — la calibration reste en mémoire pour la session */
        }
        useStudio.getState().log('system', 'agent',
          `[CALIBRATION] Modèle latent calibré sur FDM — r = ${cal.r.toFixed(3)}, pente ${cal.slope.toFixed(3)} °C/u, RMSE ${cal.rmse.toFixed(1)} °C (${cal.samples + (anchor ? 1 : 0)} échantillons+ancre)`)
      } finally {
        setCalBusy(false)
      }
    }, 30)
  }

  return (
    <Tabs defaultValue="pipeline" className="flex h-full flex-col gap-0">
      <TabsList className="h-8 w-full shrink-0 justify-start gap-0.5 rounded-none border-b border-emerald-900/40 bg-black/40 p-0.5">
        {['pipeline', 'agents', 'copilote', 'analyse', 'export', 'historique'].map((t) => (
          <TabsTrigger
            key={t}
            value={t}
            className="h-7 rounded-md px-2.5 text-[11px] capitalize data-[state=active]:bg-emerald-900/50 data-[state=active]:text-emerald-200"
          >
            {t}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* ============================ PIPELINE ============================ */}
      <ScrollArea className="min-h-0 flex-1">
        <TabsContent value="pipeline" className="mt-0 space-y-3 p-3">
          {Object.values(stages).map((st) => (
            <div key={st.id} className="rounded-lg border border-neutral-800/60 bg-black/30 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-emerald-100">{st.label}</span>
                <Badge
                  variant="outline"
                  className={`h-4.5 border px-1.5 text-[9px] uppercase ${
                    st.status === 'done' ? 'border-emerald-700 text-emerald-400'
                    : st.status === 'running' ? 'border-emerald-500 text-emerald-300 animate-pulse'
                    : st.status === 'error' ? 'border-red-700 text-red-400'
                    : 'border-neutral-700 text-neutral-500'
                  }`}
                >
                  {st.status}
                </Badge>
              </div>
              <p className="mt-0.5 text-[10px] text-neutral-500">{st.detail || '—'}</p>
              {st.durationMs !== undefined && (
                <p className="text-[9px] font-mono text-emerald-800">{st.durationMs} ms</p>
              )}
            </div>
          ))}
        </TabsContent>

        {/* ============================ AGENTS ============================ */}
        <TabsContent value="agents" className="mt-0 space-y-3 p-3">
          {/* --- Agent LLM --- */}
          <section className="rounded-lg border border-fuchsia-900/40 bg-fuchsia-950/10 p-3" aria-label="Agent LLM">
            <div className="mb-1.5 flex items-center gap-2">
              <Bot className="h-4 w-4 text-fuchsia-400" />
              <span className="text-[11px] font-semibold text-fuchsia-200">Agent LLM — Plan stratégique</span>
              <Badge variant="outline" className={`ml-auto h-4.5 border px-1.5 text-[9px] ${plan?.source === 'llm' ? 'border-fuchsia-700 text-fuchsia-300' : 'border-neutral-700 text-neutral-400'}`}>
                {plan ? (plan.source === 'llm' ? 'LLM' : 'repli règles') : 'en attente'}
              </Badge>
            </div>
            {plan ? (
              <>
                <p className="text-[11px] leading-snug text-neutral-300">{plan.strategy}</p>
                <Separator className="my-2 bg-fuchsia-950/60" />
                <div className="grid grid-cols-3 gap-1.5">
                  {plan.zones.filter((z) => !z.ref.startsWith('J') && !z.ref.startsWith('R') && !z.ref.startsWith('C')).map((z) => (
                    <div key={z.ref} className="rounded-md bg-black/40 px-1.5 py-1" title={z.rationale}>
                      <div className="text-[10px] font-semibold text-emerald-200">{z.ref}</div>
                      <div className="text-[9px] text-fuchsia-300/90">{z.zone}</div>
                    </div>
                  ))}
                </div>
                {plan.notes.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {plan.notes.map((n, i) => (
                      <li key={i} className="text-[10px] text-neutral-500">• {n}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-[10px] text-neutral-500">
                L&apos;agent LLM analysera la netlist et les contraintes pour décider des zones de placement.
              </p>
            )}
          </section>

          {/* --- Agent RL / World Model --- */}
          <section className="rounded-lg border border-emerald-900/40 bg-black/30 p-3" aria-label="Agent RL">
            <div className="mb-1.5 flex items-center gap-2">
              <Zap className="h-4 w-4 text-emerald-400" />
              <span className="text-[11px] font-semibold text-emerald-200">Agent RL + World Model</span>
              {placement && (
                <span className="ml-auto font-mono text-[9px] text-emerald-600">
                  {placement.iterations} itérations · {placement.durationMs} ms
                </span>
              )}
            </div>
            <Sparkline data={costHistory} />
            {placement ? (
              <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px]">
                <div className="rounded-md bg-black/40 px-2 py-1.5">
                  <span className="text-neutral-500">HPWL </span>
                  <span className="font-mono text-emerald-300">{placement.cost.hpwl.toFixed(0)}</span>
                </div>
                <div className="rounded-md bg-black/40 px-2 py-1.5">
                  <span className="text-neutral-500">Thermique </span>
                  <span className="font-mono text-emerald-300">{placement.cost.thermal.toFixed(0)}</span>
                </div>
                <div className="rounded-md bg-black/40 px-2 py-1.5">
                  <span className="text-neutral-500">Chevauch. </span>
                  <span className="font-mono text-emerald-300">{placement.cost.overlap.toFixed(0)}</span>
                </div>
                <div className="rounded-md bg-black/40 px-2 py-1.5">
                  <span className="text-neutral-500">Contraintes </span>
                  <span className="font-mono text-emerald-300">{placement.cost.constraint.toFixed(0)}</span>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-[10px] text-neutral-500">
                Le World Model prédit la récompense (longueur, thermique, contraintes) sans simulation complète — l&apos;agent explore l&apos;espace d&apos;action par recuit simulé.
              </p>
            )}
          </section>

          {/* --- Optimiseur autonome [AutoPCB] --- */}
          {result.optimization && (
            <section className="rounded-lg border border-amber-900/40 bg-amber-950/10 p-3" aria-label="Optimiseur ratchet">
              <div className="mb-1.5 flex items-center gap-2">
                <Repeat className="h-4 w-4 text-amber-400" />
                <span className="text-[11px] font-semibold text-amber-200">Boucle ratchet [AutoPCB]</span>
                <span className="ml-auto font-mono text-[9px] text-amber-600">{result.optimization.durationMs} ms</span>
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
                <div className="rounded-md bg-black/40 py-1.5">
                  <div className="font-bold text-amber-300">{result.optimization.accepted}/{result.optimization.proposals}</div>
                  <div className="text-[9px] text-neutral-500">propositions gardées</div>
                </div>
                <div className="rounded-md bg-black/40 py-1.5">
                  <div className="font-bold text-amber-300">{result.optimization.costBefore.toFixed(0)} → {result.optimization.costAfter.toFixed(0)}</div>
                  <div className="text-[9px] text-neutral-500">coût World Model</div>
                </div>
                <div className="rounded-md bg-black/40 py-1.5">
                  <div className="font-bold text-emerald-300">−{result.optimization.gainPct} %</div>
                  <div className="text-[9px] text-neutral-500">gain sans régression</div>
                </div>
              </div>
              <p className="mt-1.5 text-[9px] leading-snug text-neutral-500">
                proposer → évaluer (World Model, µs) → garder uniquement mieux : le placement s’améliore en continu, jamais régressé.
              </p>
            </section>
          )}

          {/* --- Auto-vérification [Siemens Fuse] --- */}
          {result.verification && (
            <section className="rounded-lg border border-sky-900/40 bg-sky-950/10 p-3" aria-label="Auto-vérification">
              <div className="mb-1.5 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-sky-400" />
                <span className="text-[11px] font-semibold text-sky-200">Self-verifier [Siemens Fuse]</span>
                <Badge variant="outline" className={`ml-auto h-4.5 border px-1.5 text-[9px] ${
                  result.verification.placementPass && result.verification.routingPass
                    ? 'border-emerald-700 text-emerald-400' : 'border-amber-700 text-amber-400'
                }`}>
                  {result.verification.placementPass && result.verification.routingPass ? 'conforme' : 'écarts détectés'}
                </Badge>
              </div>
              <div className="space-y-1 text-[10px]">
                <div className="flex items-center justify-between rounded-md bg-black/40 px-2 py-1">
                  <span className="text-neutral-400">Audit placement (déterministe)</span>
                  <span className={result.verification.placementPass ? 'text-emerald-400' : 'text-amber-400'}>
                    {result.verification.placementPass ? '✓ conforme' : `${result.verification.placementViolations.length} écart(s)`}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-black/40 px-2 py-1">
                  <span className="text-neutral-400">Audit routage (ouverts, clearances)</span>
                  <span className={result.verification.routingPass ? 'text-emerald-400' : 'text-amber-400'}>
                    {result.verification.routingPass ? '✓ conforme' : `${result.verification.routingViolations.length} écart(s)`}
                  </span>
                </div>
                {result.verification.rolledBack && (
                  <p className="rounded-md bg-amber-950/30 px-2 py-1 text-[9px] text-amber-300">
                    Rollback appliqué : re-légalisation après violation, puis re-audit.
                  </p>
                )}
              </div>
            </section>
          )}

          {/* --- Routeur --- */}
          {routing && (
            <section className="rounded-lg border border-teal-900/40 bg-black/30 p-3">
              <div className="mb-1 flex items-center gap-2">
                <Gauge className="h-4 w-4 text-teal-400" />
                <span className="text-[11px] font-semibold text-teal-200">Routeur A* multicouche</span>
                <span className="ml-auto font-mono text-[9px] text-teal-600">{routing.durationMs} ms</span>
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
                <div className="rounded-md bg-black/40 py-1.5">
                  <div className="font-bold text-teal-300">{routing.routedNets}/{routing.totalNets}</div>
                  <div className="text-[9px] text-neutral-500">nets routés</div>
                </div>
                <div className="rounded-md bg-black/40 py-1.5">
                  <div className="font-bold text-teal-300">{routing.totalLengthMm.toFixed(0)}</div>
                  <div className="text-[9px] text-neutral-500">mm de pistes</div>
                </div>
                <div className="rounded-md bg-black/40 py-1.5">
                  <div className="font-bold text-teal-300">{routing.viaCount}{routing.viasRemoved ? <span className="text-emerald-400"> −{routing.viasRemoved}</span> : null}</div>
                  <div className="text-[9px] text-neutral-500">vias {routing.viasRemoved ? '[DeepPCB]' : ''}</div>
                </div>
              </div>
              {routing.viasRemoved ? (
                <p className="mt-1 text-[9px] text-emerald-500/80">
                  via_minimizer : {routing.viasRemoved} transition(s) de couche éliminée(s) — fiabilité et fabricabilité accrues.
                </p>
              ) : null}
            </section>
          )}
        </TabsContent>

        {/* ============================ COPILOTE ============================ */}
        <TabsContent value="copilote" className="mt-0 h-[calc(100%-2rem)]">
          <CopilotChat />
        </TabsContent>

        {/* ============================ ANALYSE ============================ */}
        <TabsContent value="analyse" className="mt-0 space-y-3 p-3">
          {/* Thermique */}
          <section className="rounded-lg border border-orange-900/40 bg-black/30 p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <Thermometer className="h-4 w-4 text-orange-400" />
              <span className="text-[11px] font-semibold text-orange-200">Simulation thermique</span>
              {thermal && (
                <span className="ml-auto font-mono text-[10px] text-orange-300">
                  max {thermal.maxT.toFixed(1)} °C
                </span>
              )}
            </div>
            {thermal ? (
              <div className="space-y-1">
                {thermal.hotspots.map((h) => (
                  <div key={h.ref} className="flex items-center justify-between rounded-md bg-black/40 px-2 py-1 text-[10px]">
                    <span className="text-neutral-300">{h.ref}</span>
                    <span className={`font-mono ${h.t > 85 ? 'text-red-400' : h.t > 60 ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {h.t.toFixed(1)} °C
                    </span>
                  </div>
                ))}
                <p className="text-[9px] text-neutral-600">Différences finies, grille 1 mm, bords à {thermal.minT.toFixed(0)} °C</p>
              </div>
            ) : <p className="text-[10px] text-neutral-500">En attente de la simulation…</p>}
          </section>

          {/* SI */}
          {si && si.metrics.length > 0 && (
            <section className="rounded-lg border border-cyan-900/40 bg-black/30 p-3">
              <div className="mb-1.5 text-[11px] font-semibold text-cyan-200">Intégrité du signal</div>
              <div className="space-y-1">
                {si.metrics.slice(0, 14).map((m, i) => (
                  <div key={`${m.net}-${i}`} className="rounded-md bg-black/40 px-2 py-1 text-[10px]">
                    <div className="flex items-center justify-between">
                      <span className="text-neutral-300">{m.net}</span>
                      <span className={`font-mono ${m.impedanceOk ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {m.impedance.toFixed(0)} Ω{m.targetImpedance ? ` / ${m.targetImpedance} Ω` : ''}
                      </span>
                    </div>
                    {m.crosstalkPct !== undefined && (
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className="text-[9px] text-neutral-500">diaphonie</span>
                        <div className="h-1 w-16 overflow-hidden rounded-full bg-neutral-800">
                          <div
                            className={`h-full ${m.crosstalkOk ? 'bg-emerald-500' : 'bg-amber-500'}`}
                            style={{ width: `${Math.min(100, (m.crosstalkPct / 35) * 100)}%` }}
                          />
                        </div>
                        <span className={`font-mono text-[9px] ${m.crosstalkOk ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {m.crosstalkPct.toFixed(1)} % ← {m.crosstalkWith}
                        </span>
                      </div>
                    )}
                    <div className="text-[9px] text-neutral-600">{m.comment}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Corrélation des modèles — calibration [P2.3] */}
          <section className="rounded-lg border border-cyan-900/40 bg-black/30 p-3" data-testid="calibration-card">
            <div className="mb-1.5 flex items-center gap-2">
              <Thermometer className="h-4 w-4 text-cyan-400" />
              <span className="text-[11px] font-semibold text-cyan-200">Corrélation modèle ↔ simulation</span>
              {thermalCal && (
                <Badge variant="outline" className={`ml-auto h-4.5 border px-1.5 text-[9px] ${
                  thermalCal.r >= 0.85 ? 'border-emerald-700 text-emerald-400'
                  : thermalCal.r >= 0.6 ? 'border-cyan-700 text-cyan-300'
                  : 'border-amber-700 text-amber-400'
                }`}>
                  r = {thermalCal.r.toFixed(3)}
                </Badge>
              )}
            </div>
            <p className="mb-2 text-[9px] leading-relaxed text-neutral-500">
              Le noyau latent (1/(1+r²), µs) est confronté au solveur FDM (vérité terrain) sur des placements
              aléatoires légaux + la solution opérante (ancre). La droite de calibration mappe l&apos;unité latente vers
              le °C : ΔT moyen aux composants sensibles — cible exacte du noyau.
            </p>
            {thermalCal ? (
              <>
                <div className="mb-2 grid grid-cols-4 gap-1.5 text-center">
                  <div className="rounded-md bg-black/40 py-1.5">
                    <div className="font-mono text-sm font-bold text-cyan-300">{thermalCal.r.toFixed(3)}</div>
                    <div className="text-[8px] text-neutral-500">corrélation r</div>
                  </div>
                  <div className="rounded-md bg-black/40 py-1.5">
                    <div className="font-mono text-sm font-bold text-cyan-300">{thermalCal.slope.toFixed(3)}</div>
                    <div className="text-[8px] text-neutral-500">°C / unité</div>
                  </div>
                  <div className="rounded-md bg-black/40 py-1.5">
                    <div className="font-mono text-sm font-bold text-cyan-300">{thermalCal.rmse.toFixed(1)}</div>
                    <div className="text-[8px] text-neutral-500">RMSE °C</div>
                  </div>
                  <div className="rounded-md bg-black/40 py-1.5">
                    <div className="font-mono text-sm font-bold text-cyan-300">{thermalCal.samples + 1}</div>
                    <div className="text-[8px] text-neutral-500">échant.+ancre</div>
                  </div>
                </div>
                {calEst !== null && (
                  <div className="mb-2 flex items-center justify-between rounded-md bg-black/40 px-2.5 py-1.5 text-[9px]">
                    <span className="text-neutral-500">ΔT sensibles du placement courant (prédiction calibrée)</span>
                    <span className="font-mono text-cyan-300">{calEst.toFixed(1)} °C</span>
                  </div>
                )}
                <div className="mb-2 text-[8px] leading-relaxed text-neutral-600">
                  ΔT max carte : r = {thermalCal.rMax.toFixed(2)} — structurellement décorrélat du noyau (il prédit
                  l&apos;exposition des sensibles, pas le point chaud global) : outil de CLASSEMENT, pas de prévision absolue.
                </div>
                {/* Profil d&apos;impédance IPC-2141 par classe */}
                <div className="mb-2 overflow-hidden rounded border border-neutral-800/60">
                  <div className="grid grid-cols-[1fr_52px_52px_46px_46px] gap-x-1 border-b border-neutral-800 bg-black/50 px-2 py-1 text-[8px] font-semibold uppercase tracking-wide text-neutral-500">
                    <span>Classe</span><span className="text-right">Largeur</span><span className="text-right">Z0</span><span className="text-right">Cible</span><span className="text-right">Δ</span>
                  </div>
                  {ziProfile.map((z) => (
                    <div key={z.cls} className="grid grid-cols-[1fr_52px_52px_46px_46px] items-center gap-x-1 border-b border-neutral-900/60 bg-black/30 px-2 py-0.5 text-[9px] last:border-b-0">
                      <span className="truncate text-neutral-300">{z.cls}</span>
                      <span className="text-right font-mono text-neutral-400">{z.widthMm.toFixed(2)}</span>
                      <span className="text-right font-mono text-neutral-200">{z.z0.toFixed(1)}Ω</span>
                      <span className="text-right font-mono text-neutral-500">{z.target ?? '—'}</span>
                      <span className={`text-right font-mono ${z.delta === null ? 'text-neutral-600' : Math.abs(z.delta) < 5 ? 'text-emerald-400' : Math.abs(z.delta) < 15 ? 'text-amber-400' : 'text-red-400'}`}>
                        {z.delta === null ? '—' : `${z.delta > 0 ? '+' : ''}${z.delta.toFixed(1)}`}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="mb-2 flex h-16 items-center justify-center rounded-md bg-black/40 text-[10px] text-neutral-600">
                Pas encore calibré pour ce projet — la droite latent→°C n&apos;existe pas encore.
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={calBusy}
              className="w-full gap-2 border-cyan-700 bg-cyan-950/30 text-[10px] text-cyan-300 hover:bg-cyan-900/40"
              onClick={runCalibration}
              data-testid="calibrate-btn"
            >
              <Repeat className={`h-3 w-3 ${calBusy ? 'animate-spin' : ''}`} />
              {calBusy ? 'Calibration en cours (FDM ×17)…' : thermalCal ? 'Recalibrer le modèle latent' : 'Calibrer le modèle latent'}
            </Button>
          </section>

          {/* DRC */}
          <section className="rounded-lg border border-red-900/40 bg-black/30 p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <TriangleAlert className="h-4 w-4 text-red-400" />
              <span className="text-[11px] font-semibold text-red-200">DRC / DFM</span>
              {drc && (
                <Badge variant="outline" className={`ml-auto h-4.5 border px-1.5 text-[9px] ${drc.pass ? 'border-emerald-700 text-emerald-400' : 'border-red-700 text-red-400'}`}>
                  {drc.pass ? 'conforme' : `${drc.errors} erreur(s)`}
                </Badge>
              )}
            </div>
            {dfm && (
              <div className="mb-2 flex items-center gap-3 rounded-md bg-black/40 px-2.5 py-2">
                <div className="text-2xl font-bold text-emerald-300">{dfm.score}</div>
                <div className="text-[9px] leading-tight text-neutral-500">
                  score DFM usine
                  <br />
                  occupation {dfm.utilizationPct}%
                </div>
                <div className="ml-auto space-y-0.5 text-[9px] text-neutral-400">
                  {dfm.checks.map((c) => (
                    <div key={c.name} className="flex items-center gap-1">
                      {c.pass ? <CheckCircle2 className="h-2.5 w-2.5 text-emerald-500" /> : <TriangleAlert className="h-2.5 w-2.5 text-amber-500" />}
                      {c.name}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {drc && drc.violations.length > 0 ? (
              <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                {drc.violations.map((v, i) => (
                  <div
                    key={`${v.code}-${i}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => v.location && setViewer({ selectedRef: v.refs?.[0] ?? null })}
                    className={`cursor-default rounded-md px-2 py-1 text-[10px] ${
                      v.severity === 'error' ? 'bg-red-950/40 text-red-300' : 'bg-amber-950/30 text-amber-300'
                    }`}
                  >
                    <span className="font-mono font-semibold">{v.code}</span> — {v.message}
                  </div>
                ))}
              </div>
            ) : drc ? (
              <p className="text-[10px] text-emerald-400">Aucune violation détectée ✓</p>
            ) : (
              <p className="text-[10px] text-neutral-500">En attente de la vérification…</p>
            )}
          </section>
        </TabsContent>

        {/* ============================ EXPORT ============================ */}
        <TabsContent value="export" className="mt-0 space-y-3 p-3">
          {gerber ? (
            <>
              <div className="rounded-lg border border-emerald-900/40 bg-black/30 p-3">
                <div className="text-[11px] font-semibold text-emerald-200">Package de fabrication</div>
                <div className="mt-1 grid grid-cols-3 gap-1.5 text-center text-[10px]">
                  <div className="rounded-md bg-black/40 py-1.5">
                    <div className="font-bold text-emerald-300">{gerber.padCount}</div>
                    <div className="text-[9px] text-neutral-500">pads</div>
                  </div>
                  <div className="rounded-md bg-black/40 py-1.5">
                    <div className="font-bold text-emerald-300">{gerber.viaCount}</div>
                    <div className="text-[9px] text-neutral-500">vias</div>
                  </div>
                  <div className="rounded-md bg-black/40 py-1.5">
                    <div className="font-bold text-emerald-300">{gerber.traceCount}</div>
                    <div className="text-[9px] text-neutral-500">pistes</div>
                  </div>
                </div>
              </div>
              {gerber.files.map((f) => (
                <div key={f.name} className="flex items-center justify-between rounded-lg border border-neutral-800/60 bg-black/30 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px] text-emerald-200">{f.name}</div>
                    <div className="text-[9px] text-neutral-500">{f.role} · {(f.content.length / 1024).toFixed(1)} Ko</div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 gap-1 border-emerald-800 px-2 text-[10px] text-emerald-300 hover:bg-emerald-900/40"
                    onClick={() => download(`${gerberDir}_${f.name}`, f.content)}
                  >
                    <FileDown className="h-3 w-3" /> Télécharger
                  </Button>
                </div>
              ))}
              <Button
                className="w-full gap-2 bg-emerald-600 text-xs text-white hover:bg-emerald-500"
                onClick={() => gerber.files.forEach((f, i) => setTimeout(() => download(`${gerberDir}_${f.name}`, f.content), i * 250))}
              >
                <Download className="h-3.5 w-3.5" /> Tout télécharger ({gerber.files.length} fichiers)
              </Button>
              {/* ---------- Package ODB++ (.tgz) [audit P2.1] ---------- */}
              <Button
                variant="outline"
                disabled={odbBusy || !result.placement || !result.routing}
                className="w-full gap-2 border-sky-700 bg-sky-950/30 text-xs text-sky-300 hover:bg-sky-900/40"
                onClick={async () => {
                  setOdbBusy(true)
                  try {
                    const { buildOdbJob, tarGzBlob } = await import('@/lib/engine/odb')
                    const job = buildOdbJob(netlist, result.placement!.placements, result.routing!)
                    const blob = await tarGzBlob(job.files)
                    const a = document.createElement('a')
                    a.href = URL.createObjectURL(blob)
                    a.download = `${job.jobName}_odbpp.tgz`
                    a.click()
                    URL.revokeObjectURL(a.href)
                    useStudio.getState().log('system', 'agent',
                      `[ODB++] Package exporté — ${job.files.length} fichiers (matrix, outline, ${job.layerNames.join('/')} + drill, netlist), ${job.stats.lines} pistes · ${job.stats.pads} pads · ${job.stats.vias} vias · ${job.stats.drills} perçages`)
                  } finally {
                    setOdbBusy(false)
                  }
                }}
                data-testid="export-odb"
              >
                <Package className="h-3.5 w-3.5" /> {odbBusy ? 'Compression…' : 'Package ODB++ (.tgz)'}
              </Button>
              {/* ---------- Panelisation production [audit P2.2] ---------- */}
              {result.routing && result.placement && (
                <div className="space-y-2 rounded-lg border border-amber-900/50 bg-amber-950/10 p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[10px] font-bold tracking-wide text-amber-300">
                      <LayoutGrid className="h-3 w-3" /> PANELISATION PRODUCTION
                    </span>
                    <Badge variant="outline" className={`h-4.5 border px-1.5 text-[9px] ${
                      fabReport?.pass ? 'border-emerald-700 text-emerald-400' : 'border-red-700 text-red-400'
                    }`}>
                      {fabReport?.pass ? 'CONFORME' : 'NON CONFORME'}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                    <select
                      value={fabId}
                      onChange={(e) => setFabId(e.target.value)}
                      data-testid="fab-select"
                      className="col-span-2 rounded border border-neutral-700 bg-black/50 px-2 py-1 text-[10px] text-amber-200 outline-none"
                    >
                      {FABRICS.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                    <select
                      value={panelMode}
                      onChange={(e) => setPanelMode(e.target.value as 'vcut' | 'bites')}
                      className="rounded border border-neutral-700 bg-black/50 px-2 py-1 text-[10px] text-amber-200 outline-none"
                    >
                      <option value="vcut">Séparation : V-cut 30°</option>
                      <option value="bites">Séparation : onglets ⌀0,6</option>
                    </select>
                    <div className="flex items-center justify-between rounded border border-neutral-700 bg-black/50 px-2 py-1">
                      <span className="text-neutral-500">grille</span>
                      <div className="flex items-center gap-1">
                        {([['cols', panelCols, setPanelCols] as const, ['rows', panelRows, setPanelRows] as const]).map(([key, val, set]) => (
                          <span key={key} className="flex items-center gap-0.5">
                            <button
                              onClick={() => set(Math.max(1, val - 1))}
                              className="rounded bg-neutral-800 px-1 text-neutral-400 hover:bg-neutral-700"
                            ><Minus className="h-2.5 w-2.5" /></button>
                            <span className="w-8 text-center font-mono text-amber-200">{val}×{key === 'cols' ? panelRows : panelCols}</span>
                            <button
                              onClick={() => set(Math.min(4, val + 1))}
                              className="rounded bg-neutral-800 px-1 text-neutral-400 hover:bg-neutral-700"
                            ><Plus className="h-2.5 w-2.5" /></button>
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  {/* Conformité fabricant — valeur mesurée vs exigée */}
                  {fabReport && (
                    <div className="overflow-hidden rounded border border-neutral-800/60">
                      {fabReport.checks.map((c) => (
                        <div key={c.id} className="flex items-center gap-1.5 border-b border-neutral-900/60 bg-black/30 px-2 py-1 text-[9px] last:border-b-0">
                          {c.ok
                            ? <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />
                            : <TriangleAlert className="h-3 w-3 shrink-0 text-red-400" />}
                          <span className="min-w-0 flex-1 truncate text-neutral-300" title={c.label}>{c.label}</span>
                          <span className="font-mono text-neutral-500">{c.measured}</span>
                          <span className="font-mono text-neutral-600">{c.required}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Gabarit panel */}
                  <div className="flex items-center justify-between rounded border border-neutral-800/60 bg-black/30 px-2 py-1 text-[9px]">
                    <span className="text-neutral-400">
                      Panel <span className="font-mono text-amber-200">{panelGeo.panelW.toFixed(0)}×{panelGeo.panelH.toFixed(0)} mm</span>
                      {' · '}{panelGeo.cols}×{panelGeo.rows} cartes
                      {' · '}<span className="font-mono text-amber-200">{(panelGeo.utilization * 100).toFixed(0)} %</span> matière
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    disabled={panelBusy || !result.gerber}
                    className="w-full gap-2 border-amber-700 bg-amber-950/30 text-xs text-amber-300 hover:bg-amber-900/40"
                    onClick={async () => {
                      setPanelBusy(true)
                      try {
                        const pkg = generatePanelPackage(netlist, result.routing!, panelGeo, result.gerber!.files, fabPreset)
                        pkg.forEach((f, i) => setTimeout(() => download(`${gerberDir}_${f.name}`, f.content), i * 250))
                        useStudio.getState().log('system', 'agent',
                          `[PANEL] Package exporté — ${panelGeo.cols}×${panelGeo.rows} copies, ${panelGeo.panelW.toFixed(0)}×${panelGeo.panelH.toFixed(0)} mm, ${panelGeo.mode === 'vcut' ? 'V-cut' : 'onglets'}, utilisation ${(panelGeo.utilization * 100).toFixed(0)} %, fabricant ${fabPreset.name} ${fabReport?.pass ? '(conforme)' : '(NON conforme — revue requise)'}`)
                      } finally {
                        setPanelBusy(false)
                      }
                    }}
                    data-testid="export-panel"
                  >
                    <LayoutGrid className="h-3.5 w-3.5" /> Télécharger le panel ({(netlist.board.layers >= 4 ? 4 : 2) + 3} fichiers)
                  </Button>
                </div>
              )}
              <p className="text-[9px] leading-relaxed text-neutral-600">
                Gerber X2 (RS-274X + attributs nets/composants/vias — rétrocompatible X1, format 3.6, mm) +
                perçage Excellon + BOM/Pick&amp;Place + pinmap firmware + package ODB++ ASCII
                (matrix, outline, couches lignes/pads, drill, netlist — sous-set, plans cuivre dans les .gbr) —
                exploitables par PCBWay, JLCPCB, Valor, ou importables dans KiCad pour vérification.
              </p>
            </>
          ) : (
            <div className="flex h-40 items-center justify-center text-[11px] text-neutral-600">
              Lancez la conception pour générer le package de fabrication
            </div>
          )}
        </TabsContent>

        {/* ============================ HISTORIQUE ============================ */}
        <TabsContent value="historique" className="mt-0 space-y-2 p-3">
          {comparison ? (
            /* ---------- Vue comparaison A/B [audit P1.3] ---------- */
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Button
                  size="sm" variant="outline"
                  className="h-6 gap-1 border-neutral-700 px-2 text-[10px] text-neutral-300 hover:bg-neutral-800"
                  onClick={() => { setComparison(null); setSelA(null); setSelB(null) }}
                >
                  <X className="h-3 w-3" /> Fermer la comparaison
                </Button>
                <span className="text-[9px] text-neutral-500">
                  <span className="text-emerald-400">{comparison.summary.improved} ↗</span> · {' '}
                  <span className="text-red-400">{comparison.summary.regressed} ↘</span> · {' '}
                  {comparison.summary.unchanged} =
                </span>
              </div>
              <div className="rounded-lg border border-neutral-800/60 bg-black/30 p-2.5">
                <div className="grid grid-cols-2 gap-2 text-[9px]">
                  <div>
                    <div className="mb-0.5 flex items-center gap-1"><span className="rounded bg-emerald-900/60 px-1 font-mono text-[9px] text-emerald-300">A</span><span className="text-neutral-500">base</span></div>
                    <div className="text-neutral-400">{new Date(comparison.a.createdAt).toLocaleString('fr-FR')}</div>
                    <div className="text-neutral-600">{comparison.a.status} · plan {comparison.a.planSource}</div>
                  </div>
                  <div>
                    <div className="mb-0.5 flex items-center gap-1"><span className="rounded bg-teal-900/60 px-1 font-mono text-[9px] text-teal-300">B</span><span className="text-neutral-500">candidat</span></div>
                    <div className="text-neutral-400">{new Date(comparison.b.createdAt).toLocaleString('fr-FR')}</div>
                    <div className="text-neutral-600">{comparison.b.status} · plan {comparison.b.planSource}</div>
                  </div>
                </div>
              </div>
              <div className="overflow-hidden rounded-lg border border-neutral-800/60">
                <div className="grid grid-cols-[1fr_52px_52px_86px] gap-x-1 border-b border-neutral-800 bg-black/50 px-2 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-neutral-500">
                  <span>Métrique</span><span className="text-right">A</span><span className="text-right">B</span><span className="text-right">Δ B−A</span>
                </div>
                {comparison.metrics.map((m) => (
                  <div key={m.key} className="grid grid-cols-[1fr_52px_52px_86px] items-center gap-x-1 border-b border-neutral-900/60 bg-black/30 px-2 py-1 text-[9px] last:border-b-0">
                    <span className="truncate text-neutral-300" title={m.label}>{m.label}</span>
                    <span className="text-right font-mono text-neutral-400">{fmtNum(m.a, m.decimals)}{m.unit}</span>
                    <span className="text-right font-mono text-neutral-200">{fmtNum(m.b, m.decimals)}{m.unit}</span>
                    <span className={`whitespace-nowrap text-right font-mono ${
                      m.verdict === 'better' ? 'text-emerald-400'
                      : m.verdict === 'worse' ? 'text-red-400'
                      : 'text-neutral-500'
                    }`}>
                      {m.delta > 0 ? '+' : ''}{fmtNum(m.delta, m.decimals ?? 0)}{m.pct !== null && m.pct !== 0 ? ` (${m.pct > 0 ? '+' : ''}${m.pct.toFixed(0)}%)` : ''}
                      {' '}{m.verdict === 'better' ? '↗' : m.verdict === 'worse' ? '↘' : '='}
                    </span>
                  </div>
                ))}
              </div>
              {!comparison.sameProject && (
                <p className="text-[9px] text-amber-500/80">
                  ⚠ Les deux runs proviennent de projets différents — lecture indicative.
                </p>
              )}
            </div>
          ) : (
            /* ---------- Liste des runs (+ mode comparaison) ---------- */
            <>
              <div className="flex items-center justify-between px-0.5">
                <span className="text-[9px] text-neutral-600">
                  {history.length} exécution{history.length > 1 ? 's' : ''} enregistrée{history.length > 1 ? 's' : ''}
                </span>
                <Button
                  size="sm" variant="outline"
                  className={`h-6 gap-1 px-2 text-[10px] ${
                    compareMode ? 'border-emerald-600 bg-emerald-900/40 text-emerald-300' : 'border-neutral-700 text-neutral-400 hover:bg-neutral-800'
                  }`}
                  onClick={() => { setCompareMode((v) => !v); setSelA(null); setSelB(null) }}
                >
                  <GitCompare className="h-3 w-3" /> Comparer
                </Button>
              </div>
              {compareMode && (
                <div className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-2.5 py-1.5 text-[9px] text-emerald-200/80">
                  Choisissez la base <span className="rounded bg-emerald-900/60 px-1 font-mono text-emerald-300">A</span> et le candidat <span className="rounded bg-teal-900/60 px-1 font-mono text-teal-300">B</span> sur deux exécutions, ou utilisez « Δ vs précédent ».
                </div>
              )}
              {compareMode && (selA || selB) && (
                <div className="px-0.5 text-[9px] text-neutral-500">
                  Sélection : {selA ? <span className="text-emerald-400">A ✓</span> : 'A —'} · {selB ? <span className="text-teal-400">B ✓</span> : 'B —'}
                  {selA && selB && <span className="ml-1 animate-pulse text-neutral-400">calcul…</span>}
                </div>
              )}
              {history.length === 0 ? (
                <div className="flex h-32 items-center justify-center text-[11px] text-neutral-600">
                  Aucune exécution enregistrée pour ce projet
                </div>
              ) : (
                history.map((h, i) => (
                  <div key={h.id} className={`rounded-lg border p-2.5 ${
                    selA === h.id ? 'border-emerald-600/70 bg-emerald-950/20'
                    : selB === h.id ? 'border-teal-600/70 bg-teal-950/20'
                    : 'border-neutral-800/60 bg-black/30'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-neutral-400">
                        {new Date(h.createdAt).toLocaleString('fr-FR')}
                      </span>
                      <Badge variant="outline" className={`h-4.5 border px-1.5 text-[9px] ${
                        h.status === 'success' ? 'border-emerald-700 text-emerald-400' : 'border-amber-700 text-amber-400'
                      }`}>
                        {h.status}
                      </Badge>
                    </div>
                    <div className="mt-1 grid grid-cols-4 gap-1 text-center text-[9px]">
                      <div><span className="font-mono text-emerald-300">{h.dfmScore}</span><span className="text-neutral-600"> DFM</span></div>
                      <div><span className="font-mono text-teal-300">{h.routedNets}/{h.totalNets}</span><span className="text-neutral-600"> nets</span></div>
                      <div><span className="font-mono text-orange-300">{h.maxTempC.toFixed(0)}°C</span><span className="text-neutral-600"> max</span></div>
                      <div><span className="font-mono text-fuchsia-300">{h.planSource}</span><span className="text-neutral-600"> plan</span></div>
                    </div>
                    {compareMode && (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <button
                          data-testid={`cmp-a-${h.id}`}
                          onClick={() => setSelA(selA === h.id ? null : h.id)}
                          className={`h-5 rounded px-2 font-mono text-[9px] transition-colors ${
                            selA === h.id ? 'bg-emerald-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
                          }`}
                        >A</button>
                        <button
                          data-testid={`cmp-b-${h.id}`}
                          onClick={() => setSelB(selB === h.id ? null : h.id)}
                          className={`h-5 rounded px-2 font-mono text-[9px] transition-colors ${
                            selB === h.id ? 'bg-teal-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
                          }`}
                        >B</button>
                        {i < history.length - 1 && (
                          <button
                            data-testid={`cmp-prev-${h.id}`}
                            onClick={() => { setSelA(h.id); setSelB(history[i + 1].id) }}
                            className="ml-auto h-5 rounded bg-neutral-800 px-2 text-[9px] text-neutral-400 transition-colors hover:bg-neutral-700"
                          >
                            Δ vs précédent
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </>
          )}
        </TabsContent>
      </ScrollArea>
    </Tabs>
  )
}
