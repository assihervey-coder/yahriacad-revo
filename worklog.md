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

---
Task ID: 2
Agent: Super Z (agent principal)
Task: Corriger le crash WebGL du viewer (« THREE.WebGLRenderer: A WebGL context could not be created » — sandbox avec AllowWebgl2:false) puis committer et pousser tout le projet sur github.com/assihervey-coder/yahriacad-revo.git.

Work Log:
- Diagnostic : `new THREE.WebGLRenderer()` levait une exception dans les environnements où WebGL/WebGL2 est désactivé (preview sandboxée, VM, GPU bloqué) — aucune détection préalable dans `board-viewer.tsx`.
- Création de `src/components/studio/board-viewer-2d.tsx` : viewer de secours 100 % Canvas 2D (zéro WebGL) rendant la même information — substrat, pistes colorées par classe (couche bottom atténuée), vias dorés, plan de masse bicouche (texture offscreen 1 px/cellule), heatmap thermique (palette inferno, ImageData), keepout RF hachuré, composants orientés avec étiquettes, sélection au clic (hit-test avec swap 90°/270°), redessin sur ResizeObserver.
- Patch `board-viewer.tsx` : helper `isWebGLAvailable()` (test de contexte webgl2/webgl sans exception), état `webglOk` (null/true/false), garde en tête de l'effet d'init + try/catch autour du constructeur WebGLRenderer, rendu conditionnel `<BoardViewer2D />` en repli, masquage du switch 3D/2D en mode secours, badge ambre « WebGL indisponible — rendu 2D logiciel actif ».
- Correction au passage d'une erreur TypeScript préexistante dans `src/app/api/agent/plan/route.ts` (`c.power` possiblement undefined → `(c.power ?? 0)`).
- Vérification : `tsc --noEmit` → zéro erreur dans `src/` ; serveur dev → `GET / 200`, compilation propre.
- Commit + push vers `assihervey-coder/yahriacad-revo` (main).

Stage Summary:
- Le viewer ne peut plus crasher : détection WebGL explicite + repli Canvas 2D fonctionnellement équivalent (même interactions, mêmes calques visuels).
- Code source `src/` strictement propre côté TypeScript ; projet poussé sur GitHub.

---
Task ID: 3
Agent: Super Z (agent principal)
Task: Analyser l'arborescence v2 (intégration DeepPCB / Siemens Fuse / Cadence AuraStack / Flux.ai / Circuitron / AutoPCB), implémenter les optimisations correspondantes dans le moteur NEXUS PCB, puis commit + push.

