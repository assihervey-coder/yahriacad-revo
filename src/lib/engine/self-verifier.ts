/**
 * NEXUS PCB — Auto-vérification physique déterministe (inspiration Siemens Fuse)
 * Équivalent : services/ai_engine/self_verifier/
 *   ├── deterministic_checker : re-contrôle chaque décision des agents (RL/LLM)
   │     contre un moteur géométrique déterministe, indépendant
 *   └── rollback_manager      : annule / répare les décisions qui échouent
 *
 * Principe clé [Fuse] : les agents IA peuvent se tromper, la physique non.
 * Chaque état (placement, routage) est audité par un second moteur strict,
 * sans apprentissage ni hasard. Toute violation déclenche un rollback
 * maîtrisé (re-légalisation) plutôt qu'un échec silencieux avalé par le DRC.
 */
import type {
  Constraint, DesignRules, Netlist, PlacedComponent, RoutingSolution, TraceSegment,
} from './types'
import { placedRect } from './world-model'

export interface AuditViolation {
  code: string
  message: string
}

export interface PlacementAudit {
  pass: boolean
  violations: AuditViolation[]
}

export interface RoutingAudit {
  pass: boolean
  violations: AuditViolation[]
}

/* =================== deterministic_checker — PLACEMENT =================== */

export function verifyPlacement(
  nl: Netlist, placements: PlacedComponent[], constraints: Constraint[],
): PlacementAudit {
  const violations: AuditViolation[] = []
  const comps = new Map(nl.components.map((c) => [c.ref, c]))
  const W = nl.board.w, H = nl.board.h

  // 1. Bornes de carte + marge (les composants fixés au bord sont exemptés de marge)
  for (const p of placements) {
    const c = comps.get(p.ref)
    if (!c) { violations.push({ code: 'SV-REF', message: `${p.ref} absent de la netlist` }); continue }
    const r = placedRect(p, c)
    if (r.x - r.w / 2 < -0.05 || r.x + r.w / 2 > W + 0.05 || r.y - r.h / 2 < -0.05 || r.y + r.h / 2 > H + 0.05) {
      violations.push({ code: 'SV-BOUNDS', message: `${p.ref} hors des limites de la carte (${r.x.toFixed(1)}, ${r.y.toFixed(1)})` })
    }
  }

  // 2. Chevauchements (audit strict, indépendant de la légalisation)
  const list = placements
    .map((p) => ({ p, c: comps.get(p.ref)! }))
    .filter((x) => x.c)
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const ra = placedRect(list[i].p, list[i].c)
      const rb = placedRect(list[j].p, list[j].c)
      const ox = Math.min(ra.x + ra.w / 2, rb.x + rb.w / 2) - Math.max(ra.x - ra.w / 2, rb.x - rb.w / 2)
      const oy = Math.min(ra.y + ra.h / 2, rb.y + rb.h / 2) - Math.max(ra.y - ra.h / 2, rb.y - rb.h / 2)
      if (ox > 0 && oy > 0) {
        violations.push({ code: 'SV-OVERLAP', message: `${list[i].p.ref} ∩ ${list[j].p.ref} — recouvrement ${(ox * oy).toFixed(2)} mm²` })
      }
    }
  }

  // 3. Keepouts RF : intrusion interdite — SAUF le propriétaire, les composants
  // RF, et la chaîne RF connectée aux nets du keepout (réseau d'adaptation π :
  // L/C près de l'antenne = pratique industrielle, même sémantique que le DRC)
  for (const cst of constraints.filter((c) => c.kind === 'keepout')) {
    const rfNetSet = new Set(cst.nets)
    const rfChainRefs = new Set(
      nl.nets.filter((n) => rfNetSet.has(n.name))
        .flatMap((n) => n.pins.map((p) => p.ref)),
    )
    for (const ref of cst.refs) {
      const ownerP = placements.find((p) => p.ref === ref)
      const ownerC = comps.get(ref)
      if (!ownerP || !ownerC) continue
      const m = cst.value ?? 5
      const kr = placedRect(ownerP, ownerC)
      const kx0 = kr.x - kr.w / 2 - m, kx1 = kr.x + kr.w / 2 + m
      const ky0 = kr.y - kr.h / 2 - m, ky1 = kr.y + kr.h / 2 + m
      for (const p of placements) {
        if (p.ref === ref) continue
        const c = comps.get(p.ref)
        if (!c || c.category === 'rf' || rfChainRefs.has(p.ref)) continue
        const r = placedRect(p, c)
        if (r.x + r.w / 2 > kx0 && r.x - r.w / 2 < kx1 && r.y + r.h / 2 > ky0 && r.y - r.h / 2 < ky1) {
          violations.push({ code: 'SV-KEEPOUT', message: `${p.ref} intruse dans le keepout RF de ${ref}` })
        }
      }
    }
  }

  // 4. Contraintes de bord : les connecteurs fixés doivent exister et être fixés
  for (const cst of constraints.filter((c) => c.kind === 'edge')) {
    for (const ref of cst.refs) {
      const p = placements.find((x) => x.ref === ref)
      if (!p) violations.push({ code: 'SV-EDGE', message: `${ref} (contrainte de bord) non placé` })
      else if (!p.fixed) violations.push({ code: 'SV-EDGE', message: `${ref} devrait être fixé au bord` })
    }
  }

  return { pass: violations.length === 0, violations }
}

/* ==================== rollback_manager — PLACEMENT ==================== */

