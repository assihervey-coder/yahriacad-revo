/**
 * NEXUS PCB — API d'historique des runs (boucle d'amélioration continue)
 * Équivalent : entrepôt de données d'entraînement / feedback usine
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/auth'

export async function GET(req: NextRequest) {
  try {
    const netlistId = req.nextUrl.searchParams.get('netlistId')
    const runs = await db.run.findMany({
      where: netlistId ? { project: { netlistId } } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { project: { select: { netlistId: true, name: true } } },
    })
    return NextResponse.json({ runs })
  } catch {
    return NextResponse.json({ runs: [] })
  }
}

export async function POST(req: NextRequest) {
  // [M4] action d'ingénierie — lecteur et non-authentifiés refusés
  const gate = await requireRole('ingenieur')
  if (gate.denied) return NextResponse.json({ error: gate.denied.message }, { status: gate.denied.status })
  try {
    const body = (await req.json()) as {
      netlistId?: string
      status?: string
      planSource?: string
      costHpwl?: number
      costThermal?: number
      costConstraint?: number
      routedNets?: number
      totalNets?: number
      viaCount?: number
      totalLengthMm?: number
      drcErrors?: number
      drcWarnings?: number
      dfmScore?: number
      maxTempC?: number
      durationMs?: number
    }
    if (!body.netlistId) return NextResponse.json({ error: 'netlistId requis' }, { status: 400 })

    // Trouve ou crée le projet pour cette netlist
    let project = await db.project.findFirst({ where: { netlistId: body.netlistId } })
    if (!project) {
      project = await db.project.create({ data: { netlistId: body.netlistId, name: body.netlistId } })
    }

    const run = await db.run.create({
      data: {
        projectId: project.id,
        status: body.status ?? 'success',
        planSource: body.planSource ?? 'rules',
        costHpwl: body.costHpwl ?? 0,
        costThermal: body.costThermal ?? 0,
        costConstraint: body.costConstraint ?? 0,
        routedNets: body.routedNets ?? 0,
        totalNets: body.totalNets ?? 0,
        viaCount: body.viaCount ?? 0,
        totalLengthMm: body.totalLengthMm ?? 0,
        drcErrors: body.drcErrors ?? 0,
        drcWarnings: body.drcWarnings ?? 0,
        dfmScore: body.dfmScore ?? 0,
        maxTempC: body.maxTempC ?? 0,
        durationMs: body.durationMs ?? 0,
      },
    })
    return NextResponse.json({ run })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erreur' }, { status: 500 })
  }
}
