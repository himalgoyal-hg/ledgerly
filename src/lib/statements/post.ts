import type { Prisma, StatementTransaction } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import {
  createJournalDocument,
  editJournalDocument,
  PostingError,
  type LineInput,
} from '@/lib/ledger/posting'
import { learnRule } from './rules'
import { isNature } from './natures'

// Tagging + posting (spec §3 steps 5–6). Members tag; the engine posts the
// balanced journal underneath — they never see Dr/Cr.

export class TagError extends Error {}

/** Days of slack when matching the two sides of an own-account transfer. */
const MIRROR_WINDOW_DAYS = 3

async function loadTaggable(tx: Prisma.TransactionClient, txnId: string) {
  const txn = await tx.statementTransaction.findUniqueOrThrow({ where: { id: txnId } })
  if (txn.status === 'DUPLICATE') throw new TagError('Previously-imported rows cannot be tagged')
  return txn
}

async function assertHeadTaggable(
  tx: Prisma.TransactionClient,
  entityId: string,
  headAccountId: string,
  costCentreId: string | null,
) {
  const head = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: headAccountId } })
  if (head.entityId !== entityId) throw new TagError('Head does not belong to this entity')
  if (head.isGroup) throw new TagError(`"${head.name}" is a group head — pick a leaf account`)
  if (head.archivedAt) throw new TagError(`"${head.name}" is archived`)
  if (costCentreId) {
    const cc = await tx.costCentre.findUniqueOrThrow({ where: { id: costCentreId } })
    if (cc.entityId !== entityId || cc.archivedAt) throw new TagError('Invalid cost centre')
  }
  return head
}

/**
 * Step 5: apply a 3-tier tag. Manual tags feed the learning engine so the
 * next import auto-verifies the same party (spec §3 step 4).
 */
export async function applyTag(
  tx: Prisma.TransactionClient,
  args: {
    txnId: string
    headAccountId: string
    nature: string
    costCentreId?: string | null
    actorId: string
  },
) {
  const txn = await loadTaggable(tx, args.txnId)
  if (txn.status === 'POSTED') throw new TagError('Already posted — use retag instead')
  if (!isNature(args.nature)) throw new TagError('Unknown nature')
  await assertHeadTaggable(tx, txn.entityId, args.headAccountId, args.costCentreId ?? null)

  await tx.statementTransaction.update({
    where: { id: txn.id },
    data: {
      status: 'TAGGED',
      headAccountId: args.headAccountId,
      nature: args.nature,
      costCentreId: args.costCentreId ?? null,
      autoTagged: false,
      taggedById: args.actorId,
      taggedAt: new Date(),
    },
  })
  await learnRule(tx, {
    entityId: txn.entityId,
    narration: txn.narration,
    headAccountId: args.headAccountId,
    nature: args.nature,
    costCentreId: args.costCentreId ?? null,
  })
}

/** Send a tagged-but-unposted row back to the pending queue. */
export async function clearTag(tx: Prisma.TransactionClient, txnId: string) {
  const txn = await loadTaggable(tx, txnId)
  if (txn.status !== 'TAGGED') throw new TagError('Only tagged (unposted) rows can be untagged')
  await tx.statementTransaction.update({
    where: { id: txn.id },
    data: {
      status: 'PENDING',
      headAccountId: null,
      nature: null,
      costCentreId: null,
      autoTagged: false,
      taggedById: null,
      taggedAt: null,
    },
  })
}

/** The uniform posting rule (spec §3 step 6 table). Cost centre rides the head line. */
function buildLines(
  txn: Pick<StatementTransaction, 'debit' | 'credit' | 'costCentreId'>,
  headAccountId: string,
  bankLedgerAccountId: string,
): LineInput[] {
  const outflow = Number(txn.debit) > 0
  const amount = outflow ? String(txn.debit) : String(txn.credit)
  const cc = txn.costCentreId ?? undefined
  return outflow
    ? [
        { accountId: headAccountId, debit: amount, costCentreId: cc },
        { accountId: bankLedgerAccountId, credit: amount },
      ]
    : [
        { accountId: bankLedgerAccountId, debit: amount },
        { accountId: headAccountId, credit: amount, costCentreId: cc },
      ]
}

/**
 * Own-account transfer mirror (spec §3 step 6): the other side, if already
 * posted, carries the journal for both rows — link instead of double-posting.
 */
async function findMirror(tx: Prisma.TransactionClient, txn: StatementTransaction) {
  if (txn.nature !== 'transfer_own' || !txn.headAccountId) return null
  const otherBank = await tx.bankAccount.findFirst({
    where: { ledgerAccountId: txn.headAccountId },
  })
  if (!otherBank) return null
  const thisBank = await tx.bankAccount.findUniqueOrThrow({ where: { id: txn.bankAccountId } })
  if (!thisBank.ledgerAccountId) return null
  const from = new Date(txn.date)
  from.setUTCDate(from.getUTCDate() - MIRROR_WINDOW_DAYS)
  const to = new Date(txn.date)
  to.setUTCDate(to.getUTCDate() + MIRROR_WINDOW_DAYS)
  return tx.statementTransaction.findFirst({
    where: {
      id: { not: txn.id },
      bankAccountId: otherBank.id,
      entityId: txn.entityId,
      status: 'POSTED',
      nature: 'transfer_own',
      headAccountId: thisBank.ledgerAccountId, // points back at this account
      mirrorTxnId: null,
      docId: { not: null },
      date: { gte: from, lte: to },
      // opposite direction, same amount: its debit is my credit and vice versa
      debit: txn.credit,
      credit: txn.debit,
    },
    orderBy: { date: 'asc' },
  })
}

