/**
 * NEXUS PCB — Gestion des comptes [Sprint 2 — M4]
 * GET    : liste des comptes (public — nécessaire à l'écran de connexion)
 * POST   : création d'un compte — ADMIN requis
 * PATCH  : changement de rôle — ADMIN requis
 * DELETE : suppression d'un compte — ADMIN requis (pas soi-même)
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isRole, requireRole } from '@/lib/auth'

export async function GET() {
  try {
    const users = await db.user.findMany({ orderBy: [{ role: 'asc' }, { name: 'asc' }] })
    return NextResponse.json({ users })
  } catch {
    return NextResponse.json({ users: [] })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireRole('admin')
  if (gate.denied) return NextResponse.json({ error: gate.denied.message }, { status: gate.denied.status })
  try {
    const { email, name, role } = (await req.json()) as { email?: string; name?: string; role?: string }
    if (!email || !name) return NextResponse.json({ error: 'email et name requis' }, { status: 400 })
    if (role && !isRole(role)) return NextResponse.json({ error: 'rôle inconnu — attendu : lecteur | ingenieur | admin' }, { status: 400 })
    const user = await db.user.create({
      data: { email: email.trim().toLowerCase(), name, role: role ?? 'lecteur' },
    })
    return NextResponse.json({ user })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erreur' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const gate = await requireRole('admin')
  if (gate.denied) return NextResponse.json({ error: gate.denied.message }, { status: gate.denied.status })
  try {
    const { id, role } = (await req.json()) as { id?: string; role?: string }
    if (!id || !role) return NextResponse.json({ error: 'id et role requis' }, { status: 400 })
    if (!isRole(role)) return NextResponse.json({ error: 'rôle inconnu' }, { status: 400 })
    const user = await db.user.update({ where: { id }, data: { role } })
    return NextResponse.json({ user })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erreur' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await requireRole('admin')
  if (gate.denied) return NextResponse.json({ error: gate.denied.message }, { status: gate.denied.status })
  try {
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id requis' }, { status: 400 })
    if (id === gate.actor.id) return NextResponse.json({ error: 'on ne supprime pas son propre compte' }, { status: 400 })
    await db.user.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erreur' }, { status: 500 })
  }
}
