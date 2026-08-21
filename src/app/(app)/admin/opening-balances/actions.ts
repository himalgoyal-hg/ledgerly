'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'

/** Set one account's opening balance from the Opening balances screen. */
export async function saveOpeningBalanceAction(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const accountId = String(formData.get('accountId') ?? '')
  const amount = String(formData.get('openingBalance') ?? '')
  if (!accountId) throw new Error('Which account?')

  await auditedTransaction(async (tx) => {
    const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })
    if (account.entityId !== entityId) throw new Error('Account belongs to other books')
    // a P&L head opens at nothing (Himal, 21 Aug: "Income and Expenses
    // remove karo") — the screen no longer offers them, and this holds
    // the line for anything that still posts here
    if (account.kind === 'EXPENSE' || account.kind === 'INCOME') {
      throw new Error('Only assets, liabilities and capital take an opening balance')
    }
    const { setHeadOpeningBalance, openingDateFor } = await import('@/lib/ledger/opening')
    const res = await setHeadOpeningBalance(tx, {
      entityId,
      accountId: account.id,
      category: account.name,
      amount,
      actorId: admin.id,
    })
    if (res.action === 'unchanged') return
    await audit(tx, {
      actorId: admin.id,
      action: res.action === 'cleared' ? 'opening_balance.clear' : 'opening_balance.set',
      targetType: 'LedgerAccount',
      targetId: account.id,
      summary:
        res.action === 'cleared'
          ? `Cleared opening balance for ${account.name}`
          : `Opening balance for ${account.name}: ₹${res.amount} as at ${openingDateFor().toISOString().slice(0, 10)}`,
    })
  })
  for (const p of ['/admin/opening-balances', '/admin/coa', '/reports/balance-sheet']) revalidatePath(p)
}
