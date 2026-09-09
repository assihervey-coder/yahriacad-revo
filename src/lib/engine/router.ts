/**
 * NEXUS PCB — Routeur maze A* multicouche
 * Équivalent : services/router/topological/ + geometrical/ + via_placer/
 *
 * Stratégie :
 *   1. Ordre de routage par criticité (RF > différentiel > haute vitesse > alim > signal),
 *      les deux membres d'une paire différentielle enchaînés [P1.2]
 *   2. Routage en arbre multi-broches : Dijkstra/A* multi-sources depuis l'arbre
 *      existant du net vers chaque broche restante
 *   3. Obstacles : corps de composants (couche top), pistes étrangères dilatées
 *      selon leur largeur (clearance), marge de bord, keepout RF
 *   4. Changement de couche = via (coût 14) — le via_placer les pose au point
 *      exact de transition
 *   5. Nets infranchissables → signalés au DRC (boucle de rétroaction)
 *   6. Pile 4 couches [P1.1] : signal/signal/masse/alim — la paire signal (L0/L1)
 *      réutilise EXACTEMENT la grille bicouche existante ; les plans masse (L2)
 *      et alim (L3) sont générés par flood-fill dédié avec antipads de vias,
 *      et les rails principaux y accèdent directement (plus de place pour les signaux)
 *   7. Paires différentielles strictes [P1.2] : corridor réservé au partenaire
 *      (modèle keepout — exclusif au couple), et méandres (peigne) du membre
 *      le plus court pour l'appariement de longueur, quel que soit son ordre
 *      de routage
 */
import type {
  Constraint, DesignRules, Netlist, PlacedComponent, Route, RoutingSolution, TraceSegment, Via,
} from './types'
import { padWorldPos, placedRect } from './world-model'

const RES = 0.25 // résolution de grille (mm)

class MinHeap {
  private keys: number[] = []
  private nodes: number[] = []
  get size() { return this.nodes.length }
  push(node: number, key: number) {
    this.keys.push(key); this.nodes.push(node)
    let i = this.nodes.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p] <= this.keys[i]) break
      this.swap(i, p); i = p
    }
  }
  pop(): number {
    const top = this.nodes[0]
    const lastK = this.keys.pop()!, lastN = this.nodes.pop()!
    if (this.nodes.length > 0) {
      this.keys[0] = lastK; this.nodes[0] = lastN
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r
        if (m === i) break
        this.swap(i, m); i = m
      }
    }
    return top
  }
  private swap(a: number, b: number) {
    ;[this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]]
    ;[this.nodes[a], this.nodes[b]] = [this.nodes[b], this.nodes[a]]
  }
}

/** [DeepPCB live_routing] événement de flux temps réel : une piste ou un via
 *  vient d'être posé par le routeur — diffusé tel quel au navigateur. */
export type TraceEvent =
  | { type: 'segment'; net: string; segment: TraceSegment }
  | { type: 'via'; net: string; via: Via }

export type RouterPhase = 'greedy' | 'ripup' | 'via-min' | 'tune' | 'pour'

export interface RouterOptions {
  onProgress?: (p: { done: number; total: number; net: string; ok: boolean }) => void
  shouldCancel?: () => boolean
  /** Flux temps réel : émis pour chaque segment/via fraîchement posé (passe glouton) */
  onTrace?: (ev: TraceEvent) => void
  /** Transition de phase du moteur (glouton → rip-up → minimisation vias → plan de masse) */
  onPhase?: (phase: RouterPhase) => void
  /** Rythme du flux : pause (ms) après chaque émission de traces d'une branche.
   *  0 = rendu plein régime (le navigateur peint quand même entre les branches). */
  pacingMs?: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const CLASS_ORDER: Record<string, number> = {
  rf: 2, highspeed: 3, diffpair: 4, power: 1, ground: 0, analog: 5, signal: 6,
}

export async function routeAll(
  nl: Netlist, placements: PlacedComponent[], rules: DesignRules,
  constraints: Constraint[], opts: RouterOptions = {},
): Promise<RoutingSolution> {
  const t0 = Date.now()
  const cols = Math.ceil(nl.board.w / RES)
  const rows = Math.ceil(nl.board.h / RES)
  const L = Math.max(2, Math.min(4, nl.board.layers || 2)) // couches cuivre (2 ou 4) [P1.1]
  const L4 = L >= 4
  const cells = cols * rows
  const total = cells * L

  const idxOf = (x: number, y: number) => y * cols + x

  /* ---- Masques d'obstacles ---- */
  const edgeCells = Math.ceil(rules.edgeClearance / RES)
  const bodyBlocked = new Uint8Array(total)     // corps de composants (couche top) + marge de bord
  const edgeBlock = new Uint8Array(cells)       // marge de bord seule (plans cuivre)
  const padNet = new Int16Array(total).fill(-1) // cellule-pad (couche 0) → index de net propriétaire
  const padNetL1 = new Int16Array(total).fill(-1) // réserve d'échappatoire L1 au-dessus des pads
  const keepBlock = new Uint8Array(total)       // keepout RF (2 couches)
  const occupied = new Int16Array(total).fill(-1) // cellules cuivre prises
  const dilated = new Int16Array(total).fill(-1)  // zone de clearance interdite
  const pairCorridor = new Int16Array(total).fill(-1) // [P1.2] corridor d'appariement (propriétaire = 1er membre)

  const netIndex = new Map<string, number>()
  nl.nets.forEach((n, i) => netIndex.set(n.name, i))
  const compByRef = new Map(nl.components.map((c) => [c.ref, c]))

  // [P1.2] Appariement des paires différentielles : contraintes 'differential'
  // puis repli par groupement nominal (même expression que le parseur)
  const pairOf = new Map<number, number>()
  {
    const link = (a: number, b: number) => {
      if (a !== b && !pairOf.has(a) && !pairOf.has(b)) { pairOf.set(a, b); pairOf.set(b, a) }
    }
    for (const cst of constraints) {
      if (cst.kind !== 'differential' || cst.nets.length < 2) continue
      for (let k = 1; k < cst.nets.length; k++) {
        const a = netIndex.get(cst.nets[0]), b = netIndex.get(cst.nets[k])
        if (a !== undefined && b !== undefined) link(a, b)
      }
    }
    const groups: Record<string, number[]> = {}
    for (const [i, n] of nl.nets.entries()) {
      if (n.cls !== 'diffpair' || pairOf.has(i)) continue
      // même expression que le parseur : suffixes DP/DM d'abord, puis P+/N-
      const base = n.name.replace(/_?[Dd][Pp]$|_?[Dd][Mm]$|[Pp]\+?$|[Nn]-?$/, '').replace(/_$/, '') || n.name
      ;(groups[base] ??= []).push(i)
    }
    for (const g of Object.values(groups)) for (let k = 1; k < g.length; k++) link(g[0], g[k])
  }

  // Rails principaux 4 couches : masse et alim à plus de broches → plans dédiés [P1.1]
  let gndMain = -1, pwrMain = -1
  if (L4) {
    for (const [i, n] of nl.nets.entries()) {
      if (n.cls === 'ground' && (gndMain === -1 || n.pins.length > nl.nets[gndMain].pins.length)) gndMain = i
      if (n.cls === 'power' && (pwrMain === -1 || n.pins.length > nl.nets[pwrMain].pins.length)) pwrMain = i
    }
  }

  // Marge de bord (toutes les couches cuivre)
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++)
      if (x < edgeCells || y < edgeCells || x >= cols - edgeCells || y >= rows - edgeCells) {
        edgeBlock[idxOf(x, y)] = 1
        for (let l = 0; l < L; l++) bodyBlocked[l * cells + idxOf(x, y)] = 1
      }

