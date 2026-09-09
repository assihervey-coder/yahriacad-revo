/**
 * NEXUS PCB — Panelisation production + contraintes fabricant [audit P2.2]
 * Équivalent : services/exporter/panelizer/ + data/manufacturing_partners/
 *
 * Deux livrables :
 *  1. Conformité fabricant — mesure HONNÊTE des caractéristiques du design
 *     (piste min, perçage min, anneau, dégagement bord, dimensions, couches)
 *     confrontée aux limites d'un préréglage usine (JLCPCB / PCBWay / générique).
 *  2. Panel de production — grille cols×rows avec rails, repères, trous de
 *     centrage, séparation V-cut ou onglets micro-percés ; les fichiers cuivre
 *     et perçage sont RÉELLEMENT transformés (translation de coordonnées) et
 *     concaténés par copie — pas une maquette.
 */
import type { DesignRules, Netlist, RoutingSolution } from './types'

/* ============================ Préréglages usine ============================ */

export interface FabPreset {
  id: string
  name: string
  minTraceMm: number
  minDrillMm: number
  minClearanceMm: number
  edgeClearanceMm: number
  minAnnularMm: number
  minBoard: { w: number; h: number }
  maxBoard: { w: number; h: number }
  maxPanel: { w: number; h: number }
  maxLayers: number
  note: string
}

export const FABRICS: FabPreset[] = [
  {
    id: 'jlcpcb',
    name: 'JLCPCB (2-4 couches, std)',
    minTraceMm: 0.127,
    minDrillMm: 0.2,
    minClearanceMm: 0.127,
    edgeClearanceMm: 0.3,
    minAnnularMm: 0.08,
    minBoard: { w: 10, h: 10 },
    maxBoard: { w: 400, h: 400 },
    maxPanel: { w: 400, h: 400 },
    maxLayers: 4,
    note: 'V-cut ou onglets acceptés — rail ≥ 5 mm conseillé, repères FID 1 mm + trous ⌀3,2.',
  },
  {
    id: 'pcbway',
    name: 'PCBWay (2-4 couches, std)',
    minTraceMm: 0.152,
    minDrillMm: 0.3,
    minClearanceMm: 0.15,
    edgeClearanceMm: 0.4,
    minAnnularMm: 0.15,
    minBoard: { w: 10, h: 10 },
    maxBoard: { w: 480, h: 580 },
    maxPanel: { w: 480, h: 580 },
    maxLayers: 4,
    note: 'V-cut 30° restant 1/3 de l\u2019épaisseur — onglets avec ⌀0,6 espacés de 2 mm.',
  },
  {
    id: 'generic',
    name: 'Générique (règles moteur)',
    minTraceMm: 0.2,
    minDrillMm: 0.3,
    minClearanceMm: 0.2,
    edgeClearanceMm: 0.5,
    minAnnularMm: 0.15,
    minBoard: { w: 15, h: 15 },
    maxBoard: { w: 300, h: 300 },
    maxPanel: { w: 300, h: 300 },
    maxLayers: 4,
    note: 'Calque des DEFAULT_RULES du moteur — référence interne neutre.',
  },
]

/* ============================ Conformité fabricant ============================ */

export interface FabCheck {
  id: string
  label: string
  required: string
  measured: string
  ok: boolean
}

export interface FabReport {
  preset: FabPreset
  pass: boolean
  checks: FabCheck[]
}

/** Distance min d'un point au bord de carte (mm). */
const edgeDist = (x: number, y: number, w: number, h: number) =>
  Math.min(x, w - x, y, h - y)

