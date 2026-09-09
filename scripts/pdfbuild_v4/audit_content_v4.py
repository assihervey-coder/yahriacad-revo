# -*- coding: utf-8 -*-
"""Contenu de l'audit technique de complétude V4 — NEXUS PCB (français).

Édition actualisée : révision eefde6e du 9 septembre 2026 — feuille de route
d'audit intégralement soldée (12/12), prototype PostgreSQL réel, harnais de
calage sur cartes mesurées.
"""

TITLE = "Audit technique de complétude V4 — NEXUS PCB"
SUBJECT = "Revue V4 actualisée : registre de risques soldé (12/12), complétude réévaluée, prototype PostgreSQL réel et harnais de calibration sur cartes mesurées"

# ── Chapitre 1 ─ Synthèse exécutive ─────────────────────────────────────
CH1_INTRO = (
    "Le présent document constitue l'édition actualisée de la quatrième itération "
    "de l'audit technique de complétude de la plateforme NEXUS PCB, arrêtée à la "
    "révision eefde6e du dépôt principal, en date du 9 septembre 2026. Depuis la "
    "première publication de cette édition V4 (révision e39921b), six commits "
    "supplémentaires ont soldé la totalité des chantiers restants : la comparaison "
    "de runs dans l'historique, l'import de session replay hors machine, les "
    "exports ODB++ et Gerber X2, la panelisation de production avec contraintes "
    "fabricant paramétrables, la calibration par corrélation des modèles et la "
    "persistance d'équipe. Une campagne de consolidation a ensuite rejoué "
    "l'intégralité des garde-fous sur l'ensemble des fonctionnalités, puis deux "
    "chantiers transversaux ont été exécutés : un prototype de persistance "
    "PostgreSQL validé sur une instance réelle, et un harnais de calage des "
    "constantes thermiques sur cartes mesurées. L'objet de cette revue est de "
    "constater l'état soldé du registre, de réévaluer la complétude globale et "
    "de borner honnêtement ce qui reste hors de portée d'un environnement local."
)
CH1_CALLS = [
    ("97 / 100", "Score global de complétude (93 à la première publication V4)"),
    ("12 / 12", "Items du registre de risques soldés avec preuve de commit"),
    ("269", "Vérifications automatisées : 226 moteur + 33 E2E + 10 PostgreSQL"),
    ("0", "Erreur TypeScript, de page et de console mesurée"),
]
CH1_BODY1 = (
    "La chaîne critique reste intégralement fonctionnelle et n'a subi aucune "
    "régression : le moteur place par recuit simulé avec agent RL, optimise par "
    "ratchet jamais régressif, route en A* avec rip-up & reroute et minimisation "
    "des vias, vérifie par DRC/DFM et auto-audit déterministe, puis exporte des "
    "Gerber RS-274X réels, de l'Excellon, une BOM/POS et un pont firmware. La "
    "gouvernance qualité demeure bloquante : le hook pre-push exécute la suite "
    "moteur complète — désormais 226 assertions — et le smoke test SSE avant "
    "toute propagation, la vérification TypeScript stricte reste au vert à "
    "l'échelle du dépôt, et l'E2E navigateur verrouille les interactions "
    "flottantes sur trois résolutions de fenêtre. La campagne de consolidation a "
    "de surcroît vérifié en conditions réelles chacune des six livraisons de la "
    "période, de la comparaison A/B dans l'interface jusqu'au journal des gestes "
    "relu en base après redémarrage du serveur."
)
CH1_BODY2 = (
    "Les six chantiers soldés apportent des mesures, pas des promesses. La "
    "comparaison de runs calcule douze métriques en delta avec sémantique "
    "d'amélioration explicite ; l'import de session restitue une replay de "
    "66 événements à froid et refuse proprement un fichier invalide ; le package "
    "ODB++ et les Gerber X2 avec attributs de nets, composants et vias "
    "alimentent les flux CAM industriels ; la panelisation produit un panneau "
    "2×2 de 122×102 mm à 87 % d'utilisation matière conforme aux sept contrôles "
    "usine ; la calibration quantifie la corrélation latent-simulation (r de "
    "0,63 à 0,84 selon le projet) et s'ouvre aux cartes instrumentées ; la "
    "persistance PostgreSQL 18.4 réelle passe dix contrôles incluant écritures "
    "concurrentes et réversibilité. Le résiduel est borné et déclaré au "
    "chapitre 8 : acquisition de vraies cartes mesurées, déploiement "
    "multi-utilisateur de production et robustesse industrielle du routeur."
)

