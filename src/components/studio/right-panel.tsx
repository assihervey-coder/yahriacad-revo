'use client'
/**
 * NEXUS PCB — Panneau droit : détails pipeline, agents IA, analyses, export fabrication
 * + cartes v2 : optimiseur ratchet [AutoPCB], audit [Siemens Fuse], diaphonie [AuraStack]
 */
import { useMemo } from 'react'
import {
  Bot, CheckCircle2, Download, FileDown, Gauge, Repeat, ShieldCheck,
  Thermometer, TriangleAlert, Zap,
} from 'lucide-react'
import { useStudio } from '@/lib/studio-store'
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
              <p className="text-[9px] leading-relaxed text-neutral-600">
                Fichiers RS-274X (format 3.6, mm) + perçage Excellon + BOM/Pick&amp;Place + pinmap firmware
                (.h / overlay Zephyr / JSON) — directement exploitables par PCBWay, JLCPCB, ou importables
                dans KiCad pour vérification.
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
          {history.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-[11px] text-neutral-600">
              Aucune exécution enregistrée pour ce projet
            </div>
          ) : (
            history.map((h) => (
              <div key={h.id} className="rounded-lg border border-neutral-800/60 bg-black/30 p-2.5">
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
              </div>
            ))
          )}
        </TabsContent>
      </ScrollArea>
    </Tabs>
  )
}
