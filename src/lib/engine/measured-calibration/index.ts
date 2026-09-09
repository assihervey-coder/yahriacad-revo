// NEXUS PCB — Coefficients de calage MESURÉS publiés dans le dépôt [Sprint 1 M2].
//
// Chaque fichier <projet>.json est produit par le CLI de calage
// (scripts/calibrate_measured.ts) — jamais à la main — et porte sa révision
// SHA-256, son verdict contre les seuils publiés et sa provenance. Deux
// régénérations du même jeu de relevés donnent la même révision : les
// coefficients sont reproductibles depuis le dépôt (protocole :
// docs/protocole-acquisition-cartes-mesurees.md).
//
// Un projet n'apparaît ici QUE si son calage a passé les seuils publiés ;
// les projets sans entrée affichent l'état « en attente » dans l'UI — jamais
// de coefficients silencieux.
import nexusCore from './nexus-core.json'

/** Fichier de coefficients tel qu'émis par le CLI (schemaVersion 1). */
export interface MeasuredCoefficientsFile {
  schemaVersion: number
  project: string
  /** SHA-256 du contenu reproductible (hors horodatage) */
  revision: string
  verdict: 'CONFORME'
  thresholds: { rMin: number; rmseMaxC: number; maxErrMaxC: number; minSamples: number }
  coefficients: { slope: number; intercept: number; slopeCi95: [number, number] | null }
  statistics: { r: number; rmse: number; maxErr: number; usedSamples: number; skippedSamples: number }
  coverage: { matchedRefs: string[]; missingRefs: string[]; ambientMinC: number; ambientMaxC: number }
  sources: string[]
  /** « demo » = jeu synthétique de démonstration ; « measured » = campagne réelle */
  dataKind: 'demo' | 'measured'
  provenance: { dataset: string; datasetSha256: string; calibratedAt: string }
}

/** Coefficients mesurés publiés, par identifiant de projet. */
export const MEASURED_CALIBRATIONS: Record<string, MeasuredCoefficientsFile> = {
  'nexus-core': nexusCore as unknown as MeasuredCoefficientsFile,
}
