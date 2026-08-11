'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { createCashEntry } from '@/lib/ops/cash'
import { COA } from '@/lib/ledger/coa'

// "Mark paid" on a party balance: a CASH settlement posts here (receipt
// against a debtor, payment against a creditor/payable). A settlement over
// the bank never posts from this screen — the imported statement row tagged
// to the party's head is what settles it, keeping reconciliation exact.

export async function settlePartyCashAction(formData: FormData) {
  const user = await requirePermission('cashEntries')
  const accountId = String(formData.get('accountId') ?? '')
  const direction = String(formData.get('direction') ?? '')
  if (direction !== 'receive' && direction !== 'pay') throw new Error('Unknown direction')
  const date = new Date(String(formData.get('date') ?? ''))
  if (isNaN(date.getTime())) throw new Error('Pick a date')

  await auditedTransaction(async (tx) => {
    const account = await tx.ledgerAccount.findUniqueOrThrow({
      where: { id: accountId },
      include: { parent: true },
    })
    const group = account.parent?.code
    const ok =
      direction === 'receive'
        ? group === COA.DEBTORS_GROUP
        : group === COA.CREDITORS_GROUP || group === COA.PAYABLES_GROUP
    if (!ok || account.isGroup || account.archivedAt) throw new Error('Not an open party account')

    const entry = await createCashEntry(tx, {
      entityId: account.entityId,
      kind: direction === 'receive' ? 'RECEIPT' : 'PAYMENT',
      date,
      locationId: String(formData.get('locationId') ?? ''),
      headAccountId: account.id,
      amount: String(formData.get('amount') ?? ''),
      remarks:
        direction === 'receive'
          ? `Received from ${account.name} — settlement`
          : `Paid to ${account.name} — settlement`,
      actorId: user.id,
    })
    await audit(tx, {
      actorId: user.id,
      action: 'party.settle',
      targetType: 'CashEntry',
      targetId: entry.id,
      summary:
        direction === 'receive'
          ? `Received ₹${entry.amount} in cash from ${account.name}`
          : `Paid ₹${entry.amount} in cash to ${account.name}`,
    })
  })
  revalidatePath('/reports/parties')
  revalidatePath('/cash')
  revalidatePath('/')
}
