/**
 * NEXUS PCB — Comparaison de runs historiques [audit P1.3]
 * Équivalent : régression métrique entre deux exécutions du pipeline
 * (base A vs candidate B) — la boucle d'amélioration continue devient lisible.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

/** Métrique comparable : sens d'interprétation du delta inclus. */
type MetricDef = {
  key: string
  label: string
  unit: string
  lowerIsBetter: boolean
  decimals?: number
  context?: boolean // métrique descriptive : delta neutre, pas de verdict
}

/** Registre ordonné des métriques comparables (15 métriques du modèle Run). */
const METRICS: MetricDef[] = [
  { key: 'dfmScore', label: 'Score DFM', unit: '/100', lowerIsBetter: false },
  { key: 'routedNets', label: 'Nets routés', unit: '', lowerIsBetter: false },
  { key: 'totalNets', label: 'Nets totaux', unit: '', lowerIsBetter: false, context: true },
  { key: 'viaCount', label: 'Vias', unit: '', lowerIsBetter: true },
  { key: 'totalLengthMm', label: 'Longueur cuivre', unit: 'mm', lowerIsBetter: true, decimals: 1 },
  { key: 'drcErrors', label: 'Erreurs DRC', unit: '', lowerIsBetter: true },
  { key: 'drcWarnings', label: 'Avertissements DRC', unit: '', lowerIsBetter: true },
  { key: 'maxTempC', label: 'Température max', unit: '°C', lowerIsBetter: true, decimals: 1 },
  { key: 'costHpwl', label: 'Coût HPWL', unit: '', lowerIsBetter: true, decimals: 2 },
  { key: 'costThermal', label: 'Coût thermique', unit: '', lowerIsBetter: true, decimals: 2 },
  { key: 'costConstraint', label: 'Coût contraintes', unit: '', lowerIsBetter: true, decimals: 2 },
  { key: 'durationMs', label: 'Durée', unit: 'ms', lowerIsBetter: true },
]

export async function GET(req: NextRequest) {
  try {
    const a = req.nextUrl.searchParams.get('a')
    const b = req.nextUrl.searchParams.get('b')
    if (!a || !b || a === b) {
      return NextResponse.json({ error: 'Deux identifiants de runs distincts (a, b) requis' }, { status: 400 })
    }

    const [runA, runB] = await Promise.all([
      db.run.findUnique({ where: { id: a }, include: { project: { select: { netlistId: true, name: true } } } }),
      db.run.findUnique({ where: { id: b }, include: { project: { select: { netlistId: true, name: true } } } }),
    ])
    if (!runA || !runB) {
      return NextResponse.json({ error: 'Run introuvable' }, { status: 404 })
    }

    const record = runA as unknown as Record<string, number>
    const recordB = runB as unknown as Record<string, number>

    const metrics = METRICS.map((m) => {
      const va = Number(record[m.key] ?? 0)
      const vb = Number(recordB[m.key] ?? 0)
      const delta = vb - va
      // Verdict : amélioration si le delta va dans le sens « meilleur »
      const verdict = m.context || delta === 0
        ? 'equal'
        : (m.lowerIsBetter ? delta < 0 : delta > 0) ? 'better' : 'worse'
      // Variation relative en % (base A) — null si base nulle
      const pct = va !== 0 ? (delta / Math.abs(va)) * 100 : null
      return { ...m, a: va, b: vb, delta, pct, verdict }
    })

    return NextResponse.json({
      a: runA,
      b: runB,
      sameProject: runA.projectId === runB.projectId,
      summary: {
        improved: metrics.filter((m) => m.verdict === 'better').length,
        regressed: metrics.filter((m) => m.verdict === 'worse').length,
        unchanged: metrics.filter((m) => m.verdict === 'equal').length,
      },
      metrics,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erreur' }, { status: 500 })
  }
}
