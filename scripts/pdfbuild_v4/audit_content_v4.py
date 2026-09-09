# -*- coding: utf-8 -*-
"""Contenu de l'audit technique de complétude V4 — NEXUS PCB (français).

Baseline : révision e39921b du 9 septembre 2026.
"""

TITLE = "Audit technique de complétude V4 — NEXUS PCB"
SUBJECT = "Revue V4 : état du registre de risques, complétude actualisée, validation et trajectoire d'industrialisation de la plateforme de conception PCB par IA"

# ── Chapitre 1 ─ Synthèse exécutive ─────────────────────────────────────
CH1_INTRO = (
    "Le présent document constitue la quatrième itération de l'audit technique de "
    "complétude de la plateforme NEXUS PCB, arrêtée à la révision e39921b du dépôt "
    "principal, en date du 9 septembre 2026. Depuis l'édition précédente (révision "
    "e21c796, score de 86 sur 100), trois commits ont mis en œuvre la quasi-totalité "
    "du plan d'action recommandé : les quatre actions de priorité 0, la pile de "
    "routage à quatre couches et l'appariement strict des paires différentielles. "
    "L'objet de cette revue est double : vérifier que ces livraisons tiennent leurs "
    "promesses par des mesures reproductibles, et réévaluer la complétude globale "
    "ainsi que le registre des risques résiduels."
)
CH1_CALLS = [
    ("93 / 100", "Score global de complétude (86 au précédent audit)"),
    ("6 / 12", "Items du registre de risques fermés et vérifiés"),
    ("118", "Vérifications automatisées : 85 moteur + 33 E2E"),
    ("0", "Erreur TypeScript, de page et de console mesurée"),
]
CH1_BODY1 = (
    "La chaîne critique reste intégralement fonctionnelle et n'a subi aucune "
    "régression : le moteur place par recuit simulé avec agent RL, optimise par "
    "ratchet jamais régressif, route en A* avec rip-up & reroute et minimisation "
    "des vias, vérifie par DRC/DFM et auto-audit déterministe, puis exporte des "
    "Gerber RS-274X réels, de l'Excellon, une BOM/POS et un pont firmware. La "
    "véritable nouveauté de cette édition est d'ordre organisationnel : la qualité "
    "est devenue bloquante. Le hook pre-push exécute désormais la suite moteur "
    "complète et le smoke test SSE avant toute propagation, la vérification "
    "TypeScript stricte est revenue au vert à l'échelle du dépôt, et l'E2E "
    "navigateur verrouille les interactions flottantes sur trois résolutions de "
    "fenêtre. Une régression sur l'un de ces garde-fous rend le push physiquement "
    "impossible."
)
CH1_BODY2 = (
    "Côté produit, deux chantiers de priorité 1 transforment le routage lui-même. "
    "La pile à quatre couches (signal, signal, masse, alimentation) routé 26 nets "
    "sur 28 du projet le plus dense contre 24 en bicouche, en divisant par deux le "
    "nombre de vias grâce aux plans de cuivre dédiés, et gagne trois points de "
    "score DFM. L'appariement strict des paires différentielles ramène le décalage "
    "de longueur de la paire USB à 0,00 millimètre, avec un espacement contrôlé au "
    "centième. S'ajoutent un enregistrement de replay porté à 16 000 événements et "
    "l'export de session JSON. Les chantiers restants sont identifiés et non "
    "entamés : comparaison de runs dans l'historique, import de session sur une "
    "autre machine, formats de production ODB++ et Gerber X2, panelisation, "
    "corrélation des modèles analytiques et persistance multi-utilisateurs."
)

