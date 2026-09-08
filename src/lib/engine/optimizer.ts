/**
 * NEXUS PCB — Optimiseur autonome (boucle Ratchet — inspiration AutoPCB)
 * Équivalent : services/ai_engine/autonomous_optimizer/
 *   ├── proposer      : propose une modification locale de placement
 *   ├── fast_evaluator: évalue en ~microsecondes via le World Model (< 5 s total)
 *   └── keeper_logic  : ne retient QUE les améliorations strictes (ratchet)
 *
 * Contrairement au recuit simulé (exploration avec température), le ratchet
 * n'accepte JAMAIS de dégradation : il rafine une solution déjà bonne,
 * proposition après proposition, sans jamais régresser. Idéal en post-traitement
 * du placement RL — y compris en tâche de fond « de nuit ».
 */
import type {
  AgentPlan, Constraint, Netlist, OptimizerReport, PlacedComponent,
} from './types'
import { buildEvalContext, evalCost, mulberry32, placedRect, type EvalContext } from './world-model'
import { legalizePlacement } from './placer'

export interface RatchetOptions {
  /** Nombre de propositions à évaluer (défaut 300 — ~1 s sur une carte 20 composants) */
  proposals?: number
  seed?: number
  onProgress?: (p: { round: number; total: number; best: number; accepted: number; placements: PlacedComponent[] }) => void
  shouldCancel?: () => boolean
}

export interface RatchetResult extends OptimizerReport {
  placements: PlacedComponent[]
  history: number[]
}

/**
 * Réparation keepout : repousse hors des zones d'exclusion RF tout composant
 * qui y aurait été poussé par la légalisation (translation minimale de sortie,
 * direction opposée au propriétaire). La chaîne RF (réseau d'adaptation) est
 * légitimement exemptée — même sémantique que le DRC.
 */
function repairKeepouts(nl: Netlist, constraints: Constraint[], list: PlacedComponent[]): PlacedComponent[] {
  const comps = new Map(nl.components.map((c) => [c.ref, c]))
  const out = list.map((p) => ({ ...p }))
  for (const cst of constraints.filter((c) => c.kind === 'keepout')) {
    const rfNetSet = new Set(cst.nets)
    const rfChain = new Set(nl.nets.filter((n) => rfNetSet.has(n.name)).flatMap((n) => n.pins.map((p) => p.ref)))
    for (const ownerRef of cst.refs) {
      const ownerC = comps.get(ownerRef)
      const ownerP = out.find((p) => p.ref === ownerRef)
      if (!ownerC || !ownerP) continue
      const m = cst.value ?? 5
      // Rect du propriétaire ROTATION COMPRISE (cohérent avec l'audit Fuse)
      const kr = placedRect(ownerP, ownerC)
      const kx0 = kr.x - kr.w / 2 - m
      const kx1 = kr.x + kr.w / 2 + m
      const ky0 = kr.y - kr.h / 2 - m
      const ky1 = kr.y + kr.h / 2 + m
      for (const p of out) {
        if (p.ref === ownerRef || p.fixed || rfChain.has(p.ref)) continue
        const c = comps.get(p.ref)
        if (!c || c.category === 'rf') continue
        const swap = p.rot === 90 || p.rot === 270
        const r = { w: swap ? c.footprint.h : c.footprint.w, h: swap ? c.footprint.w : c.footprint.h }
        if (p.x + r.w / 2 <= kx0 || p.x - r.w / 2 >= kx1 || p.y + r.h / 2 <= ky0 || p.y - r.h / 2 >= ky1) continue
        // Translation minimale de sortie (4 directions, on prend la plus courte)
        const exits = [
          { d: p.x + r.w / 2 - kx0, dx: -1, dy: 0 },   // sortir vers la gauche
          { d: kx1 - (p.x - r.w / 2), dx: 1, dy: 0 },  // vers la droite
          { d: p.y + r.h / 2 - ky0, dx: 0, dy: -1 },   // vers le bas
          { d: ky1 - (p.y - r.h / 2), dx: 0, dy: 1 },  // vers le haut
        ]
        exits.sort((a, b) => a.d - b.d)
        const e = exits[0]
        p.x += e.dx * (e.d + 0.25)
        p.y += e.dy * (e.d + 0.25)
      }
    }
  }
  return out
}

/**
 * Boucle ratchet : part du placement RL, teste des perturbations locales
 * (translation fine, rotation, échange), garde strictement mieux. La
 * légalisation finale garantit l'absence totale de chevauchement.
 */
