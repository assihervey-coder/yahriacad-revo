/**
 * NEXUS PCB — World Model (modèle du monde latent)
 * Équivalent : services/ai_engine/rl_agent/world_model/
 *
 * Rôle : PRÉDIRE la qualité d'une configuration sans lancer la simulation
 * physique complète. C'est l'avantage décisif face aux moteurs qui testent
 * par essai-erreur : chaque candidat est évalué en microsecondes via
 *   • un prédicteur HPWL (longueur de câblage bounding-box)
 *   • un noyau thermique analytique (décroissance en 1/r²)
 *   • des pénalités de contraintes (adjacence, bord, zones)
 *
 * Le solveur thermique par différences finies (simulator/thermal_sim) n'est
 * appelé qu'UNE fois, sur la solution finale, pour vérification.
 */
import type {
  AgentPlan, Component, Constraint, Netlist, PlacedComponent, ZoneHint, ZoneName,
} from './types'

/* ------------------------ Utilitaires déterministes ------------------------ */

/** Générateur pseudo-aléatoire seedé (mulberry32) — reproductibilité totale */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Boîte englobante d'un composant placé (rotation incluse) */
export function placedRect(p: PlacedComponent, c: Component): Rect {
  const swap = p.rot === 90 || p.rot === 270
  return { x: p.x, y: p.y, w: swap ? c.footprint.h : c.footprint.w, h: swap ? c.footprint.w : c.footprint.h }
}

/** Position absolue d'un pad du composant (mm, repère carte coin bas-gauche) */
export function padWorldPos(p: PlacedComponent, pad: { lx: number; ly: number }): { x: number; y: number } {
  const a = (p.rot * Math.PI) / 180
  const c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a))
  return { x: p.x + pad.lx * c - pad.ly * s, y: p.y + pad.lx * s + pad.ly * c }
}

export const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by)

/** Point d'ancrage d'une zone stratégique (repère carte) */
export function zonePoint(z: ZoneName, W: number, H: number): { x: number; y: number } {
  const mx = W * 0.28, my = H * 0.28
  switch (z) {
    case 'center': return { x: W / 2, y: H / 2 }
    case 'north': return { x: W / 2, y: H - my }
    case 'south': return { x: W / 2, y: my }
    case 'east': return { x: W - mx, y: H / 2 }
    case 'west': return { x: mx, y: H / 2 }
    case 'northeast': return { x: W - mx, y: H - my }
    case 'northwest': return { x: mx, y: H - my }
    case 'southeast': return { x: W - mx, y: my }
    case 'southwest': return { x: mx, y: my }
  }
}

/* --------------------------- Contexte d'évaluation --------------------------- */

export interface EvalContext {
  nl: Netlist
  plan: AgentPlan
  constraints: Constraint[]
  /** net → poids de câblage (rails de puissance comptent double) */
  netWeights: Map<string, number>
  /** ensemble des broches par net : [{ref, pin}] */
  netPins: Map<string, { ref: string; pin: string }[]>
  /** index composants */
  comps: Map<string, Component>
  /** paires d'adjacence imposées : [refA, refB, distMax] */
  adjacency: [string, string, number][]
  /** composants chauds et sensibles pour le noyau thermique */
  hot: { ref: string; power: number }[]
  sensitive: { ref: string; w: number }[]
  /** zone LLM par composant */
  zoneOf: Map<string, ZoneHint>
  /** zones d'exclusion (keepout RF) : rect + marge, réf. propriétaire */
  keepouts: { owner: string; x: number; y: number; w: number; h: number; margin: number }[]
  /** marge composant-bord (mm) */
  margin: number
}

