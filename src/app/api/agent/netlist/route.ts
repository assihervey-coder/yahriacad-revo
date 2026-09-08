/**
 * NEXUS PCB — Génération de netlist par langage naturel [Circuitron nl_to_skidl]
 * Équivalent : backend/services/parser/nl_to_skidl/ + researcher_agent/ + selector_agent/
 *
 * L'utilisateur décrit sa carte (« une carte drone avec STM32, LoRa et GPS »),
 * le LLM produit la DESCRIPTION des composants + connectivité, et le serveur
 * la transforme en netlist STRICTEMENT valide (empreintes réelles de la
 * bibliothèque, broches vérifiées, classes de nets déduites).
 * C'est l'équivalent fonctionnel d'un script SKiDL généré en langage naturel.
 */
import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import type { Component, ComponentCategory, Footprint, Net, Netlist, NetClass } from '@/lib/engine/types'
import {
  bga, chip2Pins, comp, crystal, header1x, led0603, mcuQfn48,
  qfn, rfModule, sot223, sot23, sot23_6, soic8, soic16, usbMicro,
} from '@/lib/engine/footprints'

/** Catalogue d'empreintes réelles de la bibliothèque (le LLM ne peut RIEN inventer) */
const FOOTPRINT_CATALOG: { key: string; make: () => Footprint; desc: string }[] = [
  { key: 'MCU_QFN48', make: () => mcuQfn48(7, 0.5, 'MCU_QFN48'), desc: 'MCU 48 broches sémantiques : PA0-PA15, PB0-PB15, BOOT0, NRST, VDD1, VDD2, VSS1, VSS2, VSS_EP, OSC_IN, OSC_OUT, PC0-PC7' },
  { key: 'QFN32', make: () => qfn(5, 8, 0.5, 'QFN32'), desc: 'QFN 32 broches numérotées 1-28 + EP (PHY, transceivers)' },
  { key: 'QFN16', make: () => qfn(3, 4, 0.65, 'QFN16'), desc: 'QFN 16 broches numérotées 1-12 + EP (capteurs, petits IC)' },
  { key: 'SOIC-8', make: () => soic8(), desc: 'SOIC 8 broches 1-8 (capteurs I2C/SPI, chargeurs, EEPROM)' },
  { key: 'SOIC-16', make: () => soic16(), desc: 'SOIC 16 broches 1-16 (drivers, logique)' },
  { key: 'SOT-223', make: () => sot223(), desc: 'Régulateur LDO : broches 1,2,3 + tab 4' },
  { key: 'SOT-23', make: () => sot23(), desc: 'Transistor/petit IC : broches 1,2,3' },
  { key: 'SOT-23-6', make: () => sot23_6(), desc: 'Conv DC-DC : broches 1-6' },
  { key: 'BGA16', make: () => bga(4, 4, 0.8, 'BGA16'), desc: 'BGA 4×4 : broches A1-D4' },
  { key: 'HDR_2', make: () => header1x(2), desc: 'Header 2 broches 1-2 (batterie, fan)' },
  { key: 'HDR_4', make: () => header1x(4), desc: 'Header 4 broches 1-4 (SWD, UART)' },
  { key: 'HDR_6', make: () => header1x(6), desc: 'Header 6 broches 1-6 (I2C/debug)' },
  { key: 'HDR_12', make: () => header1x(12), desc: 'Header 12 broches 1-12 (GPIO extension)' },
  { key: 'USB_MICROB', make: () => usbMicro(), desc: 'USB : VBUS, D+, D-, ID, GND, SH1, SH2' },
  { key: 'RF_MODULE', make: () => rfModule(18, 25.5,
      ['3V3', 'EN', 'IO36', 'IO39', 'IO34', 'IO35', 'IO32', 'IO33', 'IO25', 'IO26', 'IO27'],
      ['IO14', 'IO12', 'IO13', 'IO15', 'IO2', 'IO0', 'IO4', 'IO5', 'IO18', 'IO19', 'IO21'],
      ['GND1', 'GND2']), desc: 'Module radio ESP32-like : 3V3, EN, IO0-IO5, IO12-IO15, IO18, IO19, IO21, IO25-IO27, IO32-IO36, IO39, GND1, GND2 — keepout antenne auto' },
  { key: 'LORA_MODULE', make: () => rfModule(16, 17,
      ['3V3', 'GND1', 'MOSI', 'MISO', 'SCK', 'NSS', 'RST'], ['DIO0', 'DIO1', 'ANT', 'GND2'], []),
    desc: 'Module LoRa SX1276-like : 3V3, GND1, MOSI, MISO, SCK, NSS, RST, DIO0, DIO1, ANT, GND2' },
  { key: 'C_0402', make: () => chip2Pins('C_0402', 1.0, 0.5), desc: 'Condensateur 0402 : broches 1,2' },
  { key: 'C_0805', make: () => chip2Pins('C_0805', 2.0, 1.25), desc: 'Condensateur bulk 0805 : broches 1,2' },
  { key: 'R_0402', make: () => chip2Pins('R_0402', 1.0, 0.5), desc: 'Résistance 0402 : broches 1,2' },
  { key: 'LED_0603', make: () => led0603(), desc: 'LED 0603 : broches 1 (cathode), 2 (anode)' },
  { key: 'XTAL_3225', make: () => crystal(3.2, 2.5, 'XTAL_3225'), desc: 'Quartz 3225 : broches 1,2' },
  { key: 'ANT_50R', make: () => chip2Pins('ANT_50R', 6, 2), desc: 'Antenne PCB 50Ω : broches 1 (feed), 2 (NC)' },
]
const FP_MAP = new Map(FOOTPRINT_CATALOG.map((f) => [f.key, f]))

