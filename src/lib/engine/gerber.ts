/**
 * NEXUS PCB — Exporteur de fabrication
 * Équivalent : services/exporter/gerber_generator/ + odb_generator/ + bom_assembly/
 *
 * Génère de VRAIS fichiers exploitables par une usine :
 *   - F_Cu.gbr / B_Cu.gbr : cuivres Gerber X2 (RS-274X + attributs [P2.1], format 3.6, mm)
 *   - Edge_Cuts.gbr       : contour de carte (Profile,NP)
 *   - drill.drl           : perçage Excellon
 *   - BOM.csv / POS.csv   : nomenclature + pick & place
 *   + package ODB++ (.tgz) dans ./odb [P2.1]
 *
 * Attributs X2 émis : TF.GenerationSoftware / CreationDate / ProjectId /
 * FileFunction / Part + TO.N (net) par objet, TO.C (designator) par composant,
 * TO.V (via) — 100 % rétrocompatibles X1 (les lecteurs anciens les ignorent).
 */
import type { GerberFile, GerberPackage, Netlist, PlacedComponent, RoutingSolution } from './types'
import { padWorldPos, placedRect } from './world-model'

/** Échelle RS-274X : 3 entiers + 6 décimales → mm × 1e6 */
const S = 1e6
const fmt = (mm: number) => String(Math.round(mm * S))

/** Assainit un nom pour les attributs X2 (ASCII, pas de , ni *). */
const x2name = (s: string) => s.replace(/[^A-Za-z0-9_.\-+/!]/g, '_')

function gerberHeader(opts?: { fileFunction?: string; projectId?: string }): string {
  const lines = [
    'G04 NEXUS PCB — Design autonome par agents IA*',
    'G04 Généré le ' + new Date().toISOString() + '*',
    '%FSLAX36Y36*%',
    '%MOMM*%',
  ]
  // --- Attributs X2 globaux [P2.1] ---
  if (opts?.projectId) {
    lines.push('%TF.GenerationSoftware,NEXUS PCB,Studio,1.0*%')
    lines.push(`%TF.CreationDate,${new Date().toISOString()}*%`)
    lines.push(`%TF.ProjectId,${x2name(opts.projectId)}*%`)
    lines.push('%TF.Part,Single*%')
  }
  if (opts?.fileFunction) lines.push(`%TF.FileFunction,${opts.fileFunction}*%`)
  lines.push('%LPD*%')
  lines.push('G01*')
  lines.push('G75*')
  lines.push('')
  return lines.join('\n')
}

function gerberFooter(): string {
  return '\nM02*\n'
}

/** Trace une polyline orthogonale avec l'aperture courante */
function drawPolyline(pts: { x: number; y: number }[]): string[] {
  const out: string[] = []
  out.push(`X${fmt(pts[0].x)}Y${fmt(pts[0].y)}D02*`)
  for (let i = 1; i < pts.length; i++) out.push(`X${fmt(pts[i].x)}Y${fmt(pts[i].y)}D01*`)
  return out
}

