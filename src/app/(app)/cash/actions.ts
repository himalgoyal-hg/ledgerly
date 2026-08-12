'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { createCashEntry } from '@/lib/ops/cash'
import { resolveCostCentre } from '@/lib/ops/cost-centres'
import { deleteJournalDocument, undoJournalDocument } from '@/lib/ledger/posting'

// Cash entries (spec §6.2): gated by the "Cash entries" flag. Adjustments
// are flagged in the audit trail. Delete/undo ride the reversal machinery
// and need the edit/delete flag.

export async function createCashEntryAction(formData: FormData) {
  const user = await requirePermission('cashEntries')
  const kind = String(formData.get('kind') ?? '') as
    | 'RECEIPT' | 'PAYMENT' | 'TRANSFER' | 'ADJUSTMENT'
  if (!['RECEIPT', 'PAYMENT', 'TRANSFER', 'ADJUSTMENT'].includes(kind)) {
    throw new Error('Unknown entry type')
  }
  const date = new Date(String(formData.get('date') ?? ''))
  if (isNaN(date.getTime())) throw new Error('Pick a date')

  const entityId = String(formData.get('entityId') ?? '')
  await auditedTransaction(async (tx) => {
    const costCentreId = await resolveCostCentre(tx, {
      entityId,
      costCentreId: String(formData.get('costCentreId') ?? '') || null,
      costCentreText: String(formData.get('costCentreText') ?? '').trim() || null,
    })
    const entry = await createCashEntry(tx, {
      entityId,
      kind,
      date,
      locationId: String(formData.get('locationId') ?? ''),
      toLocationId: String(formData.get('toLocationId') ?? '') || null,
      headAccountId: String(formData.get('headAccountId') ?? '') || null,
      costCentreId,
      inflow: String(formData.get('inflow') ?? '') === 'true',
      amount: String(formData.get('amount') ?? ''),
      remarks: String(formData.get('remarks') ?? '') || null,
      reason: String(formData.get('reason') ?? '') || null,
      actorId: user.id,
    })
    await audit(tx, {
      actorId: user.id,
      action: entry.kind === 'ADJUSTMENT' ? 'cash.adjustment' : 'cash.entry',
      targetType: 'CashEntry',
      targetId: entry.id,
      summary:
        entry.kind === 'ADJUSTMENT'
          ? `CASH ADJUSTMENT ₹${entry.amount} — reason: ${entry.reason}` // flagged (spec §6.2)
          : `Cash ${entry.kind.toLowerCase()} ₹${entry.amount}`,
    })
  })
  revalidatePath('/cash')
}

export async function deleteCashEntryAction(formData: FormData) {
  const user = await requirePermission('transactionEditDelete')
  const entryId = String(formData.get('entryId') ?? '')

  await auditedTransaction(async (tx) => {
    const entry = await tx.cashEntry.findUniqueOrThrow({ where: { id: entryId } })
    if (!entry.docId) throw new Error('Entry has no posting')
    await deleteJournalDocument(tx, { docId: entry.docId, actorId: user.id })
    await audit(tx, {
      actorId: user.id,
      action: 'cash.delete',
      targetType: 'CashEntry',
      targetId: entryId,
      summary: `Deleted cash ${entry.kind.toLowerCase()} ₹${entry.amount} (reversal posted)`,
    })
  })
  revalidatePath('/cash')
}

export async function undoCashEntryAction(formData: FormData) {
  const user = await requirePermission('transactionEditDelete')
  const entryId = String(formData.get('entryId') ?? '')

  await auditedTransaction(async (tx) => {
    const entry = await tx.cashEntry.findUniqueOrThrow({ where: { id: entryId } })
    if (!entry.docId) throw new Error('Entry has no posting')
    await undoJournalDocument(tx, { docId: entry.docId, actorId: user.id })
    await audit(tx, {
      actorId: user.id,
      action: 'cash.undo',
      targetType: 'CashEntry',
      targetId: entryId,
      summary: 'Undid last operation on cash entry',
    })
  })
  revalidatePath('/cash')
}
