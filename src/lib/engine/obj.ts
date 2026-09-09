/**
 * NEXUS PCB — Export des positions en OBJ pour l'intégration mécanique [M6]
 * -------------------------------------------------------------------------
 * Un fichier OBJ minimal mais IMPORTABLE dans n'importe quel outil mécanique
 * (FreeCAD, SolidWorks, Fusion 360, Blender, Catia) : le panneau FR4 en
 * dalle + un volume englobant par composant, positionnés et orientés selon
 * le placement réel du studio.
 *
 * Convention d'axes (documentée dans l'en-tête du fichier) :
 *   - X OBJ = X carte (mm, origine coin haut-gauche carte)
 *   - Y OBJ = hauteur (mm, normale au plan carte, composants côté top en +Y)
 *   - Z OBJ = Y carte (mm)
 *   - 1 unité OBJ = 1 mm
 *
 * Le STEP (AP203/214) exigerait un noyau géométrique B-rep complet — hors
 * périmètre navigateur ; l'OBJ est le format d'échange universel accepté par
 * tous les outils CAO mécaniques (import direct ou via mesh).
 */
import type { Netlist, PlacedComponent } from './types'

/** Hauteurs d'encombrement par catégorie (mm) — volumes mécaniques plausibles. */
const HEIGHTS: Record<string, number> = {
  connector: 5,
  rf: 2,
  crystal: 1,
  sensor: 1.2,
  inductor: 2,
  mcu: 1.2,
}
const BOARD_THICKNESS = 1.6
const DEFAULT_HEIGHT = 1.5

const heightOf = (category: string) => HEIGHTS[category] ?? DEFAULT_HEIGHT

/** Coin d'un rectangle centré (cx,cy), tourné de rot°, élargi de 0 — x,y carte. */
function rectCorners(p: { x: number; y: number; rot: number }, w: number, h: number): { x: number; y: number }[] {
  const r = ((p.rot % 360) + 360) % 360
  const effW = r === 90 || r === 270 ? h : w
  const effH = r === 90 || r === 270 ? w : h
  return [
    { x: p.x - effW / 2, y: p.y - effH / 2 },
    { x: p.x + effW / 2, y: p.y - effH / 2 },
    { x: p.x + effW / 2, y: p.y + effH / 2 },
    { x: p.x - effW / 2, y: p.y + effH / 2 },
  ]
}

/** Écrit un pavé rectangulaire vertical (4 coins xz + hauteur y) en OBJ. */
function box(out: string[], name: string, corners: { x: number; y: number }[], y0: number, y1: number, label: string) {
  out.push(`o ${name}`)
  out.push(`# ${label}`)
  // sommets : 4 au sol (y0) puis 4 au plafond (y1) — Y OBJ = hauteur
  for (const c of corners) out.push(`v ${c.x.toFixed(3)} ${y0.toFixed(3)} ${c.y.toFixed(3)}`)
  for (const c of corners) out.push(`v ${c.x.toFixed(3)} ${y1.toFixed(3)} ${c.y.toFixed(3)}`)
  // faces quads : sol, plafond, 4 côtés (numérotation locale 1..8)
  const quads = [
    [1, 4, 3, 2], // sol
    [5, 6, 7, 8], // plafond
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 4, 8, 7],
    [4, 1, 5, 8],
  ]
  for (const q of quads) out.push(`f ${q.join(' ')}`)
}

/** Construit l'export OBJ complet : dalle FR4 + volumes composants. */
export function buildObjExport(nl: Netlist, placements: PlacedComponent[]): { name: string; role: string; content: string } {
  const out: string[] = []
  out.push('# NEXUS PCB — export mécanique des positions')
  out.push(`# projet : ${nl.name} (${nl.id})`)
  out.push(`# généré : ${new Date().toISOString()}`)
  out.push('# unité : 1 = 1 mm · X = X carte · Y = hauteur · Z = Y carte')
  out.push(`# carte ${nl.board.w} x ${nl.board.h} mm, FR4 ${BOARD_THICKNESS} mm, ${placements.length} composants`)
  out.push('# importable tel quel dans FreeCAD / SolidWorks / Fusion 360 / Blender')

  // Dalle FR4 : rectangle carte, z carte 0..h → OBJ x 0..w, OBJ z 0..h
  box(
    out,
    'board_FR4',
    [
      { x: 0, y: 0 },
      { x: nl.board.w, y: 0 },
      { x: nl.board.w, y: nl.board.h },
      { x: 0, y: nl.board.h },
    ],
    0,
    BOARD_THICKNESS,
    `panneau FR4 ${nl.board.w}x${nl.board.h}x${BOARD_THICKNESS} mm`,
  )

  for (const p of placements) {
    const c = nl.components.find((x) => x.ref === p.ref)
    if (!c) continue
    const h = heightOf(c.category)
    box(out, `comp_${p.ref}`, rectCorners(p, c.footprint.w, c.footprint.h), BOARD_THICKNESS, BOARD_THICKNESS + h, `${p.ref} — ${c.value} (${c.category}) en (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) rot ${p.rot}°, h ${h} mm`)
  }

  return { name: 'positions.obj', role: 'Positions 3D (OBJ mécanique)', content: out.join('\n') + '\n' }
}