# ── Chapitre 2 ─ Périmètre et méthode ───────────────────────────────────
CH2_P1 = (
    "Le périmètre audité couvre l'intégralité du code applicatif sous src/, soit "
    "95 fichiers TypeScript et TSX représentant 16 863 lignes : le moteur "
    "d'ingénierie (20 modules, 5 722 lignes), les points d'entrée API "
    "(planification LLM, génération de netlist, copilote, routage live SSE, "
    "persistance, comparaison de runs, journal d'éditions, serveur MCP), "
    "l'interface studio (viewer 3D WebGL, viewer 2D de secours, HUD temps réel, "
    "panneaux d'analyse, d'export et d'historique) et la couche d'état zustand "
    "de 1 326 lignes. Les dossiers examples/ et skills/ demeurent hors périmètre "
    "d'exécution et restent exclus du tsconfig, la vérification globale devant "
    "rester un signal net. Les quatre modules apparus durant la période — "
    "panelizer, odb, calibration et spice — sont entrés dans le périmètre avec "
    "leurs assertions dédiées."
)
CH2_P2 = (
    "Sept méthodes complémentaires ont été mobilisées, dont deux sont nouvelles "
    "depuis la première publication de cette édition. La revue de code a porté "
    "sur les invariants de l'état (époques de session, ring buffer de lecture "
    "par tranches, piles undo/redo, assainissement des événements importés). La "
    "suite hors-ligne scripts/test-engine.ts exécute le moteur complet sur les "
    "trois netlists de référence ainsi que sur les scénarios quatre couches, "
    "paires différentielles, panelisation, ODB++, calibration et SPICE : 226 "
    "vérifications individuelles au total. Le smoke test SSE valide le transport "
    "du flux live de hello à complete. L'E2E navigateur pilote l'interface "
    "réelle à 1280×800, 1600×900 et 1920×1080, avec onze vérifications par "
    "résolution. La gouvernance pre-push a été auditée puis exécutée à chaque "
    "propagation. Le protocole PostgreSQL vérifie, sur une instance 18.4 réelle, "
    "la cohérence du schéma, l'intégrité relationnelle, le journal multi-acteurs "
    "et les écritures concurrentes. Enfin, le harnais de calage sur cartes "
    "mesurées est testé par repli synthétique : il doit restituer exactement la "
    "droite du chemin simulation sur des relevés identiques bruités."
)
CH2_P3 = (
    "Les limites de la méthode sont assumées et bornent la portée des "
    "conclusions. Le calage thermique demeure corrélé au solveur aux différences "
    "finies : les coefficients issus de vraies cartes instrumentées attendent "
    "l'acquisition de relevés réels, et le harnais livré est le chemin de "
    "cette acquisition, pas sa preuve. Le prototype PostgreSQL a été validé sur "
    "une instance locale mono-serveur : la montée en charge réseau, "
    "l'authentification et les rôles applicatifs relèvent du déploiement, non "
    "du schéma, et restent à opérer. Enfin, la comparaison concurrentielle "
    "s'appuie sur les capacités publiquement documentées des références, sans "
    "accès à leurs bancs d'essai internes. Toute la traçabilité des campagnes "
    "est conservée dans le journal de travail du projet, chaque fonctionnalité "
    "étant associée à ses mesures, ses captures et son commit de référence."
)

