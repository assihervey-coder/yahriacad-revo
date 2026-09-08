/**
 * NEXUS PCB — Firmware Bridge HW/SW (inspiration Flux.ai)
 * Équivalent : services/firmware_bridge/
 *   ├── pin_exporter    : exporte les assignations de broches réelles du PCB
 *   └── header_generator: génère les headers C (.h) et overlays Zephyr
 *
 * Une fois la carte conçue, le firmware a besoin de la VÉRITÉ TERRAIN :
 * quel signal est sur quelle broche de quel composant. Ce pont génère les
 * artefacts à partir de la netlist finale — plus jamais de mismatch HW/SW.
 */
import type { GerberFile, Netlist } from './types'

const safe = (s: string) => s.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()

function timestamp(): string {
  return new Date().toISOString()
}

/**
 * Génère le package firmware complet :
 *   - NEXUS_pinmap.h      : header C (Arduino / bare-metal / HAL)
 *   - NEXUS_pinmap.overlay: devicetree overlay Zephyr
 *   - NEXUS_pinmap.json   : carte de broches machine-lisible (CI / MCP)
 */
export function generateFirmwareBridge(nl: Netlist): { files: GerberFile[]; pinCount: number; nets: number } {
  const netCls = new Map(nl.nets.map((n) => [n.name, n.cls]))
  let pinCount = 0

  /* ---------- Header C ---------- */
  const h: string[] = []
  h.push('/* NEXUS PCB — Firmware Bridge [Flux.ai firmware_bridge/header_generator]')
  h.push(' * Généré automatiquement le ' + timestamp() + ' — NE PAS ÉDITER À LA MAIN')
  h.push(' * Projet : ' + nl.name + ' — ' + nl.description)
  h.push(' * Synchronise les broches réelles du PCB avec le code firmware. */')
  h.push('#pragma once')
  h.push('')
  for (const c of nl.components) {
    const entries = Object.entries(c.pins)
    if (entries.length === 0) continue
    h.push(`/* ---- ${c.ref} : ${c.value} (${c.category}) ---- */`)
    for (const [pin, net] of entries) {
      pinCount++
      const macro = `NEXUS_${safe(c.ref)}_${safe(pin)}`
      const val = /^[A-Za-z]/.test(pin) ? pin.replace(/[^A-Za-z0-9]/g, '') : pin
      const cls = netCls.get(net) ?? 'signal'
      h.push(`#define ${macro.padEnd(28)} ${val.padEnd(10)} /* net: ${net} [${cls}] */`)
    }
    h.push('')
  }
  h.push('/* ---- Constantes de nets (bus critiques) ---- */')
  for (const n of nl.nets.filter((x) => ['rf', 'diffpair', 'highspeed', 'power'].includes(x.cls))) {
    h.push(`#define NET_${safe(n.name).padEnd(24)} "${n.name}" /* ${n.cls}, ${n.pins.length} broches */`)
  }
  h.push('')
  h.push('/* Fin du fichier généré — firmware_bridge v1 */')

  /* ---------- Overlay Zephyr (devicetree) ---------- */
  const z: string[] = []
  z.push('/* NEXUS PCB — Zephyr devicetree overlay [firmware_bridge] */')
  z.push('/* Généré le ' + timestamp() + ' — brochage réel de la carte ' + nl.name + ' */')
  z.push('/ {')
  z.push('\tnexus_pinmap {')
  z.push('\t\tcompatible = "nexus,pinmap";')
  for (const c of nl.components) {
    for (const [pin, net] of Object.entries(c.pins)) {
      z.push(`\t\t${safe(c.ref)}_${safe(pin)}: ${safe(c.ref)}_${safe(pin)} {`)
      z.push(`\t\t\tref = "${c.ref}"; pin = "${pin}"; net = "${net}";`)
      z.push('\t\t};')
    }
  }
  z.push('\t};')
  z.push('};')

  /* ---------- JSON machine-lisible ---------- */
  const json = JSON.stringify(
    {
      generator: 'NEXUS PCB firmware_bridge v1',
      project: nl.id,
      generatedAt: timestamp(),
      pins: nl.components.flatMap((c) =>
        Object.entries(c.pins).map(([pin, net]) => ({
          ref: c.ref, value: c.value, pin, net, cls: netCls.get(net) ?? 'signal',
        }))),
    },
    null, 2,
  )

  const files: GerberFile[] = [
    { name: 'NEXUS_pinmap.h', role: 'Firmware — header C (HW/SW)', content: h.join('\n') },
    { name: 'NEXUS_pinmap.overlay', role: 'Firmware — overlay Zephyr', content: z.join('\n') },
    { name: 'NEXUS_pinmap.json', role: 'Firmware — pinmap JSON (CI)', content: json },
  ]
  return { files, pinCount, nets: nl.nets.length }
}
