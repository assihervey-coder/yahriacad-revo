'use client'
/**
 * NEXUS PCB — Viewer 3D temps réel (Three.js / WebGL)
 * Équivalent : frontend/src/components/viewer/
 *
 * Rendu de la carte en 3D : composants (hauteurs réalistes par catégorie),
 * pistes cuivre colorées par classe de net, vias dorés, heatmap thermique,
 * keepout RF. Sélection au clic + caméra orbitale + mode 2D (vue dessus).
 */
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useStudio } from '@/lib/studio-store'
import { extractConstraints } from '@/lib/engine/parser'
import BoardViewer2D from './board-viewer-2d'
import { LiveRoutingHud } from './live-hud'
import type { PlacedComponent, Route, ThermalMap } from '@/lib/engine/types'

/** Hauteurs de rendu des couches cuivre (0 = F.Cu … 3 = B.Cu) — pile 4 couches [P1.1] */
const LAYER_Y = [0.87, 0.29, -0.29, -0.87]

/** Détection WebGL sans exception — évite le crash « THREE.WebGLRenderer »
 *  sur les systèmes restreints (AllowWebgl2:false, VM, GPU bloqué). */
function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl2') || canvas.getContext('webgl'))
    )
  } catch {
    return false
  }
}

const CATEGORY_COLOR: Record<string, number> = {
  mcu: 0x101314, memory: 0x1a1d1f, interface: 0x1a1d1f,
  power: 0x26221a, connector: 0x8a8f98, passive: 0xb08d57,
  crystal: 0x9aa3ad, rf: 0x2f2f33, sensor: 0x1d2b23, led: 0x351d1d,
}

const CLASS_COLOR: Record<string, number> = {
  signal: 0x2dd4a0, power: 0xf59e0b, ground: 0x6b7280,
  highspeed: 0x34d399, diffpair: 0xfbbf24, analog: 0xa3e635, rf: 0xf472b6,
}

const COMP_HEIGHT: Record<string, number> = {
  mcu: 1.1, memory: 0.9, interface: 0.9, power: 1.3, connector: 1.7,
  passive: 0.45, crystal: 0.55, rf: 1.9, sensor: 0.7, led: 0.4,
}

function heatColor(t: number): [number, number, number] {
  // palette thermique noir → rouge → orange → jaune → blanc
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

/** Vide un groupe three.js en disposant TOUTES les ressources GPU — sans ce
 *  dispose, chaque reconstruction du traceGroup (à chaque trace du flux live !)
 *  fuit géométries et matériaux : la mémoire GPU explose, le contexte WebGL se
 *  perd (« Context Lost ») et l'onglet se fige après quelques sessions. */
function disposeGroupChildren(g: THREE.Group) {
  for (const child of g.children) {
    child.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const m = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(m)) m.forEach((x) => x.dispose())
      else m?.dispose()
    })
  }
  g.clear()
}