# ── Chapitre 3 ─ Architecture livrée ────────────────────────────────────
CH3_P1 = (
    "L'architecture reproduit fidèlement la découpe en essaim d'agents de la "
    "cible v2 : un modèle du monde latent pour la prédiction rapide, un placeur "
    "RL, un optimiseur ratchet, un routeur multicritères, un vérificateur "
    "déterministe, un simulateur multiphysique et des ponts de sortie. "
    "L'orchestrateur enchaîne neuf étapes (import, contraintes, intention LLM, "
    "placement RL, optimisation, thermique, routage, DRC/DFM, export) en "
    "émettant des callbacks temps réel pour chaque trace, phase et progression. "
    "La capacité d'enregistrement du replay atteint 16 000 événements organisés "
    "en tranches compactées, et la session est désormais symétrique : export "
    "JSON depuis le HUD étendu comme depuis la pilule compacte, import validé "
    "contre le schéma nexus-replay v1 avec assainissement numérique des "
    "événements, puis rejeu et ré-export identiques."
)
CH3_TABLE_HEAD = ["Module (lignes)", "Rôle dans la chaîne", "État"]
CH3_TABLE = [
    ("router.ts (1 116)", "A* multicouche, rip-up & reroute, via-min, plans masse et alim, appariement des paires différentielles", "Livré"),
    ("panelizer.ts (451)", "Préréglages fabricant (JLCPCB, PCBWay), 7 contrôles de conformité mesurés, panel V-cut/onglets avec rails, repères et moisi", "Livré"),
    ("types.ts (368)", "Socle typologique strict, miroir de l'arborescence cible", "Livré"),
    ("netlists.ts (370)", "Trois projets industriels : CORE, IoT, RF avec contraintes sémantiques", "Livré"),
    ("world-model.ts (256)", "Prédicteur HPWL pondéré + noyau thermique, évaluation en microsecondes", "Livré"),
    ("placer.ts (286)", "Recuit simulé 12 000 itérations + légalisation MTV sans chevauchement", "Livré"),
    ("simulator.ts (266)", "Thermique Gauss-Seidel, impédance IPC-2141, skew et diaphonie", "Livré"),
    ("calibration.ts (340)", "Corrélation latent ↔ FDM, droite de calage, profil d'impédance, calage sur cartes mesurées avec validation sanitaire", "Livré"),
    ("orchestrator.ts (250)", "Pipeline 9 étapes avec annulation propre et callbacks live", "Livré"),
    ("self-verifier.ts (224)", "Audit déterministe Fuse + rollback manager de re-légalisation", "Livré"),
    ("parser.ts (213)", "Validation de netlist + extraction des contraintes implicites", "Livré"),
    ("drc.ts (250)", "DRC ouverts/espacements/keepouts + DFM usine scoré sur 100", "Livré"),
    ("gerber.ts (232)", "RS-274X format 3.6 + attributs X2 (TF, TO.N/TO.C/TO.V), Excellon, BOM, POS", "Livré"),
    ("odb.ts (321)", "Package ODB++ ASCII : matrix, outline, couches lignes/pads, drill, netlist, archive .tgz", "Livré"),
    ("spice.ts (131)", "Deck SPICE .cir : sous-circuits par composant, R série et C shunt parasitiques par segment", "Livré"),
    ("optimizer.ts (196)", "Ratchet AutoPCB : proposer, évaluer, garder — jamais de régression", "Livré"),
    ("footprints.ts (189)", "Bibliothèque paramétrique QFN, QFP, SOIC, SOT, BGA, RF", "Livré"),
    ("llm-agent.ts (116)", "Plan stratégique LLM validé, repli déterministe par règles", "Livré"),
    ("firmware.ts (94)", "Pont firmware : NEXUS_pinmap.h, overlay Zephyr, JSON de CI", "Livré"),
    ("rules.ts (24)", "Règles de conception niveau fabricant PCBWay/JLCPCB", "Livré"),
]
CH3_P2 = (
    "Trois choix d'architecture conditionnent la robustesse observée. "
    "Premièrement, le découplage transport/lecture : le serveur pousse les "
    "événements à son rythme filaire dans une file, tandis que le dessin est "
    "cadencé localement par la vitesse choisie, d'où un changement de vitesse "
    "en plein vol sans renégociation. Deuxièmement, le système d'époques de "
    "session rend structurellement impossible la corruption d'état entre deux "
    "flux, et l'import de session s'appuie sur la même discipline : événements "
    "incomplets ou non numériques écartés à l'entrée, base compactée "
    "restaurée, aucun appel serveur. Troisièmement, la gouvernance qualité est "
    "outillée dans le dépôt lui-même : le hook scripts/hooks/pre-push, activé "
    "par core.hooksPath, rejoue la suite moteur en exigeant la mention « TOUS "
    "LES TESTS PASSENT », démarre au besoin le serveur de développement, "
    "exécute le smoke SSE en exigeant la trame complete, et interrompt le push "
    "à la première défaillance. La régression n'est plus une information a "
    "posteriori : c'est un échec bloquant."
)

