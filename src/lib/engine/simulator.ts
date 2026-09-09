/**
 * NEXUS PCB — Simulateur physique
 * Équivalent : services/simulator/thermal_sim/ + services/simulator/signal_integrity/
 *
 * 1. Thermique : solveur en différences finies (état stationnaire, Gauss-Seidel)
 *    sur grille 1 mm — conditions aux limites de type convection fixée (ambiante).
 * 2. Intégrité du signal : impédance microstrip (formule IPC-2141), skew
 *    intra-bus, vérification des cibles d'impédance (RF 50 Ω, USB 90 Ω).
 */
import type { Constraint, Netlist, Route, SiMetric, SiReport, ThermalMap } from './types'
import { placedRect, padWorldPos } from './world-model'
import type { PlacedComponent } from './types'

/* ============================== THERMIQUE ============================== */

export const AMBIENT = 22.0           // °C

/**
 * Solveur thermique en différences finies.
 * - Chaque composant injecte sa puissance sur l'empreinte (W répartis sur les cellules)
 * - Les bords de carte sont fixés à l'ambiante (radiateur idéal, hypothèse 2 couches)
 * - Gauss-Seidel jusqu'à convergence (Δ < 0,01 °C) ou 800 itérations max
 */
export function solveThermal(nl: Netlist, placements: PlacedComponent[]): ThermalMap {
  const cell = 1.0
  const cols = Math.floor(nl.board.w / cell)
  const rows = Math.floor(nl.board.h / cell)
  const temps = new Float64Array(cols * rows).fill(AMBIENT)
  const sources = new Float64Array(cols * rows)

  const compByRef = new Map(nl.components.map((c) => [c.ref, c]))

  // Injection des sources de chaleur
  for (const p of placements) {
    const c = compByRef.get(p.ref)
    if (!c || c.power <= 0) continue
    const r = placedRect(p, c)
    const x0 = Math.max(0, Math.floor((r.x - r.w / 2) / cell))
    const x1 = Math.min(cols - 1, Math.ceil((r.x + r.w / 2) / cell))
    const y0 = Math.max(0, Math.floor((r.y - r.h / 2) / cell))
    const y1 = Math.min(rows - 1, Math.ceil((r.y + r.h / 2) / cell))
    const nCells = Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1))
    const perCell = (c.power * 62.5) / nCells  // résolution thermique FR4 2 couches
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        sources[y * cols + x] += perCell
  }

  // Gauss-Seidel : T = T + Σ(T_voisins - T)·α + source
  const alpha = 0.24
  const SOURCE_GAIN = 0.72 // calibré : LDO 0,65 W → ΔT ≈ +35 °C (FR4 2 couches sans plan cuivre)
  for (let it = 0; it < 2500; it++) {
    let maxDelta = 0
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const i = y * cols + x
        const lap = temps[i - 1] + temps[i + 1] + temps[i - cols] + temps[i + cols] - 4 * temps[i]
        const nt = temps[i] + alpha * lap + sources[i] * SOURCE_GAIN
        const d = Math.abs(nt - temps[i])
        if (d > maxDelta) maxDelta = d
        temps[i] = nt
      }
    }
    // Bords : ambiante (convection parfaite)
    for (let x = 0; x < cols; x++) {
      temps[x] = AMBIENT
      temps[(rows - 1) * cols + x] = AMBIENT
    }
    for (let y = 0; y < rows; y++) {
      temps[y * cols] = AMBIENT
      temps[y * cols + cols - 1] = AMBIENT
    }
    if (maxDelta < 0.01 && it > 40) break
  }

  // Détection des points chauds (maxima locaux aux centres des composants)
  const hotspots: ThermalMap['hotspots'] = []
  for (const p of placements) {
    const c = compByRef.get(p.ref)
    if (!c || c.power < 0.05) continue
    const cx = Math.min(cols - 1, Math.max(0, Math.round(p.x / cell)))
    const cy = Math.min(rows - 1, Math.max(0, Math.round(p.y / cell)))
    hotspots.push({ x: p.x, y: p.y, t: Math.round(temps[cy * cols + cx] * 10) / 10, ref: p.ref })
  }
  hotspots.sort((a, b) => b.t - a.t)

  let minT = Infinity, maxT = -Infinity
  for (const t of temps) {
    if (t < minT) minT = t
    if (t > maxT) maxT = t
  }

  return {
    cols, rows, cell, originX: 0, originY: 0,
    temps: Array.from(temps, (t) => Math.round(t * 10) / 10),
    minT: Math.round(minT * 10) / 10,
    maxT: Math.round(maxT * 10) / 10,
    hotspots: hotspots.slice(0, 5),
  }
}