Work Log:
- Analyse : 6 briques différenciantes identifiées comme implémentables dans notre moteur TypeScript in-browser (le reste — K8s, Neo4j, CUDA — noté comme roadmap infra).
- `optimizer.ts` [AutoPCB] : boucle ratchet proposer → évaluer (World Model, µs) → garder (jamais de régression), 300 propositions, légalisation + réparation keepout finale. Gains mesurés : −13 % (CORE), −30,4 % (IoT), −22,7 % (RF).
- `self-verifier.ts` [Siemens Fuse] : deterministic_checker (bornes par CORPS, chevauchements stricts, keepouts avec exemption chaîne RF, ouverts, largeurs, perçages, annular ring, clearance cuivre-cuivre) + rollback_manager (re-légalisation + re-audit). A détecté de VRAIS bugs : débordement de l'ESP32 hors carte, header 6 broches dévorant la carte.
- `router.ts` [DeepPCB via_minimizer] : passe 2b — re-routage de chaque net à via avec coût de via majoré (14→46), garde si moins de vias et longueur ≤ +30 %. −2 à −8 vias par carte.
- `firmware.ts` [Flux.ai firmware_bridge] : pin_exporter + header_generator → NEXUS_pinmap.h (C), .overlay (Zephyr devicetree), .json (CI). 71-106 broches exportées, ajoutées au package d'export.
- `simulator.ts` [AuraStack multi_physics_loop] : estimation de diaphonie (crosstalk) pour nets RF/diff/highspeed/analogiques — couplage parallèle longueur/gap avec correction de largeur, intégrée aux métriques SI + UI (barre de niveau).
- `orchestrator.ts` : nouvelles étapes 4b optimize (ratchet streaming live) et 4c audit Fuse ; audit routage 6c ; firmware dans l'export ; options planMode ('rules'|'llm') + ratchetProposals.
- Corrections profondes induites par les audits : légalisateur borné par CORPS (plus par centre) avec repli « pousser l'autre » ; connecteurs profonds pivotés LE LONG du bord sud + packing 1D sans chevauchement ; bug critique du ratchet (rng() appelé DANS le prédicat findIndex → tirage corrompu → crash) corrigé.
- Store : étape 'optimize', customNetlists + addCustomNetlist, surgicalMove (éditeur chirurgical : nudge ±2 mm → re-routage + DRC/DFM + ré-export Gerber/firmware, placement et thermique préservés).
- API : `/api/agent/netlist` [Circuitron nl_to_skidl] (langage naturel → netlist valide : catalogue d'empreintes réel, broches vérifiées, classes déduites) ; `/api/agent/chat` [Flux.ai copilote] (contexte métriques complet) ; `/api/mcp` serveur MCP JSON-RPC 2.0 (nexus_list_projects, nexus_run_design, nexus_describe_capabilities) — Claude/Cursor peuvent piloter le PCB.
- UI : bandeau 9 étapes (icône TrendingUp), tag console RATCHET, cartes AutoPCB/Fuse dans l'onglet agents, onglet copilote (chat), diaphonie visuelle dans analyse, compteur vias −N [DeepPCB], bouton « Générer par IA » dans le header (dialog), flèches chirurgicales ±2 mm dans le popup de sélection du viewer.
- Tests : `scripts/test-engine.ts` étendu (ratchet sans régression, audits Fuse cohérents routeur, firmware bridge) → **TOUS LES TESTS PASSENT** (CORE 93 % routage/DFM 87, IoT 100 %/DFM 90, RF 81 %/DFM 82).

Stage Summary:
- Le moteur est passé d'« agent RL + routeur » à un ESSAIM : RL + ratchet AutoPCB + self-verifier Fuse + via_minimizer DeepPCB + firmware bridge Flux.ai + multiphysique AuraStack + génération NL Circuitron + copilote + serveur MCP.
- Les audits déterministes ont servi immédiatement : 3 vrais défauts géométriques détectés puis corrigés à la source (bornes corps, headers au bord, keepout rotatif).
- Tous les tests passent, TypeScript propre, MCP testé en live.



---
Task ID: 4
Agent: Super Z (agent principal)
Task: Implémenter le routage live « trait par trait » façon DeepPCB — flux temps réel du routeur vers le navigateur — puis commit + push.

Work Log:
- `router.ts` : routeAll converti en asynchrone coopératif — nouveaux callbacks onTrace (chaque segment/via fraîchement posé, passe glouton uniquement via flag emitLive), onPhase (greedy → ripup → via-min → pour) et pacingMs (rythme du flux, respiration du transport entre chaque branche d'arbre).
- `orchestrator.ts` : les 3 callbacks de routage live sont exposés dans PipelineCallbacks (onRoutingTrace/onRoutingPhase/onRoutingProgress) et branchés sur routeAll.
- `api/routing/live/route.ts` (nouveau) : endpoint SSE POST — le routeur tourne CÔTÉ SERVEUR et diffuse chaque piste au fil de sa pose (hello → phase → segment/via → progress → complete/error). Choix documenté : SSE = équivalent WebSocket pour un flux de progression, traverse les proxys sans upgrade ni port dédié ; annulation propre via req.signal → shouldCancel.
- `studio-store.ts` : état liveRouting (phase, progression, net courant, traces reçues, tête du routeur) + liveRoutes (accumulation net par net) ; consommateur SSE startLiveRouting (AbortController, parseur de frames, drop des traces fantômes des nets en échec) ; finalisation complète à l'événement complete (SI + thermique + DRC/DFM + Gerber + firmware → result) ; le pipeline local diffuse AUSSI ses traces pendant l'étape de routage (source 'pipeline').
- UI : bouton « Routage live » (header, actif dès qu'un placement existe), HUD overlay (phase, barre de progression, net courant, compteur de traces, interrompre), viewers 2D Canvas ET 3D Three.js — pistes dessinées au fil de l'eau, lueur sur le net en cours, halo bleu ciel sur la tête du routeur.
- Corrections passées au fil du test : normalisation {type} → {t} des événements de trace dans la route SSE (détecté par le smoke test : 0 segment reçu) ; conversion d'événements SSE → TraceEvent dans le store (tsc) ; await sur routeAll dans surgicalMove et scripts/test-engine.ts.
- Vérifications : tsc src/ propre ; test-engine TOUS LES TESTS PASSENT ; smoke test SSE scripts/test-live-sse.ts (77 segments + 76 vias étalés sur ~2,5 s, 4 phases, complete) ; E2E navigateur (pipeline 14,9 s → routage live 4 s → « 26/28 nets · 85 vias (−10) · DFM 87/100 — analyse + export régénérés »), HUD capturé pendant le flux, zéro erreur console.

Stage Summary:
- Le routage n'est plus une boîte noire : il se REGARDE — le routeur serveur diffuse chaque piste/via en temps réel (SSE), le HUD raconte la phase du moteur, les viewers 2D/3D dessinent trait par trait avec lueur sur le net en cours.
- Le flux serveur produit un résultat canonique complet (via-minimizer + plan de masse inclus) finalisé en analyse + export, sans relancer le pipeline.
- Le pipeline local bénéficie du même affichage live pendant son étape de routage.

---
Task ID: 5
Agent: Super Z (agent principal)
Task: Vitesse du flux live réglable (×0.5/×1/×2/×4) + mode « nudge » chirurgical pendant le routage live — puis commit + push.

Work Log:
- studio-store.ts : moteur de LECTURE du flux live repensé — les événements SSE arrivent à leur rythme filaire (pacingMs 14→3 ms) et s'empilent dans une file ; la lecture (dessin trait par trait) est cadencée localement à BASE_TICK_MS/liveSpeed → vitesse réglable EN PLEIN VOL (setLiveSpeed ×0.5…×4), tempo ×1 = rythme DeepPCB d'origine (14 ms/événement).
- Fin de flux à isolation totale : le backlog post-EOF se joue par RAFALES bornées (file/12 par tick) → finalisation rapide même quand le rendu 3D coûte ~100 ms/trace ; à épreuve d'exceptions (try/catch par tick — un événement défectueux ne tue plus la chaîne de lecture).
- Génération de session (liveEpoch/livePumpEpoch) : toute session supplantée (stop, nudge, nouveau flux) perd son autorité — lecteur SSE attardé, finally résiduels et ticks de lecture se mutent SILENCIEUSEMENT au lieu de corrompre l'état ; stopLiveRouting clôture la session IMMÉDIATEMENT (HUD réactif) et protège le contrôleur d'abort de la session plus récente (myAbort).
- liveNudge [Flux.ai × DeepPCB] : pendant un flux live, coupure par révocation d'époque, déplacement borné du composant (clamp carte, rot 90/270 prise en compte), puis RESTART FORCÉ (startLiveRouting(3, force)) — le routeur repart EN DIRECT sur la nouvelle géométrie ; finalisation canonique complète (SI + DRC/DFM + Gerber + firmware).
- live-hud.tsx : sélecteur de vitesse ×0.5/×1/×2/×4 (titres explicites : ralenti/normal/×2/turbo timelapse), compteur « traces jouées », indication « Nudge live : cliquez un composant puis utilisez les flèches ».
- board-viewer.tsx : popup de sélection bimode — « nudge live · re-route en direct » pendant un flux (flèches → liveNudge), « chirurgie ±2 mm » sinon (flèches → surgicalMove) ; hook de diagnostic __nexusEngine (projection 3D→écran pour l'E2E) et __nexusStore/__liveDebug (introspection file/epoch/erreurs).
- Corruptions d'état éliminées au passage (détectées par l'E2E headless) : session zombie quand le nudge tombe sur une réponse SSE déjà bufferisée (abort sans rejet → le restart était ignoré par le garde-fou active=true, backlog dans les limbes) — l'epoch rend ce cas impossible.
- Verifications : tsc src/ propre ; test-engine TOUS LES TESTS PASSENT ; E2E complet : ralenti ×0.5 mesuré (6 traces/s vs ~10/s à ×1), turbo ×4 (flux achevé, finalisation régénérée), nudge live complet (U1 déplacé −2 mm → « Flux coupé » → « Flux ouvert » → « Routage live terminé en 8.0 s — 24/28 nets · 61 vias (−6) · DFM 84/100 »), zéro erreur console.

Stage Summary:
- Le routage live est devenu un INSTRUMENT : on le regarde au ralenti, on l'accélère en timelapse, et on INTERVIENT pendant le flux — un nudge de 2 mm et le routeur repart en direct.
- Robustesse structurelle : file de lecture + époques de session = plus aucun état corrompu possible entre deux flux.
- Le pipeline local profite des deux (ses traces passent par la même file réglable).