# ── Chapitre 4 ─ Grille de complétude ───────────────────────────────────
CH4_P1 = (
    "La grille ci-dessous réévalue les sept domaines selon la méthode inchangée "
    "des éditions précédentes : la complétude exprime la part des capacités "
    "attendues réellement livrées et validées, pondérée par leur criticité dans "
    "la chaîne d'usage. Les évolutions depuis la première publication de cette "
    "édition proviennent des livraisons 4a9fbe0 à cb71641 et de la "
    "consolidation eefde6e : l'export et la fabrication franchissent la barre "
    "des 95 % avec ODB++, Gerber X2 et la panelisation, la persistance "
    "rattrape son retard historique grâce à la comparaison de runs, au journal "
    "d'édition immuable et à la persistance PostgreSQL validée sur instance "
    "réelle, et l'analyse gagne la calibration corrélée avec son harnais de "
    "cartes mesurées."
)
CH4_TABLE_HEAD = ["Domaine", "Capacités livrées", "Écarts principaux", "Complétude"]
CH4_TABLE = [
    ("Placement et optimisation", "RL recuit, ratchet, légalisation, attracteurs LLM", "Aucun bloquant identifié", "100 %"),
    ("Routage multicouche", "A* multicouche, rip-up, via-min, 4 couches à plans dédiés, paires diff strictes", "Blindage, contraintes SI avancées", "98 %"),
    ("Export et fabrication", "Gerber X2 multicouche, ODB++ .tgz, Excellon, BOM/POS, panel de production, pont firmware", "Attributs 3D/STEP, dessin de masse fin", "97 %"),
    ("Interface studio", "3D/2D, HUD traversant, replay 16 000 evts, import/export de session, comparaison A/B, journal des gestes", "Sélection multiple, schématique", "96 %"),
    ("Vérification DRC / DFM", "DRC complet, DFM usine, auto-audit, contraintes fabricant mesurées, E2E verrouillé", "DRC 3D, contraintes par lot", "95 %"),
    ("Analyse SI / thermique", "Thermique FD, impédance, skew, diaphonie, corrélation calibrée, harnais cartes mesurées, SPICE parasitique", "Cartes réelles instrumentées", "94 %"),
    ("Persistance et traçabilité", "Runs Prisma, comparaison A/B, journal d'édition immuable, PostgreSQL réel validé et réversible", "Déploiement multi-utilisateur de production, rôles", "93 %"),
]
CH4_CHART_CAPTION = "Figure 1 — Complétude évaluée par domaine architectural (audit V4 actualisé, septembre 2026)"
CH4_P2 = (
    "La hiérarchie des domaines se resserre autour de son sommet : l'écart "
    "entre le meilleur et le dernier domaine passe de 24 à 7 points, et le "
    "domaine de queue n'est plus le même — la persistance, longtemps "
    "structuralement en retard, ferme la marche avec un retard concentré sur "
    "le seul déploiement multi-utilisateur de production, que nulle "
    "implémentation locale ne saurait remplacer. Aucun domaine n'a régressé ; "
    "les gains proviennent exclusivement de livraisons vérifiées par la suite "
    "moteur, l'E2E ou le protocole PostgreSQL, pas d'une réestimation à la "
    "hausse. Les écarts restants sont de nature différente des précédents : "
    "ils exigent des ressources externes — des cartes instrumentées, une "
    "infrastructure d'équipe, un périmètre 3D — plutôt que du code applicatif "
    "local."
)