export function buildEvalContext(nl: Netlist, plan: AgentPlan, constraints: Constraint[]): EvalContext {
  const netWeights = new Map<string, number>()
  const netPins = new Map<string, { ref: string; pin: string }[]>()
  for (const n of nl.nets) {
    netPins.set(n.name, n.pins)
    const w = n.cls === 'power' ? 2.2 : n.cls === 'highspeed' ? 1.6 : n.cls === 'diffpair' ? 1.8 : n.cls === 'rf' ? 3.0 : n.cls === 'ground' ? 0.4 : 1
    netWeights.set(n.name, w)
  }
  const adjacency: [string, string, number][] = []
  const hot: { ref: string; power: number }[] = []
  const sensitive: { ref: string; w: number }[] = []

  for (const c of constraints) {
    if (c.kind === 'adjacency' && c.refs.length >= 2) adjacency.push([c.refs[0], c.refs[1], c.value ?? 3])
  }
  for (const c of nl.components) {
    if (c.power >= 0.25) hot.push({ ref: c.ref, power: c.power })
    if (c.category === 'crystal' || c.category === 'sensor' || c.category === 'rf') sensitive.push({ ref: c.ref, w: 1.5 })
  }
  // Les nets analogiques rendent leur composant sensible
  for (const n of nl.nets) {
    if (n.cls === 'analog') for (const { ref } of n.pins) {
      if (ref.startsWith('U') && !sensitive.some((s) => s.ref === ref)) sensitive.push({ ref, w: 1 })
    }
  }
  const zoneOf = new Map(plan.zones.map((z) => [z.ref, z]))
  // Zones d'exclusion : rect du composant propriétaire + marge contrainte
  const keepouts: EvalContext['keepouts'] = []
  const compsMap = new Map(nl.components.map((c) => [c.ref, c]))
  for (const cst of constraints) {
    if (cst.kind !== 'keepout') continue
    for (const ref of cst.refs) {
      const c = compsMap.get(ref)
      if (!c) continue
      keepouts.push({ owner: ref, x: 0, y: 0, w: c.footprint.w, h: c.footprint.h, margin: cst.value ?? 5 })
    }
  }
  return {
    nl, plan, constraints, netWeights, netPins,
    comps: compsMap,
    adjacency, hot, sensitive, zoneOf, keepouts, margin: 1.2,
  }
}

/* ------------------------------ Prédicteurs ------------------------------ */

/** HPWL pondéré : demi-périmètre des boîtes englobantes par net */
export function predictHPWL(ctx: EvalContext, placements: Map<string, PlacedComponent>): number {
  let total = 0
  for (const [net, pins] of ctx.netPins) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    let count = 0
    for (const { ref, pin } of pins) {
      const p = placements.get(ref); const c = ctx.comps.get(ref)
      if (!p || !c) continue
      const pad = c.footprint.pads.find((pd) => pd.pin === pin)
      const wp = pad ? padWorldPos(p, pad) : p
      if (wp.x < minX) minX = wp.x; if (wp.x > maxX) maxX = wp.x
      if (wp.y < minY) minY = wp.y; if (wp.y > maxY) maxY = wp.y
      count++
    }
    if (count >= 2) total += (maxX - minX + maxY - minY) * (ctx.netWeights.get(net) ?? 1)
  }
  return total
}

/** Pénalité de chevauchement + débordement de carte (0 = parfait) */
export function predictOverlap(ctx: EvalContext, placements: Map<string, PlacedComponent>): number {
  const list = [...placements.entries()]
  let pen = 0
  const W = ctx.nl.board.w, H = ctx.nl.board.h
  for (let i = 0; i < list.length; i++) {
    const [refA, pa] = list[i]; const ca = ctx.comps.get(refA)!
    const ra = placedRect(pa, ca)
    // Débordement de carte
    if (ra.x - ra.w / 2 < -0.1 || ra.x + ra.w / 2 > W + 0.1) pen += 800
    if (ra.y - ra.h / 2 < -0.1 || ra.y + ra.h / 2 > H + 0.1) pen += 800
    // Marge de bord (sauf composants fixés au bord)
    if (!pa.fixed) {
      if (ra.x - ra.w / 2 < ctx.margin || ra.x + ra.w / 2 > W - ctx.margin) pen += 120
      if (ra.y - ra.h / 2 < ctx.margin || ra.y + ra.h / 2 > H - ctx.margin) pen += 120
    }
    for (let j = i + 1; j < list.length; j++) {
      const [refB, pb] = list[j]
      const cb = ctx.comps.get(refB)!
      const rb = placedRect(pb, cb)
      const ox = Math.min(ra.x + ra.w / 2, rb.x + rb.w / 2) - Math.max(ra.x - ra.w / 2, rb.x - rb.w / 2)
      const oy = Math.min(ra.y + ra.h / 2, rb.y + rb.h / 2) - Math.max(ra.y - ra.h / 2, rb.y - rb.h / 2)
      if (ox > 0 && oy > 0) pen += ox * oy * 120
      // espacement réduit toléré entre passifs (pratique CMS : 0,25-0,3 mm)
      else if (ox > -0.3 && ox < 0.3 && oy > -0.3 && oy < 0.3) pen += (0.3 - Math.max(ox, oy)) * 15
    }
  }
  return pen
}

