'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { resolveHeadAccount } from '@/lib/ops/heads'

// Budget edits on the Expenses M/M grid. Unlike the calendar-year setBudget,
// this writes the FINANCIAL year the report shows: Apr..Dec under fy,
// Jan..Mar under fy+1. "monthly" sets that figure on every FY month;
// "year" spreads the yearly figure paise-exact. Blank clears the FY's rows.

export async function setFyBudgetAction(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  let accountId = String(formData.get('accountId') ?? '')
  // "＋ Add budget" sends a head picked OR typed — a typed name becomes a
  // new expense head on the spot, same as everywhere else in the app.
  const headText = String(formData.get('headText') ?? '').trim()
  const fy = Number(formData.get('fy'))
  const kind = String(formData.get('kind') ?? 'monthly') // monthly | year
  const amount = String(formData.get('amount') ?? '').trim().replace(/[,₹\s]/g, '')
  if (!accountId && !headText) throw new Error('Pick a head')
  if (!Number.isInteger(fy)) throw new Error('Bad financial year')

  const fyMonths = [
    ...Array.from({ length: 9 }, (_, i) => ({ year: fy, month: i + 4 })),
    ...Array.from({ length: 3 }, (_, i) => ({ year: fy + 1, month: i + 1 })),
  ]

  await auditedTransaction(async (tx) => {
    if (!accountId) {
      accountId = await resolveHeadAccount(tx, { entityId, headText, isOutflow: true })
    }
    const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })
    if (account.entityId !== entityId) throw new Error('Account does not belong to this entity')
    if (account.isGroup) throw new Error('Budget a leaf account, not a group head')

    if (!amount || parsePaise(amount) === 0n) {
      await tx.budget.deleteMany({
        where: {
          entityId,
          accountId,
          OR: [
            { year: fy, month: { gte: 4 } },
            { year: fy + 1, month: { lte: 3 } },
          ],
        },
      })
      await audit(tx, {
        actorId: admin.id,
        action: 'budget.clear',
        targetType: 'LedgerAccount',
        targetId: accountId,
        summary: `Cleared FY ${fy}-${String(fy + 1).slice(2)} budget for ${account.name}`,
      })
      return
    }

    const entered = parsePaise(amount)
    const total = kind === 'monthly' ? entered * 12n : entered
    const per = total / 12n
    const remainder = total - per * 12n
    for (const [index, fm] of fyMonths.entries()) {
      const monthAmount = formatPaise(index === 0 ? per + remainder : per)
      await tx.budget.upsert({
        where: { entityId_accountId_year_month: { entityId, accountId, year: fm.year, month: fm.month } },
        create: { entityId, accountId, year: fm.year, month: fm.month, amount: monthAmount, frequency: kind === 'monthly' ? 'MONTHLY' : 'ANNUAL' },
        update: { amount: monthAmount, frequency: kind === 'monthly' ? 'MONTHLY' : 'ANNUAL' },
      })
    }
    await audit(tx, {
      actorId: admin.id,
      action: 'budget.set',
      targetType: 'LedgerAccount',
      targetId: accountId,
      summary: `Budget ${account.name} FY ${fy}-${String(fy + 1).slice(2)}: ₹${amount}/${kind === 'monthly' ? 'month' : 'year'} → ₹${formatPaise(total)} for the year`,
    })
  })
  revalidatePath('/reports/monthly')
  revalidatePath('/reports/budget')
}