export function checkManufacturability(
  nl: Netlist,
  routing: RoutingSolution,
  preset: FabPreset,
  rules: DesignRules,
): FabReport {
  const widths = routing.routes.flatMap((r) => r.segments.map((s) => s.width))
  const minTrace = widths.length > 0 ? Math.min(...widths) : 0
  const drills = routing.routes.flatMap((r) => r.vias.map((v) => v.drill))
  const minDrill = drills.length > 0 ? Math.min(...drills) : 0
  const annulars = routing.routes
    .flatMap((r) => r.vias)
    .map((v) => (v.diameter - v.drill) / 2)
  const minAnnular = annulars.length > 0 ? Math.min(...annulars) : 0
  // Dégagement bord : min sur les extrémités de pistes (segments axis-alignés
  // intérieurs à la carte → la distance est atteinte à une extrémité)
  let edge = Infinity
  for (const r of routing.routes)
    for (const s of r.segments)
      for (const p of s.pts) edge = Math.min(edge, edgeDist(p.x, p.y, nl.board.w, nl.board.h))
  if (!Number.isFinite(edge)) edge = 0

  const checks: FabCheck[] = [
    {
      id: 'trace',
      label: 'Largeur de piste min',
      required: `≥ ${preset.minTraceMm} mm`,
      measured: `${minTrace.toFixed(3)} mm`,
      ok: minTrace >= preset.minTraceMm - 1e-9,
    },
    {
      id: 'drill',
      label: 'Perçage min (via)',
      required: `≥ ${preset.minDrillMm} mm`,
      measured: drills.length ? `${minDrill.toFixed(2)} mm` : '—',
      ok: drills.length === 0 || minDrill >= preset.minDrillMm - 1e-9,
    },
    {
      id: 'annular',
      label: 'Anneau de via min',
      required: `≥ ${preset.minAnnularMm} mm`,
      measured: annulars.length ? `${minAnnular.toFixed(3)} mm` : '—',
      ok: annulars.length === 0 || minAnnular >= preset.minAnnularMm - 1e-9,
    },
    {
      id: 'clearance',
      label: 'Isolement (règle moteur)',
      required: `≥ ${preset.minClearanceMm} mm`,
      measured: `${rules.clearance.toFixed(2)} mm`,
      ok: rules.clearance >= preset.minClearanceMm - 1e-9,
    },
    {
      id: 'edge',
      label: 'Dégagement de bord',
      required: `≥ ${preset.edgeClearanceMm} mm`,
      measured: `${edge.toFixed(2)} mm`,
      ok: edge >= preset.edgeClearanceMm - 1e-9,
    },
    {
      id: 'size',
      label: 'Dimensions de carte',
      required: `${preset.minBoard.w}×${preset.minBoard.h} → ${preset.maxBoard.w}×${preset.maxBoard.h} mm`,
      measured: `${nl.board.w}×${nl.board.h} mm`,
      ok:
        nl.board.w >= preset.minBoard.w && nl.board.h >= preset.minBoard.h &&
        nl.board.w <= preset.maxBoard.w && nl.board.h <= preset.maxBoard.h,
    },
    {
      id: 'layers',
      label: 'Couches cuivre',
      required: `≤ ${preset.maxLayers}`,
      measured: `${nl.board.layers}`,
      ok: nl.board.layers <= preset.maxLayers,
    },
  ]
  return { preset, pass: checks.every((c) => c.ok), checks }
}

/* ============================ Géométrie de panel ============================ */

export interface PanelOptions {
  cols: number // 1..4
  rows: number // 1..4
  gapMm: number // espace entre cartes
  railMm: number // largeur des rails haut/bas
  mode: 'vcut' | 'bites'
}

export interface PanelGeometry {
  boardW: number
  boardH: number
  panelW: number
  panelH: number
  cols: number
  rows: number
  gap: number
  rail: number
  mode: 'vcut' | 'bites'
  origins: { x: number; y: number }[] // coin bas-gauche de chaque copie
  fiducials: { x: number; y: number }[]
  toolingHoles: { x: number; y: number }[]
  vcutLines: { x1: number; y1: number; x2: number; y2: number }[]
  biteHoles: { x: number; y: number }[]
  utilization: number // 0..1
}

