/**
 * NEXUS PCB — Exporteur ODB++ [audit P2.1]
 * Équivalent : services/exporter/odb_generator/
 *
 * Génère un package ODB++ (ASCII, sous-set fidèle) livré en .tgz :
 *   <job>/matrix/matrix                    — registre des couches
 *   <job>/steps/step/stephdr               — en-tête du step (dimensions)
 *   <job>/steps/step/outline               — contour de carte
 *   <job>/steps/step/layers/<c>/lines      — pistes (coordonnées µm)
 *   <job>/steps/step/layers/<c>/pads       — pads composants + vias
 *   <job>/steps/step/layers/drill/drill    — perçage (outils + hits)
 *   <job>/steps/step/netlist               — nets (PATH + VIA + PINS)
 *
 * Sous-set assumé : lignes, pads, vias, perçage, netlist — les plans cuivre
 * (pour) restent dans l'export RS-274X/X2 de référence. Le tar ustar est
 * construit à la main (zéro dépendance) puis compressé via CompressionStream.
 */
import type { Netlist, PlacedComponent, RoutingSolution } from './types'
import { padWorldPos } from './world-model'

export interface OdbTextFile {
  path: string // chemin relatif dans le job : "job/steps/step/layers/f_cu/lines"
  content: string
}

export interface OdbJob {
  jobName: string
  files: OdbTextFile[]
  layerNames: string[]
  stats: { lines: number; pads: number; vias: number; drills: number }
}

/** Nom de job ODB : lettre initiale + [A-Za-z0-9_] uniquement. */
function jobNameOf(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `nexus_${cleaned}`
}

/** mm → µm entier (unité ODB des fichiers de features). */
const um = (mm: number) => Math.round(mm * 1000)

/** Symbole rond ODB : r<diamètre en µm>. */
const symRound = (diaMm: number) => `r${um(diaMm)}`
/** Symbole rectangle ODB : rect<largeur>x<hauteur> en µm. */
const symRect = (wMm: number, hMm: number) => `rect${um(wMm)}x${um(hMm)}`

/** Noms de couches cuivre ODB dans l'ordre de la pile. */
function layerNames(layers: number): string[] {
  if (layers >= 4) return ['f_cu', 'in1_cu', 'in2_cu', 'b_cu']
  return ['f_cu', 'b_cu']
}

/** Entête commun des fichiers de features ODB. */
function featureHeader(): string {
  return [
    '#',
    '# NEXUS PCB — feature file (ODB++ ASCII sous-set [P2.1])',
    `# Généré le ${new Date().toISOString()}`,
    '#',
    'UNITS=UM',
    'ANGLE_DIRECTION=CCW',
    '#',
  ].join('\n')
}