const VALID_CATEGORIES = new Set<ComponentCategory>([
  'mcu', 'memory', 'power', 'connector', 'passive', 'crystal', 'rf', 'sensor', 'led', 'interface',
])

function classifyNet(name: string): NetClass {
  const u = name.toUpperCase()
  if (u === 'GND' || u.startsWith('GND') || u.startsWith('AGND') || u.startsWith('PGND')) return 'ground'
  if (u.startsWith('VDD') || u.startsWith('VCC') || u.startsWith('VBAT') ||
      u.startsWith('VIN') || u.startsWith('VOUT') || u.startsWith('VBUS') ||
      u.startsWith('+5V') || u.startsWith('+3V') || u.startsWith('SW_')) return 'power'
  if (u === 'USB_DP' || u === 'USB_DM' || u.startsWith('USB_DP') || u.startsWith('USB_DM')) return 'diffpair'
  if (u.includes('RF') || u.startsWith('ANT')) return 'rf'
  if (u.includes('XTAL') || u.includes('OSC') || u.includes('CLK') || u.startsWith('SPI') || u.startsWith('ULPI') || u.startsWith('SD_')) return 'highspeed'
  if (u.endsWith('_SENSE') || u.startsWith('ADC')) return 'analog'
  return 'signal'
}

interface RawComponent {
  ref?: string
  value?: string
  category?: string
  footprint?: string
  power?: number
  parent?: string | null
  note?: string
  pins?: Record<string, string>
}