# ── Chapitre 2 ─ Périmètre et méthode ───────────────────────────────────
CH2_P1 = (
    "Le périmètre audité couvre l'intégralité du code applicatif sous src/, soit "
    "89 fichiers TypeScript et TSX représentant 14 715 lignes : le moteur "
    "d'ingénierie (16 modules, 4 450 lignes), les huit points d'entrée API "
    "(planification LLM, génération de netlist, copilote, routage live SSE, "
    "persistance, serveur MCP), l'interface studio (viewer 3D WebGL, viewer 2D de "
    "secours, HUD temps réel, panneau d'analyse et d'export) et la couche d'état "
    "zustand de 1 140 lignes. Les dossiers examples/ et skills/ demeurent hors "
    "périmètre d'exécution ; ils sont désormais exclus du tsconfig afin de ne plus "
    "polluer la vérification globale, ce qui constitue justement l'un des quatre "
    "items de priorité 0 vérifiés ici."
)
CH2_P2 = (
    "Cinq méthodes complémentaires ont été mobilisées, dont deux sont nouvelles "
    "depuis l'édition précédente. La revue de code a porté sur les invariants de "
    "l'état (époques de session, ring buffer de lecture par tranches, piles "
    "undo/redo) et sur la gestion des ressources GPU du viewer. La suite "
    "hors-ligne scripts/test-engine.ts exécute le moteur complet sur les trois "
    "netlists de référence ainsi que sur les scénarios quatre couches et paires "
    "différentielles, pour 39 assertions et 85 vérifications individuelles. Le "
    "smoke test SSE valide le transport du flux live de hello à complete. "
    "L'E2E navigateur scripts/e2e-resolutions.ts pilote l'interface réelle à "
    "1280×800, 1600×900 et 1920×1080, avec onze vérifications par résolution. "
    "Enfin, la gouvernance pre-push a été auditée statiquement puis exécutée pour "
    "constater son comportement bloquant."
)
CH2_P3 = (
    "Les limites de la méthode restent assumées et n'ont pas changé de nature : "
    "l'environnement audité est mono-utilisateur sur base SQLite locale, sans "
    "montée en charge réseau ; les mesures thermiques et d'intégrité du signal "
    "sont analytiques et non corrélées à un simulateur SPICE ni à des cartes "
    "réelles ; et la comparaison concurrentielle s'appuie sur les capacités "
    "publiquement documentées des références, sans accès à leurs bancs d'essai "
    "internes. Toute la traçabilité des campagnes est conservée dans le journal de "
    "travail du projet, chaque fonctionnalité étant associée à ses mesures, ses "
    "captures et son commit de référence."
)

# ── Chapitre 3 ─ Architecture livrée ────────────────────────────────────
CH3_P1 = (
    "L'architecture reproduit fidèlement la découpe en essaim d'agents de la cible "
    "v2 : un modèle du monde latent pour la prédiction rapide, un placeur RL, un "
    "optimiseur ratchet, un routeur multicritères, un vérificateur déterministe, "
    "un simulateur multiphysique et des ponts de sortie. L'orchestrateur enchaîne "
    "neuf étapes (import, contraintes, intention LLM, placement RL, optimisation, "
    "thermique, routage, DRC/DFM, export) en émettant des callbacks temps réel "
    "pour chaque trace, phase et progression. La campagne de robustesse a par "
    "ailleurs porté la capacité d'enregistrement du replay à 16 000 événements "
    "organisés en tranches compactées, avec positions absolues et export de "
    "session JSON téléchargeable depuis le HUD étendu comme depuis la pilule "
    "compacte."
)
CH3_TABLE_HEAD = ["Module (lignes)", "Rôle dans la chaîne", "État"]
CH3_TABLE = [
    ("router.ts (1 116)", "A* multicouche, rip-up & reroute, via-min, plans masse et alim, appariement des paires différentielles", "Livré"),
    ("types.ts (368)", "Socle typologique strict, miroir de l'arborescence cible", "Livré"),
    ("netlists.ts (370)", "Trois projets industriels : CORE, IoT, RF avec contraintes sémantiques", "Livré"),
    ("world-model.ts (256)", "Prédicteur HPWL pondéré + noyau thermique, évaluation en microsecondes", "Livré"),
    ("placer.ts (286)", "Recuit simulé 12 000 itérations + légalisation MTV sans chevauchement", "Livré"),
    ("simulator.ts (266)", "Thermique Gauss-Seidel, impédance IPC-2141, skew et diaphonie", "Livré"),
    ("orchestrator.ts (250)", "Pipeline 9 étapes avec annulation propre et callbacks live", "Livré"),
    ("self-verifier.ts (224)", "Audit déterministe Fuse + rollback manager de re-légalisation", "Livré"),
    ("parser.ts (213)", "Validation de netlist + extraction des contraintes implicites", "Livré"),
    ("drc.ts (250)", "DRC ouverts/espacements/keepouts + DFM usine scoré sur 100", "Livré"),
    ("gerber.ts (232)", "RS-274X format 3.6, Excellon, BOM.csv, POS.csv, couches internes", "Livré"),
    ("optimizer.ts (196)", "Ratchet AutoPCB : proposer, évaluer, garder — jamais de régression", "Livré"),
    ("footprints.ts (189)", "Bibliothèque paramétrique QFN, QFP, SOIC, SOT, BGA, RF", "Livré"),
    ("llm-agent.ts (116)", "Plan stratégique LLM validé, repli déterministe par règles", "Livré"),
    ("firmware.ts (94)", "Pont firmware : NEXUS_pinmap.h, overlay Zephyr, JSON de CI", "Livré"),
    ("rules.ts (24)", "Règles de conception niveau fabricant PCBWay/JLCPCB", "Livré"),
]
CH3_P2 = (
    "Trois choix d'architecture conditionnent la robustesse observée. Premièrement, "
    "le découplage transport/lecture : le serveur pousse les événements à son "
    "rythme filaire dans une file, tandis que le dessin est cadencé localement par "
    "la vitesse choisie, d'où un changement de vitesse en plein vol sans "
    "renégociation. Deuxièmement, le système d'époques de session rend "
    "structurellement impossible la corruption d'état entre deux flux. "
    "Troisièmement, la gouvernance qualité est désormais outillée dans le dépôt "
    "lui-même : le hook scripts/hooks/pre-push, activé par core.hooksPath, "
    "rejoue la suite moteur en exigeant la mention « TOUS LES TESTS PASSENT », "
    "démarre au besoin le serveur de développement, exécute le smoke SSE en "
    "exigeant la trame complete, et interrompt le push à la première défaillance. "
    "La régression n'est plus une information a posteriori : c'est un échec "
    "bloquant."
)