export function buildOdbJob(
  nl: Netlist,
  placements: PlacedComponent[],
  routing: RoutingSolution,
): OdbJob {
  const job = jobNameOf(nl.id)
  const names = layerNames(nl.board.layers)
  const compByRef = new Map(nl.components.map((c) => [c.ref, c]))

  const stats = { lines: 0, pads: 0, vias: 0, drills: 0 }

  /* ---------- Fichiers de cuivre : lines + pads par couche ---------- */
  const files: OdbTextFile[] = []
  for (const ln of names) {
    const layerIdx = names.indexOf(ln)
    // --- lines : pistes posées sur cette couche ---
    const lines: string[] = [featureHeader()]
    for (const r of routing.routes) {
      for (const s of r.segments) {
        if (s.layer !== layerIdx) continue
        for (let i = 1; i < s.pts.length; i++) {
          lines.push(
            `L ${um(s.pts[i - 1].x)} ${um(s.pts[i - 1].y)} ${um(s.pts[i].x)} ${um(s.pts[i].y)} ${symRound(s.width)}`,
          )
          stats.lines++
        }
      }
    }
    files.push({ path: `${job}/steps/step/layers/${ln}/lines`, content: lines.join('\n') + '\n' })

    // --- pads : pads de composants (top uniquement, cf. RS-274X) + vias ---
    const pads: string[] = [featureHeader()]
    if (layerIdx === 0) {
      for (const p of placements) {
        const c = compByRef.get(p.ref)
        if (!c) continue
        for (const pd of c.footprint.pads) {
          const w = padWorldPos(p, pd)
          pads.push(`P ${um(w.x)} ${um(w.y)} ${symRect(pd.w, pd.h)} 0 0`)
          stats.pads++
        }
      }
    }
    if (layerIdx === 0 || layerIdx === names.length - 1) {
      for (const r of routing.routes) {
        for (const v of r.vias) {
          pads.push(`P ${um(v.x)} ${um(v.y)} ${symRound(v.diameter)} 0 0`)
          stats.vias++
        }
      }
    }
    files.push({ path: `${job}/steps/step/layers/${ln}/pads`, content: pads.join('\n') + '\n' })
  }

  /* ---------- Contour ---------- */
  const outline: string[] = [
    featureHeader(),
    `L 0 0 ${um(nl.board.w)} 0 ${symRound(0.15)}`,
    `L ${um(nl.board.w)} 0 ${um(nl.board.w)} ${um(nl.board.h)} ${symRound(0.15)}`,
    `L ${um(nl.board.w)} ${um(nl.board.h)} 0 ${um(nl.board.h)} ${symRound(0.15)}`,
    `L 0 ${um(nl.board.h)} 0 0 ${symRound(0.15)}`,
  ]
  files.push({ path: `${job}/steps/step/outline`, content: outline.join('\n') + '\n' })

  /* ---------- Perçage : outils par diamètre + hits ---------- */
  const vias = routing.routes.flatMap((r) => r.vias)
  const byDrill = new Map<number, { x: number; y: number }[]>()
  const seen = new Set<string>()
  for (const v of vias) {
    const k = `${v.x.toFixed(3)},${v.y.toFixed(3)}`
    if (seen.has(k)) continue
    seen.add(k)
    const arr = byDrill.get(v.drill) ?? []
    arr.push({ x: v.x, y: v.y })
    byDrill.set(v.drill, arr)
    stats.drills++
  }
  if (byDrill.size > 0) {
    const drill: string[] = [
      '#',
      '# NEXUS PCB — drill (ODB++ ASCII)',
      `# Généré le ${new Date().toISOString()}`,
      '#',
      'UNITS=UM',
    ]
    let t = 1
    const toolOf = new Map<number, number>()
    for (const dia of [...byDrill.keys()].sort((a, b) => a - b)) {
      toolOf.set(dia, t)
      drill.push(`TOOL T${t} C=${um(dia)}`)
      t++
    }
    for (const [dia, hits] of byDrill) {
      for (const h of hits) drill.push(`T${toolOf.get(dia)} ${um(h.x)} ${um(h.y)}`)
    }
    files.push({ path: `${job}/steps/step/layers/drill/drill`, content: drill.join('\n') + '\n' })
  }

  /* ---------- Netlist : NET { PATH + VIA + PINS } ---------- */
  const padsByNet = new Map<string, { ref: string; pin: string }[]>()
  for (const p of placements) {
    const c = compByRef.get(p.ref)
    if (!c) continue
    for (const pd of c.footprint.pads) {
      const net = c.pins[pd.pin]
      if (!net) continue
      const arr = padsByNet.get(net) ?? []
      arr.push({ ref: p.ref, pin: pd.pin })
      padsByNet.set(net, arr)
    }
  }
  const netlist: string[] = [
    '#',
    '# NEXUS PCB — netlist (ODB++ ASCII sous-set)',
    `# Généré le ${new Date().toISOString()}`,
    '#',
    'UNITS=UM',
  ]
  const routedNets = new Set(routing.routes.map((r) => r.net))
  for (const r of routing.routes) {
    netlist.push('NET {')
    netlist.push(`  NETNAME=${sanitizeNetName(r.net)}`)
    if (padsByNet.has(r.net)) {
      netlist.push('  PINS {')
      for (const pin of padsByNet.get(r.net)!) netlist.push(`    REFDES=${pin.ref} PIN_NUM=${pin.pin}`)
      netlist.push('  }')
    }
    // Paths par couche (séquence de points)
    const byLayer = new Map<number, { x: number; y: number }[]>()
    for (const s of r.segments) {
      const arr = byLayer.get(s.layer) ?? []
      if (arr.length === 0) arr.push(s.pts[0])
      else {
        const last = arr[arr.length - 1]
        if (last.x !== s.pts[0].x || last.y !== s.pts[0].y) arr.push(s.pts[0])
      }
      for (let i = 1; i < s.pts.length; i++) arr.push(s.pts[i])
      byLayer.set(s.layer, arr)
    }
    for (const [layer, pts] of byLayer) {
      netlist.push(`  PATH {`)
      netlist.push(`    LAYER=${names[layer] ?? `l${layer}`}`)
      for (const pt of pts) netlist.push(`    { ${um(pt.x)} ${um(pt.y)} }`)
      netlist.push('  }')
    }
    for (const v of r.vias) {
      netlist.push(`  VIA { ${um(v.x)} ${um(v.y)} PAD_STACK=${symRound(v.diameter)} DRILLED_SIZE=${um(v.drill)} }`)
    }
    netlist.push('}')
  }
  // Nets non routés (pads seul) — traçabilité
  for (const [net, pins] of padsByNet) {
    if (routedNets.has(net)) continue
    netlist.push('NET {')
    netlist.push(`  NETNAME=${sanitizeNetName(net)}`)
    netlist.push('  PINS {')
    for (const pin of pins) netlist.push(`    REFDES=${pin.ref} PIN_NUM=${pin.pin}`)
    netlist.push('  }')
    netlist.push('}')
  }
  files.push({ path: `${job}/steps/step/netlist`, content: netlist.join('\n') + '\n' })

  /* ---------- stephdr ---------- */
  const stephdr = [
    'STEP {',
    `  NAME=step`,
    `  COL=1`,
    `  ROW=1`,
    `  SIZE_X=${um(nl.board.w)}`,
    `  SIZE_Y=${um(nl.board.h)}`,
    '}',
  ]
  files.push({ path: `${job}/steps/step/stephdr`, content: stephdr.join('\n') + '\n' })

  /* ---------- matrix ---------- */
  const matrix: string[] = ['MATRIX {']
  names.forEach((ln, i) => {
    const side = i === 0 ? 'TOP' : i === names.length - 1 ? 'BOTTOM' : 'INTERNAL'
    matrix.push('  ROW {')
    matrix.push(`    NAME=${ln}`)
    matrix.push(`    TYPE=SIGNAL`)
    matrix.push(`    SIDE=${side}`)
    matrix.push('  }')
  })
  if (byDrill.size > 0) {
    matrix.push('  ROW {')
    matrix.push('    NAME=drill')
    matrix.push('    TYPE=DRILL')
    matrix.push('    SIDE=ALL')
    matrix.push('  }')
  }
  matrix.push('}')
  files.push({ path: `${job}/matrix/matrix`, content: matrix.join('\n') + '\n' })

  return { jobName: job, files, layerNames: names, stats }
}

