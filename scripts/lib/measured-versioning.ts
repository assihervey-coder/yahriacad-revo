// NEXUS PCB — Versionnage des coefficients de calage mesuré [Sprint 1 — M1].
//
// Module SANS effet de bord partagé par le CLI (scripts/calibrate_measured.ts)
// et la suite moteur (scripts/test-engine.ts) :
//   - datasetSha256      : empreinte du fichier de relevés (traçabilité d'entrée)
//   - measuredRevision   : révision des coefficients — hash déterministe des
//     SEULES parties reproductibles (projet, coefficients, statistiques,
//     couverture, sources, empreinte du jeu). Deux régénérations du même jeu
//     de relevés produisent la MÊME révision ; un seul ΔT qui change la change.
import { createHash } from 'node:crypto'

/** SHA-256 hex des octets bruts du fichier de relevés. */
export function datasetSha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Charge utile déterministe de la révision — PAS d'horodatage ici : le
 *  `calibratedAt` est une métadonnée de provenance, pas une entrée du hash. */
export interface RevisionPayload {
  project: string
  coefficients: { slope: number; intercept: number; slopeCi95: [number, number] | null }
  statistics: { r: number; rmse: number; maxErr: number; usedSamples: number; skippedSamples: number }
  coverage: { matchedRefs: string[]; missingRefs: string[]; ambientMinC: number; ambientMaxC: number }
  sources: string[]
  datasetSha256: string
  schemaVersion: number
}

/** Canonisation récursive : clés triées à TOUS les niveaux, séparateurs
 *  compacts — puis SHA-256 hex 32 o. (Le replacer-array de JSON.stringify
 *  s'applique récursivement et écraserait les propriétés imbriquées : il est
 *  donc proscrit ici.) */
export function measuredRevision(p: RevisionPayload): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])]))
    }
    return v
  }
  return createHash('sha256').update(JSON.stringify(canon(p))).digest('hex')
}
