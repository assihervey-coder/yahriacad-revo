/**
 * NEXUS PCB — Authentification applicative et rôles [Sprint 2 — M4]
 * ------------------------------------------------------------------
 * Session par cookie httpOnly `nexus-actor` portant l'identifiant User ;
 * le rôle est RELU EN BASE à chaque requête (une promotion/de promotion
 * s'applique sans reconnexion). Trois rôles hiérarchisés :
 *
 *   lecteur (1)  : lecture seule — aucun POST sur les routes mutantes ;
 *   ingenieur (2): conception, édition, journal, imports — pas d'admin ;
 *   admin (3)    : gestion des comptes (création, changement de rôle).
 *
 * Pas d'inscription libre : les comptes sont créés par l'administrateur
 * (ou seedés — scripts/seed-users.ts). En production, ce module serait le
 * point d'ancrage d'un SSO OIDC — la garde de rôle resterait identique.
 */
import { cookies } from 'next/headers'
import { db } from '@/lib/db'

export const ACTOR_COOKIE = 'nexus-actor'

export type Role = 'admin' | 'ingenieur' | 'lecteur'
export const ROLES: Role[] = ['lecteur', 'ingenieur', 'admin']
const ROLE_RANK: Record<Role, number> = { lecteur: 1, ingenieur: 2, admin: 3 }

export interface Actor {
  id: string
  name: string
  email: string
  role: Role
}

export function isRole(v: string): v is Role {
  return (ROLES as string[]).includes(v)
}

/** Acteur courant (ou null) — le rôle est relu en base à chaque appel. */
export async function getSessionActor(): Promise<Actor | null> {
  const c = await cookies()
  const id = c.get(ACTOR_COOKIE)?.value
  if (!id) return null
  const u = await db.user.findUnique({ where: { id } })
  if (!u) return null
  return { id: u.id, name: u.name, email: u.email, role: isRole(u.role) ? u.role : 'lecteur' }
}

/** Garde de rôle pour les route handlers.
 *  - non authentifié           → 401 (authentification requise)
 *  - rôle strictement inférieur → 403 (rôle insuffisant, motif explicite) */
export async function requireRole(
  min: Role,
): Promise<{ actor: Actor; denied?: never } | { actor?: never; denied: { status: number; message: string } }> {
  const actor = await getSessionActor()
  if (!actor) {
    return { denied: { status: 401, message: 'authentification requise — choisissez un compte dans l\'en-tête' } }
  }
  if (ROLE_RANK[actor.role] < ROLE_RANK[min]) {
    return {
      denied: {
        status: 403,
        message: `rôle « ${actor.role} » insuffisant — « ${min} » requis pour cette action`,
      },
    }
  }
  return { actor }
}
