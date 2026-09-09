// NEXUS PCB — Comptes applicatifs par défaut [Sprint 2 — M4].
//
//   DATABASE_URL=… bun run scripts/seed-users.ts   (ou npm run db:seed)
//
// Trois comptes couvrant les trois rôles — l'administrateur crée ensuite
// les autres comptes via POST /api/users (admin requis).
import { PrismaClient } from '@prisma/client'

const ACCOUNTS = [
  { email: 'camille@nexus.local', name: 'Camille Durand', role: 'admin' },
  { email: 'theo@nexus.local', name: 'Théo Moreau', role: 'ingenieur' },
  { email: 'alex@nexus.local', name: 'Alex Petit', role: 'lecteur' },
]

const db = new PrismaClient()
for (const a of ACCOUNTS) {
  const u = await db.user.upsert({
    where: { email: a.email },
    update: { role: a.role, name: a.name },
    create: a,
  })
  console.log(`✔ ${u.email} — ${u.name} [${u.role}]`)
}
console.log(`${ACCOUNTS.length} comptes prêts`)
await db.$disconnect()
