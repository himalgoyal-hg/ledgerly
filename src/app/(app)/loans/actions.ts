'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { audit, auditedTransaction } from '@/lib/audit'
import { getPartyAccount } from '@/lib/ops/party'
import { getSystemAccount } from '@/lib/ledger/coa'
import { createJournalDocument } from '@/lib/ledger/posting'
import { parsePaise, formatPaise } from '@/lib/ledger/money'

// Loans & advances (prototype's Loans screen). Parties live as ledger
// accounts under 1400 (Loans & Advances Given — asset) or 2300 (Loans
// Taken — liability); every movement is an ordinary balanced journal.

const LOANS_GIVEN_GROUP = '1400'
const LOANS_TAKEN_GROUP = '2300'
const OPENING_BALANCES = '3200'

export async function createLoanPartyAction(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  const kind = String(formData.get('kind') ?? 'given') // given | taken
  const opening = parsePaise(String(formData.get('opening') || '0'))
  const date = new Date(String(formData.get('date') || new Date().toISOString().slice(0, 10)))
  if (!name) throw new Error('Party name is required')

  await auditedTransaction(async (tx) => {
    const group = kind === 'taken' ? LOANS_TAKEN_GROUP : LOANS_GIVEN_GROUP
    const account = await getPartyAccount(tx, entityId, group, name)
    if (opening !== 0n) {
      const ob = await getSystemAccount(tx, entityId, OPENING_BALANCES)
      const amount = formatPaise(opening < 0n ? -opening : opening)
      await createJournalDocument(tx, {
        entityId,
        sourceType: 'loan_opening',
        sourceId: account.id,
        actorId: admin.id,
        content: {
          date,
          narration: `Opening balance — ${name} (${kind === 'taken' ? 'loan taken' : 'advance given'})`,
          lines:
            kind === 'taken'
              ? [{ accountId: ob.id, debit: amount }, { accountId: account.id, credit: amount }]
              : [{ accountId: account.id, debit: amount }, { accountId: ob.id, credit: amount }],
        },
      })
    }
    await audit(tx, {
      actorId: admin.id,
      action: 'loan_party.create',
      targetType: 'LedgerAccount',
      targetId: account.id,
      summary: `Added loan party "${name}" (${kind === 'taken' ? 'I owe them' : 'they owe me'})`,
    })
  })
  revalidatePath('/loans')
}

export async function recordLoanMovementAction(formData: FormData) {
  const admin = await requireAdmin()
  const accountId = String(formData.get('accountId') ?? '')
  const sourceAccountId = String(formData.get('sourceAccountId') ?? '')
  const direction = String(formData.get('direction') ?? 'out') // out = money leaves us
  const amount = parsePaise(String(formData.get('amount') || '0'))
  const payMode = String(formData.get('payMode') ?? 'Bank transfer')
  const narration = String(formData.get('narration') ?? '').trim()
  const date = new Date(String(formData.get('date') || new Date().toISOString().slice(0, 10)))
  if (!accountId || !sourceAccountId) throw new Error('Pick the party and the account paying')
  if (amount <= 0n) throw new Error('Amount must be positive')

  await auditedTransaction(async (tx) => {
    const party = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } })
    const value = formatPaise(amount)
    // Money out (given / repaid by me): Dr party, Cr bank-cash.
    // Money in (repayment received / loan received): Dr bank-cash, Cr party.
    const lines =
      direction === 'out'
        ? [{ accountId, debit: value }, { accountId: sourceAccountId, credit: value }]
        : [{ accountId: sourceAccountId, debit: value }, { accountId, credit: value }]
    await createJournalDocument(tx, {
      entityId: party.entityId,
      sourceType: 'loan_movement',
      sourceId: accountId,
      actorId: admin.id,
      content: {
        date,
        narration:
          narration ||
          `${direction === 'out' ? 'Paid to' : 'Received from'} ${party.name} · ${payMode}`,
        lines,
      },
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'loan_movement.post',
      targetType: 'LedgerAccount',
      targetId: accountId,
      summary: `${direction === 'out' ? 'Paid' : 'Received'} ₹${value} ${direction === 'out' ? 'to' : 'from'} ${party.name} (${payMode})`,
    })
  })
  revalidatePath('/loans')
  revalidatePath('/')
}
