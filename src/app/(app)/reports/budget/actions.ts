'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { parsePaise, formatPaise } from '@/lib/ledger/money'

// Budget targets (spec §10 "Budget vs Actual") — Admin-only. Budgets are an
// input, not derived data: everything else in reports comes from the ledger.
// Targets are entered at their natural frequency (the sheet's Finance setup:
// weekly / monthly / quarterly / half-yearly / annual), annualised here and
// pro-rated across the twelve month rows.

const FREQ_PER_YEAR: Record<string, bigint> = {
  WEEKLY: 52n,
  MONTHLY: 12n,
  QUARTERLY: 4n,
  HALF_YEARLY: 2n,
  ANNUAL: 1n,
}
const FREQ_LABEL: Record<string, string> = {
  WEEKLY: 'week',
  MONTHLY: 'month',
  QUARTERLY: 'quarter',
  HALF_YEARLY: 'half-year',
  ANNUAL: 'year',
}

export async function setBudget(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const accountId = String(formData.get('accountId') ?? '')
  const year = Number(formData.get('year'))
  const amount = String(formData.get('amount') ?? '').trim()
  // Blank month = spread across all twelve; the frequency then says what the
  // entered amount means (₹/week, ₹/month, …). A specific month takes the
  // amount as that month's target and ignores frequency.
  const monthRaw = String(formData.get('month') ?? '')
  const freqRaw = String(formData.get('frequency') ?? '')
  const frequency = monthRaw ? 'MONTHLY' : freqRaw in FREQ_PER_YEAR ? freqRaw : 'ANNUAL'
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
    // Annualise the entered figure, then spread evenly; the first month
    // absorbs the rounding.
    const total = parsePaise(amount) * (monthRaw ? 1n : FREQ_PER_YEAR[frequency])
    const per = total / BigInt(months.length)
    const remainder = total - per * BigInt(months.length)
    for (const [index, month] of months.entries()) {
      const monthAmount = formatPaise(index === 0 ? per + remainder : per)
      await tx.budget.upsert({
        where: { entityId_accountId_year_month: { entityId, accountId, year, month } },
        create: { entityId, accountId, year, month, amount: monthAmount, frequency },
        update: { amount: monthAmount, frequency },
      })
    }
    await audit(tx, {
      actorId: admin.id,
      action: 'budget.set',
      targetType: 'LedgerAccount',
      targetId: accountId,
      summary: monthRaw
        ? `Budget ${account.name} ${year}-${monthRaw}: ₹${amount}`
        : `Budget ${account.name} ${year}: ₹${amount}/${FREQ_LABEL[frequency]} → ₹${formatPaise(total)} for the year`,
    })
  })
  revalidatePath('/reports/budget')
}
