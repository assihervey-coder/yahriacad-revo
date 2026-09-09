// NEXUS PCB — Générateur du jeu de DÉMONSTRATION pour le calage mesuré [M1].
//
//   bun run scripts/make_measured_demo.ts
//
// Produit scripts/measured-boards.demo-<projet>.json : des relevés
// SYNTHÉTIQUES étiquetés « DÉMO » partout. Rôle : PROUVER la chaîne complète
// (format ↔ validation sanitaire ↔ CLI ↔ coefficients versionnés ↔ UI) en
// attendant la campagne M1 sur de vraies cartes instrumentées. Ces données ne
// PRÉTENDENT PAS être des mesures réelles — les sources et l'UI le rappellent.
//
// Fidélité au protocole M1 (docs/protocole-acquisition-cartes-mesurees.md) :
// une campagne réelle instrumente des cartes à LAYOUT FIXE mesurées sous
// plusieurs configurations thermiques. Le jeu démo reproduit donc cette
// structure — 6 cartes (jitter manufacturier croissant 0 → 10 mm autour du
// layout optimisé) × 3 ambiances — plutôt que des placements fantaisistes
// dispersés sur toute la carte : la droite de calage doit rester fidèle au
// domaine opérant (principe de l'ancre du harnais simulation).
import { writeFileSync } from 'node:fs'
import { NETLISTS } from '../src/lib/engine/netlists'
import { extractConstraints } from '../src/lib/engine/parser'
import { buildEvalContext, mulberry32 } from '../src/lib/engine/world-model'
import { sensitiveDeltaTs } from '../src/lib/engine/calibration'
import { ruleBasedPlan } from '../src/lib/engine/llm-agent'
import { optimizePlacement } from '../src/lib/engine/placer'
import type { PlacedComponent } from '../src/lib/engine/types'

const SOURCE = 'DÉMO — données synthétiques (FDM + bruit capteur ±0,4 °C), campagne M1 en attente'
const NOISE_HALF_C = 0.4
/** 6 cartes à layout fixe (jitter manufacturier croissant 0 → 10 mm) × 3
 *  ambiances : le support de régression doit compter PLUSIEURS layouts
 *  distincts — 2 cartes ne donneraient que 2 points de support et un r
 *  dégénéré (|r| = 1 par construction). Le ΔT FDM est relatif à l'ambiance :
 *  la diversité de support vient des layouts, comme sur une campagne réelle
 *  multi-révisions. */
const JITTERS_MM = [0, 2, 4, 6, 8, 10] as const
const AMBIENTS = [20.4, 28.6, 40.2] as const

for (const nl of NETLISTS) {
  const plan = ruleBasedPlan(nl)
  const constraints = extractConstraints(nl)
  const ctx = buildEvalContext(nl, plan, constraints)
  const jitterRng = mulberry32(20260909) // graine publiée : régénération déterministe
  const noiseRng = mulberry32(4242)

  // Carte A : layout de référence = solution optimisée du studio ; cartes
  // B..F : révisions décalées de la même carte (jitter ±J mm + rotations) —
  // le domaine de calage couvre la variabilité manufacturière réaliste.
  const optimized = optimizePlacement(nl, plan, constraints, { iterations: 3000 })
  const boardLayouts = JITTERS_MM.map((j, b) => {
    if (j === 0) return optimized.placements
    return optimized.placements.map((p) => ({
      ...p,
      x: Math.min(nl.board.w - 1, Math.max(1, p.x + (jitterRng() - 0.5) * 2 * j)),
      y: Math.min(nl.board.h - 1, Math.max(1, p.y + (jitterRng() - 0.5) * 2 * j)),
      rot: (b >= 2 && jitterRng() < 0.35
        ? [90, 180, 270][Math.floor(jitterRng() * 3)]
        : p.rot) as 0 | 90 | 180 | 270,
    }))
  })

  const reading = (label: string, ambientC: number, placements: PlacedComponent[]) => {
    const perRef = sensitiveDeltaTs(ctx, nl, placements)
    return {
      label,
      ambientC,
      placements,
      measurements: perRef.map((m) => ({
        ref: m.ref,
        deltaT: Math.round((m.deltaT + (noiseRng() - 0.5) * 2 * NOISE_HALF_C) * 10) / 10,
      })),
      source: SOURCE,
    }
  }

  const boards = boardLayouts.flatMap((pl, b) =>
    AMBIENTS.map((a, i) =>
      reading(
        `DÉMO ${nl.id} — carte ${String.fromCharCode(65 + b)} (jitter ${JITTERS_MM[b]} mm), config ${i + 1} @ ${a} °C`,
        a + b * 0.7,
        pl,
      ),
    ),
  )

  const out = {
    _doc: [
      'JEU DE DÉMONSTRATION [Sprint 1 M1] — PAS des relevés réels.',
      'Vérité terrain : solveur FDM du studio + bruit de capteur simulé ±0,4 °C,',
      'structure fidèle au protocole M1 : 6 cartes à layout fixe (jitter',
      'manufacturier 0 → 10 mm autour du layout optimisé) × 3 ambiances,',
      'graines publiées (20260909 / 4242) → régénération déterministe. Démontre',
      'la chaîne complète de calage (format ↔ validation sanitaire ↔ CLI ↔',
      'coefficients versionnés ↔ UI) en attendant la campagne de mesures réelles',
      'M1 sur cartes instrumentées (docs/protocole-acquisition-cartes-mesurees.md).',
      'Format identique au gabarit scripts/measured-boards.example.json.',
    ],
    project: nl.id,
    boards,
  }
  const path = `scripts/measured-boards.demo-${nl.id}.json`
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n')
  console.log(`✔ ${path} — ${boards.length} relevés synthétiques, ${JITTERS_MM.length} cartes × ${AMBIENTS.length} ambiances (${nl.id})`)
}
