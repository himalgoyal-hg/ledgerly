import 'server-only'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { visibleEntityFilter, type CurrentUser } from '@/lib/auth'

/**
 * The "Books of" entity every screen scopes to: the session selection when
 * valid/visible, otherwise the first visible active entity.
 */
export async function getCurrentEntity(user: CurrentUser) {
  const session = await getSession()
  const entities = await prisma.entity.findMany({
    where: { archivedAt: null, ...visibleEntityFilter(user) },
    orderBy: { code: 'asc' },
  })
  return entities.find((e) => e.id === session.booksEntityId) ?? entities[0] ?? null
}