  // Corps de composants (couche 0 uniquement : on peut router dessous en couche 1)
  for (const p of placements) {
    const c = compByRef.get(p.ref)!
    const r = placedRect(p, c)
    const x0 = Math.max(0, Math.floor((r.x - r.w / 2) / RES)), x1 = Math.min(cols - 1, Math.ceil((r.x + r.w / 2) / RES))
    const y0 = Math.max(0, Math.floor((r.y - r.h / 2) / RES)), y1 = Math.min(rows - 1, Math.ceil((r.y + r.h / 2) / RES))
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        bodyBlocked[idxOf(x, y)] = 1
  }

  // Pads : cellules autorisées pour leur net propriétaire
  const padCell = new Map<string, number>() // "ref.pin" → idx
  for (const p of placements) {
    const c = compByRef.get(p.ref)!
    for (const pd of c.footprint.pads) {
      const w = padWorldPos(p, pd)
      const x = Math.min(cols - 1, Math.max(0, Math.round(w.x / RES)))
      const y = Math.min(rows - 1, Math.max(0, Math.round(w.y / RES)))
      const i = idxOf(x, y)
      const netName = c.pins[pd.pin]
      if (!netName) continue
      const ni = netIndex.get(netName)
      if (ni === undefined) continue
      bodyBlocked[i] = 0            // un pad n'est jamais un obstacle pour son net
      if (padNet[i] === -1) padNet[i] = ni
      // Réserve d'échappatoire : le pad reste dégagé sur L1 tant que son net
      // n'est pas routé (libéré dynamiquement une fois le net connecté)
      if (padNetL1[i] === -1) padNetL1[i] = ni
      padCell.set(`${p.ref}.${pd.pin}`, i)
    }
  }

