// NEXUS PCB — Test des rôles applicatifs [Sprint 2 — M4].
// Pré-requis : serveur Next démarré sur une base seedée (scripts/seed-users.ts)
//   DATABASE_URL=postgresql://nexus@127.0.0.1:5433/nexus bun run dev
// Exécution :
//   DATABASE_URL=postgresql://nexus@127.0.0.1:5433/nexus bun run scripts/test-roles.ts
//
// Vérifie le DoD : un lecteur ne peut pas modifier (403), un ingénieur ne
// peut pas administrer (403), le journal attribue chaque geste à son auteur
// (acteur de session, pas du body), les comptes sont gérés par l'admin seul.
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'
let failures = 0
function check(label: string, cond: boolean, detail = '') {
  const mark = cond ? '✓' : '✗'
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`)
  return res.headers.get('set-cookie')!.split(';')[0]
}

async function main() {
  console.log('══ M4 — Authentification et rôles ══')
  const gesture = {
    netlistId: 'nexus-core',
    kind: 'move',
    ref: 'U1',
    from: { x: 31, y: 19.8, rot: 180 },
    to: { x: 31.5, y: 19.8, rot: 180 },
    meta: 'test rôles M4',
  }

  // 1. Non authentifié : toute écriture est refusée (401)
  const anon = await fetch(`${BASE}/api/edits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gesture),
  })
  check('anonyme : écriture refusée (401)', anon.status === 401)
  const anonRead = await fetch(`${BASE}/api/runs?netlistId=nexus-core`)
  check('anonyme : lecture autorisée (200)', anonRead.status === 200)

  // 2. Lecteur : aucune modification (403), lecture OK
  const lecteur = await login('alex@nexus.local')
  const lectEdit = await fetch(`${BASE}/api/edits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: lecteur }, body: JSON.stringify(gesture),
  })
  check('lecteur : geste refusé (403)', lectEdit.status === 403, (await lectEdit.json()).error)
  const lectProj = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: lecteur }, body: JSON.stringify({ netlistId: 'x' }),
  })
  check('lecteur : création projet refusée (403)', lectProj.status === 403)
  const lectRunRead = await fetch(`${BASE}/api/runs?netlistId=nexus-core`, { headers: { Cookie: lecteur } })
  check('lecteur : lecture des runs autorisée (200)', lectRunRead.status === 200)

  // 3. Ingénieur : peut éditer, le journal porte SON nom ; admin refusé (403)
  const ingenieur = await login('theo@nexus.local')
  const ingEdit = await fetch(`${BASE}/api/edits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ingenieur }, body: JSON.stringify(gesture),
  })
  const editData = (await ingEdit.json()) as { edit?: { actor?: string; kind?: string; ref?: string; xTo?: number } }
  check('ingénieur : geste accepté (200)', ingEdit.status === 200)
  check(
    'journal : geste attribué à son auteur de session',
    editData.edit?.actor === 'Théo Moreau (ingenieur)',
    `actor = ${editData.edit?.actor}`,
  )
  const ingAdmin = await fetch(`${BASE}/api/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ingenieur },
    body: JSON.stringify({ email: 'pirate@nexus.local', name: 'Pirate', role: 'admin' }),
  })
  check('ingénieur : administration refusée (403)', ingAdmin.status === 403, (await ingAdmin.json()).error)
  const ingUsersRead = await fetch(`${BASE}/api/users`, { headers: { Cookie: ingenieur } })
  check('ingénieur : liste des comptes lisible (200)', ingUsersRead.status === 200)

  // 4. Admin : crée, promeut, supprime
  const admin = await login('camille@nexus.local')
  const newEmail = `stagiaire-${Date.now()}@nexus.local`
  const create = await fetch(`${BASE}/api/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin },
    body: JSON.stringify({ email: newEmail, name: 'Stagiaire', role: 'lecteur' }),
  })
  const created = (await create.json()) as { user?: { id?: string } }
  check('admin : création de compte acceptée (200)', create.status === 200)
  const promote = await fetch(`${BASE}/api/users`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: admin },
    body: JSON.stringify({ id: created.user?.id, role: 'ingenieur' }),
  })
  check('admin : changement de rôle accepté (200)', promote.status === 200, (await promote.json()).user?.role)
  const del = await fetch(`${BASE}/api/users?id=${created.user?.id}`, { method: 'DELETE', headers: { Cookie: admin } })
  check('admin : suppression de compte acceptée (200)', del.status === 200)

  console.log(failures === 0 ? '\n✔ RÔLES VÉRIFIÉS — lecteur bloqué, ingénieur non-admin, journal attribué [M4]' : `\n✗ ${failures} ÉCHEC(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('✗ Erreur fatale :', e)
  process.exit(1)
})