/**
 * Noyau thermique latent : prédit la « chaleur perçue » par les composants
 * sensibles via décroissance analytique P / (1 + r²) — sans simulation.
 */
export function predictThermal(ctx: EvalContext, placements: Map<string, PlacedComponent>): number {
  let pen = 0
  for (const h of ctx.hot) {
    const ph = placements.get(h.ref)
    if (!ph) continue
    for (const s of ctx.sensitive) {
      if (s.ref === h.ref) continue
      const ps = placements.get(s.ref)
      if (!ps) continue
      const d = dist(ph.x, ph.y, ps.x, ps.y)
      // au-delà de 12 mm l'influence est négligeable
      if (d < 12) pen += (h.power * s.w * 260) / (1 + d * d)
    }
  }
  return pen
}

/** Pénalités de contraintes : adjacence, attraction des zones LLM, keepout */
export function predictConstraints(ctx: EvalContext, placements: Map<string, PlacedComponent>): number {
  let pen = 0
  const W = ctx.nl.board.w, H = ctx.nl.board.h
  for (const [a, b, dmax] of ctx.adjacency) {
    const pa = placements.get(a), pb = placements.get(b)
    if (!pa || !pb) continue
    const d = dist(pa.x, pa.y, pb.x, pb.y)
    if (d > dmax) pen += (d - dmax) * (d - dmax) * 30
  }
  // Attraction douce vers les zones décidées par l'agent LLM
  for (const [ref, p] of placements) {
    if (p.fixed) continue
    const z = ctx.zoneOf.get(ref)
    if (!z) continue
    const zp = zonePoint(z.zone, W, H)
    const d = dist(p.x, p.y, zp.x, zp.y)
    pen += d * 0.9
  }
  // Zones d'exclusion (RF) : intrusion interdite sauf le propriétaire lui-même
  for (const k of ctx.keepouts) {
    const ownerP = placements.get(k.owner)
    if (!ownerP) continue
    const kx0 = ownerP.x - k.w / 2 - k.margin
    const kx1 = ownerP.x + k.w / 2 + k.margin
    const ky0 = ownerP.y - k.h / 2 - k.margin
    const ky1 = ownerP.y + k.h / 2 + k.margin
    for (const [ref, p] of placements) {
      if (ref === k.owner) continue
      const c = ctx.comps.get(ref)
      if (!c || c.category === 'rf') continue
      const r = placedRect(p, c)
      if (r.x + r.w / 2 > kx0 && r.x - r.w / 2 < kx1 && r.y + r.h / 2 > ky0 && r.y - r.h / 2 < ky1) {
        const dx = Math.min(kx1, r.x + r.w / 2) - Math.max(kx0, r.x - r.w / 2)
        const dy = Math.min(ky1, r.y + r.h / 2) - Math.max(ky0, r.y - r.h / 2)
        pen += dx * dy * 50 + 400
      }
    }
  }
  return pen
}

/** Récompense négative totale (coût) — la « prédiction du monde » */
export function evalCost(ctx: EvalContext, placements: Map<string, PlacedComponent>) {
  const hpwl = predictHPWL(ctx, placements)
  const overlap = predictOverlap(ctx, placements)
  const thermal = predictThermal(ctx, placements)
  const constraint = predictConstraints(ctx, placements)
  return { total: hpwl + overlap + thermal + constraint, hpwl, overlap, thermal, constraint }
}