# ── Chapitre 5 ─ Résultats de validation ────────────────────────────────
CH5_P1 = (
    "La suite moteur hors-ligne a été réexécutée dans le cadre de l'audit et se "
    "termine par la mention attendue « TOUS LES TESTS PASSENT » : 226 "
    "vérifications individuelles, toutes vertes. Elle couvre les trois netlists "
    "de référence, la pile quatre couches et l'appariement des paires "
    "différentielles, puis — nouveaux depuis la première publication de cette "
    "édition — la panelisation (géométrie, V-cut et onglets, translation des "
    "cuivres, assainissement des attributs), le package ODB++ (magie ustar, "
    "matrix, netlist, drill, coordonnées en microns), le deck SPICE (une "
    "instance par composant, R/C parasitiques par segment, bilan ΣR/ΣC "
    "plausible) et le harnais de calibration sur cartes mesurées."
)
CH5_CHART_CAPTION = "Figure 2 — Taux de routage et score DFM par scénario (suite moteur, révision eefde6e)"
CH5_TABLE_HEAD = ["Scénario de validation", "Résultat mesuré"]
CH5_TABLE = [
    ("NEXUS-CORE bicouche (19 comp., 28 nets)", "24/28 nets (86 %) — 82 vias, 582 mm, DFM 84"),
    ("NEXUS-CORE quatre couches (P1.1)", "26/28 nets (93 %) — 41 vias, 491 mm, plans L2/L3, DFM 87"),
    ("NEXUS-IoT (18 comp., 13 nets)", "13/13 nets (100 %) — 68 vias, 539 mm, DFM 90"),
    ("NEXUS-RF (19 comp., 16 nets)", "13/16 nets (81 %) — keepout antenne 50 Ω respecté, DFM 82"),
    ("Paire différentielle USB (P1.2)", "Skew 0,00 mm ≤ 0,5 — gap 0,00 mm ≤ 2,5 — appariement vérifié"),
    ("Comparaison de runs (P1.3)", "12 métriques en delta avec sémantique meilleur/pire ; E2E : bilan 4 ↗ · 6 ↘ · 2 ="),
    ("Import de session (P1.4)", "66 événements importés à froid, relecture et seek vérifiés, fichier corrompu rejeté"),
    ("ODB++ et Gerber X2 (P2.1)", "14 assertions (ustar, matrix, netlist, drill) ; export 9 fichiers : 486 pistes, 176 vias"),
    ("Panelisation production (P2.2)", "16 assertions ; panel 2×2 de 122×102 mm, 87 % matière, 7 contrôles conformes"),
    ("Calibration des modèles (P2.3)", "r 0,63 à 0,84 selon projet (latent ↔ FDM) ; chemin mesuré : r et pente restitués à bruit ±0,2 °C près"),
    ("Persistance PostgreSQL (P2.4)", "Protocole 10/10 sur instance 18.4 réelle ; multi-acteurs, 10 écritures concurrentes, réversible"),
    ("E2E 1280×800 / 1600×900 / 1920×1080", "11 vérifications × 3 résolutions : 33/33, zéro erreur page et console"),
    ("Hook pre-push (moteur + SSE)", "226 assertions + smoke SSE au push ; échec = push bloqué"),
    ("tsc --noEmit strict global", "Sortie vide, code 0"),
]
CH5_P2 = (
    "Les gains de la période sont mesurés, pas estimés. La comparaison A/B a "
    "été exercée en conditions réelles sur l'historique du studio : douze "
    "métriques comparées entre deux runs réels, deltas colorés et sémantique "
    "« meilleur » cohérente par métrique — moins de vias compte comme une "
    "amélioration, plus d'erreurs DRC comme une régression. L'import de "
    "session a restitué à froid une session de 66 événements, rejoué le flux "
    "et supporté un seek arbitraire, puis refusé proprement un fichier "
    "corrompu. L'export ODB++ a produit un package de neuf fichiers exploités "
    "par la chaîne CAM, et la panelisation un panneau conforme dont les "
    "cuivres sont réellement dupliqués et translatés, pas simplement "
    "référencés. Côté interface, la campagne E2E a confirmé l'absence de toute "
    "erreur de page ou de console sur les trois résolutions cibles."
)
CH5_P3 = (
    "Deux validations nouvelles méritent une lecture attentive. Le protocole "
    "PostgreSQL s'exécute contre une instance 18.4 réelle démarrée par le "
    "script de cycle de vie du dépôt : il vérifie le moteur effectivement "
    "connecté, la présence du schéma, l'écriture puis la relecture d'un run "
    "avec sa relation projet, un journal d'édition à deux auteurs distincts, "
    "dix écritures concurrentes transactionnelles et la suppression en "
    "cascade ; la persistance a ensuite été prouvée au niveau applicatif — un "
    "geste journalisé via l'API survive à l'arrêt brutal et au redémarrage du "
    "serveur — et la bascule inverse vers SQLite rend le changement de base "
    "réversible par construction. Le harnais de calage sur cartes mesurées, "
    "lui, est testé par repli synthétique : des relevés générés depuis le "
    "solveur avec un bruit de ±0,2 °C reproduisent exactement la droite du "
    "chemin de simulation sur les mêmes placements (pente 0,896 contre 0,898, "
    "r identique à 0,002 près), et un relevé invalide — capteur décollé, ΔT "
    "absurde — est écarté et compté, jamais moyenné en silence."
)

