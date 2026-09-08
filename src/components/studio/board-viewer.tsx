'use client'
/**
 * NEXUS PCB — Viewer 3D temps réel (Three.js / WebGL)
 * Équivalent : frontend/src/components/viewer/
 *
 * Rendu de la carte en 3D : composants (hauteurs réalistes par catégorie),
 * pistes cuivre colorées par classe de net, vias dorés, heatmap thermique,
 * keepout RF. Sélection au clic + caméra orbitale + mode 2D (vue dessus).
 */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useStudio } from '@/lib/studio-store'
import { extractConstraints } from '@/lib/engine/parser'
import type { PlacedComponent, Route, ThermalMap } from '@/lib/engine/types'

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

  /* ---------------- Initialisation de la scène ---------------- */
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x05080a)
    scene.fog = new THREE.Fog(0x05080a, 120, 260)

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 500)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
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

    // Raycast sélection
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let downPos: { x: number; y: number } | null = null
    const onPointerDown = (e: PointerEvent) => { downPos = { x: e.clientX, y: e.clientY } }
    const onPointerUp = (e: PointerEvent) => {
      if (!downPos) return
      const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y)
      downPos = null
      if (moved > 5) return // c'était une rotation caméra
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(compGroup.children, false)
      const ref = hits.length ? (hits[0].object.userData.ref as string) : null
      useStudio.getState().setViewer({ selectedRef: ref })
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
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
    eng.compGroup.clear()
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

  /* ---------------- Pistes + vias ---------------- */
  useEffect(() => {
    const eng = engineRef.current
    if (!eng) return
    const { boardW: W, boardH: H } = eng
    eng.traceGroup.clear()
    const routes: Route[] = result.routing?.routes ?? []
    if (!routes.length) return
    const netCls = new Map(netlist.nets.map((n) => [n.name, n.cls]))

    for (const r of routes) {
      const color = CLASS_COLOR[netCls.get(r.net) ?? 'signal'] ?? 0x2dd4a0
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 })
      for (const seg of r.segments) {
        for (let i = 1; i < seg.pts.length; i++) {
          const ax = seg.pts[i - 1].x - W / 2, az = seg.pts[i - 1].y - H / 2
          const bx = seg.pts[i].x - W / 2, bz = seg.pts[i].y - H / 2
          const len = Math.hypot(bx - ax, bz - az)
          if (len < 0.01) continue
          const y = seg.layer === 0 ? 0.87 : -0.87
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
    eng.traceGroup.visible = viewer.showTraces
  }, [result.routing, netlist, viewer.showTraces])

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

  /* ---------------- Plan de masse synthétique ---------------- */
  useEffect(() => {
    const eng = engineRef.current
    if (!eng) return
    const gp = result.routing?.groundPour
    if (!viewer.showTraces || !gp) {
      eng.pourMesh.visible = false
      eng.pourMeshTop.visible = false
      return
    }
    const buildTex = (cells: { x: number; y: number }[]) => {
      const canvas = document.createElement('canvas')
      canvas.width = gp.cols
      canvas.height = gp.rows
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.clearRect(0, 0, gp.cols, gp.rows)
      ctx.fillStyle = '#2b8a5f'
      for (const c of cells) {
        const cx = Math.floor(c.x / gp.res)
        const cy = Math.floor(c.y / gp.res)
        ctx.fillRect(cx, gp.rows - 1 - cy, 1, 1)
      }
      const tex = new THREE.CanvasTexture(canvas)
      tex.magFilter = THREE.NearestFilter
      return tex
    }
    const matB = eng.pourMesh.material as THREE.MeshBasicMaterial
    matB.map?.dispose()
    matB.map = buildTex(gp.bottom)
    matB.needsUpdate = true
    eng.pourMesh.visible = true
    const matT = eng.pourMeshTop.material as THREE.MeshBasicMaterial
    matT.map?.dispose()
    matT.map = buildTex(gp.top)
    matT.needsUpdate = true
    eng.pourMeshTop.visible = true
  }, [result.routing, viewer.showTraces])

  /* ---------------- Keepout RF ---------------- */
  useEffect(() => {
    const eng = engineRef.current
    if (!eng) return
    eng.keepGroup.clear()
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
    eng.pourMesh.visible = viewer.showTraces && !!result.routing?.groundPour
    eng.pourMeshTop.visible = viewer.showTraces && !!result.routing?.groundPour
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
      <div ref={mountRef} className="h-full w-full" data-testid="board-viewer" />

      {/* Barre d'outils superposée */}
      <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
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
          <button className="mt-1 text-[10px] text-neutral-500 hover:text-neutral-300" onClick={() => setViewer({ selectedRef: null })}>
            fermer
          </button>
        </div>
      )}
    </div>
  )
}
