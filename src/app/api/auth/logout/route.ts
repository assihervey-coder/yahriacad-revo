/**
 * NEXUS PCB — Déconnexion [Sprint 2 — M4] : efface le cookie de session.
 */
import { NextResponse } from 'next/server'
import { ACTOR_COOKIE } from '@/lib/auth'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(ACTOR_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 })
  return res
}
