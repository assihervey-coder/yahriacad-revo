/**
 * NEXUS PCB — API Projets & Runs (persistance Prisma/SQLite)
 * Équivalent : api_gateway/routes/ + PostgreSQL métadonnées
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/auth'

export async function GET() {
  try {
    const projects = await db.project.findMany({
      include: { runs: { orderBy: { createdAt: 'desc' }, take: 10 } },
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ projects })
  } catch {
    return NextResponse.json({ projects: [] })
  }
}

export async function POST(req: NextRequest) {
  // [M4] action d'ingénierie — lecteur et non-authentifiés refusés
  const gate = await requireRole('ingenieur')
  if (gate.denied) return NextResponse.json({ error: gate.denied.message }, { status: gate.denied.status })
  try {
    const { netlistId, name } = (await req.json()) as { netlistId?: string; name?: string }
    if (!netlistId) return NextResponse.json({ error: 'netlistId requis' }, { status: 400 })
    const project = await db.project.create({
      data: { netlistId, name: name ?? netlistId },
    })
    return NextResponse.json({ project })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erreur' }, { status: 500 })
  }
}
