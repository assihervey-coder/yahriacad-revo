/**
 * NEXUS PCB — Calibration par corrélation des modèles [audit P2.3]
 * Équivalent : services/simulator/calibration/
 *
 * Le monde latent (noyau 1/(1+r²)) prédit la chaleur en unités arbitraires ;
 * le solveur FDM donne la vérité en °C. Ce harnais :
 *   1. échantillonne des placements aléatoires légaux (RNG seedé),
 *   2. confronte prédiction latente et ΔT FDM sur chaque échantillon,
 *   3. calcule la corrélation de Pearson + la droite de calibration
 *      (moindres carrés) qui mappe l'unité latente vers le °C,
 *   4. expose la prédiction calibrée pour l'analyse en ligne.
 *
 * Un profil d'impédance par classe complète le contrôle du modèle SI
 * (largeur de piste → Z0 IPC-2141 vs cible de classe).
 */
import type { AgentPlan, Constraint, DesignRules, Netlist, PlacedComponent } from './types'
import { buildEvalContext, mulberry32, predictThermal, type EvalContext } from './world-model'
import { microstripZ0, solveThermal, AMBIENT } from './simulator'

export interface ThermalCalibration {
  samples: number
  /** Corrélation de Pearson : chaleur latente ↔ ΔT moyen aux composants sensibles (0..1 attendu) */
  r: number
  /** Corrélation latente ↔ ΔT max carte (info : structurellement plus faible — le noyau ne cible pas le max) */
  rMax: number
  /** °C par unité de chaleur latente (régression moindres carrés, cible sensibles) */
  slope: number
  intercept: number
  /** Erreur quadratique moyenne de la droite calibrée (°C) */
  rmse: number
  /** Écart maximal droit ↔ FDM sur l'échantillon (°C) */
  maxErr: number
  predMin: number
  predMax: number
  truthMin: number
  truthMax: number
  at: string
}

/** Placement aléatoire légal — grille intérieure, rotation aléatoire. */
function randomPlacement(nl: Netlist, rng: () => number, ref: string): PlacedComponent {
  const c = nl.components.find((x) => x.ref === ref)!
  const m = 2
  const x = m + c.footprint.w / 2 + rng() * Math.max(0.1, nl.board.w - c.footprint.w - 2 * m)
  const y = m + c.footprint.h / 2 + rng() * Math.max(0.1, nl.board.h - c.footprint.h - 2 * m)
  const rot = [0, 90, 180, 270][Math.floor(rng() * 4)] as PlacedComponent['rot']
  return { ref, x, y, rot, side: 'top', fixed: false }
}

/** Vérité terrain du noyau latent : ΔT moyen (°C) lu dans le champ FDM aux
 *  composants SENSIBLES — c'est exactement ce que prédit predictThermal
 *  (« chaleur perçue »). Le ΔT max carte est une métrique différente. */
export function truthSensitiveDeltaT(
  ctx: EvalContext,
  nl: Netlist,
  placements: PlacedComponent[],
): number {
  const tm = solveThermal(nl, placements)
  const at = (x: number, y: number) =>
    tm.temps[
      Math.min(tm.rows - 1, Math.max(0, Math.round(y / tm.cell))) * tm.cols +
      Math.min(tm.cols - 1, Math.max(0, Math.round(x / tm.cell)))
    ]
  const vals = ctx.sensitive.map((s) => {
    const p = placements.find((q) => q.ref === s.ref)
    return p ? at(p.x, p.y) - AMBIENT : 0
  })
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
}