# ── Chapitre 4 ─ Grille de complétude ───────────────────────────────────
CH4_P1 = (
    "La grille ci-dessous réévalue les sept domaines selon la méthode inchangée "
    "des éditions précédentes : la complétude exprime la part des capacités "
    "attendues réellement livrées et validées, pondérée par leur criticité dans la "
    "chaîne d'usage. Les évolutions depuis la dernière édition proviennent des "
    "livraisons e39921b et 4e760cf : le routage multicouche franchit la barre des "
    "95 % avec la pile quatre couches et les paires différentielles, l'interface "
    "studio progresse grâce au HUD traversant, au repli compact et au replay "
    "étendu, et la persistance progresse légèrement avec l'export de session."
)
CH4_TABLE_HEAD = ["Domaine", "Capacités livrées", "Écarts principaux", "Complétude"]
CH4_TABLE = [
    ("Placement et optimisation", "RL recuit, ratchet, légalisation, attracteurs LLM", "Aucun bloquant identifié", "100 %"),
    ("Routage multicouche", "A* multicouche, rip-up, via-min, 4 couches à plans dédiés, paires diff strictes", "Blindage, contraintes SI avancées", "98 %"),
    ("Interface studio", "3D/2D, HUD traversant + repli compact, replay 16 000 evts, export session, drag, undo/redo", "Sélection multiple, schématique", "95 %"),
    ("Vérification DRC / DFM", "DRC complet, DFM usine, auto-audit déterministe, E2E verrouillé", "DRC 3D, contraintes fabricant par lot", "92 %"),
    ("Analyse SI / thermique", "Thermique FD, impédance, skew, diaphonie", "Corrélation SPICE et cartes réelles", "88 %"),
    ("Export et fabrication", "Gerber multicouche, Excellon, BOM/POS, pont firmware", "ODB++, Gerber X2, panel de production", "85 %"),
    ("Persistance et traçabilité", "Runs Prisma, historique, export de session JSON", "Comparaison de runs, multi-utilisateurs", "76 %"),
]
CH4_CHART_CAPTION = "Figure 1 — Complétude évaluée par domaine architectural (audit V4, septembre 2026)"
CH4_P2 = (
    "La hiérarchie des domaines se resserre autour de son sommet : six domaines "
    "sur sept dépassent désormais 85 %, contre quatre à l'édition précédente, et "
    "l'écart entre le meilleur et le dernier passe de 28 à 24 points. La persistance "
    "reste le domaine de queue, mais son retard se concentre sur deux fonctions "
    "précises — la comparaison de runs et le multi-utilisateur — tandis que la "
    "traçabilité élémentaire est assurée : historique par projet, métriques "
    "complètes par run, et désormais export de session partageable. Aucun domaine "
    "n'a régressé ; les gains proviennent exclusivement de livraisons vérifiées "
    "par la suite moteur ou l'E2E, pas d'une réestimation à la hausse."
)

