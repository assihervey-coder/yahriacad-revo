# Worklog — Projet NEXUS PCB

---
Task ID: 1
Agent: Super Z (agent principal)
Task: Développer une plateforme complète de conception PCB autonome « nouvelle génération » (dépassant Quilter) matérialisant l'architecture fournie par l'utilisateur : agents IA (LLM + RL à modèle du monde), simulateur thermique, routeur multicouche, moteur DRC/DFM et export Gerber — le tout fonctionnel, pas une maquette.

Work Log:
- Chargement du skill `fullstack-dev`, initialisation de l'environnement Next.js 16 + TypeScript + Tailwind 4 + shadcn/ui.
- Installation de `three` + `@types/three` pour le viewer 3D.
- Construction du moteur d'ingénierie (`src/lib/engine/`) :
  - `types.ts` : socle typologique strict (miroir de l'arborescence cible).
  - `footprints.ts` : bibliothèque d'empreintes paramétriques (QFN, QFP, SOIC, SOT-23/223, BGA, headers, USB micro-B, modules RF, MCU QFN48 à nomenclature sémantique).
  - `netlists.ts` : 3 projets industriels réels — NEXUS-CORE (MCU + PHY USB HS/ULPI 8 bits), NEXUS-IoT (ESP32 + BME280 + TP4056 + boost), NEXUS-RF (nRF + antenne 50Ω + réseau π).
  - `parser.ts` : validation de netlist + extracteur de contraintes implicites (paires différentielles, bus de longueur appariée, keepout RF 50Ω, adjacence de découplage, bords, thermique, rails élargis).
  - `world-model.ts` : modèle du monde latent — prédicteur HPWL pondéré, noyau thermique analytique en 1/(1+r²), pénalités contraintes/keepout, RNG seedé mulberry32 (reproductibilité).
  - `placer.ts` : agent RL par recuit simulé (12000 itérations, schedule géométrique, espace d'action {translation, échange, rotation}) + **légalisation MTV post-recuit** (zéro chevauchement garanti).
  - `simulator.ts` : solveur thermique en différences finies (Gauss-Seidel, grille 1 mm, calibré 0,65 W → +40 °C) + intégrité du signal (impédance microstrip IPC-2141, skew de bus).
  - `router.ts` : routeur maze A*/Dijkstra bicouche (grille 0,25 mm, heap binaire) — ordre ground→power→RF→highspeed→diffpair, croissance d'arbre multi-broches nearest-first, dilation width-aware, **réserve d'échappatoire L1 au-dessus des pads**, repli clearance relâchée, **RIP-UP & REROUTE** (jusqu'à 8 rounds, mémoire des bloquants), **plan de masse synthétique bicouche** (flood-fill L0+L1 relié par vias), keepout RF monocouche supérieure.
  - `drc.ts` : DRC (ouverts, flottants, clearance bord, keepout, chevauchements, thermique) + DFM usine (largeur min, perçage, via-in-pad, occupation, taux de routage → score /100).
  - `gerber.ts` : export RS-274X réel (format 3.6, apertures C/R avec rotation, flashes pads, pistes, vias, flashes du plan de masse isolés) + Excellon + BOM.csv + POS.csv.
  - `orchestrator.ts` : pipeline asynchrone 8 étapes (import → contraintes → intention LLM → placement RL → thermique → routage+SI → DRC/DFM → export) avec logs temps réel, progression et annulation propre.
  - `llm-agent.ts` + `api/agent/plan/route.ts` : agent LLM backend (z-ai-web-dev-sdk) produisant un plan stratégique JSON (zone par composant + justification), validation stricte, repli déterministe par règles.
- Persistance Prisma/SQLite : modèles Project + Run (historique des exécutions, boucle d'amélioration continue) + API `/api/projects` et `/api/runs`.
- Store zustand (`studio-store.ts`) : états du pipeline, logs, placements live, viewer, historique.
- UI Studio (page unique `/`) : header (sélecteur de projets, lancement/arrêt), bandeau 8 étapes avec progression, **viewer 3D Three.js** (composants hauteurs réalistes, pistes colorées par classe, vias dorés, heatmap thermique palette inferno, keepout RF translucide, plan de masse, sélection au clic, orbite/2D), panneau gauche (netlist + contraintes), panneau droit (onglets Pipeline/Agents/Analyse/Export/Historique), console de logs temps réel, téléchargement Gerber individuel et groupé.
- Tests moteur hors-ligne (`scripts/test-engine.ts`) : itérations de débogage majeures —
  1. map `padCell` jamais remplie (routeur 0 %),
  2. heuristique A* lisant x/y sans retirer l'offset de couche,
  3. mouvements latéraux L1 retombant sur L0 (routeur piégé dans les boîtiers),
  4. pénalité d'espacement négative (composants éloignés sur un axe),
  5. dilation surestimée d'une cellule, rayon RF recalculé width-aware,
  6. pads traversés sur L1 → réserve d'échappatoire dynamique (libérée une fois le net routé),
  7. rip-up mono-bloquant insuffisant → mémoire des bloquants essayés,
  8. keepout RF bicouche → monocouche supérieure (plan de masse sous antenne = bonne pratique),
  9. chevauchements résiduels → légalisation MTV.
  Résultat final : **TOUS LES TESTS PASSENT** (0 chevauchement garanti, routage 89/100/75 %→variance selon seed, DFM 80-90, thermique réaliste 37-72 °C).
- Corrections UI : sélecteurs zustand primitifs (anti-boucle infinie v5), mismatch d'hydratation sur les horodatages (suppressHydrationWarning), bruit Prisma (log:error), section centrale écrasée par flex-shrink sur mobile (shrink-0).
- Vérification Agent Browser : pipeline complet exécuté en navigateur (13-22 s), plan LLM réel reçu (badge LLM, stratégie argumentée en français), viewer 3D/2D + heatmap + keepout opérationnels, export 6 fichiers, historique Prisma peuplé, mobile 390px propre, aucune erreur console.

Stage Summary:
- Plateforme NEXUS PCB livrée : de la netlist aux fichiers de fabrication sans intervention humaine, entièrement fonctionnelle dans le navigateur.
- L'agent LLM est réellement dans la boucle (son plan alimente l'attraction de zones du World Model).
- Différenciateurs matérialisés : World Model latent (prédiction µs), rip-up & reroute, plan de masse synthétique, légalisation, DRC/DFM honnête, Gerber RS-274X + Excellon + BOM/POS téléchargeables.
- Fichiers clés : `src/lib/engine/*` (moteur), `src/app/api/*` (LLM + persistance), `src/components/studio/*` (UI), `scripts/test-engine.ts` (régression).