/** Step 6: post one tagged row — a balanced journal entry underneath. */
export async function postStatementTransaction(
  tx: Prisma.TransactionClient,
  args: { txnId: string; actorId: string },
) {
  const txn = await tx.statementTransaction.findUniqueOrThrow({ where: { id: args.txnId } })
  if (txn.status !== 'TAGGED') throw new TagError('Only tagged rows can be posted')
  if (!txn.headAccountId || !txn.nature) throw new TagError('Row has no tag')
  const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: txn.bankAccountId } })
  if (!bank.ledgerAccountId) throw new TagError(`${bank.nickname} has no ledger account`)

  const mirror = await findMirror(tx, txn)
  if (mirror) {
    await tx.statementTransaction.update({
      where: { id: txn.id },
      data: { status: 'POSTED', mirrorTxnId: mirror.id },
    })
    await tx.statementTransaction.update({
      where: { id: mirror.id },
      data: { mirrorTxnId: txn.id },
    })
    return { docId: mirror.docId!, mirrored: true }
  }

  const { doc } = await createJournalDocument(tx, {
    entityId: txn.entityId,
    sourceType: 'statement_txn',
    sourceId: txn.id,
    actorId: args.actorId,
    content: {
      date: txn.date,
      narration: txn.narration,
      reference: txn.reference,
      lines: buildLines(txn, txn.headAccountId, bank.ledgerAccountId),
    },
  })
  await tx.statementTransaction.update({
    where: { id: txn.id },
    data: { status: 'POSTED', docId: doc.id },
  })
  return { docId: doc.id, mirrored: false }
}

/**
 * "Post All Confirmed" (spec §3 step 6): batch-post every tagged row for the
 * entity, oldest first, each atomically. One bad row (e.g. locked period)
 * doesn't sink the batch — failures are reported per row.
 */
export async function postAllConfirmed(entityId: string, actorId: string) {
  const tagged = await prisma.statementTransaction.findMany({
    where: { entityId, status: 'TAGGED' },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    select: { id: true, narration: true },
  })
  const posted: string[] = []
  const failed: { id: string; narration: string; error: string }[] = []
  for (const txn of tagged) {
    try {
      await prisma.$transaction((tx) => postStatementTransaction(tx, { txnId: txn.id, actorId }))
      posted.push(txn.id)
    } catch (e) {
      const message =
        e instanceof PostingError || e instanceof TagError
          ? e.message
          : 'Unexpected error'
      failed.push({ id: txn.id, narration: txn.narration, error: message })
    }
  }
  return { posted, failed }
}

/**
 * Retag a posted row (spec §5 edit): reversal of the original journal + post
 * of the new version, tag fields updated, rule retrained.
 */
export async function retagPostedTransaction(
  tx: Prisma.TransactionClient,
  args: {
    txnId: string
    headAccountId: string
    nature: string
    costCentreId?: string | null
    actorId: string
  },
) {
  const txn = await tx.statementTransaction.findUniqueOrThrow({ where: { id: args.txnId } })
  if (txn.status !== 'POSTED') throw new TagError('Only posted rows can be retagged')
  if (!txn.docId) {
    throw new TagError(
      'This row is the mirror of a transfer posted from the other account — edit that side instead',
    )
  }
  if (!isNature(args.nature)) throw new TagError('Unknown nature')
  await assertHeadTaggable(tx, txn.entityId, args.headAccountId, args.costCentreId ?? null)
  const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: txn.bankAccountId } })
  if (!bank.ledgerAccountId) throw new TagError(`${bank.nickname} has no ledger account`)

  await editJournalDocument(tx, {
    docId: txn.docId,
    actorId: args.actorId,
    content: {
      date: txn.date,
      narration: txn.narration,
      reference: txn.reference,
      lines: buildLines(
        { debit: txn.debit, credit: txn.credit, costCentreId: args.costCentreId ?? null },
        args.headAccountId,
        bank.ledgerAccountId,
      ),
    },
  })
  await tx.statementTransaction.update({
    where: { id: txn.id },
    data: {
      headAccountId: args.headAccountId,
      nature: args.nature,
      costCentreId: args.costCentreId ?? null,
      autoTagged: false,
      taggedById: args.actorId,
      taggedAt: new Date(),
    },
  })
  await learnRule(tx, {
    entityId: txn.entityId,
    narration: txn.narration,
    headAccountId: args.headAccountId,
    nature: args.nature,
    costCentreId: args.costCentreId ?? null,
  })
}
