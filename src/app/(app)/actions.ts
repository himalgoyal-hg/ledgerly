'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser, visibleEntityFilter } from '@/lib/auth'
import { getSession } from '@/lib/session'

/** "Books of" switcher — re-scopes every screen (spec §2.1). */
export async function setBooksOf(formData: FormData) {
  const user = await requireUser()
  const entityId = String(formData.get('entityId') ?? '')

  // Server-side check: the user may only switch to an entity they can see.
  const entity = await prisma.entity.findFirst({
    where: { id: entityId, archivedAt: null, ...visibleEntityFilter(user) },
  })
  if (!entity) throw new Error('Entity not available')

  const session = await getSession()
  session.booksEntityId = entity.id
  await session.save()
  revalidatePath('/', 'layout')
}