  // Keepout RF (autour des composants marqués keepout)
  for (const cst of constraints) {
    if (cst.kind !== 'keepout') continue
    for (const ref of cst.refs) {
      const c = compByRef.get(ref); const p = placements.find((x) => x.ref === ref)
      if (!c || !p) continue
      const r = placedRect(p, c)
      const m = (cst.value ?? 5)
      const x0 = Math.max(0, Math.floor((r.x - r.w / 2 - m) / RES)), x1 = Math.min(cols - 1, Math.ceil((r.x + r.w / 2 + m) / RES))
      const y0 = Math.max(0, Math.floor((r.y - r.h / 2 - m) / RES)), y1 = Math.min(rows - 1, Math.ceil((r.y + r.h / 2 + m) / RES))
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          // keepout RF sur la couche supérieure uniquement : le plan de masse
          // en couche inférieure sous l'antenne est une bonne pratique RF
          keepBlock[idxOf(x, y)] = 1
        }
    }
  }

  const isRfNet = (ni: number) => nl.nets[ni]?.cls === 'rf'
  const widthOfNet = (ni: number) => {
    const cls = nl.nets[ni].cls
    return nl.nets[ni].width ?? rules.widths[cls] ?? 0.25
  }

  /* ---- Marquage d'une piste routée (occupation + dilation) ---- */
  function markPath(path: number[], ni: number, vias: { x: number; y: number }[]) {
    const w = widthOfNet(ni)
    // rayon de dilation : mon bord + demi-largeur du net voisin le plus fin + clearance
    const radius = Math.max(1, Math.ceil((w / 2 + rules.minTraceWidth / 2 + rules.clearance) / RES) - 1)
    const viaRadius = Math.max(radius, Math.ceil((0.9 / 2 + rules.minTraceWidth / 2 + rules.clearance) / RES) - 1)
    const mark = (i: number, radius: number) => {
      occupied[i] = ni
      const x = i % cols, y = Math.floor(i / cols) % rows
      const layer = Math.floor(i / cells)
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const j = layer * cells + idxOf(nx, ny)
          if (dilated[j] === -1) dilated[j] = ni
        }
    }
    for (const i of path) mark(i, radius)
    for (const v of vias) {
      const x = Math.min(cols - 1, Math.max(0, Math.round(v.x / RES)))
      const y = Math.min(rows - 1, Math.max(0, Math.round(v.y / RES)))
      mark(idxOf(x, y), viaRadius); mark(cells + idxOf(x, y), viaRadius)
    }
  }

  /* ---- A* multi-sources : arbre existant → broche cible ---- */
  const gStamp = new Int32Array(total)
  const gVal = new Float32Array(total)
  const parent = new Int32Array(total)
  let stamp = 0

  const routedSet = new Set<number>()

  /** Coût d'une transition de couche (via) — majoré par le via_minimizer [DeepPCB] */
  let viaCost = 14

  function passable(i: number, ni: number, relaxed = false): boolean {
    if (occupied[i] !== -1 && occupied[i] !== ni) return false
    if (!relaxed && dilated[i] !== -1 && dilated[i] !== ni) return false
    if (padNet[i] !== -1 && padNet[i] !== ni) return false
    // Échappatoire L1 au-dessus des pads : réservée aux nets non encore routés
    if (i >= cells) {
      const p1 = padNetL1[i - cells]
      if (p1 !== -1 && p1 !== ni && !routedSet.has(p1)) return false
    }
    // [P1.2] corridor d'appariement : réservé au propriétaire et à son partenaire
    const pc = pairCorridor[i]
    if (pc !== -1 && pc !== ni && pairOf.get(pc) !== ni) return false
    if (keepBlock[i] && !isRfNet(ni) && padNet[i] !== ni) return false
    return true
  }

  function search(tree: Set<number>, source: number, ni: number, relaxed = false): number[] | null {
    stamp++
    const heap = new MinHeap()
    const sb = source % cells
    const sx = sb % cols, sy = Math.floor(sb / cols)
    const h = (i: number) => {
      const b = i % cells
      const x = b % cols, y = Math.floor(b / cols)
      return Math.abs(x - sx) + Math.abs(y - sy)
    }
    for (const t of tree) {
      gStamp[t] = stamp; gVal[t] = 0; parent[t] = -1
      heap.push(t, h(t))
    }
    const VIA_COST = viaCost
    let expansions = 0
    while (heap.size > 0) {
      const cur = heap.pop()
      if (gStamp[cur] !== stamp) continue
      if (cur === source) {
        // reconstruction
        const path: number[] = []
        let n = cur
        while (n !== -1) { path.push(n); n = parent[n] }
        return path.reverse()
      }
      if (++expansions > 150000) return null
      const layer = cur < cells ? 0 : 1
      const base = cur % cells
      const x = base % cols, y = Math.floor(base / cols)
      const layerBase = layer * cells
      const neighbors: [number, number][] = []
      // Mouvements latéraux SUR LA MÊME COUCHE (coût uniforme)
      if (x > 0) neighbors.push([layerBase + base - 1, 1])
      if (x < cols - 1) neighbors.push([layerBase + base + 1, 1])
      if (y > 0) neighbors.push([layerBase + base - cols, 1])
      if (y < rows - 1) neighbors.push([layerBase + base + cols, 1])
      // Via : couche opposée, même cellule
      neighbors.push([cells - layerBase + base, VIA_COST])
      for (const [nb, cost] of neighbors) {
        if (nb < 0 || nb >= total) continue
        const layerNb = nb < cells ? 0 : 1
        const isVia = layerNb !== layer
        if (isVia) {
          // un via ne se pose jamais dans le corps d'un composant (couche top)
          if (bodyBlocked[nb] && padNet[nb] !== ni) continue
        } else if (layerNb === 0 && bodyBlocked[nb] && padNet[nb] !== ni) {
          continue // piste sur le cuivre supérieur : corps interdit
        }
        if (!passable(nb, ni, relaxed)) continue
        const ng = gVal[cur] + cost
        if (gStamp[nb] !== stamp || ng < gVal[nb]) {
          gStamp[nb] = stamp; gVal[nb] = ng; parent[nb] = cur
          heap.push(nb, ng + h(nb))
        }
      }
    }
    if (process.env.NEXUS_DEBUG) {
      const b = source % cells
      console.log(`[search-fail] net=${ni} src=(${b % cols},${Math.floor(b / cols)}) expansions=${expansions} treeSize=${tree.size}`)
      // diagnostic : pourquoi le pad de l'arbre est-il scellé ?
      const seedCell = [...tree][0]
      const sb2 = seedCell % cells
      const sx2 = sb2 % cols, sy2 = Math.floor(sb2 / cols)
      const reason = (i: number) => {
        const parts: string[] = []
        if (occupied[i] !== -1 && occupied[i] !== ni) parts.push(`occ=${occupied[i]}`)
        if (dilated[i] !== -1 && dilated[i] !== ni) parts.push(`dil=${dilated[i]}`)
        if (padNet[i] !== -1 && padNet[i] !== ni) parts.push(`pad=${padNet[i]}`)
        if (bodyBlocked[i] && padNet[i] !== ni) parts.push('body')
        if (keepBlock[i] && !isRfNet(ni)) parts.push('keep')
        return parts.join(',') || 'OK'
      }
      console.log(`  seed=(${sx2},${sy2}) layer0 raison=${reason(seedCell)}`)
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nx = sx2 + dx, ny = sy2 + dy
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
        console.log(`  L0 voisin (${nx},${ny}): ${reason(idxOf(nx, ny))} | L1: ${reason(cells + idxOf(nx, ny))}`)
      }
    }
    return null
  }

  /* ---- Boucle principale : routage glouton + RIP-UP & REROUTE ---- */
  // Cellules-pad pré-calculées par net (avant le tri : spanOf en dépend)
  const netPinsCellCache = new Map<string, number[]>()
  for (const net of nl.nets) {
    const pinCells: number[] = []
    for (const { ref, pin } of net.pins) {
      const i = padCell.get(`${ref}.${pin}`)
      if (i !== undefined && i >= 0) pinCells.push(i)
    }
    netPinsCellCache.set(net.name, [...new Set(pinCells)])
  }
  const netPinsCells = new Map<number, number[]>()
  for (const net of nl.nets) {
    netPinsCells.set(netIndex.get(net.name)!, netPinsCellCache.get(net.name)!)
  }

  // Ordre : criticité de classe, puis empan croissant (les bus courts d'abord)
  const spanOf = (n: (typeof nl.nets)[number]) => {
    const cells2 = netPinsCellCache.get(n.name)
    if (!cells2 || cells2.length === 0) return 0
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const c of cells2) {
      const x = c % cols, y = Math.floor(c / cols)
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
    return maxX - minX + (maxY - minY)
  }
  const ordered = [...nl.nets]
    .filter((n) => n.pins.length >= 2)
    .sort((a, b) => (CLASS_ORDER[a.cls] ?? 9) - (CLASS_ORDER[b.cls] ?? 9) || spanOf(a) - spanOf(b))

  // [P1.2] les deux membres d'une paire sont routés l'un juste après l'autre,
  // le membre à l'empan le plus large d'abord (le membre court sera méandré pour l'égaler)
  for (const [a, b] of pairOf) {
    if (a > b) continue
    const ia = ordered.indexOf(nl.nets[a]), ib = ordered.indexOf(nl.nets[b])
    if (ia === -1 || ib === -1) continue
    if (spanOf(nl.nets[b]) > spanOf(nl.nets[a])) {
      ordered.splice(ia, 1)
      ordered.splice(ordered.indexOf(nl.nets[b]) + 1, 0, nl.nets[a])
    } else {
      ordered.splice(ib, 1)
      ordered.splice(ordered.indexOf(nl.nets[a]) + 1, 0, nl.nets[b])
    }
  }

  interface NetRouteState {
    segments: TraceSegment[]
    vias: Via[]
    tree: number[]
    /** chemins par branche (méandres inclus) — permet la réconciliation [P1.2] */
    paths: number[][]
    lengthMm: number
  }
  const routedStore = new Map<number, NetRouteState>()
  const failedNets = new Set<number>()
  const triedRip = new Map<number, Set<number>>()
  let done = 0

  /* ---- [P1.2] Appariement strict des paires différentielles ---- */
  const DIFF_TOL = 0.5                          // tolérance de skew (mm) — grille 0,25 mm
  const DIFF_GAP = Math.max(0.5, 2 * rules.clearance + 0.15) // gap cible (mm)
  const TOOTH_D = 2                             // profondeur du peigne (cellules)
  const TOOTH_MM = 2 * TOOTH_D * RES            // longueur ajoutée par dent (mm)
  const layerOf = (i: number) => Math.floor(i / cells)

  const pathLengthMm = (p: number[]) => {
    let s = 0
    for (let i = 1; i < p.length; i++) if (p[i] % cells !== p[i - 1] % cells) s += RES
    return s
  }

  const bx = (v: number) => ({ x: (v % cols) * RES + RES / 2, y: Math.floor((v % cells) / cols) * RES + RES / 2 })

  /** Construit segments + vias d'un chemin de cellules (pur, sans effet de bord).
   *  Partagé par la passe glouton (phase 3) et la réconciliation des paires [P1.2]
   *  — les méandres étant insérés dans le chemin AVANT cet appel, live, replay
   *  et résultat final restent parfaitement cohérents. */
  function buildPathSegments(ni: number, path: number[]): { segments: TraceSegment[]; vias: Via[]; lengthMm: number } {
    const netName = nl.nets[ni].name
    const w = widthOfNet(ni)
    const segments: TraceSegment[] = []
    const vias: Via[] = []
    let len = 0
    let pts: { x: number; y: number }[] = []
    const flush = (endLayer: number) => {
      if (pts.length >= 2) {
        const simplified: { x: number; y: number }[] = [pts[0]]
        for (let i = 1; i < pts.length - 1; i++) {
          const a = simplified[simplified.length - 1], b = pts[i], c = pts[i + 1]
          const collinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)
          if (!collinear) simplified.push(b)
        }
        simplified.push(pts[pts.length - 1])
        let l = 0
        for (let i = 1; i < simplified.length; i++)
          l += Math.abs(simplified[i].x - simplified[i - 1].x) + Math.abs(simplified[i].y - simplified[i - 1].y)
        len += l
        segments.push({ net: netName, layer: endLayer, pts: simplified, width: w })
      }
    }
    let curLayer: number = layerOf(path[0])
    for (let i = 1; i < path.length; i++) {
      const prev = path[i - 1], curr = path[i]
      const layerPrev = layerOf(prev)
      const layerCur = layerOf(curr)
      if (layerCur !== layerPrev) {
        pts.push(bx(prev))
        flush(layerPrev)
        const pos = bx(prev)
        vias.push({ net: netName, x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100, drill: rules.minDrill, diameter: rules.minDrill + 0.5 })
        curLayer = layerCur
        pts = [bx(curr)]
      } else {
        if (pts.length === 0) pts.push(bx(prev))
        pts.push(bx(curr))
      }
    }
    flush(curLayer)
    return { segments, vias, lengthMm: len }
  }

  /** Corridor réservé au partenaire autour du 1er membre routé (modèle keepout RF) */
  function markCorridor(ni: number) {
    const partner = pairOf.get(ni)
    if (partner === undefined || routedStore.has(partner)) return
    const w = widthOfNet(ni)
    const radius = Math.max(1, Math.ceil((w / 2 + DIFF_GAP) / RES))
    for (const i of routedStore.get(ni)!.tree) {
      const base = i % cells
      const x = base % cols, y = Math.floor(base / cols)
      const lb = layerOf(i) * cells
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const j = lb + idxOf(nx, ny)
          if (pairCorridor[j] === -1) pairCorridor[j] = ni
        }
    }
  }

  /** Cellule libre pour le net ni (mêmes règles que passable, hors corridor) */
  function cellFreeFor(j: number, ni: number): boolean {
    if (j < 0 || j >= total) return false
    if (occupied[j] !== -1 && occupied[j] !== ni) return false
    if (dilated[j] !== -1 && dilated[j] !== ni) return false
    if (padNet[j] !== -1 && padNet[j] !== ni) return false
    if (j < cells && bodyBlocked[j] && padNet[j] !== ni) return false
    if (j >= cells && j < 2 * cells) {
      const p1 = padNetL1[j - cells]
      if (p1 !== -1 && p1 !== ni && !routedSet.has(p1)) return false
    }
    if (keepBlock[j] && !isRfNet(ni) && padNet[j] !== ni) return false
    return true
  }

  /** Insère UNE dent de peigne (méandre rectangulaire) sur le plus long tronçon
   *  droit du chemin — path muté en place. Retourne la longueur ajoutée (mm), 0 si échec.
   *  Profondeur dégressive : dents de 2 cellules (1,0 mm) puis de 1 cellule (0,5 mm). */
  function insertTooth(path: number[], ni: number, used: Set<number>): number {
    let best = -1, bestRun = 0, bestHoriz = false
    for (let s = 0; s < path.length - 1; s++) {
      const a = path[s], b = path[s + 1]
      if (a % cells === b % cells || layerOf(a) !== layerOf(b)) continue // via
      const ax = a % cols, ay = Math.floor(a % cells / cols)
      const bx = b % cols, by = Math.floor(b % cells / cols)
      const horiz = ay === by && ax !== bx
      const vert = ax === bx && ay !== by
      if (!horiz && !vert) continue
      let run = 1
      while (s + run < path.length) {
        const c = path[s + run], prev = path[s + run - 1]
        if (c % cells === prev % cells || layerOf(c) !== layerOf(prev)) break
        const cx = c % cols, cy = Math.floor(c % cells / cols)
        if (horiz ? cy !== ay : cx !== ax) break
        run++
      }
      if (run > bestRun) { bestRun = run; best = s; bestHoriz = horiz }
      s += run - 1
    }
    if (best < 0 || bestRun < 2) return 0
    const mid = best + Math.max(1, Math.min(bestRun - 2, Math.floor(bestRun / 2) - 1))
    const m0 = path[mid], m1 = path[mid + 1]
    const mx = m0 % cols, my = Math.floor(m0 % cells / cols)
    const m1x = m1 % cols, m1y = Math.floor(m1 % cells / cols)
    const lb = layerOf(m0) * cells
    const px = bestHoriz ? 0 : 1, py = bestHoriz ? 1 : 0
    for (const d of [TOOTH_D, 1]) {
      if (bestRun < d + 1) continue
      for (const side of [1, -1] as const) {
        const inserted: number[] = []
        let ok = true
        for (let k = 1; k <= d && ok; k++) inserted.push(lb + idxOf(mx + px * side * k, my + py * side * k))
        for (let k = d; k >= 1 && ok; k--) inserted.push(lb + idxOf(m1x + px * side * k, m1y + py * side * k))
        if (inserted.some((j) => used.has(j) || !cellFreeFor(j, ni))) continue
        path.splice(mid + 1, 0, ...inserted)
        for (const j of inserted) used.add(j)
        return 2 * d * RES
      }
    }
    return 0
  }

  /** [P1.2] Appariement de longueur : si le partenaire est déjà routé et que
   *  l'ARBRE COMPLET de ce net est trop court, pose des dents de peigne le long
   *  des tronçons droits des branches — les plus longues d'abord (plus de place)
   *  — jusqu'à revenir dans la tolérance. Comparer l'arbre entier (et non chaque
   *  branche isolément) au total du partenaire évite la sur-méandration : le
   *  besoin résiduel se transmet naturellement à la branche suivante. Les
   *  méandres sont posés AVANT la construction des segments → flux live,
   *  replay et résultat final parfaitement cohérents. */
  function tunePairTree(ni: number, paths: number[][], tree: Set<number>) {
    const partner = pairOf.get(ni)
    if (partner === undefined) return
    const st = routedStore.get(partner)
    if (!st) return // 1er membre de la paire (ou net à 1 broche) : rien à égaler
    const rawTotal = paths.reduce((s, p) => s + pathLengthMm(p), 0)
    const diff = rawTotal - st.lengthMm
    if (diff >= -DIFF_TOL) return // pas trop court — un membre long ne se raccourcit pas
    const used = new Set<number>(tree)
    for (const p of paths) for (const i of p) used.add(i)
    let need = st.lengthMm - rawTotal
    let added = 0
    // branches les plus longues d'abord : plus de tronçons droits pour loger des dents
    const order = paths.map((_, k) => k).sort((a, b) => pathLengthMm(paths[b]) - pathLengthMm(paths[a]))
    for (let guard = 0; guard < 400 && need > DIFF_TOL; guard++) {
      let progressed = false
      for (const k of order) {
        if (need <= DIFF_TOL) break
        const mm = insertTooth(paths[k], ni, used)
        if (mm > 0) { need -= mm; added += mm; progressed = true }
      }
      if (!progressed) break // plus aucune place pour une dent sur aucune branche
    }
    if (process.env.NEXUS_DEBUG)
      console.log(`[pair-tune][${routerCtx}] net=${nl.nets[ni].name} partenaire=${nl.nets[partner].name} diff=${diff.toFixed(2)} mm → méandres +${added.toFixed(2)} mm (reste ${Math.max(0, need).toFixed(2)} mm)`)
  }
  /** [DeepPCB live] émission des traces activée pendant la passe glouton uniquement —
   *  les re-routages internes (rip-up, via-min, ré-appariement) ne polluent pas le flux. */
  let emitLive = false
  let suppressEmit = false
  let routerCtx = 'init'

  /** Reconstruit les masques d'occupation depuis l'état des nets routés */
  function rebuildMasks() {
    occupied.fill(-1)
    dilated.fill(-1)
    pairCorridor.fill(-1)
    routedSet.clear()
    for (const k of routedStore.keys()) routedSet.add(k)
    for (const [ni2, st] of routedStore) {
      markPath(st.tree, ni2, st.vias)
      markCorridor(ni2)
    }
  }

  /** Tente de router entièrement un net (croissance d'arbre, broches les plus proches d'abord).
   *  Asynchrone et coopérative : à chaque branche posée, les traces fraîches sont émises
   *  au flux live puis une pause laisse le transport (SSE) ou le navigateur respirer. */
  async function attemptRoute(ni: number): Promise<{ ok: boolean; blockedAt?: number }> {
    const net = nl.nets[ni]
    const pinCells = netPinsCells.get(ni)!
    const w = widthOfNet(ni)
    const tree = new Set<number>([pinCells[0], pinCells[0] + cells])
    const allSegments: TraceSegment[] = []
    const allVias: Via[] = []
    let netLen = 0
    const remaining = pinCells.slice(1)

    const nearestFirst = () => {
      let best = 0, bestD = Infinity
      const tcs = [...tree].filter((t) => t < cells)
      for (let i = 0; i < remaining.length; i++) {
        const bx = remaining[i] % cols, by = Math.floor(remaining[i] / cols)
        let d = Infinity
        for (const t of tcs) {
          const ddx = Math.abs((t % cols) - bx), ddy = Math.abs(Math.floor(t / cols) - by)
          if (ddx + ddy < d) d = ddx + ddy
        }
        if (d < bestD) { bestD = d; best = i }
      }
      return best
    }

    if (process.env.NEXUS_DEBUG && pairOf.has(ni))
      console.log(`[attempt][${routerCtx}] ${net.name} pins=${pinCells.length} remaining=${remaining.length}`)

    /* Phase 1 — recherche brute branche par branche (arbre multi-broches).
     * Toutes les branches sont cherchées d'abord ; l'appariement [P1.2] et la
     * construction des segments interviennent ensuite (phases 2 et 3). */
    const branchPaths: number[][] = []
    while (remaining.length > 0) {
      const pick = nearestFirst()
      const target = remaining.splice(pick, 1)[0]
      // masse & puissance : tentative relâchée d'emblée (elles ont le droit de passer
      // dans les zones de clearance des autres, jamais sur leur cuivre)
      const relaxedFirst = net.cls === 'ground' || net.cls === 'power'
      let path = relaxedFirst ? search(tree, target, ni, true) : search(tree, target, ni)
      if (!path) path = search(tree, target, ni, true) // repli : clearance relâchée
      if (!path) {
        if (process.env.NEXUS_DEBUG) {
          const net2 = nl.nets[ni]
          const pin = net2.pins.find(({ ref, pin: p }) => padCell.get(`${ref}.${p}`) === target)
          const bx2 = target % cols, by2 = Math.floor(target / cols)
          const why = (i: number, relaxed2: boolean) => {
            const parts: string[] = []
            if (occupied[i] !== -1 && occupied[i] !== ni) parts.push(`occ=${occupied[i]}`)
            if (!relaxed2 && dilated[i] !== -1 && dilated[i] !== ni) parts.push(`dil=${dilated[i]}`)
            if (padNet[i] !== -1 && padNet[i] !== ni) parts.push(`pad=${padNet[i]}`)
            if (i >= cells) {
              const p1 = padNetL1[i - cells]
              if (p1 !== -1 && p1 !== ni && !routedSet.has(p1)) parts.push(`res=${p1}`)
            }
            if (keepBlock[i] && !isRfNet(ni) && padNet[i] !== ni) parts.push('keep')
            return parts.join(',') || 'OK'
          }
          console.log(`[route-fail] net=${net2.name} broche=${pin ? `${pin.ref}.${pin.pin}` : '?'} cellule=(${bx2},${by2})`)
          for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
            const nx2 = bx2 + dx, ny2 = by2 + dy
            if (nx2 < 0 || ny2 < 0 || nx2 >= cols || ny2 >= rows) continue
            console.log(`   L0(${nx2},${ny2}):${why(idxOf(nx2, ny2), true)} | L1:${why(cells + idxOf(nx2, ny2), true)}`)
          }
        }
        return { ok: false, blockedAt: target }
      }
      branchPaths.push(path)
      for (const i of path) tree.add(i)
    }

    /* Phase 2 — [P1.2] appariement de longueur : méandres posés sur l'arbre
     * COMPLET (comparé au total du partenaire) AVANT toute construction de
     * segments — le besoin résiduel d'une branche se transmet à la suivante.
     * Flux live, replay et résultat final parfaitement cohérents. */
    tunePairTree(ni, branchPaths, tree)
    for (const path of branchPaths) for (const i of path) tree.add(i) // dents incluses

    /* Phase 3 — construction des segments + vias, émission live par branche */
    for (const path of branchPaths) {
      const built = buildPathSegments(ni, path)
      allSegments.push(...built.segments)
      allVias.push(...built.vias)
      netLen += built.lengthMm

      /* [DeepPCB live] émission des traces fraîches + respiration du transport */
      if (emitLive && !suppressEmit && opts.onTrace && (built.segments.length > 0 || built.vias.length > 0)) {
        for (const segment of built.segments) opts.onTrace({ type: 'segment', net: net.name, segment })
        for (const via of built.vias) opts.onTrace({ type: 'via', net: net.name, via })
        await sleep(opts.pacingMs && opts.pacingMs > 0 ? opts.pacingMs : 0)
      }
    }

    const seenVia = new Set<string>()
    const uniqVias = allVias.filter((v) => {
      const k = `${v.x},${v.y}`
      if (seenVia.has(k)) return false
      seenVia.add(k); return true
    })
    markPath([...tree], ni, uniqVias)
    routedSet.add(ni)
    routedStore.set(ni, { segments: allSegments, vias: uniqVias, tree: [...tree], paths: branchPaths, lengthMm: netLen })
    markCorridor(ni)
    return { ok: true }
  }

  /** Trouve le net routé dont le cuivre bloque le plus la broche en échec
   *  (en excluant les rip-ups déjà tentés et échoués pour ce net) */
  function findBlocker(fi: number, blockedAt: number): number {
    const bx2 = blockedAt % cols, by2 = Math.floor(blockedAt / cols)
    const tried = triedRip.get(fi) ?? new Set<number>()
    let best = -1, bestD = Infinity
    for (const [ri, st] of routedStore) {
      // [P1.2] les membres d'une paire différentielle ne sont jamais déchirés :
      // leur longueur appariée est garantie par la passe de réconciliation
      if (ri === fi || tried.has(ri) || pairOf.has(ri)) continue
      for (let i = 0; i < st.tree.length; i += 2) {
        const c = st.tree[i] % cells
        const d = Math.abs((c % cols) - bx2) + Math.abs(Math.floor(c / cols) - by2)
        if (d < bestD) { bestD = d; best = ri }
      }
    }
    return best
  }

  /* ---- Passe 1 : routage glouton par criticité (flux live activé) ---- */
  opts.onPhase?.('greedy')
  routerCtx = 'greedy'
  emitLive = true
  for (const net of ordered) {
    if (opts.shouldCancel?.()) break
    const ni = netIndex.get(net.name)!
    const pinCells = netPinsCells.get(ni)!
    if (pinCells.length < 2) {
      done++
      opts.onProgress?.({ done, total: ordered.length, net: net.name, ok: true })
      continue
    }
    // [P1.1] rails principaux 4 couches : connectés par les plans dédiés (passe « pour »)
    if (L4 && (ni === gndMain || ni === pwrMain)) {
      done++
      opts.onProgress?.({ done, total: ordered.length, net: `${net.name} (plan dédié)`, ok: true })
      continue
    }
    const r = await attemptRoute(ni)
    if (!r.ok) failedNets.add(ni)
    done++
    opts.onProgress?.({ done, total: ordered.length, net: net.name, ok: r.ok })
  }
  emitLive = false

  /* ---- Passe 2 : RIP-UP & REROUTE (jusqu'à 8 rounds, rip multi-bloquants) ---- */
  opts.onPhase?.('ripup')
  routerCtx = 'ripup'
  for (let round = 0; round < 8 && failedNets.size > 0; round++) {
    if (opts.shouldCancel?.()) break
    let progress = false
    for (const fi of [...failedNets]) {
      if (opts.shouldCancel?.()) break
      const probe = await attemptRoute(fi)
      const blockedAt = probe.blockedAt
      if (blockedAt === undefined) { failedNets.delete(fi); triedRip.delete(fi); progress = true; continue }
      const blocker = findBlocker(fi, blockedAt)
      if (blocker === -1) continue
      const snapshot = new Map(routedStore)
      const blockerNet = nl.nets[blocker].name
      routedStore.delete(blocker)
      rebuildMasks()
      const rF = await attemptRoute(fi)
      if (rF.ok) {
        failedNets.delete(fi)
        triedRip.delete(fi)
        opts.onProgress?.({ done, total: ordered.length, net: `${nl.nets[fi].name} (rip-up de ${blockerNet})`, ok: true })
        const rB = await attemptRoute(blocker)
        if (!rB.ok) failedNets.add(blocker)
        progress = true
      } else {
        // Échec : mémorise ce bloquant pour tenter le suivant au prochain round
        if (!triedRip.has(fi)) triedRip.set(fi, new Set())
        triedRip.get(fi)!.add(blocker)
        routedStore.clear()
        for (const [k, v] of snapshot) routedStore.set(k, v)
        rebuildMasks()
      }
    }
    if (!progress) break
  }

  /* ---- Passe 2b : MINIMISATION DES VIAS [DeepPCB via_minimizer] ----
   * Chaque net routé possédant des vias est re-routé avec un coût de via
   * fortement majoré : si une variante avec moins de transitions de couche
   * existe dans l'espace libre actuel, elle remplace la première passe.
   * Garde-fou : longueur acceptée jusqu'à +30 % (+2 mm) — un via coûte plus
   * cher qu'un détour (fiabilité, insertion, fabrication). */
  let viasRemoved = 0
  {
    opts.onPhase?.('via-min')
    routerCtx = 'via-min'
    viaCost = 46
    // [P1.2] les membres d'une paire différentielle sont exclus : leur longueur
    // appariée prime sur l'économie de vias
    const candidates = [...routedStore.keys()].filter((ni) => routedStore.get(ni)!.vias.length > 0 && !pairOf.has(ni))
    for (const ni of candidates) {
      if (opts.shouldCancel?.()) break
      const before = routedStore.get(ni)!
      routedStore.delete(ni)
      rebuildMasks()
      const r = await attemptRoute(ni)
      const after = routedStore.get(ni)
      if (r.ok && after && after.vias.length < before.vias.length && after.lengthMm <= before.lengthMm * 1.3 + 2) {
        viasRemoved += before.vias.length - after.vias.length
        opts.onProgress?.({ done, total: ordered.length, net: `${nl.nets[ni].name} (−${before.vias.length - after.vias.length} via)`, ok: true })
      } else {
        // Variante pas assez bonne → restauration de la route d'origine
        routedStore.set(ni, before)
        rebuildMasks()
      }
    }
    viaCost = 14
  }

  /* ---- Passe 2c : RÉCONCILIATION DES PAIRES [P1.2] ----
   * Après stabilisation (rip-up et via-min terminés, membres intouchables),
   * chaque paire dont le skew dépasse la tolérance est rapprochée en méandrant
   * le membre le PLUS COURT — quel que soit son ordre de routage — par dents
   * de peigne insérées dans ses branches enregistrées (jamais sur le cuivre du
   * partenaire ni d'un tiers), puis segments reconstruits via buildPathSegments.
   * Les dents n'ajoutent aucun via : les transitions de couche d'origine
   * restent valides. Live/replay non pollués (passe silencieuse). */
  {
    opts.onPhase?.('tune')
    routerCtx = 'recon'
    suppressEmit = true
    for (const [a, b] of pairOf) {
      if (opts.shouldCancel?.()) break
      if (a > b) continue
      const sa = routedStore.get(a), sb = routedStore.get(b)
      if (!sa || !sb) continue
      const skew0 = Math.abs(sa.lengthMm - sb.lengthMm)
      if (skew0 <= DIFF_TOL) continue
      const shortNi = sa.lengthMm < sb.lengthMm ? a : b
      const longNi = shortNi === a ? b : a
      const stS = routedStore.get(shortNi)!
      const stL = routedStore.get(longNi)!
      let need = skew0
      const used = new Set<number>()
      for (const p of [...stS.paths, ...stL.paths]) for (const i of p) used.add(i)
      // branches les plus longues d'abord : plus de tronçons droits pour loger des dents
      const order = stS.paths.map((_, k) => k).sort((x, y) => pathLengthMm(stS.paths[y]) - pathLengthMm(stS.paths[x]))
      for (let guard = 0; guard < 400 && need > DIFF_TOL; guard++) {
        let progressed = false
        for (const k of order) {
          if (need <= DIFF_TOL) break
          const mm = insertTooth(stS.paths[k], shortNi, used)
          if (mm > 0) { need -= mm; progressed = true }
        }
        if (!progressed) break // plus aucune place pour une dent
      }
      if (need > DIFF_TOL && process.env.NEXUS_DEBUG)
        console.log(`[pair-recon][${routerCtx}] ${nl.nets[a].name}↔${nl.nets[b].name} : besoin résiduel ${need.toFixed(2)} mm — plus de place pour des dents`)
      // reconstruction des segments du membre méandré + remise à jour des masques
      const newSegs: TraceSegment[] = []
      let newLen = 0
      for (const p of stS.paths) {
        const built = buildPathSegments(shortNi, p)
        newSegs.push(...built.segments)
        newLen += built.lengthMm
      }
      const treeS = new Set<number>(stS.tree)
      for (const p of stS.paths) for (const i of p) treeS.add(i)
      routedStore.set(shortNi, { segments: newSegs, vias: stS.vias, tree: [...treeS], paths: stS.paths, lengthMm: newLen })
      rebuildMasks()
      const skew1 = Math.abs(newLen - stL.lengthMm)
      if (skew1 < skew0) {
        opts.onProgress?.({ done, total: ordered.length, net: `${nl.nets[a].name} ↔ ${nl.nets[b].name} appariés (skew ${skew1.toFixed(2)} mm)`, ok: true })
        if (process.env.NEXUS_DEBUG)
          console.log(`[pair-recon][${routerCtx}] ${nl.nets[shortNi].name} méandré → skew ${skew0.toFixed(2)} → ${skew1.toFixed(2)} mm`)
      }
    }
    suppressEmit = false
  }

  /* ---- Passe 3 : plans cuivre / pour de masse ----
   * 4 couches [P1.1] : plans dédiés masse (In2.Cu) et alim (B.Cu) générés par
   * flood-fill monocouche — antipads autour des vias étrangers, pads du net
   * propriétaire intégrés au plan ; les rails secondaires restent routés.
   * 2 couches : plan de masse synthétique bicouche pour les nets de masse
   * irroutables (toutes les cellules libres, inondées depuis les pads de masse). */
  let groundPour: RoutingSolution['groundPour'] | undefined
  const planes: RoutingSolution['planes'] = []
  opts.onPhase?.('pour')
  if (L4) {
    // antipads : les vias des nets déjà routés percent les plans — clearance
    // autour du PERÇAGE (drill/2 + clearance), pas de l'anneau
    const viaAnti = new Int16Array(total).fill(-1)
    const viaAntiR = Math.max(1, Math.ceil((rules.minDrill / 2 + rules.clearance) / RES))
    for (const [ni2, st] of routedStore) {
      for (const v of st.vias) {
        const vx = Math.min(cols - 1, Math.max(0, Math.round(v.x / RES)))
        const vy = Math.min(rows - 1, Math.max(0, Math.round(v.y / RES)))
        for (let l = 2; l < L; l++)
          for (let dy = -viaAntiR; dy <= viaAntiR; dy++)
            for (let dx = -viaAntiR; dx <= viaAntiR; dx++) {
              const nx = vx + dx, ny = vy + dy
              if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
              const j = l * cells + idxOf(nx, ny)
              if (viaAnti[j] === -1) viaAnti[j] = ni2
            }
      }
    }
    const buildPlane = (ni: number, layer: number): NonNullable<RoutingSolution['planes']>[number] | null => {
      const pins = netPinsCells.get(ni)!
      if (!pins || pins.length < 2) return null
      // les pads du net propriétaire sont sacrés : le plan les rejoint toujours
      const free = (base: number) => {
        if (edgeBlock[base]) return false
        if (padNet[base] === ni) return true
        return viaAnti[layer * cells + base] === -1 && padNet[base] === -1
      }
      // flood multi-source : une source par pad non encore couvert (le plan peut
      // former plusieurs îlots du même net autour des champs de pads denses)
      const region = new Set<number>()
      const flood = (start: number) => {
        if (region.has(start) || !free(start)) return false
        const queue: number[] = [start]
        region.add(start)
        while (queue.length > 0) {
          const cur = queue.pop()!
          const cx = cur % cols, cy = Math.floor(cur / cols)
          const nbs: number[] = []
          if (cx > 0) nbs.push(cur - 1)
          if (cx < cols - 1) nbs.push(cur + 1)
          if (cy > 0) nbs.push(cur - cols)
          if (cy < rows - 1) nbs.push(cur + cols)
          for (const nb of nbs) {
            if (region.has(nb) || !free(nb)) continue
            region.add(nb)
            queue.push(nb)
          }
        }
        return true
      }
      const bases = pins.map((p) => p % cells)
      for (const b of bases) flood(b)
      for (const b of bases) if (!region.has(b)) return null // pad scellé de toutes parts
      if (region.size < 1) return null
      const net = nl.nets[ni]
      return {
        layer, net: net.name, cls: net.cls === 'power' ? 'power' : 'ground',
        cells: [...region].map((b) => ({
          x: Math.round(((b % cols) * RES + RES / 2) * 100) / 100,
          y: Math.round((Math.floor(b / cols) * RES + RES / 2) * 100) / 100,
        })),
        cols, rows, res: RES,
      }
    }
    const tryPlane = async (ni: number, layer: number) => {
      if (ni === -1) return
      const pl = buildPlane(ni, layer)
      if (pl) {
        planes.push(pl)
        opts.onProgress?.({ done, total: ordered.length, net: `${pl.net} (plan cuivre L${layer} · ${pl.cells.length} cellules)`, ok: true })
      } else {
        // repli : routage A* classique sur la paire signal
        const r = await attemptRoute(ni)
        if (!r.ok) failedNets.add(ni)
        opts.onProgress?.({ done, total: ordered.length, net: nl.nets[ni].name, ok: r.ok })
      }
    }
    await tryPlane(gndMain, 2)
    await tryPlane(pwrMain, 3)
  } else {
  for (const fi of [...failedNets]) {
    if (nl.nets[fi].cls !== 'ground') continue
    const pins = netPinsCells.get(fi)!
    const niG = fi
    // Inondation bicouche : cellules libres L0+L1 reliées par transitions de couche
    const freeCell = (node: number): boolean => {
      const layer = node < cells ? 0 : 1
      const base = node % cells
      if (layer === 0) {
        if (occupied[base] !== -1 || bodyBlocked[base]) return false
        const pn = padNet[base]
        return pn === -1 || pn === niG
      }
      return occupied[cells + base] === -1
    }
    const start0 = pins[0]
    if (!freeCell(start0) || !freeCell(cells + start0)) continue
    const region = new Set<number>([start0, cells + start0])
    const queue: number[] = [start0, cells + start0]
    while (queue.length > 0) {
      const cur = queue.pop()!
      const layer = cur < cells ? 0 : 1
      const base = cur % cells
      const cx = base % cols, cy = Math.floor(base / cols)
      const neighbors: number[] = []
      if (cx > 0) neighbors.push(cur - 1)
      if (cx < cols - 1) neighbors.push(cur + 1)
      if (cy > 0) neighbors.push(cur - cols)
      if (cy < rows - 1) neighbors.push(cur + cols)
      neighbors.push(layer === 0 ? cells + base : base) // via
      for (const nb of neighbors) {
        if (nb < 0 || nb >= total) continue
        if (region.has(nb) || !freeCell(nb)) continue
        region.add(nb)
        queue.push(nb)
      }
    }
    // Tous les pads de masse doivent appartenir au plan
    if (!pins.every((p) => region.has(p))) {
      if (process.env.NEXUS_DEBUG) {
        const reached = pins.filter((p) => region.has(p)).length
        console.log(`[pour] net=${nl.nets[fi].name} région bicouche=${region.size} cellules, pads joints=${reached}/${pins.length} — ÎLOTS SÉPARÉS`)
      }
      continue
    }
    failedNets.delete(fi)
    const toMm = (node: number) => {
      const base = node % cells
      return {
        x: Math.round(((base % cols) * RES + RES / 2) * 100) / 100,
        y: Math.round((Math.floor(base / cols) * RES + RES / 2) * 100) / 100,
      }
    }
    groundPour = {
      top: [...region].filter((n) => n < cells).map(toMm),
      bottom: [...region].filter((n) => n >= cells).map(toMm),
      cols, rows, res: RES,
    }
    opts.onProgress?.({ done, total: ordered.length, net: `${nl.nets[fi].name} (plan de masse synthétique bicouche)`, ok: true })
  }
  }

  /* ---- Résultats finaux ---- */
  // [P1.2] métadonnées d'appariement (état final, après rip-up et via-min)
  const pairMeta = new Map<number, Route['pair']>()
  {
    const pairDone = new Set<number>()
    for (const [a, b] of pairOf) {
      if (pairDone.has(a) || pairDone.has(b)) continue
      pairDone.add(a); pairDone.add(b)
      const sa = routedStore.get(a), sb = routedStore.get(b)
      if (!sa || !sb) continue
      const skew = Math.abs(sa.lengthMm - sb.lengthMm)
      let minD = Infinity
      outer: for (const i of sa.tree) {
        const x1 = i % cols, y1 = Math.floor((i % cells) / cols)
        for (const j of sb.tree) {
          const d = Math.abs(x1 - (j % cols)) + Math.abs(y1 - Math.floor((j % cells) / cols))
          if (d < minD) { minD = d; if (minD <= 1) break outer }
        }
      }
      const gapMm = Math.max(0, (minD - 1) * RES)
      const meta = { partner: nl.nets[b].name, skewMm: Math.round(skew * 100) / 100, gapMm: Math.round(gapMm * 100) / 100, matched: skew <= DIFF_TOL }
      pairMeta.set(a, meta)
      pairMeta.set(b, { ...meta, partner: nl.nets[a].name })
    }
  }

  const routes: Route[] = []
  let routedCount = 0
  let totalLen = 0
  let viaCount = 0
  for (const net of ordered) {
    const ni = netIndex.get(net.name)!
    const pinCells = netPinsCells.get(ni)!
    const st = routedStore.get(ni)
    if (st) {
      routedCount++
      totalLen += st.lengthMm
      viaCount += st.vias.length
      const pr = pairMeta.get(ni)
      routes.push({ net: net.name, segments: st.segments, vias: st.vias, lengthMm: Math.round(st.lengthMm * 10) / 10, routed: true, ...(pr ? { pair: pr } : {}) })
    } else if (groundPour && nl.nets[ni].cls === 'ground') {
      routedCount++
      routes.push({ net: net.name, segments: [], vias: [], lengthMm: 0, routed: true, pour: true })
    } else if (planes.some((p) => p.net === net.name)) {
      routedCount++
      routes.push({ net: net.name, segments: [], vias: [], lengthMm: 0, routed: true, pour: true })
    } else if (pinCells.length < 2) {
      routedCount++
      routes.push({ net: net.name, segments: [], vias: [], lengthMm: 0, routed: true })
    } else {
      routes.push({ net: net.name, segments: [], vias: [], lengthMm: 0, routed: false, failureReason: 'Aucun chemin libre — rip-up épuisé' })
    }
  }

  return {
    routes,
    routedNets: routedCount,
    totalNets: ordered.length,
    totalLengthMm: Math.round(totalLen * 10) / 10,
    viaCount,
    viasRemoved,
    groundPour,
    planes: planes.length > 0 ? planes : undefined,
    durationMs: Date.now() - t0,
  }
}
