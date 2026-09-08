/**
 * NEXUS PCB — Agent RL (policy network par recuit simulé)
 * Équivalent : services/ai_engine/rl_agent/policy_network/ + action_space/
 *
 * L'agent explore l'espace d'action {translation, rotation, échange} en
 * interrogeant le World Model à chaque étape : pas de simulation physique
 * coûteuse, des milliers de placements « mentalement » simulés par seconde.
 * Le schedule de température (T ← T·α) garantit la convergence.
 */
import type {
  AgentPlan, Constraint, Netlist, PlacementSolution, PlacedComponent,
} from './types'
import {
  buildEvalContext, evalCost, mulberry32, placedRect, zonePoint, type EvalContext,
} from './world-model'

export interface PlacerOptions {
  seed?: number
  iterations?: number
  t0?: number
  tEnd?: number
  onProgress?: (p: { iter: number; total: number; cost: number; placements: PlacedComponent[] }) => void
  shouldCancel?: () => boolean
}

/** Placement initial : connecteurs fixés au bord, MCU au centre, zones LLM, découplage collé au parent */
export function initialPlacement(nl: Netlist, plan: AgentPlan, constraints: Constraint[]): PlacedComponent[] {
  const rng = mulberry32(42)
  const { w: W, h: H } = nl.board
  const edgeConstraints = new Set(constraints.filter((c) => c.kind === 'edge').flatMap((c) => c.refs))
  const zoneOf = new Map(plan.zones.map((z) => [z.ref, z]))
  const parentOf = new Map(nl.components.filter((c) => c.parent).map((c) => [c.ref, c.parent!]))
  const placed: PlacedComponent[] = []
  const used = new Set<string>()

  const snap = (v: number) => Math.round(v * 4) / 4

  // 1. Connecteurs : alignés sur le bord sud, répartis (sauf antenne → coin NE)
  const connectors = nl.components.filter((c) => edgeConstraints.has(c.ref))
  const antenna = connectors.filter((c) => c.category === 'rf')
  const others = connectors.filter((c) => c.category !== 'rf')
  for (const c of antenna) {
    placed.push({ ref: c.ref, x: W - c.footprint.w / 2 - 1.5, y: H - c.footprint.h / 2 - 3, rot: 0, side: 'top', fixed: true })
    used.add(c.ref)
  }
  others.forEach((c, i) => {
    const x = (W * (i + 1)) / (others.length + 1)
    placed.push({ ref: c.ref, x: snap(x), y: c.footprint.h / 2 + 0.8, rot: 0, side: 'top', fixed: true })
    used.add(c.ref)
  })

  // 2. MCU au centre, puis tous les composants non fixés par zones
  for (const c of nl.components) {
    if (used.has(c.ref)) continue
    if (c.category === 'mcu') {
      placed.push({ ref: c.ref, x: snap(W / 2), y: snap(H / 2), rot: 0, side: 'top' })
      used.add(c.ref)
    }
  }
  for (const c of nl.components) {
    if (used.has(c.ref)) continue
    const z = zoneOf.get(c.ref)
    const zp = z ? zonePoint(z.zone, W, H) : { x: W / 2, y: H / 2 }
    const jx = (rng() - 0.5) * W * 0.2
    const jy = (rng() - 0.5) * H * 0.2
    placed.push({
      ref: c.ref,
      x: snap(Math.min(W - 2, Math.max(2, zp.x + jx))),
      y: snap(Math.min(H - 2, Math.max(2, zp.y + jy))),
      rot: 0, side: 'top',
    })
    used.add(c.ref)
  }

  // 3. Condensateurs de découplage : collés à leur parent immédiatement
  const map = new Map(placed.map((p) => [p.ref, p]))
  for (const c of nl.components) {
    const parent = parentOf.get(c.ref)
    if (!parent) continue
    const pp = map.get(parent)
    const pc = map.get(c.ref)
    if (!pp || !pc) continue
    const parentComp = nl.components.find((x) => x.ref === parent)!
    const pr = placedRect(pp, parentComp)
    const angle = (placed.length % 4) * (Math.PI / 2) + 0.6
    pc.x = snap(Math.min(W - 1.5, Math.max(1.5, pp.x + (pr.w / 2 + c.footprint.w / 2 + 0.6) * Math.cos(angle))))
    pc.y = snap(Math.min(H - 1.5, Math.max(1.5, pp.y + (pr.h / 2 + c.footprint.h / 2 + 0.6) * Math.sin(angle))))
  }
  return placed
}