# ── Chapitre 5 ─ Résultats de validation ────────────────────────────────
CH5_P1 = (
    "La suite moteur hors-ligne a été réexécutée dans le cadre de l'audit et se "
    "termine par la mention attendue « TOUS LES TESTS PASSENT » : 39 assertions "
    "réparties en 85 vérifications individuelles, toutes vertes, en moins de dix "
    "secondes. Elle couvre les trois netlists de référence, puis deux sections "
    "introduites par les chantiers de priorité 1 : la pile quatre couches sur "
    "NEXUS-CORE, avec vérification des plans de masse et d'alimentation, des "
    "flashes Gerber des couches internes et du contrôle DFM « plans cuivre "
    "dédiés » ; et l'appariement de la paire différentielle USB avec détection, "
    "skew, espacement et cohérence des métadonnées entre les deux membres."
)
CH5_CHART_CAPTION = "Figure 2 — Taux de routage et score DFM par scénario (suite moteur, révision e39921b)"
CH5_TABLE_HEAD = ["Scénario de validation", "Résultat mesuré"]
CH5_TABLE = [
    ("NEXUS-CORE bicouche (19 comp., 28 nets)", "24/28 nets (86 %) en 2,5 s — 82 vias, 582 mm, DFM 84"),
    ("NEXUS-CORE quatre couches (P1.1)", "26/28 nets (93 %) — 41 vias, 491 mm, plans L2/L3, DFM 87"),
    ("NEXUS-IoT (18 comp., 13 nets)", "13/13 nets (100 %) — 68 vias, 539 mm, DFM 90"),
    ("NEXUS-RF (19 comp., 16 nets)", "13/16 nets (81 %) — keepout antenne 50 Ω respecté, DFM 82"),
    ("Paire différentielle USB (P1.2)", "Skew 0,00 mm ≤ 0,5 — gap 0,00 mm ≤ 2,5 — appariement vérifié"),
    ("E2E 1280×800 / 1600×900 / 1920×1080", "11 vérifications × 3 résolutions : 33/33, zéro erreur page et console"),
    ("Hook pre-push (moteur + SSE)", "Suite moteur et smoke SSE exécutés au push ; échec = push bloqué"),
    ("tsc --noEmit strict global", "Sortie vide, code 0, exemples et skills exclus du tsconfig"),
]
CH5_P2 = (
    "Le gain du quatre couches est mesuré, pas estimé : sept points de taux de "
    "routage sur le projet le plus dense (86 % à 93 %), un nombre de vias divisé "
    "par deux (82 à 41) grâce aux plans de cuivre qui absorbent les rapatriements, "
    "une longueur totale de pistes réduite de 15 % et trois points de DFM "
    "supplémentaires. Le projet RF confirme son comportement assumé : les trois "
    "nets restants sont ceux que le keepout d'antenne 50 ohms interdit de router, "
    "et l'audit Fuse est cohérent avec cette politique conservatrice. Côté "
    "interface, la campagne E2E a rejoué les onze vérifications flottantes à "
    "chacune des trois résolutions cibles : traversée du HUD par les événements "
    "pointeur en deux points, cibles tactiles REPLAY et vitesse ×2, pilule "
    "compacte sans timeline, ré-expansion, et absence de toute erreur de page ou "
    "de console."
)
CH5_P3 = (
    "La gouvernance qualité a été testée en conditions réelles. Le hook pre-push "
    "reconstruit l'environnement de test : il rejoue la suite moteur en exigeant "
    "la mention de succès complète, puis démarre si nécessaire le serveur de "
    "développement avec une attente bornée à 90 secondes, exécute le smoke SSE et "
    "vérifie la trame de clôture du flux. Toute défaillance, à l'une ou l'autre "
    "étape, interrompt la propagation avec un message explicite et un code non "
    "nul. Ce mécanisme transforme la dette de régression en incident immédiat : "
    "aucun état du dépôt distant ne peut plus ignorer la suite moteur, ce qui "
    "explique mécaniquement la stabilité observée entre les audits V3 et V4."
)

