# -*- coding: utf-8 -*-
"""Figures de l'audit V4 — palette Template 07 Crystal Blue, règles typesetting/charts.md."""
import matplotlib
import matplotlib.font_manager as fm

fm.fontManager.addfont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')

import matplotlib.pyplot as plt

plt.rcParams['font.sans-serif'] = ['DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

OUT = '/home/z/my-project/scripts/pdfbuild_v4'

# Palette Template 07 (corps) — famille bleue ~215°
ACCENT = '#2d7ab3'
DEEP = '#1a4a7a'
LIGHT = '#7fb3d5'
PALE = '#c0d0e2'
TEXT = '#142840'
MUTED = '#5a7a96'
BORDER = '#c0d0e2'


def strip_axes(ax):
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.spines['left'].set_visible(False)
    ax.spines['bottom'].set_color(BORDER)
    ax.spines['bottom'].set_linewidth(0.8)
    ax.tick_params(colors=MUTED, labelsize=10)


# ── Figure 1 — Complétude par domaine (barres horizontales) ────────────
domaines = [
    ('Persistance et traçabilité', 76),
    ('Export et fabrication', 85),
    ('Analyse SI / thermique', 88),
    ('Vérification DRC / DFM', 92),
    ('Interface studio', 95),
    ('Routage multicouche', 98),
    ('Placement et optimisation', 100),
]
labels = [d[0] for d in domaines]
vals = [d[1] for d in domaines]

fig, ax = plt.subplots(figsize=(8.6, 3.9), constrained_layout=True)
bars = ax.barh(labels, vals, height=0.62, color=ACCENT, edgecolor='none')
bars[6].set_color(DEEP)  # domaine à 100 % en bleu profond
for i, v in enumerate(vals):
    ax.text(v + 1.2, i, f'{v} %', va='center', ha='left', fontsize=10.5,
            color=TEXT, fontweight='bold')
ax.set_xlim(0, 112)
ax.set_xticks([0, 25, 50, 75, 100])
ax.set_xticklabels(['0', '25', '50', '75', '100 %'])
ax.grid(axis='x', linestyle='--', linewidth=0.5, alpha=0.2, color=MUTED)
ax.set_axisbelow(True)
strip_axes(ax)
ax.tick_params(axis='y', labelsize=10.5, colors=TEXT)
fig.savefig(f'{OUT}/chart_domaines_v4.png', dpi=200, facecolor='white')
plt.close(fig)

# ── Figure 2 — Taux de routage et DFM par scénario (barres groupées) ───
scen = ['CORE\nbicouche', 'CORE\n4 couches', 'NEXUS-IoT', 'NEXUS-RF']
routage = [86, 93, 100, 81]
dfm = [84, 87, 90, 82]
x = range(len(scen))
w = 0.36

fig, ax = plt.subplots(figsize=(8.6, 3.8), constrained_layout=True)
b1 = ax.bar([i - w / 2 for i in x], routage, width=w, color=ACCENT, label='Nets routés (%)')
b2 = ax.bar([i + w / 2 for i in x], dfm, width=w, color=LIGHT, label='Score DFM (/100)')
for b in list(b1) + list(b2):
    ax.text(b.get_x() + b.get_width() / 2, b.get_height() + 1.6,
            f'{b.get_height():.0f}', ha='center', va='bottom',
            fontsize=10, color=TEXT, fontweight='bold')
ax.set_xticks(list(x))
ax.set_xticklabels(scen, fontsize=10.5, color=TEXT)
ax.set_ylim(0, 115)
ax.set_yticks([0, 25, 50, 75, 100])
ax.grid(axis='y', linestyle='--', linewidth=0.5, alpha=0.2, color=MUTED)
ax.set_axisbelow(True)
strip_axes(ax)
leg = ax.legend(loc='upper left', bbox_to_anchor=(0.0, 1.14), ncol=2,
                frameon=False, fontsize=10, handlelength=1.2, columnspacing=1.8)
fig.savefig(f'{OUT}/chart_projets_v4.png', dpi=200, facecolor='white')
plt.close(fig)

# ── Figure 3 — Registre de risques (donut, légende riche) ──────────────
parts = [6, 1, 5]
part_labels = ['Fermés avec preuve de commit', 'Partiel (export livré, import manquant)', 'Ouverts, non entamés']
colors_ = [DEEP, LIGHT, PALE]

fig, ax = plt.subplots(figsize=(8.2, 3.7), constrained_layout=True)
wedges, _ = ax.pie(parts, colors=colors_, startangle=90, counterclock=False,
                   wedgeprops=dict(width=0.34, edgecolor='white', linewidth=2))
ax.text(0, 0.06, '12', ha='center', va='center', fontsize=30, color=TEXT, fontweight='bold')
ax.text(0, -0.24, 'items suivis', ha='center', va='center', fontsize=10.5, color=MUTED)
legend_labels = [f'{l} — {v}' for l, v in zip(part_labels, parts)]
leg = ax.legend(wedges, legend_labels, loc='center left', bbox_to_anchor=(1.02, 0.5),
                frameon=False, fontsize=10.5, labelspacing=1.1, handlelength=1.0)
ax.set_aspect('equal')
fig.savefig(f'{OUT}/chart_registre_v4.png', dpi=200, facecolor='white')
plt.close(fig)

print('3 figures OK')
