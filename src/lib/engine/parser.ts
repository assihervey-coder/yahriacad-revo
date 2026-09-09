/**
 * NEXUS PCB — Service Parser
 * Équivalent : services/parser/ + netlist_parser/ + constraint_extractor/
 *
 * 1. Validation du netlist (intégrité référentielle, nets flottants)
 * 2. Extraction des contraintes implicites : détection des interfaces
 *    (USB, bus parallèle, quartz, RF, rails de puissance, découplage...)
 */
import type { Constraint, Netlist, NetClass } from './types'

export interface ParseReport {
  ok: boolean
  errors: string[]
  warnings: string[]
  stats: {
    components: number
    nets: number
    pins: number
    connectedPins: number
    boardMm: string
    netClasses: Record<NetClass, number>
  }
}

/** Validation complète du netlist avant toute conception */
export function parseNetlist(nl: Netlist): ParseReport {
  const errors: string[] = []
  const warnings: string[] = []
  const comps = new Map(nl.components.map((c) => [c.ref, c]))
  let pins = 0
  let connectedPins = 0
  const netClasses: Partial<Record<NetClass, number>> = {}

  for (const net of nl.nets) {
    netClasses[net.cls] = (netClasses[net.cls] ?? 0) + 1
    if (net.pins.length < 2 && net.cls !== 'rf') {
      warnings.push(`Net « ${net.name} » ne connecte qu'une seule broche (flottant)`)
    }
    for (const { ref, pin } of net.pins) {
      pins++
      const c = comps.get(ref)
      if (!c) {
        errors.push(`Net « ${net.name} » référence un composant inconnu : ${ref}`)
        continue
      }
      if (!(pin in c.pins)) {
        errors.push(`Net « ${net.name} » : broche ${ref}.${pin} inexistante sur l'empreinte ${c.footprint.name}`)
        continue
      }
      connectedPins++
    }
  }

  // Broches déclarées mais non connectées (informatif)
  for (const c of nl.components) {
    for (const p of c.footprint.pads) {
      if (!(p.pin in c.pins) && !c.pins[p.pin]) {
        // broche sans mapping → pas d'erreur bloquante, avertissement discret
      }
    }
  }

  const dupRefs = nl.components.map((c) => c.ref)
  const seen = new Set<string>()
  for (const r of dupRefs) {
    if (seen.has(r)) errors.push(`Référence dupliquée : ${r}`)
    seen.add(r)
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      components: nl.components.length,
      nets: nl.nets.length,
      pins,
      connectedPins,
      boardMm: `${nl.board.w}×${nl.board.h} mm / ${nl.board.layers} couches`,
      netClasses: netClasses as Record<NetClass, number>,
    },
  }
}

/* =====================================================================
 *  Extracteur de contraintes — « lit entre les lignes » de la netlist
 * ===================================================================== */

const CRIT = (s: string, ...keys: string[]) => keys.some((k) => s.toUpperCase().includes(k))