/** Mesure r et droite de calibration sur N échantillons aléatoires. */
export function calibrateThermalModel(
  nl: Netlist,
  plan: AgentPlan,
  constraints: Constraint[],
  opts?: { samples?: number; seed?: number; anchor?: PlacedComponent[] },
): ThermalCalibration {
  const ctx = buildEvalContext(nl, plan, constraints)
  const rng = mulberry32(opts?.seed ?? 20260909)
  const N = Math.max(8, Math.min(64, Math.round(opts?.samples ?? 20)))

  const pairs: { pred: number; truth: number }[] = []
  const maxPairs: { pred: number; truthMax: number }[] = []
  const push = (placements: PlacedComponent[]) => {
    const map = new Map(placements.map((p) => [p.ref, p]))
    const pred = predictThermal(ctx, map)
    pairs.push({ pred, truth: truthSensitiveDeltaT(ctx, nl, placements) })
    maxPairs.push({ pred, truthMax: solveThermal(nl, placements).maxT - AMBIENT })
  }
  // Point d'ancrage : la solution OPERANTE (celle du studio) — la droite de
  // calibration doit rester fidèle au domaine réellement utilisé, pas
  // seulement à la distribution aléatoire d'exploration.
  if (opts?.anchor && opts.anchor.length > 0) push(opts.anchor)
  for (let i = 0; i < N; i++) {
    push(nl.components.map((c) => randomPlacement(nl, rng, c.ref)))
  }

  const stats = (arr: { a: number; b: number }[]) => {
    const n = arr.length
    const ma = arr.reduce((s, p) => s + p.a, 0) / n
    const mb = arr.reduce((s, p) => s + p.b, 0) / n
    let cov = 0, va = 0, vb = 0
    for (const p of arr) {
      cov += (p.a - ma) * (p.b - mb)
      va += (p.a - ma) ** 2
      vb += (p.b - mb) ** 2
    }
    const r = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0
    const slope = va > 0 ? cov / va : 0
    const intercept = mb - slope * ma
    let se = 0, maxE = 0
    for (const p of arr) {
      const e = slope * p.a + intercept - p.b
      se += e * e
      maxE = Math.max(maxE, Math.abs(e))
    }
    return { r, slope, intercept, rmse: Math.sqrt(se / n), maxErr: maxE }
  }

  const s = stats(pairs.map((p) => ({ a: p.pred, b: p.truth })))
  const sMax = stats(maxPairs.map((p) => ({ a: p.pred, b: p.truthMax })))

  return {
    samples: N,
    r: s.r,
    rMax: sMax.r,
    slope: s.slope,
    intercept: s.intercept,
    rmse: s.rmse,
    maxErr: s.maxErr,
    predMin: Math.min(...pairs.map((p) => p.pred)),
    predMax: Math.max(...pairs.map((p) => p.pred)),
    truthMin: Math.min(...pairs.map((p) => p.truth)),
    truthMax: Math.max(...pairs.map((p) => p.truth)),
    at: new Date().toISOString(),
  }
}

/** Prédiction calibrée du ΔT max (°C) pour un placement donné. */
export function calibratedDeltaT(
  cal: ThermalCalibration,
  ctx: EvalContext,
  placements: Map<string, PlacedComponent>,
): number {
  return Math.max(0, cal.slope * predictThermal(ctx, placements) + cal.intercept)
}

/* ====================== Profil d'impédance par classe ====================== */

/** Cibles d'impédance usuelles par classe (Ω) — null = non contraint. */
const Z_TARGETS: { cls: string; target: number | null }[] = [
  { cls: 'rf', target: 50 },
  { cls: 'diffpair', target: 90 },
  { cls: 'highspeed', target: 50 },
  { cls: 'power', target: null },
  { cls: 'ground', target: null },
  { cls: 'signal', target: null },
  { cls: 'analog', target: null },
]

export interface ImpedanceCheck {
  cls: string
  widthMm: number
  z0: number
  target: number | null
  delta: number | null
}

/** Z0 IPC-2141 pour chaque classe de règles + écart à la cible. */
export function impedanceProfile(rules: DesignRules): ImpedanceCheck[] {
  return Z_TARGETS.map(({ cls, target }) => {
    const widthMm = rules.widths[cls as keyof DesignRules['widths']]
    const z0 = microstripZ0(widthMm)
    return {
      cls,
      widthMm,
      z0,
      target,
      delta: target !== null ? z0 - target : null,
    }
  })
}
