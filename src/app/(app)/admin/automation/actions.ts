'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { runAutomation } from '@/lib/automation/run'
import { deliverQueued } from '@/lib/automation/notify'

// Automation admin (spec §8, §6.5) — Admin-only.

export async function setPreference(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const purpose = String(formData.get('purpose') ?? '').trim()
  const ledgerAccountId = String(formData.get('ledgerAccountId') ?? '')
  if (!purpose) throw new Error('Pick a purpose')
  if (!ledgerAccountId) throw new Error('Pick an account')

  await auditedTransaction(async (tx) => {
    const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: ledgerAccountId } })
    if (account.entityId !== entityId) throw new Error('Account belongs to another entity')
    // One preferred account per purpose: replace rather than accumulate.
    await tx.paymentPreference.deleteMany({ where: { entityId, purpose } })
    await tx.paymentPreference.create({ data: { entityId, purpose, ledgerAccountId } })
    await audit(tx, {
      actorId: admin.id,
      action: 'automation.preference_set',
      targetType: 'PaymentPreference',
      targetId: `${entityId}:${purpose}`,
      summary: `"${purpose}" payments now default to ${account.name}`,
    })
  })
  revalidatePath('/admin/automation')
}

export async function clearPreference(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  await auditedTransaction(async (tx) => {
    const pref = await tx.paymentPreference.findUniqueOrThrow({ where: { id } })
    await tx.paymentPreference.delete({ where: { id } })
    await audit(tx, {
      actorId: admin.id,
      action: 'automation.preference_clear',
      targetType: 'PaymentPreference',
      targetId: id,
      summary: `Cleared payment mapping for "${pref.purpose}"`,
    })
  })
  revalidatePath('/admin/automation')
}

/** "Run now" — the same job cron calls, with the weekly summary forced. */
export async function runNow() {
  const admin = await requireAdmin()
  await runAutomation({ actorId: admin.id, force: true })
  revalidatePath('/admin/automation')
  revalidatePath('/bills')
  revalidatePath('/tasks')
}

export async function retryDelivery() {
  await requireAdmin()
  await deliverQueued()
  revalidatePath('/admin/automation')
}
