'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { seedChartOfAccounts } from '@/lib/ledger/coa'

// Entity Manager — Admin only (spec §2.1). Remove = archive (soft):
// hidden from dropdowns and the "Books of" switcher, data preserved,
// restorable. Hard delete only when the entity has no data under it.

const entitySchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, 'Code is required')
    .max(10, 'Code must be at most 10 characters')
    .regex(/^[A-Z0-9]+$/, 'Code must be letters/digits only'),
  type: z.enum(['INDIVIDUAL', 'PVT_LTD', 'PARTNERSHIP', 'LLP']),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN must look like AAAAA9999A'),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  fyStartMonth: z.coerce.number().int().min(1).max(12).default(4),
})

export async function createEntity(formData: FormData) {
  const admin = await requireAdmin()
  const parsed = entitySchema.safeParse({
    name: formData.get('name'),
    code: formData.get('code'),
    type: formData.get('type'),
    pan: formData.get('pan'),
    gstin: formData.get('gstin'),
    fyStartMonth: formData.get('fyStartMonth') || undefined,
  })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)
  const data = parsed.data

  await auditedTransaction(async (tx) => {
    const entity = await tx.entity.create({ data })
    // Spec §4: Chart of Accounts auto-seeded on entity creation.
    await seedChartOfAccounts(tx, entity.id)
    await audit(tx, {
      actorId: admin.id,
      action: 'entity.create',
      targetType: 'Entity',
      targetId: entity.id,
      summary: `Created entity ${data.name} (${data.code}) with seeded Chart of Accounts`,
      after: data,
    })
  })
  revalidatePath('/', 'layout')
}

export async function updateEntity(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const parsed = entitySchema.safeParse({
    name: formData.get('name'),
    code: formData.get('code'),
    type: formData.get('type'),
    pan: formData.get('pan'),
    gstin: formData.get('gstin'),
    fyStartMonth: formData.get('fyStartMonth') || undefined,
  })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)
  const data = parsed.data

  await auditedTransaction(async (tx) => {
    const before = await tx.entity.findUniqueOrThrow({ where: { id } })
    await tx.entity.update({ where: { id }, data: { ...data, gstin: data.gstin ?? null } })
    await audit(tx, {
      actorId: admin.id,
      action: 'entity.update',
      targetType: 'Entity',
      targetId: id,
      summary: `Updated entity ${data.name} (${data.code})`,
      before: {
        name: before.name,
        code: before.code,
        type: before.type,
        pan: before.pan,
        gstin: before.gstin,
        fyStartMonth: before.fyStartMonth,
      },
      after: { ...data, gstin: data.gstin ?? null },
    })
  })
  revalidatePath('/', 'layout')
}

export async function archiveEntity(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  await auditedTransaction(async (tx) => {
    const entity = await tx.entity.findUniqueOrThrow({ where: { id } })
    if (entity.archivedAt) throw new Error('Entity is already archived')
    await tx.entity.update({ where: { id }, data: { archivedAt: new Date() } })
    await audit(tx, {
      actorId: admin.id,
      action: 'entity.archive',
      targetType: 'Entity',
      targetId: id,
      summary: `Archived entity ${entity.name} (${entity.code})`,
    })
  })
  revalidatePath('/', 'layout')
}

export async function restoreEntity(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  await auditedTransaction(async (tx) => {
    const entity = await tx.entity.findUniqueOrThrow({ where: { id } })
    if (!entity.archivedAt) throw new Error('Entity is not archived')
    await tx.entity.update({ where: { id }, data: { archivedAt: null } })
    await audit(tx, {
      actorId: admin.id,
      action: 'entity.restore',
      targetType: 'Entity',
      targetId: id,
      summary: `Restored entity ${entity.name} (${entity.code})`,
    })
  })
  revalidatePath('/', 'layout')
}

/**
 * Hard delete — allowed only when the entity has zero transactions
 * (spec §2.1): no journal entries, no bank accounts, no cash locations.
 * The seeded Chart of Accounts is removed along with it.
 */
export async function hardDeleteEntity(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  await auditedTransaction(async (tx) => {
    const entity = await tx.entity.findUniqueOrThrow({
      where: { id },
      include: {
        _count: {
          select: { bankAccounts: true, cashLocations: true, journalEntries: true },
        },
      },
    })
    if (
      entity._count.bankAccounts > 0 ||
      entity._count.cashLocations > 0 ||
      entity._count.journalEntries > 0
    ) {
      throw new Error(
        'Cannot hard-delete: entity has accounts or transactions. Archive instead.',
      )
    }
    await tx.userEntityScope.deleteMany({ where: { entityId: id } })
    await tx.periodLock.deleteMany({ where: { entityId: id } })
    await tx.journalDoc.deleteMany({ where: { entityId: id } })
    await tx.ledgerAccount.deleteMany({ where: { entityId: id } })
    await tx.entity.delete({ where: { id } })
    await audit(tx, {
      actorId: admin.id,
      action: 'entity.hard_delete',
      targetType: 'Entity',
      targetId: id,
      summary: `Hard-deleted empty entity ${entity.name} (${entity.code})`,
      before: { name: entity.name, code: entity.code, pan: entity.pan },
    })
  })
  revalidatePath('/', 'layout')
}
