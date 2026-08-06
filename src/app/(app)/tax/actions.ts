'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { createJournalDocument } from '@/lib/ledger/posting'
import { getSystemAccount, COA } from '@/lib/ledger/coa'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { gstr3bView, monthRange } from '@/lib/tax/register'

// GST filing (spec §7.1): filing a period locks that month. TDS deposit
// (spec §7.2) clears the payable. Both Admin-only.

export async function fileAndLockPeriod(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const year = Number(formData.get('year'))
  const month = Number(formData.get('month'))
  if (!entityId || !Number.isInteger(year) || month < 1 || month > 12) {
    throw new Error('Invalid period')
  }

  await auditedTransaction(async (tx) => {
    const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId } })
    await tx.periodLock.upsert({
      where: { entityId_year_month: { entityId, year, month } },
      create: { entityId, year, month, lockedById: admin.id },
      update: {},
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'gst.file',
      targetType: 'Entity',
      targetId: entityId,
      summary: `Filed GST for ${year}-${String(month).padStart(2, '0')} (${entity.code}) — period locked`,
    })
  })
  revalidatePath('/tax')
  revalidatePath('/admin/periods')
}

/** Pay the net GST for a period: Dr GST Payable-side accounts / Cr Bank. */
export async function payGstAction(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const year = Number(formData.get('year'))
  const month = Number(formData.get('month'))
  const sourceAccountId = String(formData.get('sourceAccountId') ?? '')
  const date = new Date(String(formData.get('date') ?? ''))
  if (!sourceAccountId) throw new Error('Pick the paying account')
  if (isNaN(date.getTime())) throw new Error('Pick a date')

  const view = await gstr3bView(entityId, monthRange(year, month))
  const net = parsePaise(view.netPayable)
  if (net <= 0n) throw new Error('Nothing payable for that period')

  await auditedTransaction(async (tx) => {
    // Settle the period: Dr Output Liability, Cr Input Credit, Cr Bank.
    const output = await getSystemAccount(tx, entityId, '2210')
    const input = await getSystemAccount(tx, entityId, '1500')
    const itc = parsePaise(view.inputCredit)
    const lines = [
      { accountId: output.id, debit: view.outputLiability },
      ...(itc > 0n ? [{ accountId: input.id, credit: view.inputCredit }] : []),
      { accountId: sourceAccountId, credit: formatPaise(net) },
    ]
    const { doc } = await createJournalDocument(tx, {
      entityId,
      sourceType: 'gst_payment',
      sourceId: `${year}-${String(month).padStart(2, '0')}`,
      actorId: admin.id,
      content: {
        date,
        narration: `GST payment ${year}-${String(month).padStart(2, '0')}`,
        lines,
      },
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'gst.pay',
      targetType: 'JournalDoc',
      targetId: doc.id,
      summary: `Paid net GST ₹${view.netPayable} for ${year}-${String(month).padStart(2, '0')}`,
    })
  })
  revalidatePath('/tax')
}

/** Deposit withheld TDS: Dr TDS Payable / Cr Bank. */
export async function depositTdsAction(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const amount = String(formData.get('amount') ?? '')
  const sourceAccountId = String(formData.get('sourceAccountId') ?? '')
  const date = new Date(String(formData.get('date') ?? ''))
  const taskId = String(formData.get('taskId') ?? '') || null
  if (!sourceAccountId) throw new Error('Pick the paying account')
  if (isNaN(date.getTime())) throw new Error('Pick a date')
  if (parsePaise(amount) <= 0n) throw new Error('Amount must be positive')

  await auditedTransaction(async (tx) => {
    const payable = await getSystemAccount(tx, entityId, COA.TDS_PAYABLE)
    const { doc } = await createJournalDocument(tx, {
      entityId,
      sourceType: 'tds_deposit',
      actorId: admin.id,
      content: {
        date,
        narration: `TDS deposit ${date.toISOString().slice(0, 10)}`,
        lines: [
          { accountId: payable.id, debit: amount },
          { accountId: sourceAccountId, credit: amount },
        ],
      },
    })
    if (taskId) {
      await tx.financeTask.update({
        where: { id: taskId },
        data: { status: 'DONE', completedAt: new Date(), completedById: admin.id },
      })
    }
    await audit(tx, {
      actorId: admin.id,
      action: 'tds.deposit',
      targetType: 'JournalDoc',
      targetId: doc.id,
      summary: `Deposited TDS ₹${amount}`,
    })
  })
  revalidatePath('/tax')
  revalidatePath('/tasks')
}