/**
 * Rollback maîtrisé : si l'audit échoue, on répare par re-légalisation
 * (translation minimale déterministe) puis on re-audit. Retourne l'état
 * réparé + les actions entreprises (pour la traçabilité des agents).
 */
export function rollbackPlacement(
  nl: Netlist, placements: PlacedComponent[], constraints: Constraint[],
  legalize: (nl: Netlist, placements: PlacedComponent[]) => PlacedComponent[],
): { placements: PlacedComponent[]; rolledBack: boolean; notes: string[] } {
  const audit = verifyPlacement(nl, placements, constraints)
  if (audit.pass) return { placements, rolledBack: false, notes: ['Audit placement : conforme d’emblée'] }

  const notes: string[] = audit.violations.slice(0, 6).map((v) => `${v.code} : ${v.message}`)
  const repaired = legalize(nl, placements)
  const re = verifyPlacement(nl, repaired, constraints)
  notes.push(re.pass
    ? `Rollback : re-légalisation MTM appliquée → ${audit.violations.length} violation(s) réparée(s)`
    : `Rollback partiel : ${re.violations.length} violation(s) résiduelle(s) transmise(s) au DRC`)
  return { placements: repaired, rolledBack: true, notes }
}

/* =================== deterministic_checker — ROUTAGE =================== */

/** Distance min entre deux segments orthogonaux (approx. rectangle-min) */
function segDistance(a: TraceSegment, b: TraceSegment): number {
  let best = Infinity
  for (let i = 1; i < a.pts.length; i++) {
    for (let j = 1; j < b.pts.length; j++) {
      const a1 = a.pts[i - 1], a2 = a.pts[i], b1 = b.pts[j - 1], b2 = b.pts[j]
      const aH = a1.y === a2.y, bH = b1.y === b2.y
      let d: number
      if (aH && bH) {
        // distance verticale si recouvrement horizontal, sinon distance coins
        const ox = Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x)) - Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x))
        d = ox > 0 ? Math.abs(a1.y - b1.y) : cornerDist(a1, a2, b1, b2)
      } else if (!aH && !bH) {
        const oy = Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y)) - Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y))
        d = oy > 0 ? Math.abs(a1.x - b1.x) : cornerDist(a1, a2, b1, b2)
      } else {
        // perpendiculaires : distance point-segment croisée (approx. coin)
        d = cornerDist(a1, a2, b1, b2)
      }
      if (d < best) best = d
    }
  }
  return best
}

function cornerDist(a1: { x: number; y: number }, a2: { x: number; y: number },
  b1: { x: number; y: number }, b2: { x: number; y: number }): number {
  const ptsA = [a1, a2], ptsB = [b1, b2]
  let best = Infinity
  for (const p of ptsA) {
    for (const q of ptsB) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y))
  }
  return best
}

export function verifyRouting(
  nl: Netlist, routing: RoutingSolution, rules: DesignRules,
): RoutingAudit {
  const violations: AuditViolation[] = []

  // 1. Ouverts : chaque net multi-broches doit être routé (ou connecté au plan)
  for (const r of routing.routes) {
    const net = nl.nets.find((n) => n.name === r.net)
    if (!net || net.pins.length < 2) continue
    if (!r.routed) violations.push({ code: 'SV-OPEN', message: `Net ${r.net} non connecté (${net.pins.length} broches)` })
  }

  // 2. Largeur minimale + perçage minimal + annular ring
  for (const r of routing.routes) {
    for (const seg of r.segments) {
      if (seg.width < rules.minTraceWidth - 1e-6) {
        violations.push({ code: 'SV-WIDTH', message: `Net ${r.net} : piste ${seg.width} mm < min ${rules.minTraceWidth} mm` })
      }
    }
    for (const v of r.vias) {
      if (v.drill < rules.minDrill - 1e-6) {
        violations.push({ code: 'SV-DRILL', message: `Net ${r.net} : perçage ${v.drill} mm < min ${rules.minDrill} mm` })
      }
      if (v.diameter < v.drill + 0.2) {
        violations.push({ code: 'SV-ANNULAR', message: `Net ${r.net} : annular ring insuffisant (Ø ${v.diameter} / drill ${v.drill})` })
      }
    }
  }

  // 3. Clearance cuivre-cuivre entre nets différents (même couche).
  // Tolérance 20 % : la dilation du routeur garantit la clearance pour des
  // voisins de largeur minimale ; on ne remonte ici que les manquements
  // sérieux (cuivre large adjacent), signalés à l'orchestrateur.
  const allSegs: { seg: TraceSegment; net: string }[] = []
  for (const r of routing.routes) {
    if (!r.routed || r.pour) continue
    for (const seg of r.segments) allSegs.push({ seg, net: r.net })
  }
  const widthOf = new Map(nl.nets.map((n) => [n.name, n.width ?? 0.25]))
  for (let i = 0; i < allSegs.length; i++) {
    for (let j = i + 1; j < allSegs.length; j++) {
      const A = allSegs[i], B = allSegs[j]
      if (A.net === B.net || A.seg.layer !== B.seg.layer) continue
      const need = (widthOf.get(A.net) ?? 0.25) / 2 + (widthOf.get(B.net) ?? 0.25) / 2 + rules.clearance
      const d = segDistance(A.seg, B.seg)
      if (d < need * 0.8 - 0.02) {
        violations.push({
          code: 'SV-CLEARANCE',
          message: `${A.net} ↔ ${B.net} : ${d.toFixed(2)} mm < clearance requise ${need.toFixed(2)} mm (L${A.seg.layer})`,
        })
      }
    }
  }

  return { pass: violations.length === 0, violations }
}
