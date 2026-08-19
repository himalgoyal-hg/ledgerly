'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requirePermission, requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { createCashEntry } from '@/lib/ops/cash'
import { resolveCostCentre } from '@/lib/ops/cost-centres'
import { resolveHeadAccount } from '@/lib/ops/heads'
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

  await auditedTransaction(async (tx) => {
    // Cash shows all books at once, so the books are whichever the picked
    // location lives in — never a hidden field.
    const location = await tx.cashLocation.findUniqueOrThrow({
      where: { id: String(formData.get('locationId') ?? '') },
    })
    const entityId = location.entityId
    const costCentreId = await resolveCostCentre(tx, {
      entityId,
      costCentreId: String(formData.get('costCentreId') ?? '') || null,
      costCentreText: String(formData.get('costCentreText') ?? '').trim() || null,
    })
    // Creatable head combobox: receipts birth income heads, payments and
    // outflow adjustments birth expense heads. Transfers carry no head.
    let headAccountId = String(formData.get('headAccountId') ?? '') || null
    const headText = String(formData.get('headText') ?? '').trim() || null
    if (headAccountId && kind !== 'TRANSFER') {
      const head = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: headAccountId } })
      if (head.entityId !== entityId) {
        throw new Error(`"${head.name}" is a head of other books — pick one from ${location.name}'s books`)
      }
    }
    if (!headAccountId && headText && kind !== 'TRANSFER') {
      headAccountId = await resolveHeadAccount(tx, {
        entityId,
        headText,
        isOutflow:
          kind === 'PAYMENT' ||
          (kind === 'ADJUSTMENT' && String(formData.get('inflow') ?? '') !== 'true'),
      })
    }
    const entry = await createCashEntry(tx, {
      entityId,
      kind,
      date,
      locationId: String(formData.get('locationId') ?? ''),
      toLocationId: String(formData.get('toLocationId') ?? '') || null,
      headAccountId,
      costCentreId,
      separateReport: String(formData.get('separateReport') ?? '') === 'Yes',
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

/**
 * The Excel-style quick row: one signed amount instead of separate
 * receipt/payment forms — "−4000" is cash paid, "4000" is cash received.
 * The books are whichever the picked location lives in (cash is one physical
 * pool shown across all books; each entry still posts double-entry in its
 * own books). A head typed but unknown is created there on the fly.
 */
export async function quickCashEntryAction(formData: FormData) {
  const user = await requirePermission('cashEntries')
  const date = new Date(String(formData.get('date') ?? ''))
  if (isNaN(date.getTime())) throw new Error('Pick a date')
  const rawAmount = String(formData.get('amount') ?? '').replace(/[,₹\s]/g, '')
  const value = Number(rawAmount)
  if (!isFinite(value) || value === 0) {
    throw new Error('Amount: positive = cash received, negative = cash paid')
  }
  const isOutflow = value < 0
  const locationId = String(formData.get('locationId') ?? '')
  const details = String(formData.get('details') ?? '').trim() || null
  const comments = String(formData.get('comments') ?? '').trim() || null
  const costCentreId = String(formData.get('costCentreId') ?? '') || null
  const costCentreText = String(formData.get('costCentreText') ?? '').trim() || null

  await auditedTransaction(async (tx) => {
    const location = await tx.cashLocation.findUniqueOrThrow({ where: { id: locationId } })
    const entityId = location.entityId
    let headAccountId = String(formData.get('headAccountId') ?? '') || null
    if (headAccountId) {
      const head = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: headAccountId } })
      if (head.entityId !== entityId) {
        throw new Error(`"${head.name}" is a head of other books — pick one from ${location.name}'s books`)
      }
    } else {
      headAccountId = await resolveHeadAccount(tx, {
        entityId,
        headText: String(formData.get('headText') ?? '').trim() || null,
        isOutflow,
      })
    }
    const ccId = await resolveCostCentre(tx, { entityId, costCentreId, costCentreText })
    const entry = await createCashEntry(tx, {
      entityId,
      kind: isOutflow ? 'PAYMENT' : 'RECEIPT',
      date,
      locationId,
      headAccountId,
      costCentreId: ccId, // null → head's default rides along inside createCashEntry
      separateReport: String(formData.get('separateReport') ?? '') === 'Yes',
      amount: Math.abs(value).toFixed(2),
      remarks: details,
      actorId: user.id,
    })
    if (comments) {
      await tx.cashEntry.update({ where: { id: entry.id }, data: { comments } })
    }
    await audit(tx, {
      actorId: user.id,
      action: 'cash.entry',
      targetType: 'CashEntry',
      targetId: entry.id,
      summary: `Cash ${entry.kind.toLowerCase()} ₹${entry.amount} — ${location.name}${details ? ` (${details})` : ''}`,
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

// --- Cash flow (CASH pool only): planned future receipts/payments ---------
// Lines live in BudgetLine with source 'CASH'; the projection on the Cash
// tab rolls the live balance forward with them (current month netted by
// actuals). Saving re-syncs Budget vs Actual for the matched head.

export async function saveCashPlanAction(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '') || null
  const label = String(formData.get('label') ?? '').trim()
  const source = String(formData.get('source') ?? 'CASH')
  const frequency = String(formData.get('frequency') ?? 'ONCE')
  const amountRaw = String(formData.get('amount') ?? '').replace(/[,₹\s]/g, '')
  const amount = Number(amountRaw)
  let onMonth = String(formData.get('onMonth') ?? '').trim() || null
  // The sheet's extra columns: Claimable-as (income tax) and the due day.
  // A one-time line may send a full date; it splits into month + day.
  const taxTreatment = String(formData.get('taxTreatment') ?? '').trim() || null
  let dayNote = String(formData.get('dayNote') ?? '').trim() || null
  const onDate = String(formData.get('onDate') ?? '').trim()
  if (onDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(onDate)) throw new Error('Bad date')
    onMonth = onDate.slice(0, 7)
    dayNote = String(Number(onDate.slice(8, 10)))
  }

  if (!label) throw new Error('Name the payment')
  if (!['ACPL', 'HG', 'MG', 'PG', 'CASH'].includes(source)) throw new Error('Pick the source')
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL', 'ONCE'].includes(frequency)) {
    throw new Error('Pick the frequency')
  }
  if (!Number.isFinite(amount) || amount === 0) throw new Error('Amount: + = cash out, − = cash in')
  if (frequency === 'ONCE' && !/^\d{4}-\d{2}$/.test(onMonth ?? '')) {
    throw new Error('A one-off needs its month')
  }

  await auditedTransaction(async (tx) => {
    const heads = await tx.ledgerAccount.findMany({
      where: { isGroup: false, archivedAt: null, name: { equals: label, mode: 'insensitive' } },
      include: { entity: { select: { code: true } } },
    })
    // Prefer the head living in the paying pool's own books.
    const head =
      heads.find((h) => h.entity.code === source) ??
      heads.find((h) => h.entity.code === 'HG') ??
      heads[0] ??
      null
    const entity = head
      ? await tx.entity.findUniqueOrThrow({ where: { id: head.entityId } })
      : await tx.entity.findFirstOrThrow({ where: { code: source === 'CASH' ? 'HG' : source } })
    // No head with this name anywhere? It is born right here, in the pool's
    // books — so the plan line and the tagging screen share one head from
    // day one (+ = expense head, − = income head).
    const headAccountId =
      head?.id ??
      (await resolveHeadAccount(tx, { entityId: entity.id, headText: label, isOutflow: amount > 0 }))
    const data = {
      entityId: entity.id,
      headAccountId,
      label,
      source,
      frequency,
      amount: amount.toFixed(2),
      onMonth: frequency === 'ONCE' ? onMonth : null,
      taxTreatment,
      dayNote,
    }
    const line = id
      ? await tx.budgetLine.update({ where: { id }, data })
      : await tx.budgetLine.create({ data })
    if (line.headAccountId) {
      const { syncBudgetForHead } = await import('@/lib/budget/plan')
      await syncBudgetForHead(tx, line.headAccountId)
    }
    await audit(tx, {
      actorId: admin.id,
      action: 'cash.plan_save',
      targetType: 'BudgetLine',
      targetId: line.id,
      summary: `Plan (${source}): ${label} ${frequency.toLowerCase()} ₹${amount.toFixed(2)}${onMonth ? ` in ${onMonth}` : ''}`,
    })
  })
  revalidatePath('/cash')
  revalidatePath('/reports/cash-flow')
}

export async function archiveCashPlanAction(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  await auditedTransaction(async (tx) => {
    const line = await tx.budgetLine.update({ where: { id }, data: { archivedAt: new Date() } })
    if (line.headAccountId) {
      const { syncBudgetForHead } = await import('@/lib/budget/plan')
      await syncBudgetForHead(tx, line.headAccountId)
    }
    await audit(tx, {
      actorId: admin.id,
      action: 'cash.plan_archive',
      targetType: 'BudgetLine',
      targetId: id,
      summary: `Cash plan line removed: ${line.label}`,
    })
  })
  revalidatePath('/cash')
  revalidatePath('/reports/cash-flow')
}

/**
 * Empty a bin entry for good. Only entries whose posting is already
 * reversed (the recycle bin) can go — the ledger keeps the original and
 * its reversal untouched, so balances never move.
 */
export async function purgeCashEntryAction(formData: FormData) {
  const user = await requirePermission('transactionEditDelete')
  const entryId = String(formData.get('entryId') ?? '')
  await auditedTransaction(async (tx) => {
    const entry = await tx.cashEntry.findUniqueOrThrow({ where: { id: entryId } })
    if (entry.docId) {
      const doc = await tx.journalDoc.findUniqueOrThrow({ where: { id: entry.docId } })
      if (!doc.deletedAt) throw new Error('Delete the entry first — only bin entries can be removed forever')
    }
    await tx.cashEntry.delete({ where: { id: entryId } })
    await audit(tx, {
      actorId: user.id,
      action: 'cash.purge',
      targetType: 'CashEntry',
      targetId: entryId,
      summary: `Removed binned cash ${entry.kind.toLowerCase()} ₹${entry.amount} forever (ledger reversal stays)`,
    })
  })
  revalidatePath('/cash')
}

/**
 * One category, one row — the Cash-ahead register's save: bank and cash
 * budgets in their own columns, claimable-as editable, everything else
 * (mode, books, nature, cost centre) carried from the master. Runs the
 * same applyMasterRow the Accounts register uses, so both screens are the
 * same truth.
 */
export async function saveCategoryPlanAction(formData: FormData) {
  const admin = await requireAdmin()
  const f = (n: string) => String(formData.get(n) ?? '').trim()
  const num = (n: string) => {
    const raw = f(n).replace(/[,₹\s]/g, '')
    if (!raw) return 0
    const v = Number(raw)
    if (!Number.isFinite(v)) throw new Error(`Bad amount in ${n}`)
    return v
  }
  const category = f('category')
  if (!category) throw new Error('Name the category')
  const bankBudget = num('bankBudget')
  const cashBudget = num('cashBudget')
  const frequency = f('frequency') || null
  if ((bankBudget !== 0 || cashBudget !== 0) && !frequency) throw new Error('A budget needs its frequency')

  const hm = await prisma.headMode.findFirst({
    where: { category: { equals: category, mode: 'insensitive' } },
  })
  const { applyMasterRow } = await import('@/lib/budget/master-sync')
  await applyMasterRow({
    category: hm?.category ?? category,
    bankMode: hm?.modeBank ?? null,
    expenseType: hm?.expenseType ?? null,
    bankBudget,
    cashBudget,
    frequency,
    dayNote: f('dayNote') || null,
    nature: hm?.nature ?? null,
    books: hm?.books ?? null,
    taxTreatment: f('taxTreatment') || null,
  })
  await auditedTransaction(async (tx) => {
    await audit(tx, {
      actorId: admin.id,
      action: 'cash.plan_save',
      targetType: 'HeadMode',
      targetId: category,
      summary: `Plan "${category}": bank ₹${bankBudget} / cash ₹${cashBudget} ${frequency ?? ''}`,
    })
  })
  revalidatePath('/cash')
  revalidatePath('/reports/cash-flow')
  revalidatePath('/admin/coa')
}

/** Take a whole category off the recurring plan (both its bank and cash lines). */
export async function archiveCategoryPlanAction(formData: FormData) {
  const admin = await requireAdmin()
  const category = String(formData.get('category') ?? '').trim()
  const lines = await prisma.budgetLine.findMany({
    where: { archivedAt: null, frequency: { not: 'ONCE' }, label: { equals: category, mode: 'insensitive' } },
  })
  await auditedTransaction(async (tx) => {
    for (const line of lines) {
      await tx.budgetLine.update({ where: { id: line.id }, data: { archivedAt: new Date() } })
      if (line.headAccountId) {
        const { syncBudgetForHead } = await import('@/lib/budget/plan')
        await syncBudgetForHead(tx, line.headAccountId)
      }
    }
    await audit(tx, {
      actorId: admin.id,
      action: 'cash.plan_archive',
      targetType: 'HeadMode',
      targetId: category,
      summary: `Plan category "${category}" removed (${lines.length} line(s) → recycle bin)`,
    })
  })
  revalidatePath('/cash')
  revalidatePath('/reports/cash-flow')
}
