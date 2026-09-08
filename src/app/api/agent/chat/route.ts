/**
 * NEXUS PCB — Interface conversationnelle [Flux.ai chat_interface]
 * Équivalent : frontend/src/components/chat_interface/ + backend LLM
 *
 * Copilote contextuel : il connaît le projet courant (netlist, contraintes,
 * métriques du dernier run) et répond aux questions de l'ingénieur —
 * diagnostic, arbitrages, prochaines actions. Le brainstorming entre
 * l'humain et l'essaim d'agents devient possible.
 */
import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

interface ChatMessage { role: 'user' | 'assistant'; content: string }

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      messages?: ChatMessage[]
      context?: string
    }
    const messages = (body.messages ?? [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12) // fenêtre de conversation raisonnable
    if (messages.length === 0) {
      return NextResponse.json({ error: 'Conversation vide' }, { status: 400 })
    }

    const context = (body.context ?? '').slice(0, 4000)
    const systemPrompt = `Tu es le COPILOTE NEXUS PCB — assistant expert en conception de circuits imprimés embarqué dans un studio de conception autonome par agents IA (RL + World Model + LLM + routeur A* + DRC/DFM + export Gerber).

CONTEXTE ACTUEL DU PROJET (généré par le moteur) :
${context || '(aucun résultat encore — invite l\u2019utilisateur à lancer la conception)'}

TON RÔLE :
- Répondre en FRANÇAIS, concis et technique (3-8 phrases max), ton d'ingénieur hardware senior
- T'appuyer sur les MÉTRIQUES réelles du contexte (DFM, vias, thermique, diaphonie, nets non routés) pour diagnostiquer
- Proposer des actions concrètes utilisables dans le studio : « relancez la conception », « sélectionnez J1 puis utilisez l'éditeur chirurgical pour le déplacer de 2 mm », « activez la heatmap thermique », « exportez le pinmap firmware »
- Expliquer les briques v2 quand c'est pertinent : boucle ratchet AutoPCB, audit Siemens Fuse, minimisation des vias DeepPCB, firmware bridge Flux.ai
- Si on te demande de concevoir une NOUVELLE carte : renvoie vers le bouton « Générer par IA » du header
- Jamais de markdown lourd : texte simple, tirets, chiffres clés en gras interdit — reste sobre`

    const zai = await ZAI.create()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      thinking: { type: 'disabled' },
    })
    const reply = completion.choices[0]?.message?.content?.trim()
    if (!reply) {
      return NextResponse.json({ error: 'Réponse vide du modèle' }, { status: 502 })
    }
    return NextResponse.json({ reply })
  } catch (e) {
    return NextResponse.json(
      { error: `Copilote indisponible : ${e instanceof Error ? e.message : 'erreur'}` },
      { status: 500 },
    )
  }
}
