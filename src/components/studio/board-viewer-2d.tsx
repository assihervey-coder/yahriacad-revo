'use client'
/**
 * NEXUS PCB — Viewer 2D de secours (Canvas 2D, zéro WebGL)
 * ---------------------------------------------------------
 * Activé automatiquement quand WebGL est indisponible (VM, navigateur durci,
 * sandbox « AllowWebgl2:false »). Rend la même information que le viewer 3D :
 * carte, pistes colorées par classe de net, vias dorés, plan de masse bicouche,
 * heatmap thermique, keepout RF et sélection des composants au clic.
 * Aucune dépendance GPU : rendu logiciel pur via l'API Canvas 2D.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStudio } from '@/lib/studio-store'
import { extractConstraints } from '@/lib/engine/parser'

const CATEGORY_COLOR: Record<string, string> = {
  mcu: '#101314', memory: '#1a1d1f', interface: '#1a1d1f',
  power: '#26221a', connector: '#8a8f98', passive: '#b08d57',
  crystal: '#9aa3ad', rf: '#2f2f33', sensor: '#1d2b23', led: '#351d1d',
}

const CLASS_COLOR: Record<string, string> = {
  signal: '#2dd4a0', power: '#f59e0b', ground: '#6b7280',
  highspeed: '#34d399', diffpair: '#fbbf24', analog: '#a3e635', rf: '#f472b6',
}

function heatRgb(t: number): [number, number, number] {
  // palette thermique identique au viewer 3D : noir → rouge → orange → jaune → blanc
  const stops: [number, [number, number, number]][] = [
    [0, [8, 4, 6]], [0.25, [96, 14, 22]], [0.5, [200, 60, 20]],
    [0.75, [246, 178, 40]], [1, [255, 250, 210]],
  ]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i]
      const k = (t - t0) / (t1 - t0)
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k]
    }
  }
  return [255, 250, 210]
}

export default function BoardViewer2D() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef({ s: 1, ox: 0, oy: 0 })
  const downRef = useRef<{ x: number; y: number } | null>(null)
  const dragRef = useRef<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const netlist = useStudio((s) => s.netlist)
  const placements = useStudio((s) => s.livePlacements)
  const result = useStudio((s) => s.result)
  const viewer = useStudio((s) => s.viewer)
  const setViewer = useStudio((s) => s.setViewer)
  const liveRoutes = useStudio((s) => s.liveRoutes)
  const liveActive = useStudio((s) => s.liveRouting.active)
  const liveCurrentNet = useStudio((s) => s.liveRouting.currentNet)
  const liveLastPoint = useStudio((s) => s.liveRouting.lastPoint)

  /* ------------------------- Rendu complet ------------------------- */
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const cw = parent.clientWidth, chh = parent.clientHeight
    if (cw === 0 || chh === 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(chh * dpr)) {
      canvas.width = Math.round(cw * dpr)
      canvas.height = Math.round(chh * dpr)
      canvas.style.width = `${cw}px`
      canvas.style.height = `${chh}px`
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const W = netlist.board.w, H = netlist.board.h
    const margin = 30
    const s = Math.min((cw - 2 * margin) / W, (chh - 2 * margin) / H)
    const ox = (cw - W * s) / 2
    const oy = (chh - H * s) / 2
    viewRef.current = { s, ox, oy }
    const X = (mm: number) => ox + mm * s
    const Y = (mm: number) => oy + mm * s

    // Fond
    ctx.fillStyle = '#05080a'
    ctx.fillRect(0, 0, cw, chh)

    // Substrat carte + bordure
    ctx.fillStyle = '#0a2e1c'
    ctx.fillRect(X(0), Y(0), W * s, H * s)
    ctx.strokeStyle = 'rgba(16,185,129,0.55)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(X(0), Y(0), W * s, H * s)

    const routing = result.routing

    // Plan de masse synthétique bicouche (texture offscreen 1 px/cellule)
    if (viewer.showTraces && routing?.groundPour) {
      const gp = routing.groundPour
      const makeTex = (cells: { x: number; y: number }[]) => {
        const tex = document.createElement('canvas')
        tex.width = gp.cols
        tex.height = gp.rows
        const tctx = tex.getContext('2d')
        if (!tctx) return null
        tctx.fillStyle = '#2b8a5f'
        for (const c of cells) {
          const cx = Math.floor(c.x / gp.res)
          const cy = Math.floor(c.y / gp.res)
          if (cx >= 0 && cx < gp.cols && cy >= 0 && cy < gp.rows) tctx.fillRect(cx, cy, 1, 1)
        }
        return tex
      }
      ctx.imageSmoothingEnabled = false
      const bottom = makeTex(gp.bottom)
      if (bottom) {
        ctx.globalAlpha = 0.30
        ctx.drawImage(bottom, X(0), Y(0), W * s, H * s)
      }
      const top = makeTex(gp.top)
      if (top) {
        ctx.globalAlpha = 0.45
        ctx.drawImage(top, X(0), Y(0), W * s, H * s)
      }
      ctx.globalAlpha = 1
      ctx.imageSmoothingEnabled = true
    }

    // Plans cuivre dédiés 4 couches [P1.1] : masse (vert) et alim (ambre), sous les pistes
    if (viewer.showTraces && routing?.planes?.length) {
      const drawPlane = (cells: { x: number; y: number }[], cols: number, rows: number, res: number, fill: string, alpha: number) => {
        const tex = document.createElement('canvas')
        tex.width = cols
        tex.height = rows
        const tctx = tex.getContext('2d')
        if (!tctx) return
        tctx.fillStyle = fill
        for (const c of cells) {
          const cx = Math.floor(c.x / res)
          const cy = Math.floor(c.y / res)
          if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) tctx.fillRect(cx, cy, 1, 1)
        }
        ctx.imageSmoothingEnabled = false
        ctx.globalAlpha = alpha
        ctx.drawImage(tex, X(0), Y(0), W * s, H * s)
      }
      for (const p of routing.planes)
        drawPlane(p.cells, p.cols, p.rows, p.res, p.cls === 'ground' ? '#2b8a5f' : '#a16207', p.cls === 'ground' ? 0.32 : 0.26)
      ctx.globalAlpha = 1
      ctx.imageSmoothingEnabled = true
    }

    // Heatmap thermique (texture offscreen + palette inferno)
    if (viewer.showHeatmap && result.thermal) {
      const th = result.thermal
      const tex = document.createElement('canvas')
      tex.width = th.cols
      tex.height = th.rows
      const tctx = tex.getContext('2d')
      if (tctx) {
        const img = tctx.createImageData(th.cols, th.rows)
        const range = Math.max(0.001, th.maxT - th.minT)
        for (let i = 0; i < th.temps.length; i++) {
          const t = (th.temps[i] - th.minT) / range
          const [r, g, b] = heatRgb(Math.pow(t, 0.85))
          img.data[i * 4] = r
          img.data[i * 4 + 1] = g
          img.data[i * 4 + 2] = b
          img.data[i * 4 + 3] = 255
        }
        tctx.putImageData(img, 0, 0)
        ctx.globalAlpha = 0.75
        ctx.drawImage(tex, X(th.originX), Y(th.originY), th.cols * th.cell * s, th.rows * th.cell * s)
        ctx.globalAlpha = 1
      }
    }

    // Pistes + vias — pendant un flux live [DeepPCB], on dessine les traces
    // reçues du routeur AU FIL DE L'EAU (le net en cours porte une lueur).
    if (viewer.showTraces) {
      const routes = liveActive ? liveRoutes : (routing?.routes ?? [])
      const netCls = new Map(netlist.nets.map((n) => [n.name, n.cls]))
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const r of routes) {
        const color = CLASS_COLOR[netCls.get(r.net) ?? 'signal'] ?? '#2dd4a0'
        const isCurrent = liveActive && r.net === liveCurrentNet
        if (isCurrent) {
          ctx.shadowColor = color
          ctx.shadowBlur = 9
        }
        for (const seg of r.segments) {
          if (seg.pts.length < 2) continue
          ctx.strokeStyle = color
          ctx.globalAlpha = [0.95, 0.6, 0.45, 0.4][seg.layer] ?? 0.95 // couches profondes atténuées
          ctx.lineWidth = Math.max(1, seg.width * s)
          ctx.beginPath()
          ctx.moveTo(X(seg.pts[0].x), Y(seg.pts[0].y))
          for (let i = 1; i < seg.pts.length; i++) ctx.lineTo(X(seg.pts[i].x), Y(seg.pts[i].y))
          ctx.stroke()
        }
        ctx.shadowBlur = 0
        ctx.globalAlpha = 1
        ctx.fillStyle = '#d4af37'
        for (const v of r.vias) {
          ctx.beginPath()
          ctx.arc(X(v.x), Y(v.y), Math.max(1.2, (v.diameter / 2) * s), 0, Math.PI * 2)
          ctx.fill()
        }
      }
      // Tête du routeur : dernier point posé, halo bleu ciel
      if (liveActive && liveLastPoint) {
        ctx.shadowColor = '#38bdf8'
        ctx.shadowBlur = 14
        ctx.fillStyle = '#7dd3fc'
        ctx.beginPath()
        ctx.arc(X(liveLastPoint.x), Y(liveLastPoint.y), 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }
    }

    // Keepout RF (rectangle hachuré rouge)
    if (placements) {
      const constraints = extractConstraints(netlist)
      for (const cst of constraints.filter((c) => c.kind === 'keepout')) {
        for (const ref of cst.refs) {
          const p = placements.find((x) => x.ref === ref)
          const c = netlist.components.find((x) => x.ref === ref)
          if (!p || !c) continue
          const m = cst.value ?? 5
          ctx.save()
          ctx.strokeStyle = 'rgba(239,68,68,0.7)'
          ctx.setLineDash([5, 4])
          ctx.lineWidth = 1.2
          ctx.strokeRect(
            X(p.x - c.footprint.w / 2 - m), Y(p.y - c.footprint.h / 2 - m),
            (c.footprint.w + 2 * m) * s, (c.footprint.h + 2 * m) * s,
          )
          ctx.restore()
        }
      }
    }

    // Composants (rectangles orientés, sélection émeraude)
    if (viewer.showComponents && placements) {
      ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const p of placements) {
        const c = netlist.components.find((x) => x.ref === p.ref)
        if (!c) continue
        const swap = p.rot === 90 || p.rot === 270
        const w = (swap ? c.footprint.h : c.footprint.w) * s
        const h = (swap ? c.footprint.w : c.footprint.h) * s
        const cx = X(p.x), cy = Y(p.y)
        const selected = viewer.selectedRef === p.ref
        ctx.fillStyle = selected ? 'rgba(16,185,129,0.9)' : (CATEGORY_COLOR[c.category] ?? '#333333')
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h)
        ctx.strokeStyle = selected ? '#6ee7b7' : 'rgba(110,231,183,0.25)'
        ctx.lineWidth = selected ? 2 : 1
        ctx.strokeRect(cx - w / 2, cy - h / 2, w, h)
        if (w > 32 && h > 14) {
          ctx.fillStyle = selected ? '#052e1a' : 'rgba(255,255,255,0.72)'
          ctx.fillText(p.ref, cx, cy)
        }
      }
    }
  }, [netlist, placements, result, viewer, liveRoutes, liveActive, liveCurrentNet, liveLastPoint])

  /* Redessin à chaque changement d'état */
  useEffect(() => { draw() }, [draw])

  /* Redessin au redimensionnement */
  useEffect(() => {
    const parent = canvasRef.current?.parentElement
    if (!parent) return
    const ro = new ResizeObserver(() => draw())
    ro.observe(parent)
    return () => ro.disconnect()
  }, [draw])

  /* Sélection au clic + DRAG & DROP direct (même interaction que le viewer 3D) */
  const hitTest = (mmX: number, mmY: number): string | null => {
    if (!placements) return null
    for (const p of placements) {
      const c = netlist.components.find((x) => x.ref === p.ref)
      if (!c) continue
      const swap = p.rot === 90 || p.rot === 270
      const w = swap ? c.footprint.h : c.footprint.w
      const h = swap ? c.footprint.w : c.footprint.h
      if (mmX >= p.x - w / 2 && mmX <= p.x + w / 2 && mmY >= p.y - h / 2 && mmY <= p.y + h / 2) return p.ref
    }
    return null
  }
  const toMm = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const { s, ox, oy } = viewRef.current
    return { mmX: (e.clientX - rect.left - ox) / s, mmY: (e.clientY - rect.top - oy) / s }
  }
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    downRef.current = { x: e.clientX, y: e.clientY }
    const { mmX, mmY } = toMm(e)
    const hit = hitTest(mmX, mmY)
    const s = useStudio.getState()
    if (hit && !s.running && !s.surgicalBusy && s.livePlacements) {
      // saisie directe : le composant devient draggable, la sélection suit
      dragRef.current = hit
      setDragging(true)
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* sans gravité */ }
      s.beginDrag(hit)
      setViewer({ selectedRef: hit })
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return
    const { mmX, mmY } = toMm(e)
    useStudio.getState().dragMoveTo(dragRef.current, mmX, mmY)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wasDrag = dragRef.current
    dragRef.current = null
    setDragging(false)
    if (wasDrag) {
      if (useStudio.getState().dragRef === wasDrag) void useStudio.getState().commitDrag(wasDrag)
      return // sélection déjà faite au pointerdown
    }
    const down = downRef.current
    downRef.current = null
    if (!down) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return
    const { mmX, mmY } = toMm(e)
    setViewer({ selectedRef: hitTest(mmX, mmY) })
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid="board-viewer-2d"
      className={`h-full w-full ${dragging ? 'cursor-grabbing' : 'cursor-crosshair'}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}
