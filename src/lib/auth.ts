import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import type { PermissionFlag } from '@/lib/permissions'

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof loadUser>>>

async function loadUser() {
  const session = await getSession()
  if (!session.userId) return null
  const user = await prisma.user.findFirst({
    where: { id: session.userId, isActive: true, deletedAt: null },
    include: {
      permissions: true,
      entityScopes: { select: { entityId: true } },
    },
  })
  return user
}

// Deduplicate the user lookup within a single request.
export const getCurrentUser = cache(loadUser)

/** Every page/action calls this first. Redirects to /login when unauthenticated. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return user
}

export function isAdmin(user: CurrentUser) {
  return user.role === 'ADMIN'
}

export function hasPermission(user: CurrentUser, flag: PermissionFlag): boolean {
  if (user.role === 'ADMIN') return true
  return user.permissions?.[flag] === true
}

/** Admin-only capability gate (masters, user management, approvals). */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser()
  if (!isAdmin(user)) {
    // Never trust the UI (spec §1.1): server-side hard stop.
    throw new Error('Forbidden: admin only')
  }
  return user
}

/** Permission-flag gate for member-grantable capabilities. */
export async function requirePermission(flag: PermissionFlag): Promise<CurrentUser> {
  const user = await requireUser()
  if (!hasPermission(user, flag)) {
    throw new Error(`Forbidden: missing permission "${flag}"`)
  }
  return user
}

/**
 * Entity visibility (spec §1.2): admin sees all; a scoped member only the
 * entities granted to them; an unscoped member sees all active entities.
 */
export function visibleEntityFilter(user: CurrentUser) {
  if (user.role === 'ADMIN' || !user.entityScoped) return {}
  return { id: { in: user.entityScopes.map((s) => s.entityId) } }
}