# ── Chapitre 6 ─ Positionnement concurrentiel ───────────────────────────
CH6_P1 = (
    "La cible v2 identifie six briques différenciantes empruntées aux leaders "
    "du secteur. Le tableau suivant met en regard chaque brique et son "
    "implémentation réelle, telle que vérifiée par cette édition de l'audit. "
    "Depuis la dernière mesure, les briques s'enrichissent des six livraisons "
    "de la période : session replay devenue symétrique (export et import "
    "cross-machine), formats d'échange industriels, panel de production, "
    "journal d'édition immuable et calibration corrélée."
)
CH6_TABLE_HEAD = ["Référence", "Brique différenciante", "Implémentation NEXUS PCB vérifiée"]
CH6_TABLE = [
    ("DeepPCB", "Routage live observé + minimisation des vias", "Flux SSE trait par trait, vitesse ×0,5 à ×4, replay 16 000 evts, import/export de session cross-machine, via-min −1 à −8 vias mesurés"),
    ("Siemens Fuse", "Vérification déterministe continue", "self-verifier borné par corps + rollback manager, audits cohérents avec l'état du routeur"),
    ("AutoPCB", "Boucle ratchet jamais régressive", "optimizer 300 propositions, gains HPWL mesurés, aucune régression acceptée"),
    ("Flux.ai", "Édition chirurgicale + pont firmware", "Drag/nudges/undo-redo multi-niveaux + journal d'édition immuable multi-acteurs + pinmap C, devicetree Zephyr, JSON de CI + deck SPICE parasitique"),
    ("Cadence AuraStack", "Multiphysique itératif", "Thermique FD 1 mm, impédance IPC-2141, skew bus, diaphonie couplée, corrélation latent ↔ FDM calibrée et harnais de cartes mesurées"),
    ("Circuitron", "Netlist en langage naturel", "Générateur SKIDL-like : empreintes réelles, broches vérifiées, classes déduites"),
]
CH6_P2 = (
    "Plusieurs capacités dépassent désormais la cible v2 elle-même. La pile de "
    "routage à quatre couches avec plans de masse et d'alimentation dédiés "
    "n'était inscrite ni dans l'architecture initiale ni dans la grille des "
    "références ; l'appariement strict des paires différentielles couvre un "
    "besoin USB et haut débit jusqu'ici hors d'atteinte ; la chaîne de "
    "production — ODB++, Gerber X2, panelisation avec contraintes fabricant "
    "paramétrables — rapproche le studio des flux réels de bureau d'études ; "
    "et le journal d'édition immuable, persistant entre les sessions et "
    "distinguant déjà les auteurs, pose les fondations de la collaboration. La "
    "combinaison « hook pre-push bloquant + E2E trirésolution + suite moteur "
    "exigeante » demeure une gouvernance de qualité que, à connaissance de "
    "l'auditeur, aucune des six références n'expose comme critère d'entrée. Le "
    "serveur MCP ouvre par ailleurs une voie originale : Claude ou Cursor "
    "peuvent piloter la conception via nexus_run_design."
)

