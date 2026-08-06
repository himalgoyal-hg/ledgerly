'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { parsePaise, formatPaise } from '@/lib/ledger/money'

// Budget targets (spec §10 "Budget vs Actual") — Admin-only. Budgets are an
// input, not derived data: everything else in reports comes from the ledger.

export async function setBudget(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const accountId = String(formData.get('accountId') ?? '')
  const year = Number(formData.get('year'))
  const amount = String(formData.get('amount') ?? '').trim()
  // Blank month = spread the annual figure evenly across all twelve.
  const monthRaw = String(formData.get('month') ?? '')
  if (!accountId) throw new Error('Pick an account')
  if (!Number.isInteger(year)) throw new Error('Pick a year')

  await auditedTransaction(async (tx) => {
    const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })
    if (account.entityId !== entityId) throw new Error('Account does not belong to this entity')
    if (account.isGroup) throw new Error('Budget a leaf account, not a group head')

    if (!amount || parsePaise(amount) === 0n) {
      await tx.budget.deleteMany({
        where: { entityId, accountId, year, ...(monthRaw ? { month: Number(monthRaw) } : {}) },
      })
      await audit(tx, {
        actorId: admin.id,
        action: 'budget.clear',
        targetType: 'LedgerAccount',
        targetId: accountId,
        summary: `Cleared budget for ${account.name} ${year}${monthRaw ? `-${monthRaw}` : ''}`,
      })
      return
    }

    const months = monthRaw ? [Number(monthRaw)] : Array.from({ length: 12 }, (_, i) => i + 1)
    const total = parsePaise(amount)
    // Spread annual budgets evenly; the first month absorbs the rounding.
    const per = total / BigInt(months.length)
    const remainder = total - per * BigInt(months.length)
    for (const [index, month] of months.entries()) {
      const monthAmount = formatPaise(index === 0 ? per + remainder : per)
      await tx.budget.upsert({
        where: { entityId_accountId_year_month: { entityId, accountId, year, month } },
        create: { entityId, accountId, year, month, amount: monthAmount },
        update: { amount: monthAmount },
      })
    }
    await audit(tx, {
      actorId: admin.id,
      action: 'budget.set',
      targetType: 'LedgerAccount',
      targetId: accountId,
      summary: `Budget ${account.name} ${year}${monthRaw ? `-${monthRaw}` : ' (spread over 12 months)'}: ₹${amount}`,
    })
  })
  revalidatePath('/reports/budget')
}