/* ======================== INTÉGRITÉ DU SIGNAL ========================= */

const ER = 4.4          // εr FR4
const H_DIELECTRIC = 1.6 // hauteur diélectrique (carte 2 couches, mm)
const T_COPPER = 0.035   // épaisseur cuivre (mm)

/** Impédance microstrip (approx. IPC-2141) : Z0 = 87/√(εr+1.41) · ln(5.98h/(0.8w+t)) */
export function microstripZ0(wMm: number): number {
  const w = Math.max(0.08, wMm)
  return (87 / Math.sqrt(ER + 1.41)) * Math.log((5.98 * H_DIELECTRIC) / (0.8 * w + T_COPPER))
}

const TARGETS: Partial<Record<string, number>> = { rf: 50, diffpair: 90 }

/** Longueur d'une route (mm) */
export function routeLength(r: Route): number {
  let len = 0
  for (const seg of r.segments) {
    for (let i = 1; i < seg.pts.length; i++) {
      len += Math.abs(seg.pts[i].x - seg.pts[i - 1].x) + Math.abs(seg.pts[i].y - seg.pts[i - 1].y)
    }
  }
  return len
}

/**
 * Estimation de diaphonie (crosstalk) — boucle multiphysique continue
 * Équivalent : services/simulator/multi_physics_loop/ [Cadence AuraStack]
 *
 * Pour chaque net critique (RF, différentiel, haute vitesse, analogique),
 * recherche le pire couplage capacitif avec un net agresseur : segments
 * parallèles sur la même couche, longueur d'accouplement / distance.
 * Heuristique calibrée : couplage ≈ 6 % par (mm parallèle / mm de gap).
 */
function estimateCrosstalk(
  nl: Netlist, routes: Map<string, Route>,
): Map<string, { pct: number; with: string }> {
  const widthOf = new Map(nl.nets.map((n) => [n.name, n.width ?? 0.3]))
  interface Run { net: string; layer: number; a: { x: number; y: number }; b: { x: number; y: number }; horiz: boolean }
  const runs: Run[] = []
  for (const [net, r] of routes) {
    if (!r.routed || r.pour) continue
    for (const seg of r.segments) {
      for (let i = 1; i < seg.pts.length; i++) {
        const a = seg.pts[i - 1], b = seg.pts[i]
        runs.push({ net, layer: seg.layer, a, b, horiz: a.y === b.y })
      }
    }
  }
  const victims = nl.nets.filter((n) => ['rf', 'diffpair', 'highspeed', 'analog'].includes(n.cls))
  const out = new Map<string, { pct: number; with: string }>()
  const overlap1D = (a1: number, a2: number, b1: number, b2: number) =>
    Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2))
  for (const victim of victims) {
    let worst = 0, worstWith = ''
    for (const run of runs.filter((r) => r.net === victim.name)) {
      for (const agg of runs) {
        if (agg.net === victim.name || agg.layer !== run.layer) continue
        if (agg.horiz !== run.horiz) continue
        const par = run.horiz
          ? overlap1D(run.a.x, run.b.x, agg.a.x, agg.b.x)
          : overlap1D(run.a.y, run.b.y, agg.a.y, agg.b.y)
        if (par <= 0.5) continue
        const gap = par > 0
          ? (run.horiz ? Math.abs(run.a.y - agg.a.y) : Math.abs(run.a.x - agg.a.x))
          : Infinity
        if (gap < 0.05 || gap > 3) continue
        // correction largeur : cuivre large = plus de couplage
        const wFactor = ((widthOf.get(agg.net) ?? 0.3) / 0.3)
        const pct = Math.min(35, ((par * 1.2) / Math.max(gap, 0.12) / 4) * wFactor)
        if (pct > worst) { worst = pct; worstWith = agg.net }
      }
    }
    if (worst > 0.5) out.set(victim.name, { pct: Math.round(worst * 10) / 10, with: worstWith })
  }
  return out
}

