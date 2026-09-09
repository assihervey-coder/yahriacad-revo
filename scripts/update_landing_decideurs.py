# -*- coding: utf-8 -*-
"""Landing décideurs — opérations restantes : 4 étapes + encadré trajectoire.
(les éditions stat-block 12/12 et hero sont déjà appliquées)."""
PATH = '/home/z/my-project/download/Landing_decideurs_source.html'
html = open(PATH, encoding='utf-8').read()

# 1. les 4 étapes : remplacement par bornes exactes (rfind/find)
i = html.find('Comparaison de runs')
assert i > 0, 'étapes introuvables'
start = html.rfind('<li class="process-step"', 0, i)
end = html.find('</ul>', i)
new_steps = (
    '<li class="process-step"><span class="step-num">1</span><div><div class="step-title">Preuve physique</div>'
    '<div class="step-desc">Caler les constantes sur de vraies cartes instrumentées\u00a0— le harnais d\'acquisition et le format de relevés sont déjà livrés.</div></div></li>\n'
    '<li class="process-step"><span class="step-num">2</span><div><div class="step-title">Collaboration opérée</div>'
    '<div class="step-desc">PostgreSQL validé sur instance réelle (protocole 10/10, réversible)\u00a0; reste à déployer en réseau avec authentification et rôles.</div></div></li>\n'
    '<li class="process-step"><span class="step-num">3</span><div><div class="step-title">Robustesse du routeur</div>'
    '<div class="step-desc">Réduire les nets résiduels sur les cartes denses\u00a0— rip-up étendu, paire de couches paramétrable, sans régression.</div></div></li>\n'
    '<li class="process-step"><span class="step-num">4</span><div><div class="step-title">Échanges 3D</div>'
    '<div class="step-desc">Sélection multiple et export STEP des positions pour l\'intégration mécanique.</div></div></li>'
)
html = html[:start] + new_steps + html[end:]

# 2. encadré « Six chantiers, trois sprints » → état soldé
old_title = 'Six chantiers, trois sprints'
assert old_title in html, 'titre encadré introuvable'
html = html.replace(old_title, 'Douze items soldés, trois sprints ouverts')

old_p = (
    "Chaque étape ci-dessus porte un critère d'achèvement mesurable, vérifiable par la suite de tests ou par un artefact d'export. "
    "L'ordre est choisi pour protéger la crédibilité acquise : valeur immédiate, formats industriels, puis preuve physique et collaboration&nbsp;d'équipe."
)
assert old_p in html, 'paragraphe encadré introuvable'
new_p = (
    "La feuille de route d'audit d'origine est intégralement close\u00a0: douze items sur douze fermés avec preuve de commit et mesure reproductible"
    " — de la comparaison de runs à la persistance PostgreSQL validée sur instance réelle. La trajectoire ci-dessus ouvre la phase suivante. "
    "Chaque étape garde son critère d'achèvement mesurable, vérifiable par la suite de tests ou par un artefact\u00a0d'export."
)
html = html.replace(old_p, new_p)

open(PATH, 'w', encoding='utf-8').write(html)
print('étapes + encadré mis à jour OK')