export function generateGerber(
  nl: Netlist, placements: PlacedComponent[], routing: RoutingSolution,
): GerberPackage {
  const compByRef = new Map(nl.components.map((c) => [c.ref, c]))

  /* ---------- Registre d'apertures cuivre ---------- */
  const viaRingDiameter = 0.9 // diamètre d'anneau standard

  const traceWidths = new Set<number>()
  for (const r of routing.routes) for (const s of r.segments) traceWidths.add(Math.round(s.width * 100) / 100)
  const padShapes = new Map<string, { w: number; h: number; rot: number }>()
  let padCount = 0

  const copperApertures = new Map<string, { def: string; d: number }>() // clé → définition + D-code
  let nextD = 10
  const dOf = (key: string, def: string) => {
    if (!copperApertures.has(key)) copperApertures.set(key, { def, d: nextD++ })
    return copperApertures.get(key)!.d
  }
  for (const w of traceWidths) dOf(`C:${w}`, `C,${w}`)

  const viaCount = routing.routes.reduce((a, r) => a + r.vias.length, 0)
  const traceCount = routing.routes.reduce((a, r) => a + r.segments.length, 0)

  const copperLayer = (layer: number): string => {
    const pos = layer === 0 ? 'Top' : layer === (nl.board.layers >= 4 ? 3 : 1) ? 'Bot' : 'Inr'
    const lines: string[] = [gerberHeader({ projectId: nl.id, fileFunction: `Copper,L${layer + 1},${pos}` })]
    // Apertures (pistes + vias)
    for (const { def, d } of copperApertures.values()) {
      lines.push(`%ADD${d}${def}*%`)
    }
    // Pads (flashes rectangulaires avec rotation)
    const padD = new Map<string, number>()
    for (const p of placements) {
      const c = compByRef.get(p.ref)!
      for (const pd of c.footprint.pads) {
        const netName = c.pins[pd.pin]
        if (!netName) continue
        // le pad appartient à la couche : tous les pads sont top (side = top) dans cette version
        if (layer !== 0) continue
        const rot = ((p.rot % 180) + 180) % 180
        const key = `${Math.round(pd.w * 100) / 100}x${Math.round(pd.h * 100) / 100}r${rot}`
        if (!padShapes.has(key)) padShapes.set(key, { w: pd.w, h: pd.h, rot })
      }
    }
    for (const [key, sh] of padShapes) {
      const d = nextD++
      padD.set(key, d)
      lines.push(`%ADD${d}R,${sh.w}X${sh.h}X${sh.rot}*%`)
    }
    // Sélection + dessins des pistes — regroupées PAR NET pour porter
    // l'attribut X2 %TO.N sur chaque objet de net (%TD referme).
    lines.push('G04 pistes*')
    for (const r of routing.routes) {
      if (!r.segments.some((s) => s.layer === layer)) continue
      lines.push(`%TO.N,${x2name(r.net)}*%`)
      let cur = -1
      for (const seg of r.segments) {
        if (seg.layer !== layer) continue
        const key = `C:${Math.round(seg.width * 100) / 100}`
        const d = copperApertures.get(key)!.d
        if (d !== cur) {
          lines.push(`D${d}*`)
          cur = d
        }
        lines.push(...drawPolyline(seg.pts))
      }
      lines.push('%TD*%')
    }
    for (const p of placements) {
      const c = compByRef.get(p.ref)!
      lines.push(`%TO.C,${x2name(p.ref)}*%`)
      for (const pd of c.footprint.pads) {
        const netName = c.pins[pd.pin]
        if (!netName || layer !== 0) continue
        const rot = ((p.rot % 180) + 180) % 180
        const key = `${Math.round(pd.w * 100) / 100}x${Math.round(pd.h * 100) / 100}r${rot}`
        const d = padD.get(key)!
        const w = padWorldPos(p, pd)
        lines.push(`D${d}*`)
        lines.push(`%TO.N,${x2name(netName)}*%`)
        lines.push(`X${fmt(w.x)}Y${fmt(w.y)}D03*`)
        padCount++
      }
      lines.push('%TD*%')
    }
    // Vias (flashes circulaires sur les couches externes) — attribut X2 .V
    const viaD = dOf(`V:${viaRingDiameter}`, `C,${viaRingDiameter}`)
    lines.push(`D${viaD}*`)
    lines.push('%TO.V*%')
    for (const r of routing.routes) {
      for (const v of r.vias) lines.push(`X${fmt(v.x)}Y${fmt(v.y)}D03*`)
    }
    lines.push('%TD*%')
    // Pour cuivre : plan de masse synthétique (2 couches) ou plans dédiés (4 couches [P1.1])
    const pours: { cells: { x: number; y: number }[]; cols: number; rows: number; res: number }[] = []
    if (routing.groundPour) {
      const gp = routing.groundPour
      if (layer === 0) pours.push({ cells: gp.top, cols: gp.cols, rows: gp.rows, res: gp.res })
      if (layer === 1) pours.push({ cells: gp.bottom, cols: gp.cols, rows: gp.rows, res: gp.res })
    }
    for (const p of routing.planes ?? []) if (p.layer === layer) pours.push(p)
    for (const pour of pours) {
      const pourSet = new Set(pour.cells.map((c) => `${c.x},${c.y}`))
      const neighborhoodFree = (x: number, y: number) => {
        for (let dy = -8; dy <= 8; dy += 2)
          for (let dx = -8; dx <= 8; dx += 2) {
            if (!pourSet.has(`${Math.round((x + dx * pour.res) * 100) / 100},${Math.round((y + dy * pour.res) * 100) / 100}`)) return false
          }
        return true
      }
      const pourD = dOf('POUR:0.6', 'C,0.6')
      lines.push(`D${pourD}*`)
      for (let i = 0; i < pour.cells.length; i += 2) {
        const c = pour.cells[i]
        if (!neighborhoodFree(c.x, c.y)) continue
        lines.push(`X${fmt(c.x)}Y${fmt(c.y)}D03*`)
      }
    }
    lines.push(gerberFooter())
    return lines.join('\n')
  }

  /* ---------- Contour ---------- */
  const outline = [
    gerberHeader({ projectId: nl.id, fileFunction: 'Profile,NP' }),
    '%ADD20C,0.15*%',
    'D20*',
    `X${fmt(0)}Y${fmt(0)}D02*`,
    `X${fmt(nl.board.w)}Y${fmt(0)}D01*`,
    `X${fmt(nl.board.w)}Y${fmt(nl.board.h)}D01*`,
    `X${fmt(0)}Y${fmt(nl.board.h)}D01*`,
    `X${fmt(0)}Y${fmt(0)}D01*`,
    gerberFooter(),
  ].join('\n')

  /* ---------- Perçage Excellon ---------- */
  const drillLines: string[] = [
    '; NEXUS PCB — Drill file (Excellon)',
    '; Généré le ' + new Date().toISOString(),
    'M48',
    'METRIC,TZ',
    `T1C${routing.routes.flatMap((r) => r.vias).map((v) => v.drill)[0]?.toFixed(3) ?? '0.600'}`,
    '%',
    'G90',
    'G05',
    'T1',
  ]
  const seen = new Set<string>()
  for (const r of routing.routes) {
    for (const v of r.vias) {
      const k = `${v.x.toFixed(3)},${v.y.toFixed(3)}`
      if (seen.has(k)) continue
      seen.add(k)
      drillLines.push(`X${v.x.toFixed(3)}Y${v.y.toFixed(3)}`)
    }
  }
  drillLines.push('M30', '')

  /* ---------- BOM + Pick&Place ---------- */
  const bomGroups = new Map<string, { refs: string[]; value: string; fp: string }>()
  for (const c of nl.components) {
    const key = `${c.value}|${c.footprint.name}`
    const g = bomGroups.get(key) ?? { refs: [], value: c.value, fp: c.footprint.name }
    g.refs.push(c.ref)
    bomGroups.set(key, g)
  }
  const bom = [
    'Designateur(s);Valeur;Empreinte;Quantite',
    ...[...bomGroups.values()].map((g) => `${g.refs.join(', ')};${g.value};${g.fp};${g.refs.length}`),
    '',
  ].join('\n')

  const pos = [
    'Designateur;X_mm;Y_mm;Rotation_deg;Face',
    ...placements.map((p) => `${p.ref};${p.x.toFixed(3)};${p.y.toFixed(3)};${p.rot};${p.side === 'top' ? 'top' : 'bottom'}`),
    '',
  ].join('\n')

  const layerFiles: GerberFile[] = (nl.board.layers >= 4
    ? [
        { idx: 0, name: 'F_Cu.gbr', role: 'Cuivre supérieur (signal)' },
        { idx: 1, name: 'In1_Cu.gbr', role: 'Cuivre interne 1 (signal)' },
        { idx: 2, name: 'In2_Cu.gbr', role: 'Cuivre interne 2 (plan de masse)' },
        { idx: 3, name: 'B_Cu.gbr', role: 'Cuivre inférieur (plan d\'alimentation)' },
      ]
    : [
        { idx: 0, name: 'F_Cu.gbr', role: 'Cuivre supérieur' },
        { idx: 1, name: 'B_Cu.gbr', role: 'Cuivre inférieur' },
      ]
  ).map(({ idx, name, role }) => ({ name, role, content: copperLayer(idx) }))

  const files: GerberFile[] = [
    ...layerFiles,
    { name: 'Edge_Cuts.gbr', role: 'Contour de carte', content: outline },
    { name: 'drill.drl', role: 'Perçage (Excellon)', content: drillLines.join('\n') },
    { name: 'BOM.csv', role: 'Nomenclature', content: bom },
    { name: 'POS.csv', role: 'Pick & Place', content: pos },
  ]

  return { files, padCount, viaCount, traceCount }
}
