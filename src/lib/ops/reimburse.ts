import { Prisma } from '@/generated/prisma/client'
import { COA } from '@/lib/ledger/coa'
import { createJournalDocument } from '@/lib/ledger/posting'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { getPartyAccount } from './party'

// Reimbursements (spec §6.1). Members submit; Admin approves/rejects.
// Approve posts Dr Expense / Cr Member Payable — the expense hits P&L
// immediately. Settlement (here, or a statement row tagged
// reimbursement_settlement) posts Dr Member Payable / Cr Bank-Cash.
// The tab's "live running balance" is the member's payable ledger.

export class OpsError extends Error {}

export function memberPayableName(memberName: string) {
  return `Payable — ${memberName}`
}

export async function submitClaim(
  tx: Prisma.TransactionClient,
  args: {
    entityId: string
    memberId: string
    date: Date
    category: string
    amount: string
    link?: string | null
    remarks?: string | null
  },
) {
  if (parsePaise(args.amount) <= 0n) throw new OpsError('Amount must be positive')
  return tx.reimbursement.create({
    data: {
      entityId: args.entityId,
      memberId: args.memberId,
      date: args.date,
      category: args.category,
      amount: args.amount,
      link: args.link ?? null,
      remarks: args.remarks ?? null,
    },
  })
}

/** Admin approve: picks the expense head (+ cost centre) and posts. */
export async function approveClaim(
  tx: Prisma.TransactionClient,
  args: {
    claimId: string
    expenseAccountId: string
    costCentreId?: string | null
    actorId: string
  },
) {
  const claim = await tx.reimbursement.findUniqueOrThrow({ where: { id: args.claimId } })
  if (claim.status !== 'PENDING') throw new OpsError('Claim is already reviewed')
  const member = await tx.user.findUniqueOrThrow({ where: { id: claim.memberId } })
  const payable = await getPartyAccount(
    tx, claim.entityId, COA.PAYABLES_GROUP, memberPayableName(member.name),
  )
  const amount = formatPaise(parsePaise(String(claim.amount)))
  const { doc } = await createJournalDocument(tx, {
    entityId: claim.entityId,
    sourceType: 'reimbursement',
    sourceId: claim.id,
    actorId: args.actorId,
    content: {
      date: claim.date,
      narration: `Reimbursement — ${member.name}: ${claim.category}`,
      lines: [
        { accountId: args.expenseAccountId, debit: amount, costCentreId: args.costCentreId ?? undefined },
        { accountId: payable.id, credit: amount },
      ],
    },
  })
  return tx.reimbursement.update({
    where: { id: claim.id },
    data: {
      status: 'APPROVED',
      reviewedById: args.actorId,
      reviewedAt: new Date(),
      expenseAccountId: args.expenseAccountId,
      costCentreId: args.costCentreId ?? null,
      docId: doc.id,
    },
  })
}

/** Admin reject: remarks are mandatory (spec §6.1); nothing posts. */
export async function rejectClaim(
  tx: Prisma.TransactionClient,
  args: { claimId: string; reason: string; actorId: string },
) {
  if (!args.reason.trim()) throw new OpsError('Rejection requires remarks')
  const claim = await tx.reimbursement.findUniqueOrThrow({ where: { id: args.claimId } })
  if (claim.status !== 'PENDING') throw new OpsError('Claim is already reviewed')
  return tx.reimbursement.update({
    where: { id: claim.id },
    data: {
      status: 'REJECTED',
      reviewedById: args.actorId,
      reviewedAt: new Date(),
      rejectReason: args.reason.trim(),
    },
  })
}

/** Settle a member's balance: Dr Member Payable / Cr Bank-Cash. */
export async function settleMember(
  tx: Prisma.TransactionClient,
  args: {
    entityId: string
    memberId: string
    amount: string
    date: Date
    sourceAccountId: string // bank or cash-location ledger account
    actorId: string
  },
) {
  if (parsePaise(args.amount) <= 0n) throw new OpsError('Amount must be positive')
  const member = await tx.user.findUniqueOrThrow({ where: { id: args.memberId } })
  const payable = await getPartyAccount(
    tx, args.entityId, COA.PAYABLES_GROUP, memberPayableName(member.name),
  )
  const amount = formatPaise(parsePaise(args.amount))
  const { doc } = await createJournalDocument(tx, {
    entityId: args.entityId,
    sourceType: 'reimbursement_settlement',
    sourceId: args.memberId,
    actorId: args.actorId,
    content: {
      date: args.date,
      narration: `Reimbursement settlement — ${member.name}`,
      lines: [
        { accountId: payable.id, debit: amount },
        { accountId: args.sourceAccountId, credit: amount },
      ],
    },
  })
  return doc
}