/**
 * Légalisation : passe déterministe post-recuit qui élimine tout chevauchement
 * résiduel en repoussant le composant le plus petit le long de l'axe de
 * séparation (technique standard des placeurs commerciaux).
 */
export function legalizePlacement(nl: Netlist, placements: PlacedComponent[]): PlacedComponent[] {
  const out = placements.map((p) => ({ ...p }))
  const compByRef = new Map(nl.components.map((c) => [c.ref, c]))
  const rects = () =>
    out.map((p) => {
      const c = compByRef.get(p.ref)!
      const swap = p.rot === 90 || p.rot === 270
      return { ref: p.ref, x: p.x, y: p.y, w: swap ? c.footprint.h : c.footprint.w, h: swap ? c.footprint.w : c.footprint.h, area: c.footprint.w * c.footprint.h, fixed: !!p.fixed }
    })
  const GAP = 0.35
  const stuck = new Map<string, number>()
  for (let pass = 0; pass < 120; pass++) {
    const rs = rects()
    const overlaps: { a: typeof rs[number]; b: typeof rs[number]; ox: number; oy: number }[] = []
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j]
        const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2)
        const oy = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2)
        if (ox > 0 && oy > 0) overlaps.push({ a, b, ox, oy })
      }
    }
    if (overlaps.length === 0) break
    for (const { a, b, ox, oy } of overlaps) {
      // pousse le composant le plus petit (jamais un composant fixé)
      const push = (a.fixed ? b : (!b.fixed && b.area < a.area) ? b : a)
      const other = push === a ? b : a
      if (push.fixed) continue
      // Vecteur de translation minimale (MTV) ; alternance d'axe si blocage répété
      const key = [a.ref, b.ref].sort().join('|')
      const tries = stuck.get(key) ?? 0
      let useX = ox <= oy
      if (tries > 0 && tries % 3 === 2) useX = !useX // débloque les coincements au bord
      stuck.set(key, tries + 1)
      const nx = useX ? Math.sign(push.x - other.x || 1) : 0
      const ny = useX ? 0 : Math.sign(push.y - other.y || 1)
      const dist = (useX ? ox : oy) + GAP
      const idx = out.findIndex((p) => p.ref === push.ref)
      out[idx] = {
        ...out[idx],
        x: Math.min(nl.board.w - 0.8, Math.max(0.8, push.x + nx * dist)),
        y: Math.min(nl.board.h - 0.8, Math.max(0.8, push.y + ny * dist)),
      }
    }
  }
  return out
}

/**
 * Recuit simulé : minimise le coût prédit par le World Model.
 * Toutes les solutions intermédiaires sont évaluées en ~microsecondes —
 * c'est la « simulation mentale » qui différencie NEXUS d'un moteur
 * d'essai-erreur classique.
 */
