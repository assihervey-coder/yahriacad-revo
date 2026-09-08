/**
 * NEXUS PCB — API de l'Agent LLM
 * Équivalent : services/ai_engine/llm_agent/ (microservice backend)
 *
 * Le LLM reçoit le contexte compact de conception (netlist + contraintes
 * extraites) et produit un PLAN STRATÉGIQUE de placement : zone par
 * composant + justification. Ce plan alimente l'attraction de zones du
 * World Model → le LLM est réellement dans la boucle d'optimisation.
 *
 * Robustesse : validation stricte de la réponse JSON + repli côté client.
 */
import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

interface ZoneRaw { ref?: string; zone?: string; rationale?: string }
interface PlanRequest {
  project?: { id?: string; name?: string; boardW?: number; boardH?: number }
  components?: { ref?: string; value?: string; category?: string; parent?: string; power?: number; note?: string }[]
  nets?: { name?: string; cls?: string; pinCount?: number }[]
  constraints?: { kind?: string; refs?: string[]; nets?: string[]; value?: number; rationale?: string }[]
}

const VALID_ZONES = new Set([
  'center', 'north', 'south', 'east', 'west',
  'northeast', 'northwest', 'southeast', 'southwest',
])

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as PlanRequest
    const comps = (body.components ?? []).filter((c) => c.ref && c.value)
    if (comps.length === 0) {
      return NextResponse.json({ error: 'Netlist vide' }, { status: 400 })
    }
    const project = body.project ?? {}
    const nets = (body.nets ?? []).slice(0, 60)
    const constraints = (body.constraints ?? []).slice(0, 30)

    const systemPrompt = `Tu es l'agent de planification stratégique de NEXUS PCB, un système expert en conception de circuits imprimés. Ton rôle : décider de la ZONE de placement de chaque composant sur une carte rectangulaire, en raisonnant comme un ingénieur hardware senior.

Zones disponibles (grille 3×3 de la carte) : center, north, south, east, west, northeast, northwest, southeast, southwest.

Règles d'or :
- MCU au CENTRE (bus les plus courts)
- Connecteurs en bord (south de préférence) — mais ils sont déjà fixés, donne quand même une zone cohérente
- Antenne/RF dans un COIN (northeast par défaut) : rayonnement dégagé
- Quartz près du MCU (center)
- Alimentation (LDO, chargeur, boost) en bord opposé aux signaux sensibles (southwest)
- Capteurs analogiques loin du bruit (northwest ou west)
- LED/témoins en bord (southeast)
- Condensateurs de découplage : même zone que leur composant parent
- Mémoire/interface : côté est si le MCU est au centre

Réponds UNIQUEMENT avec un JSON valide, sans texte autour, au format :
{"zones":[{"ref":"U1","zone":"center","rationale":"…"}],"strategy":"…","notes":["…"]}`

    const context = `PROJET : ${project.name ?? 'carte'} — carte ${project.boardW ?? 60}×${project.boardH ?? 45} mm, 2 couches.

COMPOSANTS (${comps.length}) :
${comps.map((c) => `- ${c.ref} : ${c.value} [${c.category}]${c.parent ? ` parent=${c.parent}` : ''}${c.power > 0.2 ? ` ⚠ dissipation ${(c.power * 1000).toFixed(0)}mW` : ''}${c.note ? ` — ${c.note}` : ''}`).join('\n')}

NETS CRITIQUES :
${nets.filter((n) => n.cls && !['signal', 'ground'].includes(n.cls)).map((n) => `- ${n.name} [${n.cls}] (${n.pinCount} broches)`).join('\n')}

CONTRAINTES EXTRAITES :
${constraints.map((c) => `- [${c.kind}${c.value !== undefined ? ` ${c.value}` : ''}] ${c.rationale}`).join('\n')}`

    const zai = await ZAI.create()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: systemPrompt },
        { role: 'user', content: context },
      ],
      thinking: { type: 'disabled' },
    })
    const raw = completion.choices[0]?.message?.content ?? ''

    // Extraction robuste du JSON (le modèle peut ajouter du texte)
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1) throw new Error('Pas de JSON dans la réponse')
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { zones?: ZoneRaw[]; strategy?: string; notes?: string[] }

    const validRefs = new Set(comps.map((c) => c.ref!))
    const zones = (parsed.zones ?? [])
      .filter((z): z is { ref: string; zone: string; rationale?: string } =>
        typeof z.ref === 'string' && typeof z.zone === 'string' &&
        validRefs.has(z.ref) && VALID_ZONES.has(z.zone))
      .map((z) => ({ ref: z.ref, zone: z.zone, rationale: z.rationale ?? '' }))

    if (zones.length === 0) throw new Error('Zones vides ou invalides')

    return NextResponse.json({
      plan: {
        zones,
        strategy: parsed.strategy ?? 'Plan stratégique généré par l’agent LLM.',
        notes: (parsed.notes ?? []).slice(0, 5).map(String),
        source: 'llm',
      },
      model: 'glm-agent',
      usage: { components: comps.length, zones: zones.length },
    })
  } catch (e) {
    // Le client dispose d'un repli par règles : on signale juste l'échec
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Erreur agent LLM' },
      { status: 502 },
    )
  }
}
