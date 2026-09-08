/**
 * NEXUS PCB — Types fondamentaux du moteur de conception autonome
 * ---------------------------------------------------------------
 * Miroir de l'arborescence cible :
 *   services/parser/            → Netlist, Component, Pad
 *   services/parser/constraint_extractor/ → Constraint
 *   services/ai_engine/llm_agent/  → AgentPlan, ZoneHint
 *   services/ai_engine/rl_agent/   → PlacedComponent, PlacementSolution
 *   services/simulator/            → ThermalMap, SiReport
 *   services/router/               → Route, TraceSegment, Via
 *   services/drc_dfm_engine/       → DrcViolation, DfmReport
 *   services/exporter/             → GerberPackage
 */

/** Classe de signal d'un net — pilote largeurs, priorités et règles SI */
export type NetClass =
  | 'signal'      // signal numérique standard
  | 'power'       // rail d'alimentation
  | 'ground'      // masse
  | 'highspeed'   // horloge / bus rapide
  | 'diffpair'    // paire différentielle (USB, LVDS...)
  | 'analog'      // analogique / RF sensible
  | 'rf'          // antenne RF 50Ω

export type ComponentCategory =
  | 'mcu' | 'memory' | 'power' | 'connector' | 'passive'
  | 'crystal' | 'rf' | 'sensor' | 'led' | 'interface'

export interface Pad {
  /** Nom de la broche (ex: "PA0", "1", "GND") */
  pin: string
  /** Position locale du pad dans le repère du composant (mm, origine = centre du boîtier) */
  lx: number
  ly: number
  w: number
  h: number
}

export interface Footprint {
  name: string
  /** Empreinte totale (mm) */
  w: number
  h: number
  pads: Pad[]
}

export interface Component {
  ref: string       // "U1", "C3", "R2", "J1"...
  value: string     // "STM32F407VGT6", "100nF"...
  category: ComponentCategory
  footprint: Footprint
  /** Puissance dissipée estimée (W) — alimente le simulateur thermique */
  power: number
  /** Net associé à chaque broche : { "PA0": "VDD_3V3", ... } */
  pins: Record<string, string>
  /** Parent fonctionnel (ex: condensateur de découplage → "U1") */
  parent?: string
  /** Description courte affichée dans l'UI */
  note?: string
}

export interface Net {
  name: string
  cls: NetClass
  /** Broches connectées : { ref, pin } */
  pins: { ref: string; pin: string }[]
  /** Largeur de piste imposée (mm) — résolue par le moteur de règles */
  width?: number
}

export interface Netlist {
  id: string
  name: string
  description: string
  /** Dimensions de la carte (mm) */
  board: { w: number; h: number; layers: number }
  components: Component[]
  nets: Net[]
}

/* ------------------------- Contraintes ------------------------- */

export type ConstraintKind =
  | 'differential'      // paire différentielle : routage côte à côte
  | 'length_match'      // appariement de longueur (mm)
  | 'impedance'         // impédance caractéristique cible (Ω)
  | 'keepout'           // zone interdite (RF, antenne)
  | 'adjacency'         // composants à placer adjacents (découplage)
  | 'edge'              // composant fixé au bord (connecteur)
  | 'thermal'           // composant chaud : éloigner des éléments sensibles
  | 'spacing_class'     // classe d'espacement électrique (kV/mm)

export interface Constraint {
  id: string
  kind: ConstraintKind
  /** Composants concernés (refs) */
  refs: string[]
  /** Nets concernés (noms) */
  nets: string[]
  /** Paramètre numérique (longueur cible, impédance, marge...) */
  value?: number
  /** Justification lisible générée par l'extracteur */
  rationale: string
  /** Sévérité : une violation DRC dure ou une simple préférence */
  severity: 'hard' | 'soft'
}

/* ------------------------- Placement ------------------------- */

export interface PlacedComponent {
  ref: string
  x: number            // centre (mm)
  y: number
  /** Rotation en degrés, multiples de 90 */
  rot: 0 | 90 | 180 | 270
  side: 'top' | 'bottom'
  fixed?: boolean      // connecteurs fixés au bord par les contraintes
}

export type ZoneName =
  | 'center' | 'north' | 'south' | 'east' | 'west'
  | 'northeast' | 'northwest' | 'southeast' | 'southwest'

export interface ZoneHint {
  ref: string
  zone: ZoneName
  rationale: string
}

/** Plan stratégique produit par l'agent LLM (ou le repli par règles) */
export interface AgentPlan {
  zones: ZoneHint[]
  strategy: string
  notes: string[]
  source: 'llm' | 'rules'
}

export interface PlacementSolution {
  placements: PlacedComponent[]
  /** Coût final décomposé */
  cost: { total: number; hpwl: number; overlap: number; thermal: number; constraint: number }
  iterations: number
  history: number[]     // évolution du coût pour la courbe d'apprentissage
  durationMs: number
}

/* ------------------------- Routage ------------------------- */

export interface TraceSegment {
  net: string
  layer: 0 | 1          // 0 = top (F.Cu), 1 = bottom (B.Cu)
  /** Polyline orthogonale (mm) */
  pts: { x: number; y: number }[]
  width: number
}

