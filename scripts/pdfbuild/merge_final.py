# -*- coding: utf-8 -*-
"""Fusion couverture (Playwright) + corps (ReportLab) → PDF final unique."""
from pypdf import PdfReader, PdfWriter

A4_W, A4_H = 595.28, 841.89

def normalize_page_to_a4(page):
    box = page.mediabox
    w, h = float(box.width), float(box.height)
    if abs(w - A4_W) > 0.1 or abs(h - A4_H) > 0.1:
        page.scale_to(A4_W, A4_H)
        page.mediabox.lower_left = (0, 0)
        page.mediabox.upper_right = (A4_W, A4_H)
    return page

writer = PdfWriter()
cover_page = PdfReader('/home/z/my-project/scripts/pdfbuild/cover.pdf').pages[0]
writer.add_page(normalize_page_to_a4(cover_page))
for page in PdfReader('/home/z/my-project/scripts/pdfbuild/audit_body.pdf').pages:
    writer.add_page(normalize_page_to_a4(page))
writer.add_metadata({
    '/Title': 'Audit technique de complétude — NEXUS PCB',
    '/Author': 'Z.ai',
    '/Creator': 'Z.ai',
    '/Subject': "Revue d'architecture, grille de complétude, validation et dettes techniques de la plateforme de conception PCB par IA",
})
out = '/home/z/my-project/download/Audit_technique_completude_NEXUS_PCB.pdf'
with open(out, 'wb') as f:
    writer.write(f)
print('Fusion OK →', out, '(', len(writer.pages), 'pages )')