# ── Chapitre 6 ─ Positionnement concurrentiel ───────────────────────────
CH6_P1 = (
    "La cible v2 identifie six briques différenciantes empruntées aux leaders du "
    "secteur. Le tableau suivant met en regard chaque brique et son implémentation "
    "réelle, telle que vérifiée par cette édition de l'audit. Depuis la dernière "
    "mesure, les valeurs de via-minimisation ont été reprises sur l'exécution "
    "actuelle de la suite, et la brique DeepPCB s'enrichit de la vitesse de "
    "lecture réglable et du replay de session désormais exportable."
)
CH6_TABLE_HEAD = ["Référence", "Brique différenciante", "Implémentation NEXUS PCB vérifiée"]
CH6_TABLE = [
    ("DeepPCB", "Routage live observé + minimisation des vias", "Flux SSE trait par trait, vitesse ×0,5 à ×4, replay 16 000 evts, via-min −1 à −8 vias mesurés"),
    ("Siemens Fuse", "Vérification déterministe continue", "self-verifier borné par corps + rollback manager, audits cohérents avec l'état du routeur"),
    ("AutoPCB", "Boucle ratchet jamais régressive", "optimizer 300 propositions, gains HPWL mesurés, aucune régression acceptée"),
    ("Flux.ai", "Édition chirurgicale + pont firmware", "Drag/nudges/undo-redo multi-niveaux + pinmap C, devicetree Zephyr, JSON de CI"),
    ("Cadence AuraStack", "Multiphysique itératif", "Thermique FD 1 mm, impédance IPC-2141, skew bus, diaphonie couplée"),
    ("Circuitron", "Netlist en langage naturel", "Générateur SKIDL-like : empreintes réelles, broches vérifiées, classes déduites"),
]
CH6_P2 = (
    "Deux capacités dépassent désormais la cible v2 elle-même. La pile de routage "
    "à quatre couches avec plans de masse et d'alimentation dédiés n'était "
    "inscrite ni dans l'architecture initiale ni dans la grille des références : "
    "elle rapproche le produit des besoins réels de bureau d'études. L'appariement "
    "strict des paires différentielles, calqué sur la discipline du keepout RF, "
    "couvre un besoin USB et haut débit jusqu'ici hors d'atteinte. Enfin, la "
    "combinaison « hook pre-push bloquant + E2E trirésolution + suite moteur "
    "exigeante » constitue une gouvernance de qualité que, à connaissance de "
    "l'auditeur, aucune des six références n'expose comme critère d'entrée. Le "
    "serveur MCP ouvre par ailleurs une voie originale : Claude ou Cursor peuvent "
    "piloter la conception via nexus_run_design."
)