export default function BoardViewer() {
  const mountRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<{
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    renderer: THREE.WebGLRenderer
    controls: OrbitControls
    compGroup: THREE.Group
    traceGroup: THREE.Group
    heatMesh: THREE.Mesh
    pourMesh: THREE.Mesh
    pourMeshTop: THREE.Mesh
    keepGroup: THREE.Group
    boardW: number
    boardH: number
    raycaster: THREE.Raycaster
    targetCamPos: THREE.Vector3 | null
  } | null>(null)

  const netlist = useStudio((s) => s.netlist)
  const placements = useStudio((s) => s.livePlacements)
  const result = useStudio((s) => s.result)
  const viewer = useStudio((s) => s.viewer)
  const setViewer = useStudio((s) => s.setViewer)
  const surgicalMove = useStudio((s) => s.surgicalMove)
  const liveNudge = useStudio((s) => s.liveNudge)
  const undoSurgical = useStudio((s) => s.undoSurgical)
  const redoSurgical = useStudio((s) => s.redoSurgical)
  const surgicalBusy = useStudio((s) => s.surgicalBusy)
  const historyLen = useStudio((s) => s.placementHistory.length)
  const redoLen = useStudio((s) => s.redoStack.length)
  const pipelineRunning = useStudio((s) => s.running)
  const liveRoutes = useStudio((s) => s.liveRoutes)
  const liveActive = useStudio((s) => s.liveRouting.active)
  const liveCurrentNet = useStudio((s) => s.liveRouting.currentNet)
  const liveLastPoint = useStudio((s) => s.liveRouting.lastPoint)

  /** null = test en cours · true = WebGL OK · false = repli 2D logiciel */
  const [webglOk, setWebglOk] = useState<boolean | null>(null)

  /* ---------------- Nudge clavier [sans popup] ----------------
   * Sélectionner un composant puis piloter au clavier : flèches = pas fin
   * 0,5 mm (Maj = pas chirurgical 2 mm). Pendant un flux live → nudge live
   * (le routeur repart en direct), sinon chirurgie classique. Tout est lu
   * via getState() → un seul abonnement, jamais de closure périmée. */
  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
    }
    const onKey = (e: KeyboardEvent) => {
      if (isTyping()) return
      const s = useStudio.getState()
      // Ctrl/Cmd+Z — undo multi-niveaux · Ctrl/Cmd+Maj+Z / Ctrl+Y — redo (miroir)
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'z' && !e.shiftKey) {
          if (!s.running && !s.surgicalBusy && !s.liveRouting.active && s.placementHistory.length > 0) {
            e.preventDefault()
            void s.undoSurgical()
          }
          return
        }
        if ((k === 'z' && e.shiftKey) || k === 'y') {
          if (!s.running && !s.surgicalBusy && !s.liveRouting.active && s.redoStack.length > 0) {
            e.preventDefault()
            void s.redoSurgical()
          }
          return
        }
      }
      if (e.key === 'Escape') {
        if (s.viewer.selectedRef) s.setViewer({ selectedRef: null })
        return
      }
      const ref = s.viewer.selectedRef
      if (!ref || s.surgicalBusy || s.running) return
      const step = e.shiftKey ? 2 : 0.5
      let dx = 0
      let dy = 0
      if (e.key === 'ArrowUp') dy = -step
      else if (e.key === 'ArrowDown') dy = step
      else if (e.key === 'ArrowLeft') dx = -step
      else if (e.key === 'ArrowRight') dx = step
      else return
      e.preventDefault() // un nudge n'est jamais un scroll de page
      if (s.liveRouting.active) void s.liveNudge(ref, dx, dy)
      else void s.surgicalMove(ref, dx, dy)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ---------------- Initialisation de la scène ---------------- */
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    if (!isWebGLAvailable()) {
      setWebglOk(false)
      return
    }
    setWebglOk(true)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x05080a)
    scene.fog = new THREE.Fog(0x05080a, 120, 260)

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 500)
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch {
      // GPU réellement indisponible malgré le test de contexte — repli 2D
      setWebglOk(false)
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = false
    mount.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI * 0.52
    controls.minDistance = 8
    controls.maxDistance = 220

    // Lumières
    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const dir = new THREE.DirectionalLight(0xffffff, 1.1)
    dir.position.set(30, 60, 25)
    scene.add(dir)
    const rim = new THREE.PointLight(0x10b981, 24, 160)
    rim.position.set(-40, 18, -30)
    scene.add(rim)
    const rim2 = new THREE.PointLight(0xf59e0b, 14, 160)
    rim2.position.set(40, 12, 30)
    scene.add(rim2)

    // Sol grille
    const grid = new THREE.GridHelper(300, 60, 0x123322, 0x0b1d14)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.35
    grid.position.y = -2.4
    scene.add(grid)

    // Groupes
    const compGroup = new THREE.Group()
    const traceGroup = new THREE.Group()
    const keepGroup = new THREE.Group()
    const pourMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x1f6f4a, transparent: true, opacity: 0.32, depthWrite: false }),
    )
    pourMesh.rotation.x = -Math.PI / 2
    pourMesh.visible = false
    const pourMeshTop = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x1f6f4a, transparent: true, opacity: 0.22, depthWrite: false }),
    )
    pourMeshTop.rotation.x = -Math.PI / 2
    pourMeshTop.visible = false
    const heatMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.78, depthWrite: false }),
    )
    heatMesh.rotation.x = -Math.PI / 2
    scene.add(compGroup, traceGroup, keepGroup, heatMesh, pourMesh, pourMeshTop)

    // Raycast sélection + DRAG & DROP direct [souris]
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let downPos: { x: number; y: number } | null = null
    // état du drag : composant saisi + plan de saisie à la surface de la carte
    let dragTarget: string | null = null
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.8) // y = 0.8 mm (surface)
    const dragHit = new THREE.Vector3()
    const screenToNdc = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    }
    const onPointerDown = (e: PointerEvent) => {
      downPos = { x: e.clientX, y: e.clientY }
      // saisie directe : un composant sous le pointeur devient draggable —
      // la caméra (OrbitControls) s'efface pendant le geste
      screenToNdc(e)
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(compGroup.children, false)
      if (hits.length) {
        const ref = hits[0].object.userData.ref as string
        const s = useStudio.getState()
        if (!s.running && !s.surgicalBusy && s.livePlacements) {
          dragTarget = ref
          controls.enabled = false
          try { renderer.domElement.setPointerCapture(e.pointerId) } catch { /* sans gravité */ }
          s.beginDrag(ref)
          s.setViewer({ selectedRef: ref })
        }
      }
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragTarget) return
      screenToNdc(e)
      raycaster.setFromCamera(pointer, camera)
      if (!raycaster.ray.intersectPlane(dragPlane, dragHit)) return
      const eng = engineRef.current
      if (!eng) return
      // monde 3D → coordonnées carte (mm) — même repère que les placements
      useStudio.getState().dragMoveTo(dragTarget, dragHit.x + eng.boardW / 2, dragHit.z + eng.boardH / 2)
    }
    const onPointerUp = (e: PointerEvent) => {
      const wasDrag = dragTarget
      dragTarget = null
      controls.enabled = true
      if (wasDrag) {
        downPos = null
        try { renderer.domElement.releasePointerCapture(e.pointerId) } catch { /* déjà libéré */ }
        // mouvement réel → commit (re-routage / reprise du flux) ; sinon simple clic = sélection (déjà faite au pointerdown)
        if (useStudio.getState().dragRef === wasDrag) void useStudio.getState().commitDrag(wasDrag)
        return
      }
      if (!downPos) return
      const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y)
      downPos = null
      if (moved > 5) return // c'était une rotation caméra
      screenToNdc(e)
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(compGroup.children, false)
      const ref = hits.length ? (hits[0].object.userData.ref as string) : null
      useStudio.getState().setViewer({ selectedRef: ref })
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    // Resize
    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight
      if (w === 0 || h === 0) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)
    resize()

    engineRef.current = {
      scene, camera, renderer, controls, compGroup, traceGroup, heatMesh, keepGroup, pourMesh, pourMeshTop,
      boardW: 60, boardH: 45, raycaster, targetCamPos: null,
    }
    // Hook de diagnostic E2E (inoffensif en production) — pilotage du viewer depuis les tests
    if (typeof window !== 'undefined') {
      ;(window as unknown as Record<string, unknown>).__nexusEngine = engineRef.current
    }

    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      const eng = engineRef.current
      if (!eng) return
      if (eng.targetCamPos) {
        eng.camera.position.lerp(eng.targetCamPos, 0.12)
        if (eng.camera.position.distanceTo(eng.targetCamPos) < 0.3) eng.targetCamPos = null
      }
      eng.controls.update()
      eng.renderer.render(eng.scene, eng.camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      controls.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      engineRef.current = null
    }
  }, [])

  /* ---------------- Reconstruction de la carte (netlist) ---------------- */
  useEffect(() => {
    const eng = engineRef.current
    if (!eng) return
    const { w: W, h: H } = netlist.board
    eng.boardW = W
    eng.boardH = H

    // PCB
    for (const child of [...eng.scene.children]) {
      if (child.userData.isBoard) {
        eng.scene.remove(child)
        child.traverse((o) => {
          if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose() }
        })
      }
    }
    const pcb = new THREE.Mesh(
      new THREE.BoxGeometry(W, 1.6, H),
      new THREE.MeshStandardMaterial({ color: 0x0a2e1c, roughness: 0.55, metalness: 0.1 }),
    )
    pcb.userData.isBoard = true
    // Alésage : coins visibles via bords
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(pcb.geometry),
      new THREE.LineBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.5 }),
    )
    pcb.add(edges)
    eng.scene.add(pcb)

    // Heatmap + keepout dimensionnés à la carte
    eng.heatMesh.scale.set(W, H, 1)
    eng.heatMesh.position.y = 0.83
    eng.pourMesh.scale.set(W, H, 1)
    eng.pourMesh.position.y = 0.845
    eng.pourMeshTop.scale.set(W, H, 1)
    eng.pourMeshTop.position.y = 0.855
    eng.keepGroup.clear()

    // Caméra adaptée
    const d = Math.max(W, H) * 1.5
    eng.camera.position.set(d * 0.62, d * 0.72, d * 0.62)
    eng.controls.target.set(0, 0, 0)
  }, [netlist])

  /* ---------------- Composants (placement live) ---------------- */
  useEffect(() => {
    const eng = engineRef.current
    if (!eng) return
    const { boardW: W, boardH: H } = eng
    const list: PlacedComponent[] = placements ?? []
    disposeGroupChildren(eng.compGroup)
    if (!placements) return

    for (const p of list) {
      const c = netlist.components.find((x) => x.ref === p.ref)
      if (!c) continue
      const swap = p.rot === 90 || p.rot === 270
      const w = swap ? c.footprint.h : c.footprint.w
      const h = swap ? c.footprint.w : c.footprint.h
      const ch = COMP_HEIGHT[c.category] ?? 0.6
      const color = CATEGORY_COLOR[c.category] ?? 0x333333
      const selected = viewer.selectedRef === p.ref
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, ch, h),
        new THREE.MeshStandardMaterial({
          color: selected ? 0x10b981 : color,
          roughness: 0.4, metalness: 0.25,
          emissive: selected ? 0x10b981 : c.category === 'led' ? 0x552211 : 0x000000,
          emissiveIntensity: selected ? 0.5 : 0.15,
        }),
      )
      mesh.position.set(p.x - W / 2, 0.8 + ch / 2, p.y - H / 2)
      mesh.rotation.y = (-p.rot * Math.PI) / 180
      mesh.userData.ref = p.ref
      const eg = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: selected ? 0x6ee7b7 : 0x0f2a1d, transparent: true, opacity: 0.8 }),
      )
      mesh.add(eg)
      eng.compGroup.add(mesh)
    }
    eng.compGroup.visible = viewer.showComponents
  }, [placements, netlist, viewer.selectedRef, viewer.showComponents])

  /* ---------------- Pistes + vias ----------------
   * Pendant un flux live [DeepPCB] : les traces reçues du routeur sont
   * ajoutées AU FIL DE L'EAU ; le net en cours porte une lueur claire. */
  useEffect(() => {
    const eng = engineRef.current
    if (!eng) return
    const { boardW: W, boardH: H } = eng
    disposeGroupChildren(eng.traceGroup)
    const routes: Route[] = liveActive ? liveRoutes : (result.routing?.routes ?? [])
    if (!routes.length) return
    const netCls = new Map(netlist.nets.map((n) => [n.name, n.cls]))

    for (const r of routes) {
      const color = CLASS_COLOR[netCls.get(r.net) ?? 'signal'] ?? 0x2dd4a0
      const isCurrent = liveActive && r.net === liveCurrentNet
      const mat = new THREE.MeshBasicMaterial({
        color: isCurrent ? new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.45) : color,
        transparent: true,
        opacity: isCurrent ? 1 : 0.92,
      })
      for (const seg of r.segments) {
        for (let i = 1; i < seg.pts.length; i++) {
          const ax = seg.pts[i - 1].x - W / 2, az = seg.pts[i - 1].y - H / 2
          const bx = seg.pts[i].x - W / 2, bz = seg.pts[i].y - H / 2
          const len = Math.hypot(bx - ax, bz - az)
          if (len < 0.01) continue
          const y = LAYER_Y[seg.layer] ?? 0.87
          const geo = new THREE.BoxGeometry(len + seg.width, 0.07, seg.width)
          const m = new THREE.Mesh(geo, mat)
          m.position.set((ax + bx) / 2, y, (az + bz) / 2)
          m.rotation.y = -Math.atan2(bz - az, bx - ax)
          eng.traceGroup.add(m)
        }
      }
      // Vias
      const viaMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.9, roughness: 0.25 })
      for (const v of r.vias) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(v.diameter / 2, v.diameter / 2, 1.85, 12), viaMat)
        m.position.set(v.x - W / 2, 0, v.y - H / 2)
        eng.traceGroup.add(m)
      }
    }
    // Tête du routeur : halo bleu ciel au dernier point posé
    if (liveActive && liveLastPoint) {
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.7, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.95 }),
      )
      head.position.set(liveLastPoint.x - W / 2, 0.9, liveLastPoint.y - H / 2)
      eng.traceGroup.add(head)
    }
    eng.traceGroup.visible = viewer.showTraces
  }, [result.routing, liveRoutes, liveActive, liveCurrentNet, liveLastPoint, netlist, viewer.showTraces])

  /* ---------------- Heatmap thermique ---------------- */
  useEffect(() => {
    const eng = engineRef.current
    const thermal: ThermalMap | undefined = result.thermal
    if (!eng) return
    if (!viewer.showHeatmap || !thermal) {
      eng.heatMesh.visible = false
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = thermal.cols
    canvas.height = thermal.rows
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(thermal.cols, thermal.rows)
    const range = Math.max(0.001, thermal.maxT - thermal.minT)
    for (let i = 0; i < thermal.temps.length; i++) {
      const t = (thermal.temps[i] - thermal.minT) / range
      const [r, g, b] = heatColor(Math.pow(t, 0.85))
      img.data[i * 4] = r
      img.data[i * 4 + 1] = g
      img.data[i * 4 + 2] = b
      img.data[i * 4 + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    eng.heatMesh.visible = true
    const mat = eng.heatMesh.material as THREE.MeshBasicMaterial
    mat.map?.dispose()
    mat.map = tex
    mat.needsUpdate = true
  }, [result.thermal, viewer.showHeatmap])

  /* ---------------- Plans cuivre : pour de masse (2c) ou plans dédiés (4c [P1.1]) ---------------- */
  useEffect(() => {
    const eng = engineRef.current
    if (!eng) return
    const gp = result.routing?.groundPour
    const planes = result.routing?.planes
    if (!viewer.showTraces || (!gp && !planes?.length)) {
      eng.pourMesh.visible = false
      eng.pourMeshTop.visible = false
      return
    }
    const buildTex = (cells: { x: number; y: number }[], cols: number, rows: number, res: number) => {
      const canvas = document.createElement('canvas')
      canvas.width = cols
      canvas.height = rows
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.clearRect(0, 0, cols, rows)
      ctx.fillStyle = '#2b8a5f'
      for (const c of cells) {
        const cx = Math.floor(c.x / res)
        const cy = Math.floor(c.y / res)
        ctx.fillRect(cx, rows - 1 - cy, 1, 1)
      }
      const tex = new THREE.CanvasTexture(canvas)
      tex.magFilter = THREE.NearestFilter
      return tex
    }
    const apply = (mesh: THREE.Mesh, cells: { x: number; y: number }[], cols: number, rows: number, res: number, color: number) => {
      const mat = mesh.material as THREE.MeshBasicMaterial
      mat.map?.dispose()
      mat.map = buildTex(cells, cols, rows, res)
      mat.color.setHex(color)
      mat.needsUpdate = true
      mesh.visible = true
    }
    if (gp) {
      apply(eng.pourMesh, gp.bottom, gp.cols, gp.rows, gp.res, 0x1f6f4a)
      apply(eng.pourMeshTop, gp.top, gp.cols, gp.rows, gp.res, 0x1f6f4a)
    } else if (planes) {
      const masse = planes.find((p) => p.cls === 'ground') ?? planes[0]
      apply(eng.pourMesh, masse.cells, masse.cols, masse.rows, masse.res, 0x1f6f4a)
      const alim = planes.find((p) => p.cls === 'power')
      if (alim) apply(eng.pourMeshTop, alim.cells, alim.cols, alim.rows, alim.res, 0x92600a)
      else eng.pourMeshTop.visible = false
    }
  }, [result.routing, viewer.showTraces])

  /* ---------------- Keepout RF ---------------- */
  useEffect(() => {
    const eng = engineRef.current
    if (!eng) return
    disposeGroupChildren(eng.keepGroup)
    const constraints = extractConstraints(netlist)
    const { boardW: W, boardH: H } = eng
    for (const cst of constraints.filter((c) => c.kind === 'keepout')) {
      for (const ref of cst.refs) {
        const p = placements?.find((x) => x.ref === ref)
        const c = netlist.components.find((x) => x.ref === ref)
        if (!p || !c) continue
        const m = cst.value ?? 5
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(c.footprint.w + 2 * m, 2.6, c.footprint.h + 2 * m),
          new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.1, depthWrite: false }),
        )
        box.position.set(p.x - W / 2, 1.2, p.y - H / 2)
        const wire = new THREE.LineSegments(
          new THREE.EdgesGeometry(box.geometry),
          new THREE.LineBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.55 }),
        )
        box.add(wire)
        eng.keepGroup.add(box)
      }
    }
  }, [netlist, placements])

  /* ---------------- Toggles ---------------- */
  useEffect(() => {
    const eng = engineRef.current
    if (!eng) return
    eng.compGroup.visible = viewer.showComponents
    eng.traceGroup.visible = viewer.showTraces
    eng.heatMesh.visible = viewer.showHeatmap && !!result.thermal
    eng.pourMesh.visible = viewer.showTraces && !!(result.routing?.groundPour || result.routing?.planes?.length)
    eng.pourMeshTop.visible = viewer.showTraces && !!(result.routing?.groundPour || result.routing?.planes?.length)
  }, [viewer.showComponents, viewer.showTraces, viewer.showHeatmap, result.thermal, result.routing])

  /* ---------------- Mode 2D / 3D ---------------- */
  useEffect(() => {
    const eng = engineRef.current
    if (!eng) return
    const d = Math.max(eng.boardW, eng.boardH) * 1.5
    if (viewer.mode === '2d') {
      eng.targetCamPos = new THREE.Vector3(0, d * 1.15, 0.001)
      eng.controls.maxPolarAngle = Math.PI * 0.52
    } else {
      eng.targetCamPos = new THREE.Vector3(d * 0.62, d * 0.72, d * 0.62)
    }
  }, [viewer.mode])

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border border-emerald-900/40 bg-[#05080a]">
      {webglOk === false ? (
        <BoardViewer2D />
      ) : (
        <div ref={mountRef} className="h-full w-full" data-testid="board-viewer" />
      )}

      {/* HUD du routage live [DeepPCB] — superposé pendant un flux temps réel */}
      <LiveRoutingHud />

      {/* Barre d'outils superposée */}
      <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
        {webglOk !== false && (
          <div className="pointer-events-auto flex overflow-hidden rounded-md border border-emerald-800/50 bg-black/60 backdrop-blur">
            {(['3d', '2d'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setViewer({ mode: m })}
                className={`px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide transition-colors ${
                  viewer.mode === m ? 'bg-emerald-600 text-white' : 'text-emerald-300/70 hover:bg-emerald-900/40'
                }`}
              >
                {m === '3d' ? '3D' : '2D · dessus'}
              </button>
            ))}
          </div>
        )}
        {([
          ['showComponents', 'Composants'],
          ['showTraces', 'Pistes'],
          ['showHeatmap', 'Thermique'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setViewer({ [key]: !viewer[key] } as Partial<typeof viewer>)}
            className={`pointer-events-auto rounded-md border px-2.5 py-1 text-[11px] font-medium backdrop-blur transition-colors ${
              viewer[key]
                ? 'border-emerald-600/60 bg-emerald-900/50 text-emerald-200'
                : 'border-neutral-700/60 bg-black/50 text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Légende classes de nets */}
      {viewer.showTraces && result.routing && (
        <div className="absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1 rounded-md border border-emerald-900/40 bg-black/60 px-3 py-2 text-[10px] backdrop-blur">
          {Object.entries({ signal: 'Signal', power: 'Puissance', ground: 'Masse', highspeed: 'Haute vitesse', diffpair: 'Différentiel', analog: 'Analogique', rf: 'RF' }).map(([k, label]) => (
            <span key={k} className="flex items-center gap-1.5 text-neutral-300">
              <span className="inline-block h-1.5 w-4 rounded-full" style={{ background: `#${(CLASS_COLOR[k] ?? 0).toString(16).padStart(6, '0')}` }} />
              {label}
            </span>
          ))}
        </div>
      )}

      {viewer.selectedRef && (
        <div className="absolute right-3 top-3 rounded-md border border-emerald-700/50 bg-black/75 px-3 py-2 text-xs backdrop-blur">
          <div className="font-semibold text-emerald-300">{viewer.selectedRef}</div>
          <div className="text-neutral-300">{netlist.components.find((c) => c.ref === viewer.selectedRef)?.value}</div>
          {/* Éditeur chirurgical [Flux.ai] : déplacement fin + re-routage incrémental.
              Pendant un flux live [DeepPCB] : nudge → le routeur REPART EN DIRECT. */}
          <div
            className="mt-1.5"
            title={liveActive
              ? 'Nudge live — pousse de 2 mm : le flux est coupé puis le routeur repart en direct'
              : 'Éditeur chirurgical — déplace de 2 mm puis re-route sans relancer la conception'}
          >
            <div className="mb-0.5 text-[9px] uppercase tracking-wide text-neutral-500">
              {liveActive ? 'nudge live · re-route en direct' : 'chirurgie ±2 mm'}
            </div>
            <div className="grid grid-cols-3 gap-0.5">
              <span />
              <button aria-label="Déplacer vers le haut" disabled={surgicalBusy || pipelineRunning} onClick={() => (liveActive ? void liveNudge(viewer.selectedRef!, 0, -2) : void surgicalMove(viewer.selectedRef!, 0, -2))} className="rounded border border-neutral-700 bg-black/50 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-30">↑</button>
              <span />
              <button aria-label="Déplacer à gauche" disabled={surgicalBusy || pipelineRunning} onClick={() => (liveActive ? void liveNudge(viewer.selectedRef!, -2, 0) : void surgicalMove(viewer.selectedRef!, -2, 0))} className="rounded border border-neutral-700 bg-black/50 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-30">←</button>
              <button aria-label="Déplacer vers le bas" disabled={surgicalBusy || pipelineRunning} onClick={() => (liveActive ? void liveNudge(viewer.selectedRef!, 0, 2) : void surgicalMove(viewer.selectedRef!, 0, 2))} className="rounded border border-neutral-700 bg-black/50 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-30">↓</button>
              <button aria-label="Déplacer à droite" disabled={surgicalBusy || pipelineRunning} onClick={() => (liveActive ? void liveNudge(viewer.selectedRef!, 2, 0) : void surgicalMove(viewer.selectedRef!, 2, 0))} className="rounded border border-neutral-700 bg-black/50 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-30">→</button>
            </div>
            {/* Undo / Redo multi-niveaux [Flux.ai] — piles miroir des déplacements */}
            <div className="mt-1 flex items-center justify-between gap-2">
              <div className="flex gap-1">
                <button
                  onClick={() => void undoSurgical()}
                  disabled={surgicalBusy || pipelineRunning || liveActive || historyLen === 0}
                  title={historyLen > 0 ? `Annuler le dernier déplacement (${historyLen} niveau(x) disponibles)` : 'Aucun déplacement à annuler'}
                  data-testid="undo-surgical"
                  className="rounded border border-neutral-700 bg-black/50 px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-emerald-900/40 hover:text-emerald-200 disabled:opacity-30"
                >
                  ↩ annuler
                </button>
                <button
                  onClick={() => void redoSurgical()}
                  disabled={surgicalBusy || pipelineRunning || liveActive || redoLen === 0}
                  title={redoLen > 0 ? `Rétablir le déplacement annulé (${redoLen} niveau(x) disponibles)` : 'Aucun déplacement à rétablir (Ctrl+Maj+Z)'}
                  data-testid="redo-surgical"
                  className="rounded border border-neutral-700 bg-black/50 px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-emerald-900/40 hover:text-emerald-200 disabled:opacity-30"
                >
                  ↻ rétablir
                </button>
              </div>
              <span className="text-[9px] text-neutral-500">{historyLen > 0 ? `${historyLen} niveau(x)` : ''}{redoLen > 0 ? ` · ${redoLen} à rétablir` : ''}</span>
            </div>
            <div className="mt-0.5 text-[9px] leading-snug text-neutral-500">
              souris : glissez le composant directement · clavier : ← ↑ ↓ → 0,5 mm · Maj = 2 mm
              <br />
              Échap ferme · Ctrl+Z annule · <span className="text-neutral-400">Ctrl+Maj+Z rétablit</span>
            </div>
            {surgicalBusy && <div className="mt-1 text-[9px] text-emerald-400">{liveActive ? 'reprise du flux…' : 're-routage incrémental…'}</div>}
          </div>
          <button className="mt-1 text-[10px] text-neutral-500 hover:text-neutral-300" onClick={() => setViewer({ selectedRef: null })}>
            fermer
          </button>
        </div>
      )}

      {webglOk === false && (
        <div className="absolute bottom-3 right-3 rounded-md border border-amber-700/40 bg-black/70 px-2.5 py-1.5 text-[10px] text-amber-300/90 backdrop-blur">
          WebGL indisponible sur cet appareil — rendu 2D logiciel actif
        </div>
      )}
    </div>
  )
}

// hmr-probe 1788904281