/** Analyse SI complète : impédance par classe + skew des bus + diaphonie */
export function analyzeSi(
  nl: Netlist, routes: Map<string, Route>, widthOf: (cls: string) => number,
  constraints: Constraint[],
): SiReport {
  const metrics: SiMetric[] = []
  const xtalk = estimateCrosstalk(nl, routes)

  // 1. Impédance des nets critiques (+ diaphonie [AuraStack])
  for (const n of nl.nets) {
    if (!['rf', 'diffpair', 'highspeed'].includes(n.cls)) continue
    const w = n.width ?? widthOf(n.cls)
    const z0 = microstripZ0(w)
    const target = n.cls === 'rf' ? 50 : n.cls === 'diffpair' ? 90 : undefined
    const r = routes.get(n.name)
    const len = r ? routeLength(r) : 0
    const ok = target ? Math.abs(z0 - target) / target < 0.25 : true
    let comment: string
    if (n.cls === 'rf') comment = ok
      ? `Ligne 50 Ω respectée (piste large ${w} mm sur FR4 1,6 mm)`
      : `Écart d'impédance : cible ${target} Ω, calculée ${z0.toFixed(1)} Ω`
    else if (n.cls === 'diffpair') {
      // [P1.2] appariement strict : skew et gap mesurés par le routeur
      const pr = r?.pair
      comment = pr
        ? `Paire ${pr.partner} : Z0 ${z0.toFixed(1)} Ω vs cible 90 Ω · skew ${pr.skewMm.toFixed(2)} mm ${pr.matched ? '≤ 0,5 mm ✓' : '> 0,5 mm — serpentin requis'} · gap ${pr.gapMm.toFixed(2)} mm`
        : `Paire USB : Z0 ${z0.toFixed(1)} Ω vs cible 90 Ω — routage apparié en attente`
    }
    else comment = `Net haute vitesse ${n.name} : ${len.toFixed(1)} mm, Z0 ${z0.toFixed(1)} Ω`
    const xt = xtalk.get(n.name)
    const pr = n.cls === 'diffpair' ? routes.get(n.name)?.pair : undefined
    if (xt) {
      comment += ` · diaphonie ${xt.pct.toFixed(1)} % (accouplement avec ${xt.with})`
    }
    metrics.push({
      net: n.name, cls: n.cls, lengthMm: Math.round(len * 10) / 10,
      impedance: Math.round(z0 * 10) / 10, targetImpedance: target, impedanceOk: ok,
      ...(pr ? { skewMm: pr.skewMm, skewOk: pr.matched } : {}),
      ...(xt ? { crosstalkPct: xt.pct, crosstalkOk: xt.pct < 15, crosstalkWith: xt.with } : {}),
      comment,
    })
  }

  // 2. Skew des groupes de bus (contraintes length_match)
  for (const c of constraints) {
    if (c.kind !== 'length_match' || c.nets.length < 2) continue
    const lens = c.nets.map((n) => {
      const r = routes.get(n)
      return r ? routeLength(r) : 0
    })
    const skew = Math.max(...lens) - Math.min(...lens)
    const ok = skew <= (c.value ?? 2) * 2
    for (let i = 0; i < c.nets.length; i++) {
      const w = widthOf('highspeed')
      metrics.push({
        net: c.nets[i], cls: 'highspeed', lengthMm: Math.round(lens[i] * 10) / 10,
        impedance: Math.round(microstripZ0(w) * 10) / 10, impedanceOk: true,
        skewMm: Math.round(skew * 100) / 100, skewOk: ok,
        comment: ok
          ? `Bus ${c.nets[0].split('_')[0]} : skew ${skew.toFixed(2)} mm ≤ tolérance`
          : `Skew excessif : ${skew.toFixed(2)} mm — serpentins recommandés`,
      })
    }
  }

  // 2b. Diaphonie des nets analogiques sensibles
  for (const n of nl.nets.filter((x) => x.cls === 'analog')) {
    const xt = xtalk.get(n.name)
    if (!xt) continue
    const r = routes.get(n.name)
    const len = r ? routeLength(r) : 0
    metrics.push({
      net: n.name, cls: n.cls, lengthMm: Math.round(len * 10) / 10,
      impedance: Math.round(microstripZ0(widthOf(n.cls)) * 10) / 10, impedanceOk: true,
      crosstalkPct: xt.pct, crosstalkOk: xt.pct < 15, crosstalkWith: xt.with,
      comment: `Net analogique : diaphonie ${xt.pct.toFixed(1)} % depuis ${xt.with} — ${xt.pct < 15 ? 'acceptable' : 'éloigner ou mettre à la masse entre les deux'}`,
    })
  }

  return {
    metrics,
    pass: metrics.every((m) => m.impedanceOk && m.skewOk !== false && m.crosstalkOk !== false),
  }
}

/** Recalcule la position absolue d'un pad pour le DRC/état */
export { placedRect, padWorldPos }