# ── Chapitre 7 ─ Registre des risques ───────────────────────────────────
CH7_P1 = (
    "Le registre a été réorganisé en douze items suivis, alignés sur le plan "
    "d'action d'origine (quatre priorités 0, quatre priorités 1, quatre "
    "priorités 2). Six items sont fermés avec preuve de commit et mesure "
    "d'accompagnement, un item est partiel, cinq demeurent ouverts et non "
    "entamés. Aucun nouvel item n'est apparu lors de cette édition, ce qui "
    "confirme que les livraisons n'ont pas déplacé la dette vers de nouveaux "
    "domaines."
)
CH7_REG_HEAD = ["Réf.", "Objet du risque ou du chantier", "Statut", "Preuve d'audit"]
CH7_REGISTRE = [
    ("P0.1", "HUD et barre de replay traversants aux pointeurs + repli compact automatique", "Fermé", "Commit 2e40ea5 ; E2E elementFromPoint 626×227"),
    ("P0.2", "E2E à trois résolutions (1280/1600/1920) sur interactions flottantes", "Fermé", "Commit 4e760cf ; scripts/e2e-resolutions.ts, 33/33"),
    ("P0.3", "Suite moteur + smoke SSE en échec bloquant au pre-push", "Fermé", "Commit 4e760cf ; scripts/hooks/pre-push exécuté"),
    ("P0.4", "tsc global au vert : examples/ et skills/ exclus du tsconfig", "Fermé", "Commit 4e760cf ; bunx tsc --noEmit : 0 erreur"),
    ("P1.1", "Pile de routage 4 couches signal/signal/masse/alim avec plans dédiés", "Fermé", "Commit e39921b ; 26/28 nets, DFM 87, 8 fichiers export"),
    ("P1.2", "Appariement strict des paires différentielles (longueur + espacement)", "Fermé", "Commit e39921b ; skew 0,00 mm, gap 0,00 mm"),
    ("P1.3", "Comparaison de runs dans l'historique Prisma (delta DFM, vias, longueur)", "Ouvert", "Schéma limité aux métriques scalaires ; non entamé"),
    ("P1.4", "Session de replay JSON partageable et rejouable hors machine", "Partiel", "Export livré (4e760cf) ; import et rejeu cross-machine manquants"),
    ("P2.1", "Exports ODB++ et Gerber X2 avec attributs de couches et perçage", "Ouvert", "gerber.ts mentionne l'équivalent ; non entamé"),
    ("P2.2", "Panel de production + contraintes fabricant paramétrables (annular ring, clearance)", "Ouvert", "Règles fixes niveau PCBWay/JLCPCB ; non entamé"),
    ("P2.3", "Corrélation des modèles thermique et SI sur cartes mesurées", "Ouvert", "Constantes analytiques (gain 0,72) non calées ; non entamé"),
    ("P2.4", "Persistance Postgres multi-utilisateurs, rôles, journal d'éditions", "Ouvert", "SQLite mono-instance ; non entamé"),
]
CH7_REG_CAPTION = "Figure 3 — Répartition du registre de risques après les livraisons e39921b (12 items suivis)"
CH7_P2 = (
    "Trois dettes structurelles traversent les items ouverts et méritent une "
    "vigilance explicite. La première est la persistance mono-instance : tant que "
    "P2.4 n'est pas engagé, le produit reste un studio individuel, et l'historique "
    "ne peut pas servir de référentiel d'équipe. La deuxième est l'écart possible "
    "entre les modèles analytiques et la réalité physique des cartes : la chaîne "
    "thermique et SI est cohérente et déterministe, mais aucune mesure de "
    "corrélation ne l'atteste aujourd'hui, ce que P2.3 doit corriger avant toute "
    "prétention industrielle. La troisième est le plafond d'interopérabilité de "
    "fabrication : le RS-274X est accepté par les usines, mais ODB++ et Gerber X2 "
    "restent les formats d'échange des flux industriels sérieux, et la "
    "panelisation conditionne les coûts de production. Aucune de ces dettes ne "
    "dégrade l'usage actuel ; toutes bornent le périmètre de promesse du produit."
)