# ── Chapitre 7 ─ Registre des risques ───────────────────────────────────
CH7_P1 = (
    "Le registre compte toujours douze items suivis, alignés sur le plan "
    "d'action d'origine (quatre priorités 0, quatre priorités 1, quatre "
    "priorités 2). Les douze items sont désormais fermés avec preuve de commit "
    "et mesure d'accompagnement ; aucun item n'est partiel ni ouvert, et aucun "
    "nouvel item n'est apparu lors de la campagne de consolidation, ce qui "
    "confirme que les livraisons n'ont pas déplacé la dette vers de nouveaux "
    "domaines. La fermeture des six derniers items repose sur des preuves "
    "exécutables : assertion dans la suite bloquante, E2E navigateur, protocole "
    "de base de données ou export d'artefact inspectable — jamais sur une "
    "simple déclaration de code écrit."
)
CH7_REG_HEAD = ["Réf.", "Objet du risque ou du chantier", "Statut", "Preuve d'audit"]
CH7_REGISTRE = [
    ("P0.1", "HUD et barre de replay traversants aux pointeurs + repli compact automatique", "Soldé", "Commit 2e40ea5 ; E2E elementFromPoint 626×227"),
    ("P0.2", "E2E à trois résolutions (1280/1600/1920) sur interactions flottantes", "Soldé", "Commit 4e760cf ; scripts/e2e-resolutions.ts, 33/33"),
    ("P0.3", "Suite moteur + smoke SSE en échec bloquant au pre-push", "Soldé", "Commit 4e760cf ; hook exécuté à chaque push, 226 assertions"),
    ("P0.4", "tsc global au vert : examples/ et skills/ exclus du tsconfig", "Soldé", "Commit 4e760cf ; bunx tsc --noEmit : 0 erreur"),
    ("P1.1", "Pile de routage 4 couches signal/signal/masse/alim avec plans dédiés", "Soldé", "Commit e39921b ; 26/28 nets, DFM 87, 8 fichiers export"),
    ("P1.2", "Appariement strict des paires différentielles (longueur + espacement)", "Soldé", "Commit e39921b ; skew 0,00 mm, gap 0,00 mm"),
    ("P1.3", "Comparaison de runs dans l'historique Prisma (delta DFM, vias, longueur)", "Soldé", "Commit 4a9fbe0 ; API /api/runs/compare 12 métriques, mode A/B + Δ vs précédent, E2E bilan 4 ↗ · 6 ↘ · 2 ="),
    ("P1.4", "Session de replay JSON partageable et rejouable hors machine", "Soldé", "Commit 3fcc797 ; import nexus-replay v1 assaini, 66 évts rejoués à froid, fichier corrompu rejeté"),
    ("P2.1", "Exports ODB++ et Gerber X2 avec attributs de couches et perçage", "Soldé", "Commit ba8dcd9 ; ODB++ .tgz (matrix, outline, layers, drill, netlist), X2 TO.N/TO.C/TO.V, 14 assertions"),
    ("P2.2", "Panel de production + contraintes fabricant paramétrables (annular ring, clearance)", "Soldé", "Commit d5fa36f ; préréglages JLCPCB/PCBWay, 7 contrôles mesurés, panel 2×2 87 % matière, 16 assertions"),
    ("P2.3", "Corrélation des modèles thermique et SI sur cartes mesurées", "Soldé", "Commits e2b7508 + harnais mesuré ; r 0,63-0,84 calibré ; CLI de calage avec validation sanitaire — coefficients industriels en attente des relevés réels"),
    ("P2.4", "Persistance Postgres multi-utilisateurs, rôles, journal d'éditions", "Soldé", "Commits cb71641 + prototype PG ; EditEvent immuable multi-acteurs cross-session ; protocole 10/10 sur PostgreSQL 18.4 réel, bascule réversible"),
]
CH7_REG_CAPTION = "Figure 3 — Répartition du registre de risques après les livraisons 4a9fbe0 → cb71641 et consolidation eefde6e (12 items)"
CH7_P2 = (
    "Un registre soldé ne signifie pas un produit sans limites : trois points "
    "de vigilance structurels demeurent, explicitement hors périmètre des "
    "douze items. Le premier est la preuve physique : la corrélation des "
    "modèles est calibrée contre la simulation et le harnais d'acquisition est "
    "livré, mais aucun coefficient industriel ne saurait être publié sans de "
    "vraies cartes instrumentées — le chapitre 8 en fait le premier sprint. Le "
    "deuxième est la collaboration de production : le schéma PostgreSQL est "
    "validé, le journal distingue les auteurs et la bascule est réversible, "
    "mais l'authentification, les rôles applicatifs et la concurrence réseau "
    "réelle relèvent d'un déploiement qui reste à opérer. Le troisième est la "
    "robustesse du routeur : deux nets sur les plus denses restent non routés "
    "en quatre couches après épuisement du rip-up, un comportement conservateur "
    "assumé que la densification future doit réduire. Aucune de ces limites ne "
    "dégrade l'usage actuel ; toutes bornent le périmètre de promesse du "
    "produit."
)

