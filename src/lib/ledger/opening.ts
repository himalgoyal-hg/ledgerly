import type { Prisma } from '@/generated/prisma/client'
import { parsePaise, formatPaise } from './money'
import { getSystemAccount, COA } from './coa'
import { createJournalDocument, editJournalDocument, deleteJournalDocument } from './posting'

// A head's opening balance (Himal, 20 Aug), set from the master register.
//
// Nothing new is stored — the ledger stays the only truth. The figure IS a
// journal document (sourceType "opening_balance", sourceId the head), dated
// the day BEFORE this financial year so it reads as brought forward rather
// than as this year's movement. Editing goes through the same reversal-and-
// new-version machinery as any other correction; blanking it deletes the
// document, which posts the reversal.
//
// It belongs to one books: a master row can name a head in several, and
// each keeps its own opening figure.

export interface OpeningResult {
  headId: string | null
  amount: string
  action: 'set' | 'cleared' | 'unchanged'
}

/** The day an opening balance sits on: 31 Mar, just before the FY starts. */
export function openingDateFor(now = new Date()): Date {
  const fy = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
  return new Date(Date.UTC(fy, 2, 31))
}

export async function setHeadOpeningBalance(
  tx: Prisma.TransactionClient,
  args: { entityId: string; category: string; amount: string; actorId: string; now?: Date },
): Promise<OpeningResult> {
  const head = await tx.ledgerAccount.findFirst({
    where: {
      entityId: args.entityId,
      isGroup: false,
      archivedAt: null,
      name: { equals: args.category, mode: 'insensitive' },
    },
  })
  if (!head) throw new Error(`"${args.category}" has no head in these books yet`)

  const existing = await tx.journalDoc.findFirst({
    where: {
      entityId: args.entityId,
      sourceType: 'opening_balance',
      sourceId: head.id,
      deletedAt: null,
    },
  })
  const raw = args.amount.replace(/[,₹\s]/g, '')
  if (raw && !Number.isFinite(Number(raw))) throw new Error('Opening balance must be a number')
  const paise = raw ? parsePaise(raw) : 0n

  if (paise === 0n) {
    if (!existing) return { headId: head.id, amount: '0', action: 'unchanged' }
    await deleteJournalDocument(tx, { docId: existing.id, actorId: args.actorId })
    return { headId: head.id, amount: '0', action: 'cleared' }
  }

  const opening = await getSystemAccount(tx, args.entityId, COA.OPENING_BALANCES)
  const amount = formatPaise(paise < 0n ? -paise : paise)
  const content = {
    date: openingDateFor(args.now),
    narration: `Opening balance — ${head.name}`,
    lines:
      paise > 0n
        ? [
            { accountId: head.id, debit: amount },
            { accountId: opening.id, credit: amount },
          ]
        : [
            { accountId: opening.id, debit: amount },
            { accountId: head.id, credit: amount },
          ],
  }
  if (existing) {
    await editJournalDocument(tx, { docId: existing.id, actorId: args.actorId, content })
  } else {
    await createJournalDocument(tx, {
      entityId: args.entityId,
      sourceType: 'opening_balance',
      sourceId: head.id,
      actorId: args.actorId,
      content,
    })
  }
  return { headId: head.id, amount: formatPaise(paise), action: 'set' }
}
