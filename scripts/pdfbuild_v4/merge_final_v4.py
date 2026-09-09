# -*- coding: utf-8 -*-
"""Fusion couverture + corps → PDF final Audit V4 (normalisation A4)."""
from pypdf import PdfReader, PdfWriter

A4_W, A4_H = 595.28, 841.89

BASE = '/home/z/my-project/scripts/pdfbuild_v4'
OUT = '/home/z/my-project/download/Audit_technique_V4_NEXUS_PCB.pdf'


def normalize_page_to_a4(page):
    box = page.mediabox
    w, h = float(box.width), float(box.height)
    if abs(w - A4_W) > 0.1 or abs(h - A4_H) > 0.1:
        page.scale_to(A4_W, A4_H)
    return page


writer = PdfWriter()
cover_page = PdfReader(f'{BASE}/cover_v4.pdf').pages[0]
writer.add_page(normalize_page_to_a4(cover_page))
for page in PdfReader(f'{BASE}/audit_body_v4.pdf').pages:
    writer.add_page(normalize_page_to_a4(page))
writer.add_metadata({
    '/Title': 'Audit technique de complétude V4 — NEXUS PCB',
    '/Author': 'Z.ai',
    '/Creator': 'Z.ai',
    '/Subject': "Revue V4 : registre de risques, complétude actualisée, validation et trajectoire d'industrialisation",
})
with open(OUT, 'wb') as f:
    writer.write(f)
print('Final OK :', OUT, '—', len(writer.pages), 'pages')
