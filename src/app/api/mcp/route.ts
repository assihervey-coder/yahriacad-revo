/**
 * NEXUS PCB — Serveur MCP (Model Context Protocol) [Flux.ai + Circuitron]
 * Équivalent : backend/api_gateway/mcp_server/
 *
 * Expose le moteur de conception comme OUTILS MCP standards (JSON-RPC 2.0) :
 * Claude Desktop, Cursor, Devin ou tout agent MCP externe peuvent piloter
 * la conception PCB — lister les projets, lancer une conception autonome,
 * récupérer les métriques et les rapports.
 *
 * GET  /api/mcp           → manifeste du serveur (outils + schémas)
 * POST /api/mcp           → JSON-RPC 2.0 : initialize | tools/list | tools/call
 */
import { NextRequest, NextResponse } from 'next/server'
import { NETLISTS } from '@/lib/engine/netlists'
import { runPipeline } from '@/lib/engine/orchestrator'
import type { LogEntry } from '@/lib/engine/types'

const SERVER_INFO = { name: 'nexus-pcb-mcp', version: '2.0.0' }

const TOOLS = [
  {
    name: 'nexus_list_projects',
    description: 'Liste les projets PCB disponibles dans NEXUS (netlists prêtes pour la conception autonome).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nexus_run_design',
    description: 'Lance la conception autonome COMPLÈTE d\u2019une carte : contraintes → plan LLM → placement RL (World Model) → boucle ratchet AutoPCB → thermique → routage A* + minimisation des vias DeepPCB → DRC/DFM → export Gerber + firmware. Retourne toutes les métriques.',
    inputSchema: {
      type: 'object',
      properties: {
        netlistId: { type: 'string', description: 'ID du projet (voir nexus_list_projects)' },
        planMode: { type: 'string', enum: ['rules', 'llm'], description: 'Planification par règles (rapide, déterministe) ou LLM (plus riche, plus lent)' },
        ratchetProposals: { type: 'number', description: 'Nombre de propositions de la boucle d\u2019optimisation (défaut 300)' },
      },
      required: ['netlistId'],
    },
  },
  {
    name: 'nexus_describe_capabilities',
    description: 'Décrit les capacités du moteur NEXUS PCB : pipeline, agents, différenciateurs vs Quilter, formats d\u2019export.',
    inputSchema: { type: 'object', properties: {} },
  },
]

function toolResult(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  }
}

async function runDesign(args: { netlistId?: string; planMode?: 'rules' | 'llm'; ratchetProposals?: number }) {
  const nl = NETLISTS.find((n) => n.id === args.netlistId)
  if (!nl) throw new Error(`Projet inconnu : ${args.netlistId}. Utilisez nexus_list_projects.`)
  const logs: string[] = []
  const collect = (l: LogEntry['stage'], level: LogEntry['level'], msg: string) => {
    if (logs.length < 250) logs.push(`[${String(l)}][${level}] ${msg}`)
  }
  const result = await runPipeline(
    nl,
    {
      onLog: collect,
      onStage: () => undefined,
      onPlan: () => undefined,
      onPlacements: () => undefined,
      onCostHistory: () => undefined,
      shouldCancel: () => false,
    },
    { planMode: args.planMode === 'llm' ? 'llm' : 'rules', ratchetProposals: args.ratchetProposals },
  )
  return {
    project: { id: nl.id, name: nl.name, description: nl.description, board: nl.board },
    metrics: {
      routedNets: result.routing.routedNets,
      totalNets: result.routing.totalNets,
      viaCount: result.routing.viaCount,
      viasRemoved: result.routing.viasRemoved ?? 0,
      totalLengthMm: result.routing.totalLengthMm,
      drcErrors: result.drc.errors,
      drcWarnings: result.drc.warnings,
      dfmScore: result.dfm.score,
      maxTempC: result.thermal.maxT,
      siPass: result.si.pass,
      hpwl: result.placement.cost.hpwl,
    },
    optimization: result.optimization,
    verification: result.verification,
    files: result.gerber.files.map((f) => ({ name: f.name, role: f.role })),
    agentLogs: logs.slice(-40),
  }
}

function capabilities() {
  return {
    pipeline: ['import', 'constraints', 'intent-LLM', 'placement-RL', 'ratchet-AutoPCB', 'thermal', 'routing-A*+viaMinimizer', 'SI+crosstalk', 'DRC/DFM', 'export-Gerber+firmware'],
    agents: ['LLM strategist', 'RL + World Model (DreamerV3-inspired)', 'ratchet optimizer', 'self-verifier (deterministic)', 'maze router with rip-up & reroute'],
    differentiators: [
      'World Model latent : prédiction en µs au lieu d\u2019essais-erreurs',
      'Auto-vérification déterministe [Siemens Fuse] avec rollback',
      'Minimisation des vias [DeepPCB] en post-routage',
      'Boucle ratchet [AutoPCB] : amélioration continue sans humain',
      'Firmware bridge [Flux.ai] : pinmap .h/.overlay/.json synchronisés',
      'Analyse multiphysique : thermique + impédance + diaphonie [AuraStack]',
    ],
    exports: ['Gerber RS-274X (F_Cu, B_Cu, Edge_Cuts)', 'Excellon drill', 'BOM.csv', 'POS.csv (pick & place)', 'NEXUS_pinmap.h', 'NEXUS_pinmap.overlay', 'NEXUS_pinmap.json'],
  }
}

export async function GET() {
  return NextResponse.json({
    server: SERVER_INFO,
    protocol: 'MCP over HTTP (JSON-RPC 2.0)',
    usage: { initialize: 'POST {jsonrpc:"2.0",id:1,method:"initialize"}', listTools: 'POST {method:"tools/list"}', call: 'POST {method:"tools/call",params:{name,arguments}}' },
    tools: TOOLS,
  })
}

export async function POST(req: NextRequest) {
  let body: { jsonrpc?: string; id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 })
  }
  const id = body.id ?? null

  try {
    switch (body.method) {
      case 'initialize':
        return NextResponse.json({
          jsonrpc: '2.0', id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO },
        })
      case 'tools/list':
        return NextResponse.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      case 'tools/call': {
        const name = body.params?.name
        const args = body.params?.arguments ?? {}
        switch (name) {
          case 'nexus_list_projects':
            return NextResponse.json({
              jsonrpc: '2.0', id,
              result: toolResult(NETLISTS.map((n) => ({
                id: n.id, name: n.name, description: n.description,
                board: `${n.board.w}x${n.board.h}mm`, components: n.components.length, nets: n.nets.length,
              }))),
            })
          case 'nexus_run_design': {
            const out = await runDesign(args as { netlistId?: string; planMode?: 'rules' | 'llm'; ratchetProposals?: number })
            return NextResponse.json({ jsonrpc: '2.0', id, result: toolResult(out) })
          }
          case 'nexus_describe_capabilities':
            return NextResponse.json({ jsonrpc: '2.0', id, result: toolResult(capabilities()) })
          default:
            return NextResponse.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `Outil inconnu : ${name}` } }, { status: 400 })
        }
      }
      default:
        return NextResponse.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Méthode inconnue : ${body.method}` } }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({
      jsonrpc: '2.0', id,
      error: { code: -32000, message: e instanceof Error ? e.message : 'Erreur serveur' },
    }, { status: 500 })
  }
}
