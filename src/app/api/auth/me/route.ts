/**
 * NEXUS PCB — Acteur courant [Sprint 2 — M4] : qui suis-je (ou null).
 */
import { NextResponse } from 'next/server'
import { getSessionActor } from '@/lib/auth'

export async function GET() {
  const actor = await getSessionActor()
  return NextResponse.json({ actor })
}
