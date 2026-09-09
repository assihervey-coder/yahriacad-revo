/**
 * NEXUS PCB — Journal d'édition immuable [audit P2.4]
 * Chaque geste d'édition (déplacement chirurgical, nudge live, drag, undo,
 * redo) est journalisé avec son auteur (actor) et ses positions avant/après.
 * Sur Postgres multi-utilisateurs, actor distinguera les auteurs.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/auth'

export async function GET(req: NextRequest) {
  try {
    const netlistId = req.nextUrl.searchParams.get('netlistId')
    const take = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get('take') ?? 30)))
    const edits = await db.editEvent.findMany({
      where: netlistId ? { project: { netlistId } } : undefined,
      orderBy: { createdAt: 'desc' },
      take,
    })
    return NextResponse.json({ edits })
  } catch {
    return NextResponse.json({ edits: [] })
  }
}

export async function POST(req: NextRequest) {
  // [M4] écriture du journal = geste d'ingénierie — le lecteur est refusé
  const gate = await requireRole('ingenieur')
  if (gate.denied) return NextResponse.json({ error: gate.denied.message }, { status: gate.denied.status })
  try {
    const body = (await req.json()) as {
      netlistId?: string
      kind?: string
      ref?: string
      from?: { x?: number; y?: number; rot?: number }
      to?: { x?: number; y?: number; rot?: number }
      meta?: string
    }
    if (!body.netlistId || !body.ref || !body.kind) {
      return NextResponse.json({ error: 'netlistId, kind et ref requis' }, { status: 400 })
    }

    let project = await db.project.findFirst({ where: { netlistId: body.netlistId } })
    if (!project) {
      project = await db.project.create({ data: { netlistId: body.netlistId, name: body.netlistId } })
    }

    // [M4] l'auteur est l'acteur DE SESSION (fait foi) — chaque geste du
    // journal est attribué à son auteur réel, le body ne peut pas usurper.
    const edit = await db.editEvent.create({
      data: {
        projectId: project.id,
        actor: `${gate.actor.name} (${gate.actor.role})`,
        kind: body.kind,
        ref: body.ref,
        xFrom: body.from?.x ?? 0,
        yFrom: body.from?.y ?? 0,
        xTo: body.to?.x ?? 0,
        yTo: body.to?.y ?? 0,
        rotFrom: body.from?.rot,
        rotTo: body.to?.rot,
        meta: body.meta,
      },
    })
    return NextResponse.json({ edit })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erreur' }, { status: 500 })
  }
}
