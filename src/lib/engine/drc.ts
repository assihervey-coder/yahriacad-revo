/**
 * NEXUS PCB — Moteur DRC / DFM
 * Équivalent : services/drc_dfm_engine/design_rules/ + manufacturing_rules/ + checkers/
 *
 * DRC  : continuité électrique (nets non routés), clearance de bord,
 *        violation de keepout RF, chevauchements, contraintes thermiques
 * DFM  : fabricabilité (largeur de piste, perçage, via-in-pad, taux
 *        d'occupation) — règles usine PCBWay/JLCPCB standard 2 couches
 */
import type {
  Constraint, DesignRules, DfmReport, DrcReport, DrcViolation, Netlist,
  PlacedComponent, RoutingSolution, ThermalMap,
} from './types'
import { placedRect } from './world-model'

export function runDrc(
  nl: Netlist, placements: PlacedComponent[], routing: RoutingSolution,
  thermal: ThermalMap, rules: DesignRules, constraints: Constraint[],
): DrcReport {
  const t0 = Date.now()
  const v: DrcViolation[] = []
  const compByRef = new Map(nl.components.map((c) => [c.ref, c]))
  const routeByNet = new Map(routing.routes.map((r) => [r.net, r]))

  /* 1. Continuité : nets non routés */
  for (const r of routing.routes) {
    if (!r.routed) {
      v.push({
        code: 'DRC-OPEN', severity: 'error',
        message: `Net « ${r.net} » non routé — ${r.failureReason ?? 'chemin introuvable'}`,
      })
    }
  }

  /* 2. Nets à une seule broche (flottants) */
  for (const n of nl.nets) {
    if (n.pins.length === 1) {
      v.push({
        code: 'DRC-FLOAT', severity: 'warning',
        message: `Net « ${n.name} » ne connecte qu'une broche (pin isolé)`,
      })
    }
  }

  /* 3. Clearance de bord : pistes trop proches du contour */
  for (const r of routing.routes) {
    for (const seg of r.segments) {
      for (const p of seg.pts) {
        const dEdge = Math.min(p.x, p.y, nl.board.w - p.x, nl.board.h - p.y)
        if (dEdge < rules.edgeClearance) {
          v.push({
            code: 'DRC-EDGE', severity: 'warning',
            message: `Piste du net ${r.net} à ${dEdge.toFixed(2)} mm du bord (min ${rules.edgeClearance} mm)`,
            location: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 },
          })
          break
        }
      }
    }
  }

  /* 4. Keepout RF : pistes étrangères dans la zone d'exclusion */
  for (const cst of constraints) {
    if (cst.kind !== 'keepout') continue
    const zones = cst.refs.map((ref) => {
      const c = compByRef.get(ref)
      const p = placements.find((x) => x.ref === ref)
      return c && p ? placedRect(p, c) : null
    }).filter(Boolean) as { x: number; y: number; w: number; h: number }[]
    const m = (cst.value ?? 5)
    const rfNets = new Set(cst.nets)
    for (const r of routing.routes) {
      if (rfNets.has(r.net)) continue
      for (const seg of r.segments) {
        // le keepout antenne concerne la couche supérieure ; le plan de masse
        // en couche inférieure sous l'antenne est une bonne pratique RF
        if (seg.layer !== 0) continue
        for (const p of seg.pts) {
          for (const z of zones) {
            if (p.x > z.x - z.w / 2 - m && p.x < z.x + z.w / 2 + m && p.y > z.y - z.h / 2 - m && p.y < z.y + z.h / 2 + m) {
              v.push({
                code: 'DRC-KEEPOUT', severity: 'error',
                message: `Piste du net ${r.net} dans la zone d'exclusion RF (${cst.refs.join('/')})`,
                location: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 },
              })
              break
            }
          }
        }
      }
    }
    // Composants parasites dans le keepout — sauf la chaîne RF
    // (réseau d'adaptation : composants reliés aux nets RF du propriétaire)
    const rfNetSet = new Set(cst.nets)
    const rfChainRefs = new Set(
      nl.nets.filter((n) => rfNetSet.has(n.name))
        .flatMap((n) => n.pins.map((p) => p.ref)),
    )
    for (const pl of placements) {
      if (cst.refs.includes(pl.ref) || rfChainRefs.has(pl.ref)) continue
      const c = compByRef.get(pl.ref)!
      const r = placedRect(pl, c)
      for (const z of zones) {
        if (r.x + r.w / 2 > z.x - z.w / 2 - m && r.x - r.w / 2 < z.x + z.w / 2 + m &&
            r.y + r.h / 2 > z.y - z.h / 2 - m && r.y - r.h / 2 < z.y + z.h / 2 + m) {
          v.push({
            code: 'DRC-KEEPOUT-C', severity: 'error',
            message: `Composant ${pl.ref} dans la zone d'exclusion RF`,
          })
        }
      }
    }
  }

  /* 5. Chevauchement de composants (sécurité placement) */
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placedRect(placements[i], compByRef.get(placements[i].ref)!)
      const b = placedRect(placements[j], compByRef.get(placements[j].ref)!)
      const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2)
      const oy = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2)
      if (ox > 0 && oy > 0) {
        v.push({
          code: 'DRC-OVERLAP', severity: 'error',
          message: `Chevauchement ${placements[i].ref} / ${placements[j].ref} (${(ox * oy).toFixed(1)} mm²)`,
          refs: [placements[i].ref, placements[j].ref],
        })
      }
    }
  }

  /* 6. Thermique : point chaud > 85 °C */
  for (const h of thermal.hotspots) {
    if (h.t > 85) {
      v.push({
        code: 'DRC-THERM', severity: 'warning',
        message: `${h.ref} atteint ${h.t.toFixed(1)} °C — prévoir aéraulie ou plan cuivre`,
        location: { x: h.x, y: h.y },
        refs: [h.ref],
      })
    }
  }

  /* 7. [P1.2] Paires différentielles : appariement de longueur (skew) */
  for (const r of routing.routes) {
    if (!r.pair || r.pair.matched) continue
    v.push({
      code: 'DRC-PAIR', severity: 'warning',
      message: `Paire ${r.net} ↔ ${r.pair.partner} : skew ${r.pair.skewMm.toFixed(2)} mm > tolérance 0,5 mm — serpentin recommandé`,
      refs: [r.net, r.pair.partner],
    })
  }

  const errors = v.filter((x) => x.severity === 'error').length
  const warnings = v.filter((x) => x.severity === 'warning').length
  return {
    violations: v.slice(0, 60),
    errors, warnings,
    pass: errors === 0,
    durationMs: Date.now() - t0,
  }
}

