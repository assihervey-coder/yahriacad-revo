/**
 * NEXUS PCB — Agent LLM (côté client)
 * Équivalent : services/ai_engine/llm_agent/intent_parser/ + prompt_engineering/
 *
 * 1. Construit le contexte compact (netlist + contraintes) pour le LLM
 * 2. Appelle l'API /api/agent/plan (backend z-ai-web-dev-sdk)
 * 3. Repli déterministe : planificateur par règles si le LLM est indisponible
 */
import type { AgentPlan, Constraint, Netlist, ZoneHint, ZoneName } from './types'

const ZONES: ZoneName[] = [
  'center', 'north', 'south', 'east', 'west',
  'northeast', 'northwest', 'southeast', 'southwest',
]

/** Repli : planification par règles expertes (déterministe, instantanée) */
export function ruleBasedPlan(nl: Netlist): AgentPlan {
  const zones: ZoneHint[] = []
  const hasRf = nl.components.some((c) => c.category === 'rf')
  for (const c of nl.components) {
    let zone: ZoneName = 'center'
    let rationale = ''
    if (c.category === 'mcu') { zone = 'center'; rationale = 'MCU au centre : minimise la longueur totale des bus' }
    else if (c.category === 'rf') { zone = 'northeast'; rationale = 'Antenne en coin : rayonnement dégagé, keepout respecté' }
    else if (c.category === 'crystal') { zone = 'center'; rationale = 'Quartz adjacent au MCU : boucle de masse minimale' }
    else if (c.category === 'sensor') { zone = 'northwest'; rationale = 'Capteur en bord ouest : loin du bruit numérique' }
    else if (c.category === 'memory' || c.category === 'interface') {
      if (hasRf && c.category === 'memory') {
        zone = 'west'
        rationale = 'Mémoire à l’ouest : le quadrant est est réservé à la chaîne RF'
      } else {
        zone = 'east'
        rationale = 'Interface/mémoire côté est : bus courts vers le MCU'
      }
    }
    else if (c.category === 'power') { zone = 'southwest'; rationale = 'Alimentation sud-ouest : loin des signaux sensibles, dissipation en bord' }
    else if (c.category === 'led') { zone = 'southeast'; rationale = 'Témoins LED en bord sud-est : visibilité' }
    else if (c.parent) {
      const p = zones.find((z) => z.ref === c.parent)
      zone = p?.zone ?? 'center'
      rationale = `Découplage/élément passif de ${c.parent} : adjacency forcée`
    }
    zones.push({ ref: c.ref, zone, rationale })
  }
  return {
    zones,
    strategy: 'Placement par règles expertes : MCU centré, bus courts vers l’est, alimentation isolée au sud-ouest, RF au coin nord-est avec keepout.',
    notes: ['Repli déterministe — LLM indisponible'],
    source: 'rules',
  }
}

/* ---------------------------- Appel backend ---------------------------- */

export interface PlanApiPayload {
  project: { id: string; name: string; boardW: number; boardH: number }
  components: { ref: string; value: string; category: string; parent?: string; power: number; note?: string }[]
  nets: { name: string; cls: string; pinCount: number }[]
  constraints: { kind: string; refs: string[]; nets: string[]; value?: number; rationale: string }[]
}

export function buildPlanPayload(nl: Netlist, constraints: Constraint[]): PlanApiPayload {
  return {
    project: { id: nl.id, name: nl.name, boardW: nl.board.w, boardH: nl.board.h },
    components: nl.components.map((c) => ({
      ref: c.ref, value: c.value, category: c.category,
      parent: c.parent, power: c.power, note: c.note,
    })),
    nets: nl.nets.map((n) => ({ name: n.name, cls: n.cls, pinCount: n.pins.length })),
    constraints: constraints.map((c) => ({
      kind: c.kind, refs: c.refs, nets: c.nets, value: c.value, rationale: c.rationale,
    })),
  }
}

/** Appelle l'agent LLM backend, avec repli local en cas d'erreur/timeout */
export async function requestPlan(
  nl: Netlist, constraints: Constraint[],
  onLog?: (msg: string) => void,
): Promise<AgentPlan> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    onLog?.('Transmission du contexte de conception à l’agent LLM…')
    const res = await fetch('/api/agent/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPlanPayload(nl, constraints)),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { plan?: { zones?: unknown; strategy?: string; notes?: string[] } }
    if (!data.plan?.zones) throw new Error('Réponse sans plan')
    // Validation stricte des zones retournées
    const validRefs = new Set(nl.components.map((c) => c.ref))
    const zones: ZoneHint[] = (data.plan.zones as { ref: string; zone: string; rationale?: string }[])
      .filter((z) => validRefs.has(z.ref) && ZONES.includes(z.zone as ZoneName))
      .map((z) => ({ ref: z.ref, zone: z.zone as ZoneName, rationale: z.rationale ?? 'Zone suggérée par le LLM' }))
    if (zones.length === 0) throw new Error('Zones invalides')
    // Compléter les composants absents de la réponse
    for (const c of nl.components) {
      if (!zones.some((z) => z.ref === c.ref)) zones.push({ ref: c.ref, zone: 'center', rationale: 'Non traité par le LLM — zone neutre' })
    }
    return {
      zones,
      strategy: data.plan.strategy ?? 'Plan fourni par l’agent LLM.',
      notes: data.plan.notes ?? [],
      source: 'llm',
    }
  } catch (e) {
    onLog?.(`Agent LLM indisponible (${e instanceof Error ? e.message : 'erreur'}) — repli sur le planificateur par règles`)
    return ruleBasedPlan(nl)
  } finally {
    clearTimeout(timer)
  }
}