export function buildPanel(nl: Netlist, opts: PanelOptions): PanelGeometry {
  const cols = Math.max(1, Math.min(4, Math.round(opts.cols)))
  const rows = Math.max(1, Math.min(4, Math.round(opts.rows)))
  const gap = Math.max(0, opts.gapMm)
  const rail = Math.max(0, opts.railMm)
  const bw = nl.board.w
  const bh = nl.board.h
  const panelW = rail * 0 + cols * bw + (cols - 1) * gap // rails latéraux non utilisés (rails haut/bas intégrés au gabarit)
  const panelH = rows * bh + (rows - 1) * gap + 2 * rail
  const origins: { x: number; y: number }[] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      origins.push({ x: c * (bw + gap), y: rail + r * (bh + gap) })

  // Repères : 2 par rail (gauche/droite) — pastille ⌀1 mm + ouverture ⌀3 mm (dessinée dans l'Edge)
  const fiducials = [
    { x: Math.min(5, panelW * 0.1), y: rail / 2 },
    { x: Math.max(panelW - 5, panelW * 0.9), y: rail / 2 },
    { x: Math.min(5, panelW * 0.1), y: panelH - rail / 2 },
    { x: Math.max(panelW - 5, panelW * 0.9), y: panelH - rail / 2 },
  ]
  // Trous de centrage ⌀3,2 aux quatre coins des rails
  const toolingHoles = [
    { x: 2.5, y: 2.5 },
    { x: panelW - 2.5, y: 2.5 },
    { x: 2.5, y: panelH - 2.5 },
    { x: panelW - 2.5, y: panelH - 2.5 },
  ]

  // Séparation : V-cut sur les axes de gap ; onglets percés en quinconce
  const vcutLines: { x1: number; y1: number; x2: number; y2: number }[] = []
  const biteHoles: { x: number; y: number }[] = []
  if (opts.mode === 'vcut') {
    for (let c = 1; c < cols; c++) {
      const x = c * (bw + gap) - gap / 2
      vcutLines.push({ x1: x, y1: 0, x2: x, y2: panelH })
    }
    for (let r = 1; r < rows; r++) {
      const y = rail + r * (bh + gap) - gap / 2
      vcutLines.push({ x1: 0, y1: y, x2: panelW, y2: y })
    }
  } else {
    for (let r = 0; r < rows; r++) {
      for (let c = 1; c < cols; c++) {
        const x = c * (bw + gap) - gap / 2
        const yStart = rail + r * (bh + gap)
        for (let y = yStart + 1; y < yStart + bh - 1; y += 5) biteHoles.push({ x, y })
      }
    }
    for (let c = 0; c < cols; c++) {
      for (let r = 1; r < rows; r++) {
        const y = rail + r * (bh + gap) - gap / 2
        const xStart = c * (bw + gap)
        for (let x = xStart + 1; x < xStart + bw - 1; x += 5) biteHoles.push({ x, y })
      }
    }
  }

  const utilization = (cols * rows * bw * bh) / (panelW * panelH)
  return {
    boardW: bw, boardH: bh, panelW, panelH, cols, rows, gap, rail, mode: opts.mode,
    origins, fiducials, toolingHoles, vcutLines, biteHoles, utilization,
  }
}

/* ==================== Transformation de fichiers Gerber ==================== */

/** Translation de toutes les coordonnées d'un fichier RS-274X/X2 (µ interne 1e6). */
export function offsetGerber(content: string, dxMm: number, dyMm: number): string {
  const dx = Math.round(dxMm * 1e6)
  const dy = Math.round(dyMm * 1e6)
  if (dx === 0 && dy === 0) return content
  return content.replace(/([XY])(-?\d+)/g, (_m, axis: string, num: string) => {
    const v = parseInt(num, 10) + (axis === 'X' ? dx : dy)
    return `${axis}${v}`
  })
}

/** Retire les attributs TF globaux (métadonnées fichier) — copies 2..N du panel. */
export function stripGlobalAttributes(content: string): string {
  return content
    .split('\n')
    .filter((l) => !l.startsWith('%TF.'))
    .join('\n')
}

/** Translation des hits d'un fichier Excellon (mm décimal). */
export function offsetExcellon(content: string, dxMm: number, dyMm: number): string {
  if (dxMm === 0 && dyMm === 0) return content
  return content.replace(/([XY])(-?\d+(?:\.\d+)?)/g, (_m, axis: string, num: string) => {
    const v = parseFloat(num) + (axis === 'X' ? dxMm : dyMm)
    return `${axis}${v.toFixed(3)}`
  })
}