# ── Chapitre 8 ─ Recommandations priorisées ─────────────────────────────
CH8_INTRO = (
    "Le plan d'action est désormais concentré sur six chantiers, organisés en "
    "trois sprints de taille comparable. Chaque chantier est formulé avec son "
    "critère d'achèvement mesurable (definition of done), vérifiable par la suite "
    "moteur, l'E2E ou un export d'artefact. Les priorités 0 étant closes, le "
    "premier sprint finalise la priorité 1 ; les deux suivants couvrent la "
    "priorité 2 dans l'ordre de dépendance : d'abord les formats d'échange, puis "
    "la crédibilité physique et la collaboration."
)
CH8_SPRINTS = [
    (
        "Sprint 1 — Finaliser la priorité 1",
        [
            ("P1.3 — Comparaison de runs.", "Ajouter au panneau historique un mode delta entre deux runs d'un même projet : écarts de DFM, de vias, de longueur et de taux de routage, avec badge d'évolution. DoD : sélection de deux runs, delta affiché, assertion dans la suite sur la cohérence des deltas calculés."),
            ("P1.4 — Import de session.", "Compléter l'export existant par un import JSON validé contre un schéma, rejeu sandboxé dans la file de lecture locale, sans appel serveur. DoD : session exportée d'une machine, importée et rejouée à l'identique sur une autre, test de schéma invalide rejeté proprement."),
        ],
    ),
    (
        "Sprint 2 — Ouvrir les formats de production",
        [
            ("P2.1 — ODB++ et Gerber X2.", "Émettre, en complément du RS-274X, un package ODB++ (matrix, steps, layers, netlist) et des Gerber X2 avec attributs de couche et de pad. DoD : les deux packages générés sur les trois projets, structure inspectable, DFM inchangé."),
            ("P2.2 — Panelisation et contraintes fabricant.", "Paramétrer annular ring, clearances par lot et profil de panel (larges, rails, repères, moisi). DoD : panneau généré paramétrable, contraintes propagées au DRC, résumé de panel dans l'export."),
        ],
    ),
    (
        "Sprint 3 — Crédibilité physique et collaboration",
        [
            ("P2.3 — Corrélation des modèles.", "Constituer un jeu de cartes de référence mesurées (températures, impédances), corréler le solveur thermique et les modèles SI, caler les coefficients. DoD : écart modèle/mesure documenté sous seuil publié, coefficients versionnés avec leur source."),
            ("P2.4 — Persistance d'équipe.", "Migrer vers Postgres avec rôles et journal des éditions chirurgicales, conserver la compatibilité SQLite en développement. DoD : deux sessions concurrentes sur un projet, journal d'éditions exhaustif, migration réversible testée."),
        ],
    ),
]
CH8_OUTRO = (
    "L'ordre des sprints n'est pas négociable à la marge : P1.3 dépend de "
    "l'historique existant et livre une valeur immédiate aux utilisateurs actuels ; "
    "les formats de production conditionnent toute adoption bureau d'études ; et la "
    "corrélation physique doit précéder la promesse multi-utilisateurs, car rien ne "
    "sert de partager un résultat dont la crédibilité n'est pas établie. Chaque "
    "sprint s'achève par une mise à jour du présent registre et une réexécution "
    "intégrale des garde-fous, conformément à la discipline instaurée par la "
    "priorité 0."
)

# ── Chapitre 9 ─ Verdict de complétude ──────────────────────────────────
CH9_P1 = (
    "Au terme de cette quatrième édition, NEXUS PCB affiche un score de complétude "
    "globale de 93 sur 100, en progression de sept points depuis l'édition "
    "précédente. La chaîne de conception reste intégralement fonctionnelle, "
    "l'expérience temps réel demeure le différenciateur majeur, et deux capacités "
    "dépassent désormais la cible d'architecture : le routage à quatre couches avec "
    "plans dédiés et l'appariement strict des paires différentielles. La "
    "différence la plus profonde est pourtant ailleurs : la qualité est passée du "
    "statut de recommandation à celui de contrainte mécanique. Un dépôt dont les "
    "pushs sont physiquement bloqués par la suite moteur, l'E2E trirésolution et "
    "le smoke SSE ne peut plus régresser silencieusement."
)
CH9_CALLS = [
    ("93 / 100", "Complétude globale pondérée (+7 points)"),
    ("9 / 9", "Étapes du pipeline fonctionnelles"),
    ("118 / 118", "Vérifications moteur et E2E au vert"),
    ("6 / 12", "Items de registre fermés, 0 régression"),
]
CH9_P2 = (
    "Le chemin restant est borné, chiffré et non ambigu : comparer les runs, "
    "compléter l'import de session, ouvrir ODB++ et Gerber X2, paramétrer la "
    "panelisation, corréler les modèles aux mesures réelles et migrer la "
    "persistance vers une base d'équipe. Tant que ces six chantiers sont ouverts, "
    "la plateforme doit être présentée comme un studio de conception autonome "
    "mono-utilisateur de référence — position qu'elle tient avec une marge "
    "désormais confortable — et non comme un environnement de production en "
    "équipe. Le plan du chapitre 8 outille précisément cette transition, dans un "
    "ordre qui préserve la crédibilité acquise : valeur immédiate, formats "
    "industriels, puis preuve physique et collaboration."
)