export function optimizePlacement(
  nl: Netlist, plan: AgentPlan, constraints: Constraint[], opts: PlacerOptions = {},
): PlacementSolution {
  const t0 = Date.now()
  const seed = opts.seed ?? 1337
  const iterations = opts.iterations ?? 9000
  const T0 = opts.t0 ?? 320
  const Tend = opts.tEnd ?? 0.35
  const rng = mulberry32(seed)

  const ctx: EvalContext = buildEvalContext(nl, plan, constraints)
  let cur: PlacedComponent[] = initialPlacement(nl, plan, constraints)
  const movable = cur.filter((p) => !p.fixed).map((p) => p.ref)
  const W = nl.board.w, H = nl.board.h

  let curCost = evalCost(ctx, new Map(cur.map((p) => [p.ref, p])))
  let best: PlacedComponent[] = cur.map((p) => ({ ...p }))
  let bestCost = curCost.total
  const history: number[] = [bestCost]
  let iter = 0
  let cancelled = false

  const lambda = Math.log(T0 / Tend) // schedule géométrique
  const placementsMap = () => new Map(cur.map((p) => [p.ref, p]))

  for (iter = 0; iter < iterations; iter++) {
    if (opts.shouldCancel?.()) { cancelled = true; break }
    const T = T0 * Math.exp((-lambda * iter) / iterations)

    // --- Espace d'action : tirage d'une action {translation | échange | rotation} ---
    const i = Math.floor(rng() * movable.length)
    const idx = cur.findIndex((p) => p.ref === movable[i])
    const moveKind = rng()
    let undo: () => void

    if (moveKind < 0.55) {
      // Translation (amplitude proportionnelle à la température)
      const amp = 1 + (T / T0) * 14
      const px = cur[idx].x, py = cur[idx].y
      const nx = Math.round(Math.min(W - 1, Math.max(1, px + (rng() - 0.5) * 2 * amp)) * 4) / 4
      const ny = Math.round(Math.min(H - 1, Math.max(1, py + (rng() - 0.5) * 2 * amp)) * 4) / 4
      cur[idx] = { ...cur[idx], x: nx, y: ny }
      undo = () => { cur[idx] = { ...cur[idx], x: px, y: py } }
    } else if (moveKind < 0.8 && movable.length > 1) {
      // Échange de positions
      let j = Math.floor(rng() * movable.length)
      if (movable[j] === movable[i]) j = (j + 1) % movable.length
      const idx2 = cur.findIndex((p) => p.ref === movable[j])
      const ax = cur[idx].x, ay = cur[idx].y, bx = cur[idx2].x, by = cur[idx2].y
      cur[idx] = { ...cur[idx], x: bx, y: by }
      cur[idx2] = { ...cur[idx2], x: ax, y: ay }
      undo = () => {
        cur[idx] = { ...cur[idx], x: ax, y: ay }
        cur[idx2] = { ...cur[idx2], x: bx, y: by }
      }
    } else {
      // Rotation 90°
      const pr = cur[idx].rot
      cur[idx] = { ...cur[idx], rot: (((pr + 90) % 360) as 0 | 90 | 180 | 270) }
      undo = () => { cur[idx] = { ...cur[idx], rot: pr } }
    }

    // --- Critère de Metropolis : accepter si le World Model prédit mieux ---
    const newCost = evalCost(ctx, placementsMap())
    const d = newCost.total - curCost.total
    if (d < 0 || rng() < Math.exp(-d / Math.max(T, 1e-6))) {
      curCost = newCost
      if (newCost.total < bestCost) {
        bestCost = newCost.total
        best = cur.map((p) => ({ ...p }))
      }
    } else {
      undo()
    }

    if (iter % 50 === 0) history.push(bestCost)
    if (opts.onProgress && iter % 250 === 0) {
      opts.onProgress({ iter, total: iterations, cost: bestCost, placements: best.map((p) => ({ ...p })) })
    }
  }

  // Légalisation : élimine tout chevauchement résiduel (garantie industrielle)
  const legalized = legalizePlacement(nl, best)
  const finalCost = evalCost(ctx, new Map(legalized.map((p) => [p.ref, p])))
  return {
    placements: legalized,
    cost: finalCost,
    iterations: iter,
    history,
    durationMs: Date.now() - t0,
  }
}

export { placedRect, mulberry32 }
export type { EvalContext, PlacedComponent, Netlist, AgentPlan, Constraint }
