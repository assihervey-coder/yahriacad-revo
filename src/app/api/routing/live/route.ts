/**
 * NEXUS PCB — Routage live façon DeepPCB (flux serveur → navigateur)
 * -------------------------------------------------------------------
 * Le routeur maze A* s'exécute CÔTÉ SERVEUR et diffuse chaque piste/via
 * posée, au fil de son exécution, dans un flux SSE (Server-Sent Events).
 *
 * Choix de transport : SSE = canal unidirectionnel serveur → client en
 * HTTP chunked, l'équivalent d'un WebSocket pour un flux de progression,
 * qui traverse tous les proxys/preview sans upgrade ni port dédié.
 * Le client peut interrompre à tout moment (abort → shouldCancel → le
 * moteur s'arrête proprement).
 *
 * Événements émis :
 *   { t:'hello', total }                  — nombre de nets à router
 *   { t:'phase', phase }                  — glouton | ripup | via-min | pour
 *   { t:'segment', net, segment }         — une piste vient d'être posée
 *   { t:'via', net, via }                 — un via vient d'être posé
 *   { t:'progress', done, total, net, ok} — net terminé (ok=false → échec)
 *   { t:'complete', result }              — solution finale canonique
 *   { t:'error', message }
 */
import { NextRequest, NextResponse } from 'next/server'
import { routeAll } from '@/lib/engine/router'
import { extractConstraints } from '@/lib/engine/parser'
import { DEFAULT_RULES } from '@/lib/engine/rules'
import type { Constraint, Netlist, PlacedComponent } from '@/lib/engine/types'

export const dynamic = 'force-dynamic'

function validate(body: unknown): { netlist: Netlist; placements: PlacedComponent[]; pacingMs: number } | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const nl = b.netlist as Netlist | undefined
  const placements = b.placements as PlacedComponent[] | undefined
  if (!nl || !Array.isArray(nl.nets) || !Array.isArray(nl.components) || typeof nl.board?.w !== 'number') return null
  if (!Array.isArray(placements) || placements.length === 0) return null
  if (placements.some((p) => typeof p?.ref !== 'string' || typeof p?.x !== 'number' || typeof p?.y !== 'number')) return null
  const raw = (b.pacingMs as number | undefined) ?? 14
  const pacingMs = Math.min(150, Math.max(0, Number.isFinite(raw) ? raw : 14))
  return { netlist: nl, placements, pacingMs }
}

export async function POST(req: NextRequest) {
  let input: { netlist: Netlist; placements: PlacedComponent[]; pacingMs: number } | null
  try {
    input = validate(await req.json())
  } catch {
    input = null
  }
  if (!input) {
    return NextResponse.json(
      { error: 'Charge invalide — netlist + placements (issue du placement RL) requis.' },
      { status: 400 },
    )
  }
  const { netlist, placements, pacingMs } = input
  const constraints: Constraint[] = extractConstraints(netlist)
  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
        } catch {
          closed = true
        }
      }
      const onClose = () => { closed = true }
      req.signal.addEventListener('abort', onClose)

      try {
        const total = netlist.nets.filter((n) => n.pins.length >= 2).length
        console.log(`[LIVE-ROUTE] entrée — ${total} nets, pacing ${pacingMs} ms`)
        send({ t: 'hello', total, board: { w: netlist.board.w, h: netlist.board.h } })
        const routing = await routeAll(netlist, placements, DEFAULT_RULES, constraints, {
          pacingMs,
          onTrace: (ev) =>
            send(ev.type === 'segment'
              ? { t: 'segment', net: ev.net, segment: ev.segment }
              : { t: 'via', net: ev.net, via: ev.via }),
          onPhase: (phase) => send({ t: 'phase', phase }),
          onProgress: (p) => send({ t: 'progress', done: p.done, total: p.total, net: p.net, ok: p.ok }),
          shouldCancel: () => closed || req.signal.aborted,
        })
        console.log(`[LIVE-ROUTE] fin routeAll — ${routing.routedNets}/${routing.totalNets} nets, closed=${closed}, signal.aborted=${req.signal.aborted}`)
        if (!closed) send({ t: 'complete', result: routing })
      } catch (e) {
        if (!closed) send({ t: 'error', message: e instanceof Error ? e.message : 'erreur inconnue' })
      } finally {
        req.signal.removeEventListener('abort', onClose)
        closed = true
        try { controller.close() } catch { /* déjà fermé */ }
      }
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
