'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requirePermission, requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { undoJournalDocument } from '@/lib/ledger/posting'

// The one recycle bin: everything deleted anywhere lands here and leaves
// from here. Restores use the same reversal machinery the delete used, so
// the ledger stays append-only throughout.

const PATHS = ['/recycle-bin', '/cash', '/tagging', '/invoices', '/reports/cash-flow', '/tasks']

/** Bring a deleted posting back — cash entry, tagged row, whatever its source. */
export async function restoreDocAction(formData: FormData) {
  const user = await requirePermission('transactionEditDelete')
  const docId = String(formData.get('docId') ?? '')
  await auditedTransaction(async (tx) => {
    await undoJournalDocument(tx, { docId, actorId: user.id })
    await audit(tx, {
      actorId: user.id,
      action: 'bin.restore',
      targetType: 'JournalDoc',
      targetId: docId,
      summary: 'Restored a deleted posting from the recycle bin',
    })
  })
  for (const p of PATHS) revalidatePath(p)
}

/** Remove a binned CASH entry's register row for good (its ledger reversal stays). */
export async function purgeBinnedCashAction(formData: FormData) {
  const user = await requirePermission('transactionEditDelete')
  const docId = String(formData.get('docId') ?? '')
  await auditedTransaction(async (tx) => {
    const doc = await tx.journalDoc.findUniqueOrThrow({ where: { id: docId } })
    if (!doc.deletedAt) throw new Error('Only deleted entries can be removed forever')
    const entry = await tx.cashEntry.findUnique({ where: { docId } })
    if (entry) await tx.cashEntry.delete({ where: { id: entry.id } })
    await audit(tx, {
      actorId: user.id,
      action: 'bin.purge',
      targetType: 'JournalDoc',
      targetId: docId,
      summary: 'Removed a binned cash entry forever (ledger reversal stays)',
    })
  })
  for (const p of PATHS) revalidatePath(p)
}

/** Un-archive a plan line — it re-enters the cashflow projections. */
export async function restorePlanLineAction(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  await auditedTransaction(async (tx) => {
    const line = await tx.budgetLine.update({ where: { id }, data: { archivedAt: null } })
    if (line.headAccountId) {
      const { syncBudgetForHead } = await import('@/lib/budget/plan')
      await syncBudgetForHead(tx, line.headAccountId)
    }
    await audit(tx, {
      actorId: admin.id,
      action: 'bin.restore',
      targetType: 'BudgetLine',
      targetId: id,
      summary: `Restored plan line "${line.label}" from the recycle bin`,
    })
  })
  for (const p of PATHS) revalidatePath(p)
}

/** Un-archive a finance-task column — it returns to the grid, history intact. */
export async function restoreTaskColumnAction(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  await auditedTransaction(async (tx) => {
    const task = await tx.financeTask.update({ where: { id }, data: { archivedAt: null } })
    await audit(tx, {
      actorId: admin.id,
      action: 'bin.restore',
      targetType: 'FinanceTask',
      targetId: id,
      summary: `Restored finance-task column "${task.name}" from the recycle bin`,
    })
  })
  for (const p of PATHS) revalidatePath(p)
}