/* ============================ Package de panel ============================ */

export interface PanelPackageFile {
  name: string
  role: string
  content: string
}

/** Génère le package complet du panel : cuivres concaténés par copie,
 *  perçage étendu, contour panel (V-cut / onglets + repères + trous),
 *  et une notice d'assemblage pour l'usine. */
export function generatePanelPackage(
  nl: Netlist,
  routing: RoutingSolution,
  panel: PanelGeometry,
  baseGerber: { name: string; role: string; content: string }[],
  preset: FabPreset,
): PanelPackageFile[] {
  const files: PanelPackageFile[] = []
  const copperFiles = baseGerber.filter((f) => f.name.endsWith('.gbr') && f.name !== 'Edge_Cuts.gbr')

  // --- Cuivres : chaque copie transformée, concaténée par couche ---
  for (const f of copperFiles) {
    const parts: string[] = []
    panel.origins.forEach((o, i) => {
      let content = offsetGerber(f.content, o.x, o.y)
      if (i > 0) content = stripGlobalAttributes(content) // TF globaux une seule fois
      parts.push(content.replace('\nM02*\n', '\n'))
    })
    parts.push('M02*\n')
    files.push({
      name: `panel_${f.name}`,
      role: `${f.role} — panel ${panel.cols}×${panel.rows} (contenu transformé par copie)`,
      content: parts.join(''),
    })
  }

  // --- Perçage : tous les hits de toutes les copies ---
  const drill = baseGerber.find((f) => f.name === 'drill.drl')
  if (drill) {
    const parts: string[] = []
    panel.origins.forEach((o, i) => {
      let content = offsetExcellon(drill.content, o.x, o.y)
      if (i > 0) content = content.replace(/^;[^\n]*\n/gm, '').replace(/M48[\s\S]*?%\n/, '').replace(/M30\n?/, '')
      parts.push(content)
    })
    files.push({
      name: 'panel_drill.drl',
      role: `Perçage panel — ${panel.origins.length} copies (en-tête unique, hits cumulés)`,
      content: parts.join(''),
    })
  }

  // --- Contour panel : cadre + séparations + repères + trous de centrage ---
  const edge: string[] = [
    'G04 NEXUS PCB — Panel de production [P2.2]*',
    'G04 ' + new Date().toISOString() + '*',
    '%FSLAX36Y36*%',
    '%MOMM*%',
    '%TF.GenerationSoftware,NEXUS PCB,Studio,1.0*%',
    `%TF.ProjectId,${nl.id.replace(/[^A-Za-z0-9_.\-+/!]/g, '_')}_panel*%`,
    '%TF.FileFunction,Profile,NP*%',
    '%LPD*%',
    'G01*',
    'G75*',
    '%ADD10C,0.15*%',
    'D10*',
  ]
  const fmt = (mm: number) => String(Math.round(mm * 1e6))
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    `X${fmt(x1)}Y${fmt(y1)}D02*X${fmt(x2)}Y${fmt(y2)}D01*`
  // Cadre du panel
  edge.push(line(0, 0, panel.panelW, 0))
  edge.push(line(panel.panelW, 0, panel.panelW, panel.panelH))
  edge.push(line(panel.panelW, panel.panelH, 0, panel.panelH))
  edge.push(line(0, panel.panelH, 0, 0))
  // Contours des cartes (repérage copie par copie)
  for (const o of panel.origins) {
    edge.push(line(o.x, o.y, o.x + panel.boardW, o.y))
    edge.push(line(o.x + panel.boardW, o.y, o.x + panel.boardW, o.y + panel.boardH))
    edge.push(line(o.x + panel.boardW, o.y + panel.boardH, o.x, o.y + panel.boardH))
    edge.push(line(o.x, o.y + panel.boardH, o.x, o.y))
  }
  // Séparation
  if (panel.mode === 'vcut') {
    edge.push('%ADD11C,0.05*%')
    edge.push('D11*')
    for (const v of panel.vcutLines) {
      // trait mixte (dash) : segments de 4 mm espacés de 2 mm
      const dx = v.x2 - v.x1
      const dy = v.y2 - v.y1
      const len = Math.hypot(dx, dy)
      const ux = dx / len
      const uy = dy / len
      for (let t = 0; t + 4 <= len; t += 6) {
        edge.push(line(v.x1 + ux * t, v.y1 + uy * t, v.x1 + ux * (t + 4), v.y1 + uy * (t + 4)))
      }
    }
  } else if (panel.biteHoles.length > 0) {
    edge.push('%ADD12C,0.6*%')
    edge.push('D12*')
    for (const h of panel.biteHoles) edge.push(`X${fmt(h.x)}Y${fmt(h.y)}D03*`)
  }
  // Repères (pastille ⌀1 mm entourée d'une ouverture ⌀3 mm tracée)
  edge.push('%ADD13C,1.0*%')
  edge.push('D13*')
  for (const f of panel.fiducials) edge.push(`X${fmt(f.x)}Y${fmt(f.y)}D03*`)
  edge.push('%ADD14C,0.15*%')
  edge.push('D14*')
  for (const f of panel.fiducials) {
    const r = 1.5
    edge.push(`X${fmt(f.x - r)}Y${fmt(f.y)}D02*`)
    edge.push(`G03X${fmt(f.x + r)}Y${fmt(f.y)}I${fmt(r)}J0D01*`)
    edge.push(`G03X${fmt(f.x - r)}Y${fmt(f.y)}I${fmt(-r)}J0D01*`)
  }
  // Trous de centrage ⌀3,2 (tracés à titre d'outillage)
  edge.push('%ADD15C,3.2*%')
  edge.push('D15*')
  for (const h of panel.toolingHoles) edge.push(`X${fmt(h.x)}Y${fmt(h.y)}D03*`)
  edge.push('M02*\n')
  files.push({
    name: 'panel_Edge.gbr',
    role: `Contour panel ${panel.panelW.toFixed(0)}×${panel.panelH.toFixed(0)} mm — ${panel.mode === 'vcut' ? 'V-cut' : 'onglets micro-percés'}, repères, trous ⌀3,2`,
    content: edge.join('\n'),
  })

  // --- Notice d'assemblage ---
  const readme = [
    `NEXUS PCB — Panel de production (${panel.cols}×${panel.rows} = ${panel.origins.length} cartes)`,
    `Généré le ${new Date().toISOString()}`,
    `Fabricant cible : ${preset.name}`,
    ``,
    `Panel : ${panel.panelW.toFixed(1)} × ${panel.panelH.toFixed(1)} mm (cartes ${panel.boardW}×${panel.boardH} mm, gap ${panel.gap} mm, rail ${panel.rail} mm)`,
    `Taux d'utilisation matière : ${(panel.utilization * 100).toFixed(1)} %`,
    `Séparation : ${panel.mode === 'vcut' ? `V-cut 30° (reste 1/3 de l'épaisseur) sur ${panel.vcutLines.length} axes` : `${panel.biteHoles.length} onglets micro-percés ⌀0,6 mm`}`,
    `Repères : 4 × pastille ⌀1 mm (ouverture ⌀3 mm) sur les rails`,
    `Outillage : 4 × trou de centrage ⌀3,2 mm`,
    ``,
    `Fichiers :`,
    ...files.map((f) => `  - ${f.name} : ${f.role}`),
    ``,
    `Note : les cuivres panel_*.gbr contiennent les ${panel.origins.length} copies transformées`,
    `(coordonnées réelles décalées) ; les attributs TF globaux ne figurent qu'une fois.`,
    preset.note ? `Prescription fabricant : ${preset.note}` : '',
  ].filter(Boolean)
  files.push({
    name: 'panel_README.txt',
    role: 'Notice d\u2019assemblage du panel',
    content: readme.join('\n') + '\n',
  })

  return files
}