/** Noms de nets ODB : ASCII sûr (l'export RS-274X conserve le nom d'origine). */
function sanitizeNetName(net: string): string {
  return net.replace(/[^A-Za-z0-9_.\-+/]/g, '_')
}

/* ============================ Tar ustar + gzip ============================ */

const octal = (n: number, len: number) => n.toString(8).padStart(len, '0')

/** Construit une archive tar ustar (100 % main, zéro dépendance). */
export function buildTar(files: OdbTextFile[]): Uint8Array {
  const enc = new TextEncoder()
  const blocks: Uint8Array[] = []
  let total = 0
  for (const f of files) {
    const data = enc.encode(f.content)
    const header = new Uint8Array(512)
    const nameBytes = enc.encode(f.path)
    if (nameBytes.length > 100) throw new Error(`Chemin ODB++ trop long (>100) : ${f.path}`)
    header.set(nameBytes, 0)
    const put = (off: number, s: string) => header.set(enc.encode(s), off)
    put(100, '0000644\0') // mode
    put(108, '0000000\0') // uid
    put(116, '0000000\0') // gid
    put(124, `${octal(data.length, 11)} `) // size
    put(136, `${octal(Math.floor(Date.now() / 1000), 11)} `) // mtime
    header.set(enc.encode('        '), 148) // checksum placeholder (espaces)
    header[156] = 0x30 // typeflag '0' (fichier régulier)
    put(257, 'ustar\0') // magic
    put(263, '00') // version
    let sum = 0
    for (const b of header) sum += b
    put(148, `${octal(sum, 6)}\0 `)
    blocks.push(header, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(new Uint8Array(pad))
    total += 512 + data.length + pad
  }
  blocks.push(new Uint8Array(1024)) // fin d'archive
  total += 1024
  const out = new Uint8Array(total)
  let off = 0
  for (const b of blocks) {
    out.set(b, off)
    off += b.length
  }
  return out
}

/** Compresse le tar en gzip (CompressionStream natif) → Blob .tgz.
 *  Repli : tar brut si CompressionStream est indisponible. */
export async function tarGzBlob(files: OdbTextFile[]): Promise<Blob> {
  const tar = buildTar(files)
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream
  if (!CS) return new Blob([tar as BlobPart], { type: 'application/x-tar' })
  const stream = new Blob([tar as BlobPart]).stream().pipeThrough(new CS('gzip'))
  const buf = await new Response(stream).arrayBuffer()
  return new Blob([buf], { type: 'application/gzip' })
}