export interface Via {
  net: string
  x: number
  y: number
  drill: number         // diamètre de perçage (mm)
  diameter: number      // diamètre de l'anneau (mm)
}

export interface Route {
  net: string
  segments: TraceSegment[]
  vias: Via[]
  lengthMm: number
  routed: boolean
  /** connecté via plan de masse synthétique (copper pour B.Cu) */
  pour?: boolean
  failureReason?: string
}

export interface RoutingSolution {
  routes: Route[]
  routedNets: number
  totalNets: number
  totalLengthMm: number
  viaCount: number
  /** [DeepPCB via_minimizer] vias éliminés par la passe de minimisation */
  viasRemoved?: number
  durationMs: number
  /** cellules du plan de masse synthétique (coordonnées mm, par couche) */
  groundPour?: {
    top: { x: number; y: number }[]
    bottom: { x: number; y: number }[]
    cols: number
    rows: number
    res: number
  }
}

/* ------------------------- Simulation ------------------------- */

/** Carte thermique grille-régulière (°C) */
export interface ThermalMap {
  cols: number
  rows: number
  cell: number            // taille de cellule (mm)
  originX: number         // coin bas-gauche (mm)
  originY: number
  temps: number[]         // rangée par rangée, index = row * cols + col
  minT: number
  maxT: number
  hotspots: { x: number; y: number; t: number; ref: string }[]
}

export interface SiMetric {
  net: string
  cls: NetClass
  lengthMm: number
  impedance: number       // Ω estimée (microstrip)
  targetImpedance?: number
  impedanceOk: boolean
  skewMm?: number         // écart de longueur intra-paire/groupe
  skewOk?: boolean
  /** [AuraStack multi_physics_loop] diaphonie estimée (% de couplage) */
  crosstalkPct?: number
  crosstalkOk?: boolean
  /** net agresseur dominant (diaphonie max) */
  crosstalkWith?: string
  comment: string
}

export interface SiReport {
  metrics: SiMetric[]
  pass: boolean
}

/* ------------------------- DRC / DFM ------------------------- */

export type DrcSeverity = 'error' | 'warning' | 'info'

export interface DrcViolation {
  code: string           // "CLR-001", "DRC-EDGE"...
  severity: DrcSeverity
  message: string
  location?: { x: number; y: number }
  refs?: string[]
}

export interface DrcReport {
  violations: DrcViolation[]
  errors: number
  warnings: number
  pass: boolean
  durationMs: number
}

export interface DfmReport {
  score: number                       // 0..100
  minTraceWidthMm: number
  minDrillMm: number
  utilizationPct: number              // taux d'occupation de la carte
  checks: { name: string; pass: boolean; detail: string }[]
}

/* ------------------------- Règles de conception ------------------------- */

export interface DesignRules {
  /** Largeur de piste minimale usine (mm) */
  minTraceWidth: number
  /** Espacement cuivre minimal (mm) */
  clearance: number
  /** Diamètre de perçage minimal (mm) */
  minDrill: number
  /** Distance minimale bord de carte → cuivre (mm) */
  edgeClearance: number
  /** Largeurs par classe de net (mm) */
  widths: Record<NetClass, number>
}

/* ------------------------- Export ------------------------- */

export interface GerberFile {
  name: string          // "F_Cu.gbr"
  role: string          // "Cuivre supérieur"
  content: string
}

export interface GerberPackage {
  files: GerberFile[]
  padCount: number
  viaCount: number
  traceCount: number
}

/* ------------------------- Pipeline ------------------------- */

export type StageId =
  | 'import' | 'constraints' | 'intent' | 'placement'
  | 'optimize' | 'thermal' | 'routing' | 'drc' | 'export'

export type StageStatus = 'pending' | 'running' | 'done' | 'error'

export interface StageState {
  id: StageId
  label: string
  status: StageStatus
  progress: number      // 0..1
  detail: string
  durationMs?: number
}

export interface LogEntry {
  ts: number
  stage: StageId | 'system'
  level: 'info' | 'success' | 'warn' | 'error' | 'agent'
  msg: string
}

/* ------------------------- Rapports agents v2 ------------------------- */

/** [AutoPCB autonomous_optimizer] bilan de la boucle ratchet proposer →
 *  évaluer (< 5 s) → garder — amélioration continue sans intervention humaine */
export interface OptimizerReport {
  proposals: number
  accepted: number
  costBefore: number
  costAfter: number
  gainPct: number
  durationMs: number
}

/** [Siemens Fuse self_verifier] audit déterministe indépendant des agents */
export interface SelfVerifyReport {
  placementPass: boolean
  placementViolations: string[]
  routingPass: boolean
  routingViolations: string[]
  rolledBack: boolean
  notes: string[]
}

export interface DesignResult {
  plan: AgentPlan
  placement: PlacementSolution
  thermal: ThermalMap
  si: SiReport
  routing: RoutingSolution
  drc: DrcReport
  dfm: DfmReport
  gerber: GerberPackage
  /** [AutoPCB] bilan de la boucle d'optimisation autonome */
  optimization?: OptimizerReport
  /** [Siemens Fuse] rapport d'auto-vérification physique */
  verification?: SelfVerifyReport
}
