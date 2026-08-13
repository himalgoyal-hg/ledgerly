'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { FREQUENCIES, POOLS } from '@/lib/budget/plan'

// Budget lines of the cash-flow plan. Rows are Excel-style always-editable;
// save re-matches the head by label so a renamed line finds its account.

async function matchHead(tx: Parameters<Parameters<typeof auditedTransaction>[0]>[0], label: string, pool: string) {
  const heads = await tx.ledgerAccount.findMany({
    where: { isGroup: false, archivedAt: null, name: { equals: label.trim(), mode: 'insensitive' } },
    include: { entity: { select: { code: true } } },
  })
  return heads.find((h) => h.entity.code === pool) ?? heads.find((h) => h.entity.code === 'HG') ?? heads[0] ?? null
}

export async function saveBudgetLineAction(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '') || null
  const label = String(formData.get('label') ?? '').trim()
  const source = String(formData.get('source') ?? '')
  const frequency = String(formData.get('frequency') ?? '')
  const amountRaw = String(formData.get('amount') ?? '').replace(/[,₹\s]/g, '')
  const amount = Number(amountRaw)
  const onMonth = String(formData.get('onMonth') ?? '').trim() || null

  if (!label) throw new Error('Name the line')
  if (!(POOLS as readonly string[]).includes(source)) throw new Error('Pick the pool')
  if (!(FREQUENCIES as readonly string[]).includes(frequency)) throw new Error('Pick the frequency')
  if (!Number.isFinite(amount) || amount === 0) throw new Error('Amount: + = goes out, − = comes in')
  if (frequency === 'ONCE' && !/^\d{4}-\d{2}$/.test(onMonth ?? '')) {
    throw new Error('A one-off needs its month')
  }

  await auditedTransaction(async (tx) => {
    const head = await matchHead(tx, label, source)
    const entity = head
      ? await tx.entity.findUniqueOrThrow({ where: { id: head.entityId } })
      : await tx.entity.findFirstOrThrow({ where: { code: source === 'CASH' ? 'HG' : source } })
    const data = {
      entityId: entity.id,
      headAccountId: head?.id ?? null,
      label,
      source,
      frequency,
      amount: amount.toFixed(2),
      onMonth: frequency === 'ONCE' ? onMonth : null,
      expenseType: String(formData.get('expenseType') ?? '').trim() || null,
      taxTreatment: String(formData.get('taxTreatment') ?? '').trim() || null,
      dayNote: String(formData.get('dayNote') ?? '').trim() || null,
    }
    const line = id
      ? await tx.budgetLine.update({ where: { id }, data })
      : await tx.budgetLine.create({ data })
    await audit(tx, {
      actorId: admin.id,
      action: id ? 'budget.line_update' : 'budget.line_create',
      targetType: 'BudgetLine',
      targetId: line.id,
      summary: `Budget line ${label} (${source}) ${frequency.toLowerCase()} ₹${amount.toFixed(2)}${onMonth ? ` in ${onMonth}` : ''}`,
    })
  })
  revalidatePath('/cashflow')
  revalidatePath('/cash')
}

export async function archiveBudgetLineAction(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  await auditedTransaction(async (tx) => {
    const line = await tx.budgetLine.update({ where: { id }, data: { archivedAt: new Date() } })
    await audit(tx, {
      actorId: admin.id,
      action: 'budget.line_archive',
      targetType: 'BudgetLine',
      targetId: id,
      summary: `Archived budget line ${line.label} (${line.source})`,
    })
  })
  revalidatePath('/cashflow')
  revalidatePath('/cash')
}
