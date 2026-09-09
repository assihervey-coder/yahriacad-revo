/**
 * NEXUS PCB — Connexion [Sprint 2 — M4]
 * POST { email } → pose le cookie de session httpOnly `nexus-actor`.
 * Le compte doit exister (créé par l'admin ou seedé). Le mot de passe
 * n'est pas manipulé ici : le périmètre M4 est l'IDENTITÉ + le RÔLE
 * appliqués côté serveur ; un SSO OIDC s'ancrerait sur ce même cookie.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ACTOR_COOKIE } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    const { email } = (await req.json()) as { email?: string }
    if (!email) return NextResponse.json({ error: 'email requis' }, { status: 400 })
    const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } })
    if (!user) return NextResponse.json({ error: 'compte inconnu' }, { status: 404 })
    const res = NextResponse.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } })
    res.cookies.set(ACTOR_COOKIE, user.id, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    })
    return res
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erreur' }, { status: 500 })
  }
}
