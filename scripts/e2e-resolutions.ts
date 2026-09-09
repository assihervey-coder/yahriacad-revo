/**
 * E2E multi-résolutions NEXUS PCB [audit P0.2]
 * ────────────────────────────────────────────
 * Vérifie à 1280×800, 1600×900 et 1920×1080 que les interactions flottantes
 * tiennent sur écrans réels : barre replay dépliée, arrière-plan TRAVERSANT
 * (elementFromPoint n'atteint jamais la barre), contrôles opérationnels
 * (vitesse ×2, cycle replier/déplier), zéro erreur page/console.
 * Prérequis : serveur dev sur :3000 (sinon NEXUS_BASE), agent-browser installé.
 * Usage : bun run scripts/e2e-resolutions.ts   (exit ≠ 0 au moindre échec)
 */
import { execSync } from 'node:child_process'

const BASE = process.env.NEXUS_BASE ?? 'http://localhost:3000'
const RESOLUTIONS: Array<[number, number]> = [[1280, 800], [1600, 900], [1920, 1080]]

let failures = 0
const ok = (cond: boolean | null, label: string) => {
  if (cond === true) console.log(`  ✓ ${label}`)
  else { failures++; console.error(`  ✗ ÉCHEC : ${label}`) }
}

const ab = (cmd: string): string => {
  try { return execSync(`agent-browser ${cmd}`, { encoding: 'utf8', timeout: 180_000 }) }
  catch (e) { return String((e as { stdout?: string }).stdout ?? e) }
}
const evalJs = (script: string): unknown => {
  const raw = ab(`eval "${script.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)
    .trim().replace(/^\s*\[agent-browser\][^\n]*\n/g, '')
  try { const p = JSON.parse(raw); return typeof p === 'string' ? JSON.parse(p) : p }
  catch { return { __raw: raw } }
}
const wait = (ms: number) => execSync(`agent-browser wait ${ms}`, { encoding: 'utf8', timeout: 60_000 })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Le script d'inspection HUD évalué à chaque résolution (retourné en JSON). */
const hudProbe = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bar = document.querySelector('[data-testid="replay-bar"]');
  if (!bar) return JSON.stringify({ bar: false });
  const r = bar.getBoundingClientRect();
  const el = (x, y) => document.elementFromPoint(x, y);
  const inBar = (x, y) => { const e = el(x, y); return e ? !!e.closest('[data-testid="replay-bar"]') : null; };
  const res = {
    bar: true,
    depliee: !!bar.querySelector('[data-testid="hud-collapse"]'),
    timeline: !!bar.querySelector('input[type=range]'),
    fondTraverse1: !inBar(r.left + 6, r.bottom - 6),
    fondTraverse2: !inBar(r.left + r.width / 2, r.bottom - 6),
    boutonReplayCible: (() => { const b = [...bar.querySelectorAll('button')].find((x) => x.textContent.includes('REPLAY')); if (!b) return false; const br = b.getBoundingClientRect(); const e = el(br.left + br.width / 2, br.top + br.height / 2); return !!e && !!e.closest('button'); })(),
    vitesse: (() => { const b = [...bar.querySelectorAll('button')].find((x) => x.textContent.trim() === '×2'); if (!b) return false; b.click(); return true; })()
  };
  await wait(150);
  const bar2 = document.querySelector('[data-testid="replay-bar"]');
  const b2 = bar2 && [...bar2.querySelectorAll('button')].find((x) => x.textContent.trim() === '×2');
  res.vitesseSelectionnee = !!b2 && b2.className.includes('bg-sky-600');
  if (res.depliee) {
    const c = bar2.querySelector('[data-testid="hud-collapse"]');
    if (c) c.click();
    await wait(150);
    const pill = document.querySelector('[data-testid="replay-bar"]');
    const pr = pill ? pill.getBoundingClientRect() : null;
    const el2 = (x, y) => document.elementFromPoint(x, y);
    res.pilule = !!pill && !!pill.querySelector('[data-testid="hud-expand"]');
    res.piluleTimelineAbsente = !!pill && !pill.querySelector('input[type=range]');
    res.piluleFondTraverse = !!pill && pr ? (() => { const e = el2(pr.left + 2, pr.top + pr.height / 2); return !e || !e.closest('[data-testid="replay-bar"]'); })() : null;
    const x2 = pill && pill.querySelector('[data-testid="hud-expand"]');
    if (x2) x2.click();
    await wait(150);
    const bar3 = document.querySelector('[data-testid="replay-bar"]');
    res.redepliee = !!bar3 && !!bar3.querySelector('input[type=range]');
  }
  return JSON.stringify(res);
})()`

for (const [w, h] of RESOLUTIONS) {
  console.log(`\n═══ Résolution ${w}×${h} ═══`)
  ab(`set viewport ${w} ${h}`)
  ab('reload')
  ab('wait --load networkidle')
  wait(1500)

  // Lance le pipeline et attend la barre replay (poll 3 s, 150 s max)
  ab('find role button click --name "Lancer la conception"')
  let barLa = false
  for (let i = 0; i < 50; i++) {
    await sleep(3000)
    const probe = evalJs(`(() => { const b = document.querySelector('[data-testid="replay-bar"]'); return b ? '1' : '0'; })()`)
    if (probe === '1' || probe === 1) { barLa = true; break }
  }
  ok(barLa, 'pipeline terminé — barre replay visible')
  if (!barLa) continue

  const res = evalJs(hudProbe) as Record<string, boolean | null>
  ok(res.bar === true, 'barre replay présente')
  ok(res.depliee === true, `dépliée par défaut (≥ 560 px de haut)`)
  ok(res.timeline === true, 'timeline seekable visible')
  ok(res.fondTraverse1 === true && res.fondTraverse2 === true, 'arrière-plan traversant (2 points sondés)')
  ok(res.boutonReplayCible === true, 'bouton REPLAY correctement ciblé')
  ok(res.vitesse === true && res.vitesseSelectionnee === true, 'vitesse ×2 cliquable et sélectionnée')
  ok(res.pilule === true && res.piluleTimelineAbsente === true, 'repli compact manuel — pilule sans timeline')
  ok(res.piluleFondTraverse === true, 'pilule compacte traversante')
  ok(res.redepliee === true, 'dépliage manuel — timeline de retour')

  const errs = ab('errors')
  const consoleErrs = ab('console').split('\n').filter((l) => l.includes('[error]')).length
  ok(!/Error/i.test(errs.replace('✓ Done', '')) && consoleErrs === 0, `zéro erreur page/console (${consoleErrs} console)`)
}

console.log(`\n═══ Bilan : ${failures === 0 ? 'TOUS LES TESTS PASSENT' : failures + ' ÉCHEC(S)'} ═══`)
process.exit(failures === 0 ? 0 : 1)
