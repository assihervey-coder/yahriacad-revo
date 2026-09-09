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

/* ====================== Régression linéaire partagée ====================== */

/** Régression moindres carrés y = a·x + b + Pearson r (outil commun des deux
 *  harnais de calibration : simulation et cartes mesurées) + IC 95 % de la pente. */
export function linregStats(arr: { a: number; b: number }[]): {
  r: number
  slope: number
  intercept: number
  rmse: number
  maxErr: number
  /** IC 95 % de la pente — null si n < 3 ou variance nulle */
  slopeCi95: [number, number] | null
} {
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
  const rmse = Math.sqrt(se / n)
  return { r, slope, intercept, rmse, maxErr: maxE, slopeCi95: slopeCi95(n, slope, rmse, va) }
}

/** Quantile bilatéral 95 % de Student (table compacte, ddl = n−2) — au-delà
 *  de 60 ddl on rejoint la normale (1,96). Clé la plus grande ≤ df (conservateur). */
function t975(df: number): number {
  const table: [number, number][] = [
    [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447],
    [7, 2.365], [8, 2.306], [9, 2.262], [10, 2.228], [12, 2.179], [14, 2.145],
    [16, 2.12], [18, 2.101], [20, 2.086], [25, 2.06], [30, 2.042], [40, 2.021], [60, 2.0],
  ]
  for (let i = table.length - 1; i >= 0; i--) if (df >= table[i][0]) return table[i][1]
  return 12.706
}

/** Intervalle de confiance 95 % de la pente : slope ± t(0,975; n−2)·RMSE/√Σ(x−x̄)².
 *  null si n < 3 (ddl insuffisant) ou variance explicative nulle. */
function slopeCi95(n: number, slope: number, rmse: number, sx2: number): [number, number] | null {
  if (n < 3 || sx2 <= 0 || !Number.isFinite(rmse)) return null
  const half = (t975(n - 2) * rmse) / Math.sqrt(sx2)
  return [slope - half, slope + half]
}

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

/** Vérité terrain du noyau latent : ΔT (°C) lu dans le champ FDM aux
 *  composants SENSIBLES — c'est exactement ce que prédit predictThermal
 *  (« chaleur perçue »). Le ΔT max carte est une métrique différente.
 *  Réutilisable pour aligner un relevé d'instrumentation réel (thermocouples,
 *  caméra thermique) sur les mêmes refs que le modèle. */
export function sensitiveDeltaTs(
  ctx: EvalContext,
  nl: Netlist,
  placements: PlacedComponent[],
): { ref: string; deltaT: number }[] {
  const tm = solveThermal(nl, placements)
  const at = (x: number, y: number) =>
    tm.temps[
      Math.min(tm.rows - 1, Math.max(0, Math.round(y / tm.cell))) * tm.cols +
      Math.min(tm.cols - 1, Math.max(0, Math.round(x / tm.cell)))
    ]
  return ctx.sensitive.map((s) => {
    const p = placements.find((q) => q.ref === s.ref)
    return { ref: s.ref, deltaT: p ? at(p.x, p.y) - AMBIENT : 0 }
  })
}