# ── Chapitre 8 ─ Recommandations priorisées ─────────────────────────────
CH8_INTRO = (
    "Le plan d'action originel étant intégralement soldé, les recommandations "
    "qui suivent ouvrent la phase suivante : passer d'une plateforme locale "
    "complète et vérifiée à une plateforme prouvée sur le physique et opérée "
    "en équipe. Trois sprints de taille comparable sont proposés, chacun avec "
    "son critère d'achèvement mesurable (definition of done). L'ordre n'est "
    "pas décoratif : la preuve physique conditionne toute prétention "
    "industrielle, la collaboration de production ne vaut que portée par des "
    "résultats crédibles, et la robustesse du routeur bénéficie des usages "
    "réels des deux premières phases."
)
CH8_SPRINTS = [
    (
        "Sprint 1 — Preuve physique sur cartes instrumentées",
        [
            ("M1 — Campagne d'acquisition.", "Instrumenter au moins deux cartes de référence (thermocouples ou caméra IR sur composants sensibles, plusieurs configurations thermiques et ambiances), au format du gabarit scripts/measured-boards.example.json avec provenance tracée. DoD : le CLI de calage produit des coefficients versionnés à partir des relevés réels, écart modèle/mesure documenté sous seuil publié."),
            ("M2 — Publication encadrée des coefficients.", "Exposer la droite de calage mesurée dans le panneau d'analyse à côté de la corrélation simulation, avec intervalle de confiance et source. DoD : prédiction calibrée mesurée disponible dans l'UI, note de portée affichée, coefficients reproductibles depuis le dépôt."),
        ],
    ),
    (
        "Sprint 2 — Collaboration de production",
        [
            ("M3 — Déploiement PostgreSQL managé.", "Opérer la base sur une instance réseau (managée ou auto-hébergée), avec sauvegarde/restauration testée et migration SQLite → PostgreSQL documentée. DoD : deux sessions navigateur sur deux machines partagent projets, historique et journal, persistance vérifiée après redémarrage."),
            ("M4 — Authentification et rôles.", "Ajouter l'authentification et les rôles applicatifs (administrateur, ingénieur, lecteur), l'actor du journal d'édition étant déjà distingué au niveau du schéma. DoD : un lecteur ne peut pas modifier, un ingénieur ne peut pas administrer, le journal attribue chaque geste à son auteur."),
        ],
    ),
    (
        "Sprint 3 — Robustesse industrielle du routeur",
        [
            ("M5 — Densification du routage.", "Réduire les nets non routés résiduels sur les cartes denses (rip-up étendu, paire de couches supplémentaire paramétrable, excavation de keepout). DoD : NEXUS-CORE quatre couches à 27/28 nets ou mieux sans régression des autres métriques."),
            ("M6 — Confort d'édition et échanges 3D.", "Sélection multiple avec déplacement groupé, export des positions en STEP/OBJ pour l'intégration mécanique. DoD : sélection de cinq composants déplacée d'un bloc avec journal distinct par composant, fichier 3D importable dans un outil mécanique."),
        ],
    ),
]
CH8_OUTRO = (
    "Ces trois sprints prolongent la discipline instaurée par la priorité 0 : "
    "chaque livraison passe par la suite moteur, l'E2E ou un protocole "
    "dédié, et chaque item fermé met à jour le présent registre avec sa "
    "preuve. La différence avec la phase précédente tient aux ressources "
    "qu'elles mobilisent : des cartes instrumentées et une infrastructure "
    "d'équipe plutôt que du seul code local. Tant que le sprint 1 n'est pas "
    "soldé, la corrélation des modèles doit être présentée comme calibrée sur "
    "simulation ; tant que le sprint 2 n'est pas opéré, la plateforme doit "
    "être présentée comme un studio individuel aux fondations d'équipe prêtes "
    "et testées — position qu'elle tient désormais avec une marge large."
)

# ── Chapitre 9 ─ Verdict de complétude ──────────────────────────────────
CH9_P1 = (
    "Au terme de cette édition actualisée, NEXUS PCB affiche un score de "
    "complétude globale de 97 sur 100, en progression de quatre points depuis "
    "la première publication de cette édition. La chaîne de conception reste "
    "intégralement fonctionnelle, l'expérience temps réel demeure le "
    "différenciateur majeur, et la phase d'implémentation du plan d'audit "
    "s'achève sans aucune régression constatée : chacun des douze items est "
    "fermé sur preuve exécutable, du commit à la mesure. La différence la plus "
    "profonde reste la gouvernance : un dépôt dont les pushs sont physiquement "
    "bloqués par 226 assertions moteur, l'E2E trirésolution et le smoke SSE ne "
    "peut plus régresser silencieusement, et la campagne de consolidation a "
    "montré que cette garantie tient en charge réelle, fonctionnalité par "
    "fonctionnalité."
)
CH9_CALLS = [
    ("97 / 100", "Complétude globale pondérée (+4 points)"),
    ("12 / 12", "Items de registre soldés, 0 régression"),
    ("269 / 269", "Vérifications moteur, E2E et PostgreSQL au vert"),
    ("20", "Modules du moteur d'ingénierie (5 722 lignes)"),
]
CH9_P2 = (
    "Le chemin restant est d'une autre nature que celui qui vient d'être "
    "parcouru : il exige des cartes instrumentées, une instance de base de "
    "données opérée et des usages réels, plus que du code applicatif. Tant que "
    "ces ressources ne sont pas engagées, la plateforme doit être présentée "
    "comme un studio de conception autonome complet — chaîne de fabrication "
    "numérique intégrée, de la netlist au panel, avec une traçabilité d'équipe "
    "déjà schématisée — et non comme un environnement de production en équipe "
    "au sens réseau. Les trois sprints du chapitre 8 outillent précisément "
    "cette transition, dans un ordre qui préserve la crédibilité acquise : "
    "preuve physique d'abord, collaboration ensuite, robustesse enfin. L'étape "
    "suivante la plus rentable reste la campagne d'acquisition du sprint 1 : "
    "le harnais est livré, le format est documenté, et chaque carte mesurée "
    "transforme immédiatement la promesse analytique en coefficient traçable."
)