function buildNetlist(raw: { name?: string; description?: string; board?: { w?: number; h?: number }; components?: RawComponent[] }): { netlist?: Netlist; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const W = Math.min(100, Math.max(30, Math.round(raw.board?.w ?? 50)))
  const H = Math.min(100, Math.max(25, Math.round(raw.board?.h ?? 40)))

  const rawComps = (raw.components ?? []).filter((c) => c.ref && c.footprint)
  if (rawComps.length < 4) errors.push('Moins de 4 composants valides — description trop vague')
  if (rawComps.length > 42) errors.push('Trop de composants (max 42) — simplifiez la description')

  const refs = new Set<string>()
  const components: Component[] = []
  for (const rc of rawComps) {
    const ref = String(rc.ref).trim()
    if (refs.has(ref)) { warnings.push(`Référence dupliquée ignorée : ${ref}`); continue }
    const fpEntry = FP_MAP.get(String(rc.footprint))
    if (!fpEntry) { warnings.push(`Empreinte inconnue « ${rc.footprint} » pour ${ref} — ignoré`); continue }
    refs.add(ref)
    const fp = fpEntry.make()
    const pinNames = new Set(fp.pads.map((p) => p.pin))
    const pins: Record<string, string> = {}
    for (const [pin, net] of Object.entries(rc.pins ?? {})) {
      if (!pinNames.has(pin)) continue // broche inconnue : ignorée
      const netName = String(net).trim().toUpperCase().replace(/[^A-Z0-9_+-]/g, '_')
      if (netName && netName !== 'NC') pins[pin] = netName
    }
    const category = VALID_CATEGORIES.has(rc.category as ComponentCategory) ? (rc.category as ComponentCategory) : 'passive'
    const power = Math.max(0, Math.min(3, Number(rc.power) || 0))
    const parent = rc.parent && refs.has(rc.parent) ? rc.parent : undefined
    components.push(comp(
      ref, String(rc.value ?? ref), category, fp, power, pins,
      { ...(parent ? { parent } : {}), ...(rc.note ? { note: rc.note } : {}) },
    ))
  }
  if (!components.some((c) => c.category === 'mcu' || c.category === 'rf')) {
    warnings.push('Aucun MCU ou module radio — carte sans intelligence centrale')
  }

  // Construction des nets depuis la connectivité (philosophie SKiDL)
  const netMap = new Map<string, { ref: string; pin: string }[]>()
  for (const c of components) {
    for (const [pin, net] of Object.entries(c.pins)) {
      if (!netMap.has(net)) netMap.set(net, [])
      netMap.get(net)!.push({ ref: c.ref, pin })
    }
  }
  const nets: Net[] = [...netMap.entries()]
    .filter(([, pins]) => pins.length >= 1)
    .map(([name, pins]) => ({ name, cls: classifyNet(name), pins }))
    .sort((a, b) => {
      const order: Record<string, number> = { ground: 0, power: 1, rf: 2, highspeed: 3, diffpair: 4, analog: 5, signal: 6 }
      return (order[a.cls] ?? 9) - (order[b.cls] ?? 9) || a.name.localeCompare(b.name)
    })

  if (nets.length < 4) errors.push('Connectivité insuffisante — précisez les liens entre composants')

  if (errors.length > 0) return { errors, warnings }

  return {
    netlist: {
      id: `custom-${Date.now().toString(36)}`,
      name: raw.name?.slice(0, 60) || 'Carte générée par IA',
      description: raw.description?.slice(0, 140) || 'Netlist générée en langage naturel [Circuitron nl_to_skidl]',
      board: { w: W, h: H, layers: 2 },
      components,
      nets,
    },
    errors: [],
    warnings,
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { prompt?: string }
    const prompt = (body.prompt ?? '').trim()
    if (prompt.length < 10) {
      return NextResponse.json({ error: 'Décrivez votre carte en quelques mots (10 caractères minimum).' }, { status: 400 })
    }

    const catalog = FOOTPRINT_CATALOG.map((f) => `- ${f.key} : ${f.desc}`).join('\n')
    const systemPrompt = `Tu es l'agent générateur de netlists de NEXUS PCB (rôle Circuitron nl_to_skidl). À partir d'une description en langage naturel, tu produis la LISTE DES COMPOSANTS avec leur connectivité broche-par-broche.

EMPREINTES DISPONIBLES (utilise UNIQUEMENT ces clés) :
${catalog}

RÈGLES D'OR D'INGÉNIERIE :
- 1 MCU ou module radio au minimum (MCU_QFN48 ou RF_MODULE/LORA_MODULE)
- Chaque broche ACTIVE du composant doit être mappée à un net ; les broches inutilisées sont omises
- Nets d'alimentation standards : GND, VDD_3V3, VDD_5V, VBAT
- Découplage : 100nF (C_0402, parent=<ref MCU>) + 10uF bulk (C_0805) par rail d'alim
- Quartz : XTAL_3225 + 2 condensateurs 18pF (C_0402) sur OSC_IN/OSC_OUT
- Connecteurs en bord (HDR_*, USB_MICROB) ; antenne ANT_50R si RF
- Régulation : SOT-223 LDO (power, 0.4-0.65W) entre VDD_5V et VDD_3V3
- Les résistances LED : R_0402 1k entre le GPIO et la LED
- Nommage des nets : MAJUSCULES_AVEC_UNDERSCORES, parlant (SDA, SCL, SPI_SCK, MOTOR_A...)
- Parent pour les passifs de découplage/filtrage : ref du composant principal
- power = dissipation estimée en W (MCU 0.1-0.8, LDO 0.3-0.7, autres ~0)

Réponds UNIQUEMENT avec un JSON valide, sans texte autour, au format :
{"name":"nom court de la carte","description":"1 phrase","board":{"w":50,"h":40},"components":[{"ref":"U1","value":"STM32F407","category":"mcu","footprint":"MCU_QFN48","power":0.4,"parent":null,"note":"...","pins":{"PA0":"NET_X","VDD1":"VDD_3V3","VSS1":"GND"}}]}`

    const zai = await ZAI.create()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: systemPrompt },
        { role: 'user', content: `Conçois la carte suivante : ${prompt}` },
      ],
      thinking: { type: 'disabled' },
    })
    const rawText = completion.choices[0]?.message?.content ?? ''

    const start = rawText.indexOf('{')
    const end = rawText.lastIndexOf('}')
    if (start === -1 || end === -1) {
      return NextResponse.json({ error: 'Le LLM n\u2019a pas produit de JSON exploitable — reformulez la demande.' }, { status: 502 })
    }
    let parsed: Parameters<typeof buildNetlist>[0]
    try {
      parsed = JSON.parse(rawText.slice(start, end + 1)) as Parameters<typeof buildNetlist>[0]
    } catch {
      return NextResponse.json({ error: 'JSON du LLM malformé — réessayez.' }, { status: 502 })
    }

    const { netlist, errors, warnings } = buildNetlist(parsed)
    if (!netlist) {
      return NextResponse.json({ error: `Netlist générée invalide : ${errors.join(' · ')}` }, { status: 422 })
    }
    return NextResponse.json({ netlist, warnings })
  } catch (e) {
    return NextResponse.json(
      { error: `Agent générateur indisponible : ${e instanceof Error ? e.message : 'erreur'}` },
      { status: 500 },
    )
  }
}