/* ================================ DFM ================================ */

export function runDfm(
  nl: Netlist, placements: PlacedComponent[], routing: RoutingSolution, rules: DesignRules,
): DfmReport {
  const checks: DfmReport['checks'] = []
  let score = 100

  const widths = new Set<number>()
  for (const r of routing.routes) for (const s of r.segments) widths.add(s.width)
  const minW = widths.size ? Math.min(...widths) : 0.25
  checks.push({
    name: 'Largeur de piste minimale',
    pass: minW >= rules.minTraceWidth,
    detail: `${minW.toFixed(2)} mm ≥ ${rules.minTraceWidth.toFixed(2)} mm (process usine standard)`,
  })
  if (minW < rules.minTraceWidth) score -= 25

  const drills = routing.routes.flatMap((r) => r.vias).map((v) => v.drill)
  const minD = drills.length ? Math.min(...drills) : rules.minDrill
  checks.push({
    name: 'Perçage minimal',
    pass: minD >= rules.minDrill,
    detail: `${minD.toFixed(2)} mm ≥ ${rules.minDrill.toFixed(2)} mm (foret mécanique)`,
  })
  if (minD < rules.minDrill) score -= 25

  // Taux d'occupation
  let usedArea = 0
  for (const p of placements) {
    const c = nl.components.find((x) => x.ref === p.ref)!
    usedArea += c.footprint.w * c.footprint.h
  }
  const utilization = (usedArea / (nl.board.w * nl.board.h)) * 100
  checks.push({
    name: 'Taux d’occupation',
    pass: utilization < 70,
    detail: `${utilization.toFixed(1)} % de la surface carte (seuil assemblage : 70 %)`,
  })
  if (utilization >= 70) score -= 15

  // Via-in-pad (risque de défauts de soudure)
  const viaInPad = routing.routes.some((r) =>
    r.vias.some((v) =>
      placements.some((p) => {
        const c = nl.components.find((x) => x.ref === p.ref)!
        const rect = placedRect(p, c)
        return Math.abs(v.x - rect.x) < rect.w / 2 && Math.abs(v.y - rect.y) < rect.h / 2
      }),
    ),
  )
  checks.push({
    name: 'Via-in-pad',
    pass: !viaInPad,
    detail: viaInPad ? 'Vias sous pads détectés — bouchage requis (surcoût)' : 'Aucun via sous pad',
  })
  if (viaInPad) score -= 10

  // Routabilité
  const routeRate = routing.totalNets ? routing.routedNets / routing.totalNets : 0
  checks.push({
    name: 'Taux de routage',
    pass: routeRate >= 0.98,
    detail: `${(routeRate * 100).toFixed(1)} % des nets routés (${routing.routedNets}/${routing.totalNets})`,
  })
  if (routeRate < 0.98) score -= Math.round((1 - routeRate) * 40)

  // [P1.1] Plans cuivre dédiés (pile 4 couches)
  const planes = routing.planes ?? []
  if (planes.length > 0) {
    const cov = planes.reduce((a, p) => a + p.cells.length, 0) / planes.reduce((a, p) => a + p.cols * p.rows, 0)
    checks.push({
      name: 'Plans cuivre dédiés (4 couches)',
      pass: cov >= 0.55,
      detail: `${planes.map((p) => `L${p.layer} ${p.net}`).join(' + ')} — couverture ${(cov * 100).toFixed(0)} %`,
    })
    if (cov < 0.55) score -= 5
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    minTraceWidthMm: minW,
    minDrillMm: minD,
    utilizationPct: Math.round(utilization * 10) / 10,
    checks,
  }
}
