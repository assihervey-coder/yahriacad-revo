/**
 * NEXUS PCB — Export SPICE + parasitique des pistes [audit P2.4]
 * Équivalent : services/exporter/spice_correlation/
 *
 * Corrélation circuit : le deck .cir exporté relie le NETLIST au simulateur :
 *   1. chaque composant → une instance X branchée sur ses nets (nœuds SPICE
 *      = noms de nets) + un .SUBCKT comportemental à remplacer par la
 *      bibliothèque du projet ;
 *   2. chaque segment de piste → sa résistance série (cuivre 35 µm) et sa
 *      capacité shunt (FR4 1,6 mm) — le parasitique RÉEL du routage devient
 *      simulable dans ngspice/LTspice : c'est la corrélation demande.
 *
 * Formules : R = ρ·L/(w·t), ρ_cu = 1,72e-8 Ω·m, t = 35 µm
 *            C = εr·ε0·w·L/h, εr_FR4 = 4,3, h = 1,6 mm
 */
import type { GerberFile, Netlist, RoutingSolution } from './types'

const CU_RHO = 1.72e-8 // Ω·m
const CU_T = 35e-6 // m (1 oz)
const ER_FR4 = 4.3
const EPS0 = 8.854e-12 // F/m
const H_FR4 = 1.6e-3 // m

export interface SpiceStats {
  nets: number
  segments: number
  instances: number
  /** Somme des R série (Ω) et C shunt (F) de tout le routage */
  rTotalOhm: number
  cTotalF: number
}

const spiceName = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_')

const polyLen = (pts: { x: number; y: number }[]) => {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return l // mm
}

export function generateSpiceDeck(
  nl: Netlist,
  routing: RoutingSolution,
): { file: GerberFile; stats: SpiceStats } {
  const lines: string[] = [
    '* NEXUS PCB — deck SPICE avec parasitique de routage [P2.4]',
    `* Généré le ${new Date().toISOString()}`,
    '* Corrélation circuit : nœuds = noms de nets ; chaque segment de piste',
    '* devient R série (cuivre 35 µm) + C shunt (FR4 1,6 mm) — réalisme PCB.',
    '* Usage : ngspice NEXUS.spice.cir — remplacer les .SUBCKT par les modèles',
    '* comportementaux du projet pour corréler post-layout vs simulation.',
    '*',
  ]

  // ---------- Composants : .SUBCKT + instances X ----------
  lines.push('* ---- Composants (modèles comportementaux à brancher) ----')
  for (const c of nl.components) {
    const pins = c.footprint.pads.map((p) => p.pin)
    lines.push(`.SUBCKT ${spiceName(c.ref)} ${pins.map((p) => `p_${spiceName(p)}`).join(' ')}`)
    lines.push(`* ${c.value} (${c.footprint.name}, ${c.power} W) — modèle à fournir`)
    lines.push('.ENDS')
  }
  const pinsByNet = new Map<string, { ref: string; pin: string }[]>()
  for (const c of nl.components) {
    for (const pd of c.footprint.pads) {
      const net = c.pins[pd.pin]
      if (!net) continue
      const arr = pinsByNet.get(net) ?? []
      arr.push({ ref: c.ref, pin: pd.pin })
      pinsByNet.set(net, arr)
    }
  }
  for (const c of nl.components) {
    const nodes = c.footprint.pads.map((pd) => {
      const net = c.pins[pd.pin]
      return net ? spiceName(net) : `nc_${spiceName(c.ref)}_${spiceName(pd.pin)}`
    })
    lines.push(`X${spiceName(c.ref)} ${nodes.join(' ')} ${spiceName(c.ref)}`)
  }

  // ---------- Parasitique : R série + C shunt par segment de piste ----------
  lines.push('*')
  lines.push('* ---- Parasitique de routage (R série cuivre + C shunt FR4) ----')
  let segIdx = 0
  let rTotal = 0
  let cTotal = 0
  for (const r of routing.routes) {
    const net = spiceName(r.net)
    // ancre : premier pad connu du net, sinon nœud dédicé
    const anchor = pinsByNet.get(r.net)?.[0]
    let prevNode = anchor ? `${spiceName(anchor.ref)}_p_${spiceName(anchor.pin)}` : `n_${net}_0`
    if (!anchor) lines.push(`* net ${r.net} sans pad ancre — chaîne autonome`)
    for (const seg of r.segments) {
      const lMm = polyLen(seg.pts)
      if (lMm <= 0) continue
      const lM = lMm * 1e-3
      const wM = seg.width * 1e-3
      const rOhm = (CU_RHO * lM) / (wM * CU_T)
      const cF = (ER_FR4 * EPS0 * wM * lM) / H_FR4
      rTotal += rOhm
      cTotal += cF
      const nextNode = `n_${net}_${segIdx + 1}`
      lines.push(`R_${net}_${segIdx} ${prevNode} ${nextNode} ${(rOhm * 1e3).toFixed(4)}m ; ${lMm.toFixed(2)} mm w=${seg.width} L${seg.layer}`)
      lines.push(`C_${net}_${segIdx} ${prevNode} 0 ${((cF) * 1e15).toFixed(4)}f`)
      prevNode = nextNode
      segIdx++
    }
    if (segIdx > 0) lines.push(`* fin net ${r.net}`)
  }

  const stats: SpiceStats = {
    nets: routing.routes.length,
    segments: segIdx,
    instances: nl.components.length,
    rTotalOhm: rTotal,
    cTotalF: cTotal,
  }
  lines.push('*')
  lines.push(`* Bilan parasitique : ${segIdx} segments, ΣR = ${(rTotal * 1e3).toFixed(2)} mΩ, ΣC = ${(cTotal * 1e15).toFixed(2)} pF`)
  lines.push('.END')
  lines.push('')

  return {
    file: {
      name: 'NEXUS.spice.cir',
      role: 'Deck SPICE — composants + parasitique R/C du routage (corrélation circuit)',
      content: lines.join('\n'),
    },
    stats,
  }
}
