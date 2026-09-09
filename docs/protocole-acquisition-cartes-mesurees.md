# Protocole d'acquisition — cartes instrumentées (Sprint 1, M1)

**Objet :** produire les relevés thermiques réels qui calent les coefficients
du noyau latent NEXUS PCB (`slope` °C/unité latente + `intercept`), en
remplacement des données de démonstration synthétiques actuellement publiées.

**Livrable DoD :** le CLI de calage (`scripts/calibrate_measured.ts`) produit
des coefficients **versionnés** (champ `revision` SHA-256) à partir des
relevés réels, avec **écart modèle/mesure documenté sous les seuils publiés**
(`r ≥ 0,55`, `RMSE ≤ 8 °C`, `err max ≤ 15 °C`, `≥ 2 relevés exploitables`).

---

## 1. Cartes de référence

| Exigence | Détail |
|---|---|
| Nombre | **Au moins 2 cartes** (idéalement 4-6 : révisions successives ou échantillons de lot) |
| Diversité de support | Les layouts doivent **différer** entre cartes (jitter de montage, révision) — des cartes strictement identiques ne fournissent qu'un point de support par carte et rendent la régression dégénérée |
| Placement réel | Coordonnées composants en mm (même convention que le studio : centre composant, repère coin haut-gauche carte), issues du fichier pick & place de production ou de l'AOI — **jamais** du placement théorique du CAO seul |
| Référence projet | `project` du JSON = identifiant du projet studio (`nexus-core`, `nexus-iot`, `nexus-rf` ou projet importé) |

## 2. Instrumentation

- **Thermocouples type-K** (fil 36 AWG, collés haute température ou pointés
  résine sur le package, au-dessus du die estimé) **ou** **caméra IR**
  (émissivité calibrée 0,90-0,95 sur chaque type de package, référence
  thermocouple croisée sur au moins un composant).
- Capteur d'**ambiance** à l'écart du rayonnement direct des composants et
  des flux d'air ; consigne stable ±1 °C pendant toute la mesure.
- Toutes les valeurs de `measurements.deltaT` sont **relatives à `ambientC`**
  (°C), pas des températures absolues.

## 3. Configurations thermiques

Pour chaque carte, relever au minimum **3 configurations** :

1. **Nominale** — régime logiciel de repos/atelier, ambiance 20-25 °C ;
2. **Charge soutenue** — charge maximale représentative ≥ 15 min (régime
   permanent, dérive < 0,5 °C/min) ;
3. **Ambiance étendue** — enceinte ou vog vanne, ambiance cible 40-45 °C
   (et idéalement un point froid 10-18 °C).

Noter le **régime de puissance** de chaque configuration dans `label` ou
`source` : le ΔT dépend du layout à puissance constante, la diversité du
support de régression vient des layouts ET des régimes.

## 4. Composants mesurés

Les ΔT ne sont exploités que sur les composants **sensibles** du projet
(cibles exactes du noyau latent) :

- `nexus-core` → **Y1**
- `nexus-iot` → **U1, U2, U3**
- `nexus-rf` → **ANT1, Y1, U1**

Mesurer aussi les autres composants d'intérêt est bienvenu (champ
`measurements`), ils seront simplement ignorés par le calage. Un relevé est
exploitable dès **1 mesure saine** sur une ref sensible ; la validation
sanitaire écarte (et compte, sans les moyenner) les relevés dont l'ambiance
est hors [-40, 125] °C ou le ΔT hors [-10, 200] °C — un capteur décollé ne
doit jamais contaminer les coefficients.

## 5. Format de fichier

Gabarit : `scripts/measured-boards.example.json` — structure identique :

```json
{
  "project": "nexus-core",
  "boards": [
    {
      "label": "révision B — lot 2026-09 — charge soutenue @ 40 °C",
      "ambientC": 40.2,
      "placements": [{ "ref": "Y1", "x": 31.0, "y": 19.8, "rot": 180, "side": "top", "fixed": false }],
      "measurements": [{ "ref": "Y1", "deltaT": 18.2 }],
      "source": "banc thermocouple type-K — opérateur AB — campagne 2026-09 — salle thermique S1"
    }
  ]
}
```

`source` est **obligatoire** pour le versionnage : banc, opérateur, campagne,
lieu. Un jeu dont les sources mentionnent « démo/synthétique/exemple » est
automatiquement marqué `dataKind: "demo"` dans les coefficients publiés —
il ne passera jamais pour une campagne industrielle.

## 6. Chaîne de calage

```bash
bun run scripts/calibrate_measured.ts --project nexus-core \
  --data scripts/measured-campaign-2026-09.json \
  --out src/lib/engine/measured-calibration/nexus-core.json
```

Le CLI :

1. valide chaque relevé (ambiance, ΔT plausibles, refs sensibles, placements
   connus) et compte les écartés ;
2. exige **≥ 2 relevés exploitables** — sinon aucun coefficient ;
3. calcule pente + intercept (moindres carrés) et **IC 95 % de la pente**
   (Student, ddl = n−2) ;
4. confronte l'écart modèle/mesure aux **seuils publiés** (`PUBLISHED_THRESHOLDS`
   dans `src/lib/engine/calibration.ts`) — hors seuil ⇒ **aucune publication** ;
5. publie `src/lib/engine/measured-calibration/<projet>.json` avec
   `revision` (SHA-256 déterministe sur le contenu reproductible) et
   `provenance.datasetSha256` (empreinte du fichier de relevés).

**Reproductibilité :** régénérer les coefficients depuis le dépôt =
rejouer la commande ci-dessus sur le même fichier de relevés ; la `revision`
doit être identique (le hash exclut l'horodatage).

## 7. Seuils publiés

| Seuil | Valeur | Sens |
|---|---|---|
| `rMin` | 0,55 | corrélation prédiction latente ↔ mesure |
| `rmseMaxC` | 8 °C | écart quadratique moyen de la droite calibrée |
| `maxErrMaxC` | 15 °C | écart ponctuel maximal |
| `minSamples` | 2 | relevés exploitables minimum |

Ces seuils engagent la portée des coefficients exposés dans l'UI ; toute
modification passe par une révision du présent protocole.

## 8. État courant

Les coefficients aujourd'hui publiés (`dataKind: "demo"`) proviennent du jeu
de **démonstration synthétique** (`scripts/make_measured_demo.ts`, vérité
terrain FDM + bruit ±0,4 °C) qui prouve la chaîne de bout en bout :

- `nexus-core` : **conforme** (r = 0,792, RMSE 4,2 °C) — coefficients publiés ;
- `nexus-iot` : r = 0,487 < 0,55 — **refusé** (garde-fou) ;
- `nexus-rf` : noyau ininformatif sur layout RF discipliné (aucune source
  chaude à moins de 12 mm d'un sensible) — **refusé**.

Tant que la campagne physique n'a pas eu lieu, la corrélation affichée dans
le panneau d'analyse reste présentée comme **calibrée sur simulation** ; les
coefficients mesurés portent le badge « DÉMONSTRATION » et leur note de
portée l'indique explicitement.