/** ΔT moyen (°C) aux composants sensibles — vérité terrain FDM du noyau latent. */
export function truthSensitiveDeltaT(
  ctx: EvalContext,
  nl: Netlist,
  placements: PlacedComponent[],
): number {
  const vals = sensitiveDeltaTs(ctx, nl, placements)
  return vals.length ? vals.reduce((a, b) => a + b.deltaT, 0) / vals.length : 0
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

  const s = linregStats(pairs.map((p) => ({ a: p.pred, b: p.truth })))
  const sMax = linregStats(maxPairs.map((p) => ({ a: p.pred, b: p.truthMax })))

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

/* ================== Calibration sur cartes MESURÉES (P2.3) ================== */

/** Un relevé réel : une carte instrumentée, une configuration thermique.
 *  positions = placement RÉEL de la carte (AOI, rayons X, fichier pick&place
 *  de production) ; measurements = ΔT mesuré par capteur (thermocouple,
 *  caméra IR) sur chaque composant sensible, RELATIF à ambientC. */
export interface MeasuredBoardSample {
  /** identifiant traçable : « révision B — lot 2026-08 » */
  label: string
  /** température ambiante de la mesure (°C) — le ΔT est relatif à cette base */
  ambientC: number
  /** placement réel des composants (mm, même convention que le studio) */
  placements: PlacedComponent[]
  /** ΔT mesuré (°C) par composant — seuls les refs sensibles comptent */
  measurements: { ref: string; deltaT: number }[]
  /** provenance : banc d'essai, campagne, opérateur… (versionnage) */
  source?: string
}

export interface MeasuredCalibration {
  /** relevés soumis */
  samples: number
  /** relevés exploitables (≥ 2 mesures sur refs sensibles, valeurs saines) */
  usedSamples: number
  /** relevés écartés par la validation sanitaire */
  skippedSamples: number
  /** refs sensibles couvertes par les mesures / manquantes */
  matchedRefs: string[]
  missingRefs: string[]
  r: number
  /** °C par unité de chaleur latente — LE coefficient de calage */
  slope: number
  intercept: number
  rmse: number
  maxErr: number
  predMin: number
  predMax: number
  truthMin: number
  truthMax: number
  /** plage d'ambiance couverte par les relevés (°C) */
  ambientMinC: number
  ambientMaxC: number
  /** provenances déclarées (traçabilité des coefficients) */
  sources: string[]
  /** IC 95 % de la pente de calage (°C/unité latente) — null si n < 3 */
  slopeCi95: [number, number] | null
  at: string
}

/* ============ Seuils PUBLIÉS du calage industriel [Sprint 1 — M1] ============ */

/** Seuils publiés : un jeu de coefficients n'est PUBLIÉ (versionné, exposé UI)
 *  que si l'écart modèle/mesure reste sous ces bornes. Documentés dans
 *  docs/protocole-acquisition-cartes-mesurees.md — toute modification passe
 *  par une révision du protocole, pas par un relâchement silencieux. */
export const PUBLISHED_THRESHOLDS = {
  /** corrélation minimale prédiction latente ↔ mesure */
  rMin: 0.55,
  /** RMSE maximal de la droite calibrée (°C) */
  rmseMaxC: 8,
  /** écart maximal ponctuel droite ↔ mesure (°C) */
  maxErrMaxC: 15,
  /** nombre minimal de relevés exploitables pour publier */
  minSamples: 2,
} as const

export interface ThresholdVerdict {
  ok: boolean
  /** motifs de refus, formatés pour le CLI et le journal */
  failures: string[]
}

/** Verdict d'un calage mesuré contre les seuils publiés [M1 — DoD « écart
 *  modèle/mesure documenté sous seuil publié »]. */
export function measuredThresholdVerdict(cal: {
  r: number
  rmse: number
  maxErr: number
  usedSamples: number
}): ThresholdVerdict {
  const failures: string[] = []
  if (cal.usedSamples < PUBLISHED_THRESHOLDS.minSamples)
    failures.push(`relevés exploitables ${cal.usedSamples} < ${PUBLISHED_THRESHOLDS.minSamples}`)
  if (!(cal.r >= PUBLISHED_THRESHOLDS.rMin)) failures.push(`r ${cal.r.toFixed(3)} < ${PUBLISHED_THRESHOLDS.rMin}`)
  if (!(cal.rmse <= PUBLISHED_THRESHOLDS.rmseMaxC))
    failures.push(`RMSE ${cal.rmse.toFixed(2)} °C > ${PUBLISHED_THRESHOLDS.rmseMaxC} °C`)
  if (!(cal.maxErr <= PUBLISHED_THRESHOLDS.maxErrMaxC))
    failures.push(`err max ${cal.maxErr.toFixed(2)} °C > ${PUBLISHED_THRESHOLDS.maxErrMaxC} °C`)
  return { ok: failures.length === 0, failures }
}

/** Bornes de plausibilité des mesures réelles (°C) — garde-fou entrée.
 *  ΔT absurde (capteur décollé, réflexion IR) → relevé écarté, jamais moyenné. */
const DT_MIN = -10
const DT_MAX = 200
const AMBIENT_MIN = -40
const AMBIENT_MAX = 125

/** Calage des coefficients du noyau latent sur des CARTES MESURÉES.
 *  Même mathématique que calibrateThermalModel, mais la vérité terrain vient
 *  de l'instrumentation réelle au lieu du solveur FDM. Un relevé est
 *  exploitable dès 1 mesure saine sur une ref sensible ; le calage lui-même
 *  exige ≥ 2 relevés (régression). Les relevés invalides sont écartés
 *  (comptés), jamais interpolés ni moyennés en silence. */
export function calibrateFromMeasuredBoards(
  nl: Netlist,
  plan: AgentPlan,
  constraints: Constraint[],
  samples: MeasuredBoardSample[],
): MeasuredCalibration {
  const ctx = buildEvalContext(nl, plan, constraints)
  const sensitiveRefs = ctx.sensitive.map((s) => s.ref)
  const sensSet = new Set(sensitiveRefs)

  const pairs: { pred: number; truth: number }[] = []
  const matched = new Set<string>()
  const sources = new Set<string>()
  let skipped = 0
  let ambMin = Infinity
  let ambMax = -Infinity

  for (const smp of samples) {
    // validation sanitaire du relevé
    const ambOk = Number.isFinite(smp.ambientC) && smp.ambientC >= AMBIENT_MIN && smp.ambientC <= AMBIENT_MAX
    const usable = ambOk
      ? smp.measurements.filter(
          (m) =>
            sensSet.has(m.ref) &&
            Number.isFinite(m.deltaT) &&
            m.deltaT >= DT_MIN &&
            m.deltaT <= DT_MAX,
        )
      : []
    const placementsOk =
      smp.placements.length > 0 &&
      smp.placements.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && nl.components.some((c) => c.ref === p.ref))
    if (!ambOk || usable.length < 1 || !placementsOk) {
      skipped++
      continue
    }
    const map = new Map(smp.placements.map((p) => [p.ref, p]))
    const pred = predictThermal(ctx, map)
    const truth = usable.reduce((acc, m) => acc + m.deltaT, 0) / usable.length
    if (!Number.isFinite(pred) || !Number.isFinite(truth)) {
      skipped++
      continue
    }
    for (const m of usable) matched.add(m.ref)
    if (smp.source) sources.add(smp.source)
    ambMin = Math.min(ambMin, smp.ambientC)
    ambMax = Math.max(ambMax, smp.ambientC)
    pairs.push({ pred, truth })
  }

  const fit =
    pairs.length >= 2
      ? linregStats(pairs.map((p) => ({ a: p.pred, b: p.truth })))
      : { r: 0, slope: 0, intercept: 0, rmse: 0, maxErr: 0, slopeCi95: null as [number, number] | null }

  return {
    samples: samples.length,
    usedSamples: pairs.length,
    skippedSamples: skipped,
    matchedRefs: sensitiveRefs.filter((r) => matched.has(r)),
    missingRefs: sensitiveRefs.filter((r) => !matched.has(r)),
    r: fit.r,
    slope: fit.slope,
    intercept: fit.intercept,
    rmse: fit.rmse,
    maxErr: fit.maxErr,
    predMin: pairs.length ? Math.min(...pairs.map((p) => p.pred)) : 0,
    predMax: pairs.length ? Math.max(...pairs.map((p) => p.pred)) : 0,
    truthMin: pairs.length ? Math.min(...pairs.map((p) => p.truth)) : 0,
    truthMax: pairs.length ? Math.max(...pairs.map((p) => p.truth)) : 0,
    ambientMinC: pairs.length ? ambMin : 0,
    ambientMaxC: pairs.length ? ambMax : 0,
    sources: [...sources],
    slopeCi95: fit.slopeCi95,
    at: new Date().toISOString(),
  }
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