export function extractConstraints(nl: Netlist): Constraint[] {
  const out: Constraint[] = []
  const push = (c: Omit<Constraint, 'id'>) => out.push({ id: `C${out.length + 1}`, ...c })

  /* 1. Paires différentielles (USB...) */
  const diffNets = nl.nets.filter((n) => n.cls === 'diffpair')
  const dpGroups: Record<string, string[]> = {}
  for (const n of diffNets) {
    // suffixes DP/DM d'abord (sinon [Pp]\+? avale le P final de « _DP »),
    // puis P+/N- (LVDS) — « USB_DP » et « USB_DM » partagent bien la base « USB »
    const base = n.name.replace(/_?[Dd][Pp]$|_?[Dd][Mm]$|[Pp]\+?$|[Nn]-?$/, '').replace(/_$/, '') || n.name
    ;(dpGroups[base] ??= []).push(n.name)
  }
  for (const [base, nets] of Object.entries(dpGroups)) {
    if (nets.length >= 2) {
      push({
        kind: 'differential', refs: [], nets,
        value: 90, severity: 'hard',
        rationale: `Paire différentielle ${base} : routage côte à côte, impédance 90 Ω, skew ≤ 0,15 mm`,
      })
    }
  }

  /* 2. Bus parallèle haute vitesse (ULPI, SDRAM, QSPI...) : appariement de longueur */
  const hsNets = nl.nets.filter((n) => n.cls === 'highspeed')
  const busPrefixes = new Map<string, string[]>()
  for (const n of hsNets) {
    const m = n.name.match(/^([A-Z]+_[A-Z]+?)_\d+$/)
    const key = m ? m[1] : null
    if (key) (busPrefixes[key] ??= []).push(n.name)
  }
  for (const [bus, nets] of Object.entries(busPrefixes)) {
    if (nets.length >= 4) {
      push({
        kind: 'length_match', refs: [], nets,
        value: 2.0, severity: 'hard',
        rationale: `Bus ${bus} (${nets.length} lignes) : appariement de longueur ±${(2.0).toFixed(1)} mm`,
      })
    }
  }

  /* 3. Réseau RF : keepout strict autour de l'antenne + impédance 50 Ω */
  const rfNets = nl.nets.filter((n) => n.cls === 'rf')
  if (rfNets.length > 0) {
    const rfComps = nl.components.filter((c) => c.category === 'rf').map((c) => c.ref)
    push({
      kind: 'keepout', refs: rfComps, nets: rfNets.map((n) => n.name),
      value: 5.0, severity: 'hard',
      rationale: `Antenne ${rfComps.join('/')}: zone d'exclusion ${(5.0).toFixed(1)} mm — aucun composant ni cuivre étranger`,
    })
    push({
      kind: 'impedance', refs: [], nets: rfNets.map((n) => n.name),
      value: 50, severity: 'hard',
      rationale: 'Ligne RF : impédance contrôlée 50 Ω, longueur la plus courte possible',
    })
  }

  /* 4. Découplage : condensateurs affectés à un parent → adjacence obligatoire */
  for (const c of nl.components) {
    if (c.parent && (c.value.startsWith('100n') || c.value.startsWith('10u') || c.value.startsWith('18p') || c.value.startsWith('1p') || c.value.startsWith('4.7n') || c.value.startsWith('1.5p'))) {
      push({
        kind: 'adjacency', refs: [c.ref, c.parent], nets: [],
        value: 2.5, severity: 'hard',
        rationale: `Découplage ${c.ref} → ${c.parent} : placement adjacent (≤ ${2.5} mm de ${c.parent})`,
      })
    }
  }

  /* 5. Connecteurs : fixés au bord de la carte */
  for (const c of nl.components) {
    if (c.category === 'connector') {
      push({
        kind: 'edge', refs: [c.ref], nets: [],
        severity: 'hard',
        rationale: `Connecteur ${c.ref} (${c.value}) : fixé au bord de la carte`,
      })
    }
  }

  /* 6. Thermique : composants dissipant > 300 mW */
  for (const c of nl.components) {
    if (c.power >= 0.3) {
      push({
        kind: 'thermal', refs: [c.ref], nets: [],
        value: c.power, severity: 'soft',
        rationale: `${c.ref} (${c.value}) dissipe ${(c.power * 1000).toFixed(0)} mW : espacer des composants sensibles, zone libre`,
      })
    }
  }

  /* 7. Quartz : trajet le plus court vers le MCU */
  const crystals = nl.components.filter((c) => c.category === 'crystal')
  const mcus = nl.components.filter((c) => c.category === 'mcu')
  if (crystals.length > 0 && mcus.length > 0) {
    push({
      kind: 'adjacency', refs: [...crystals.map((c) => c.ref), mcus[0].ref], nets: [],
      value: 4.0, severity: 'hard',
      rationale: `Quartz ${crystals.map((c) => c.ref).join('+')} : à ≤ 4 mm du MCU, boucle de masse réduite`,
    })
  }

  /* 8. Rails de puissance : largeur majorée (chute de tension) */
  const powerNets = nl.nets.filter((n) => n.cls === 'power' && n.pins.length >= 3)
  if (powerNets.length > 0) {
    push({
      kind: 'spacing_class', refs: [], nets: powerNets.map((n) => n.name),
      value: 0.6, severity: 'hard',
      rationale: `Rails ${powerNets.map((n) => n.name).join(', ')} : pistes élargies 0,6 mm (courant élevé)`,
    })
  }

  /* 9. Analogique sensible : éloigner des horloges */
  const analogNets = nl.nets.filter((n) => n.cls === 'analog')
  if (analogNets.length > 0) {
    push({
      kind: 'thermal', refs: [], nets: analogNets.map((n) => n.name),
      severity: 'soft',
      rationale: `Nets analogiques (${analogNets.map((n) => n.name).join(', ')}) : éloigner des sources de bruit (quartz, bus)`,
    })
  }

  return out
}
