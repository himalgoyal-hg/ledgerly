'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'

// Cost centre masters (spec §3 step 5 tier 3) — Admin-managed, per entity,
// archive semantics like every other master.

export async function createCostCentre(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Name is required')

  await auditedTransaction(async (tx) => {
    const cc = await tx.costCentre.create({ data: { entityId, name } })
    await audit(tx, {
      actorId: admin.id,
      action: 'costcentre.create',
      targetType: 'CostCentre',
      targetId: cc.id,
      summary: `Created cost centre "${name}"`,
    })
  })
  revalidatePath('/admin/cost-centres')
}

export async function archiveCostCentre(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  await auditedTransaction(async (tx) => {
    const cc = await tx.costCentre.update({ where: { id }, data: { archivedAt: new Date() } })
    await audit(tx, {
      actorId: admin.id,
      action: 'costcentre.archive',
      targetType: 'CostCentre',
      targetId: id,
      summary: `Archived cost centre "${cc.name}" (history preserved)`,
    })
  })
  revalidatePath('/admin/cost-centres')
}

export async function restoreCostCentre(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  await auditedTransaction(async (tx) => {
    const cc = await tx.costCentre.update({ where: { id }, data: { archivedAt: null } })
    await audit(tx, {
      actorId: admin.id,
      action: 'costcentre.restore',
      targetType: 'CostCentre',
      targetId: id,
      summary: `Restored cost centre "${cc.name}"`,
    })
  })
  revalidatePath('/admin/cost-centres')
}

/** Rename a cost centre — history keeps pointing at the same id. */
export async function renameCostCentre(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Name is required')

  await auditedTransaction(async (tx) => {
    const cc = await tx.costCentre.findUniqueOrThrow({ where: { id } })
    await tx.costCentre.update({ where: { id }, data: { name } })
    await audit(tx, {
      actorId: admin.id,
      action: 'cost_centre.rename',
      targetType: 'CostCentre',
      targetId: id,
      summary: `Renamed cost centre "${cc.name}" → "${name}"`,
      before: { name: cc.name },
      after: { name },
    })
  })
  revalidatePath('/admin/cost-centres')
}