export function ratchetOptimize(
  nl: Netlist, plan: AgentPlan, constraints: Constraint[],
  start: PlacedComponent[], opts: RatchetOptions = {},
): RatchetResult {
  const t0 = Date.now()
  const total = opts.proposals ?? 300
  const rng = mulberry32(opts.seed ?? 20240)
  const ctx: EvalContext = buildEvalContext(nl, plan, constraints)
  const W = nl.board.w, H = nl.board.h

  const asMap = (list: PlacedComponent[]) => new Map(list.map((p) => [p.ref, p]))
  const costOf = (list: PlacedComponent[]) => evalCost(ctx, asMap(list)).total

  let cur = start.map((p) => ({ ...p }))
  let curCost = costOf(cur)
  const costBefore = curCost
  const baselineLegal = legalizePlacement(nl, cur)
  const baselineCostRaw = evalCost(ctx, asMap(baselineLegal)).total

  const movable = cur.filter((p) => !p.fixed).map((p) => p.ref)
  const history: number[] = [curCost]
  let accepted = 0

  // Demi-dimensions du corps (rotation incluse) pour un bornage physique
  const halfOf = (ref: string) => {
    const c = ctx.comps.get(ref)
    const p = cur.find((x) => x.ref === ref)
    if (!c || !p) return { hw: 1, hh: 1 }
    const swap = p.rot === 90 || p.rot === 270
    return { hw: (swap ? c.footprint.h : c.footprint.w) / 2, hh: (swap ? c.footprint.w : c.footprint.h) / 2 }
  }

  for (let round = 0; round < total && movable.length > 0; round++) {
    if (opts.shouldCancel?.()) break
    // Le tirage DOIT être hors du prédicat findIndex : sinon rng() est appelé
    // une fois par élément évalué (séquence corrompue + risque d'aucun match)
    const pick = movable[Math.floor(rng() * movable.length)]
    const idx = cur.findIndex((p) => p.ref === pick)
    if (idx === -1) continue // défense en profondeur — ne doit jamais arriver
    const kind = rng()
    let undo: () => void

    if (kind < 0.6) {
      // Translation fine (0,5 – 2,5 mm, grille 0,25 mm) — corps confiné dans la carte
      const { hw, hh } = halfOf(cur[idx].ref)
      const amp = 0.5 + rng() * 2
      const px = cur[idx].x, py = cur[idx].y
      const nx = Math.round(Math.min(W - hw - 0.3, Math.max(hw + 0.3, px + (rng() - 0.5) * 2 * amp)) * 4) / 4
      const ny = Math.round(Math.min(H - hh - 0.3, Math.max(hh + 0.3, py + (rng() - 0.5) * 2 * amp)) * 4) / 4
      cur[idx] = { ...cur[idx], x: nx, y: ny }
      undo = () => { cur[idx] = { ...cur[idx], x: px, y: py } }
    } else if (kind < 0.85) {
      // Rotation 90°
      const pr = cur[idx].rot
      cur[idx] = { ...cur[idx], rot: (((pr + 90) % 360) as 0 | 90 | 180 | 270) }
      undo = () => { cur[idx] = { ...cur[idx], rot: pr } }
    } else if (movable.length > 1) {
      // Échange de positions entre deux composants mobiles
      let j = Math.floor(rng() * movable.length)
      if (movable[j] === cur[idx].ref) j = (j + 1) % movable.length
      const pick2 = movable[j]
      const idx2 = cur.findIndex((p) => p.ref === pick2)
      if (idx2 === -1) continue
      const ax = cur[idx].x, ay = cur[idx].y, bx = cur[idx2].x, by = cur[idx2].y
      cur[idx] = { ...cur[idx], x: bx, y: by }
      cur[idx2] = { ...cur[idx2], x: ax, y: ay }
      undo = () => {
        cur[idx] = { ...cur[idx], x: ax, y: ay }
        cur[idx2] = { ...cur[idx2], x: bx, y: by }
      }
    } else {
      continue
    }

    // --- keeper_logic : ratchet strict (jamais de régression) ---
    const newCost = evalCost(ctx, asMap(cur)).total
    if (newCost < curCost - 0.25) {
      curCost = newCost
      accepted++
    } else {
      undo()
    }

    if (round % 10 === 0) history.push(curCost)
    if (opts.onProgress && (round % 25 === 0 || round === total - 1)) {
      opts.onProgress({ round, total, best: curCost, accepted, placements: cur.map((p) => ({ ...p })) })
    }
  }

  // Légalisation + réparation keepout (la légalisation peut pousser un
  // composant dans une zone d'exclusion) — le meilleur état conforme gagne
  const legalized = repairKeepouts(nl, constraints, legalizePlacement(nl, cur))
  const legalCost = evalCost(ctx, asMap(legalized)).total
  const baselineRepaired = repairKeepouts(nl, constraints, baselineLegal)
  const baselineCost = Math.min(baselineCostRaw, evalCost(ctx, asMap(baselineRepaired)).total)
  // La réparation peut dégrader légèrement le coût prédit : on garde le mieux
  const useRatcheted = legalCost <= Math.max(baselineCost, curCost + 2)
  const finalPlacements = useRatcheted ? legalized : baselineRepaired
  const finalCost = useRatcheted ? legalCost : baselineCost
  const finalHistory = useRatcheted ? history : [costBefore, baselineCost]

  const gainPct = costBefore > 0 ? Math.max(0, ((costBefore - finalCost) / costBefore) * 100) : 0
  return {
    placements: finalPlacements,
    proposals: total,
    accepted,
    costBefore,
    costAfter: finalCost,
    gainPct: Math.round(gainPct * 10) / 10,
    durationMs: Date.now() - t0,
    history: finalHistory,
  }
}
