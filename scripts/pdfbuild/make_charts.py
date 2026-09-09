"""Graphiques pour l'audit NEXUS PCB — règles typesetting/charts.md."""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

# Palette cascade (palette.cascade — mêmes couleurs que le corps du rapport)
ACCENT = '#27698b'
ACCENT_2 = '#bd5264'
HEADER_FILL = '#405b69'
ICON = '#4f798f'
BORDER = '#c7d3d9'
TEXT_PRIMARY = '#212324'
TEXT_MUTED = '#747b7e'

plt.rcParams['font.family'] = 'sans-serif'
plt.rcParams['font.sans-serif'] = ['DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False
plt.rcParams['text.color'] = TEXT_PRIMARY
plt.rcParams['axes.labelcolor'] = TEXT_PRIMARY
plt.rcParams['xtick.color'] = TEXT_MUTED
plt.rcParams['ytick.color'] = TEXT_MUTED

OUT = '/home/z/my-project/scripts/pdfbuild'

# ── Graphique 1 : résultats moteur par projet (barres groupées) ──────────
projects = ['NEXUS-CORE', 'NEXUS-IoT', 'NEXUS-RF']
routage = [93, 100, 81]
dfm = [87, 90, 82]

fig, ax = plt.subplots(figsize=(7.4, 3.4), dpi=200, constrained_layout=True)
x = np.arange(len(projects))
w = 0.34
b1 = ax.bar(x - w / 2, routage, w, color=ACCENT, label='Taux de routage (%)', edgecolor='none')
b2 = ax.bar(x + w / 2, dfm, w, color=ACCENT_2, label='Score DFM (/100)', edgecolor='none')
for bars in (b1, b2):
    for r in bars:
        ax.annotate(f'{r.get_height():.0f}', (r.get_x() + r.get_width() / 2, r.get_height()),
                    xytext=(0, 3), textcoords='offset points', ha='center',
                    fontsize=10, fontweight='bold', color=TEXT_PRIMARY)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
ax.spines['left'].set_visible(False)
ax.spines['bottom'].set_color(BORDER)
ax.set_yticks([])  # valeurs étiquetées → grille et axe Y supprimés (charts.md)
ax.set_xticks(x)
ax.set_xticklabels(projects, fontsize=10.5)
ax.set_ylim(0, 118)
ax.legend(loc='upper left', bbox_to_anchor=(0, 1.14), ncol=2, frameon=False, fontsize=9.5)
fig.savefig(f'{OUT}/chart_projets.png', facecolor='white')
plt.close(fig)

# ── Graphique 2 : complétude évaluée par domaine (barres horizontales) ──
domaines = [
    'Persistance et traçabilité',
    'Intégrations IA',
    'Export et fabrication',
    'Routage multicouche',
    'Analyse SI / thermique',
    'Vérification DRC / DFM',
    'Interface studio',
    'Placement et optimisation',
]
scores = [72, 78, 85, 92, 88, 90, 90, 100]

fig, ax = plt.subplots(figsize=(7.4, 3.9), dpi=200, constrained_layout=True)
bars = ax.barh(domaines, scores, height=0.62, color=[ICON if s < 85 else ACCENT for s in scores], edgecolor='none')
for r, s in zip(bars, scores):
    ax.annotate(f'{s} %', (s, r.get_y() + r.get_height() / 2),
                xytext=(4, 0), textcoords='offset points', va='center',
                fontsize=10, fontweight='bold', color=TEXT_PRIMARY)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
ax.spines['bottom'].set_visible(False)
ax.spines['left'].set_color(BORDER)
ax.set_xticks([])
ax.set_xlim(0, 112)
ax.tick_params(axis='y', labelsize=10.5)
fig.savefig(f'{OUT}/chart_domaines.png', facecolor='white')
plt.close(fig)

print('Charts OK : chart_projets.png, chart_domaines.png')
