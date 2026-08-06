'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'

// Period locks (spec §4): Admin locks a month (mandatory after GST filing).
// Locked months reject edit/delete/undo — enforced both in the posting
// service and by a DB trigger. Unlock is Admin-only and audit-logged.

function parsePeriod(formData: FormData) {
  const entityId = String(formData.get('entityId') ?? '')
  const year = Number(formData.get('year'))
  const month = Number(formData.get('month'))
  if (!entityId || !Number.isInteger(year) || month < 1 || month > 12) {
    throw new Error('Invalid period')
  }
  return { entityId, year, month }
}

export async function lockPeriod(formData: FormData) {
  const admin = await requireAdmin()
  const { entityId, year, month } = parsePeriod(formData)

  await auditedTransaction(async (tx) => {
    const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId } })
    await tx.periodLock.upsert({
      where: { entityId_year_month: { entityId, year, month } },
      create: { entityId, year, month, lockedById: admin.id },
      update: {},
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'period.lock',
      targetType: 'Entity',
      targetId: entityId,
      summary: `Locked ${year}-${String(month).padStart(2, '0')} for ${entity.code}`,
    })
  })
  revalidatePath('/admin/periods')
}

export async function unlockPeriod(formData: FormData) {
  const admin = await requireAdmin()
  const { entityId, year, month } = parsePeriod(formData)

  await auditedTransaction(async (tx) => {
    const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId } })
    await tx.periodLock.deleteMany({ where: { entityId, year, month } })
    await audit(tx, {
      actorId: admin.id,
      action: 'period.unlock',
      targetType: 'Entity',
      targetId: entityId,
      summary: `UNLOCKED ${year}-${String(month).padStart(2, '0')} for ${entity.code}`,
    })
  })
  revalidatePath('/admin/periods')
}
