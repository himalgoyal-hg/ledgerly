import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { COA } from '@/lib/ledger/coa'
import { createJournalDocument } from '@/lib/ledger/posting'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { getPartyAccount, ledgerBalance } from './party'
import { resolveDefaultCostCentre } from './cost-centres'

// Reimbursements and member advances (spec §6.1, extended).
//
// Every member has ONE ledger account per book, "Advance — <name>", under
// 1400 Loans & Advances Given. Everything about money between the books
// and that member runs through it:
//
//   advance / settlement paid   Dr Advance — M / Cr Bank-Cash   (here, or a
//                                statement row tagged to the head)
//   claim approved              Dr Expense     / Cr Advance — M
//   unused advance returned     Dr Bank-Cash   / Cr Advance — M
//
// So the account's Dr − Cr balance is the whole story: positive = the member
// still holds that much of the books' money; negative = the books owe the
// member. The Reimbursements tab shows that balance and the account's
// ledger, so members and Admin read the same figure reports do.

export class OpsError extends Error {}

export function memberAdvanceName(memberName: string) {
  return `Advance — ${memberName}`
}

/** The member's advance account in this book (created on first use). */
export async function memberAccount(tx: Prisma.TransactionClient, entityId: string, memberName: string) {
  return getPartyAccount(tx, entityId, COA.ADVANCES_GROUP, memberAdvanceName(memberName))
}

/**
 * Make sure every active user has an advance account in this book, so the
 * heads show up in tagging before any claim exists. Idempotent and cheap.
 */
export async function ensureMemberAccounts(entityId: string) {
  const users = await prisma.user.findMany({
    where: { isActive: true, deletedAt: null },
    select: { name: true },
  })
  const wanted = users.map((u) => memberAdvanceName(u.name))
  const have = await prisma.ledgerAccount.findMany({
    where: { entityId, name: { in: wanted }, archivedAt: null },
    select: { name: true },
  })
  const missing = wanted.filter((name) => !have.some((h) => h.name === name))
  if (missing.length === 0) return
  await prisma.$transaction(async (tx) => {
    for (const name of missing) await getPartyAccount(tx, entityId, COA.ADVANCES_GROUP, name)
  })
}

/** Dr − Cr on the member's account: > 0 advance with member, < 0 owed to member. */
export async function memberBalance(tx: Prisma.TransactionClient, entityId: string, memberName: string) {
  const account = await tx.ledgerAccount.findFirst({
    where: { entityId, name: memberAdvanceName(memberName) },
    select: { id: true },
  })
  return account ? ledgerBalance(tx, account.id) : '0'
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

/** Admin approve: picks the expense head (+ cost centre) and posts against the member's advance. */
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
  const account = await memberAccount(tx, claim.entityId, member.name)
  // A blank cost centre falls back to the head's default — the master
  // register's word — the same safety net tagging and cash entry have.
  const costCentreId = await resolveDefaultCostCentre(tx, {
    entityId: claim.entityId,
    headAccountId: args.expenseAccountId,
    costCentreId: args.costCentreId,
  })
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
        { accountId: args.expenseAccountId, debit: amount, costCentreId: costCentreId ?? undefined },
        { accountId: account.id, credit: amount },
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
      costCentreId,
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

export type MemberMoneyDirection = 'paid' | 'received'

/**
 * Money moving between the books and a member, outside of claims:
 *   paid     — an advance handed over, or a settlement of what the books owe
 *              (Dr Advance — M / Cr bank-cash)
 *   received — unused advance coming back (Dr bank-cash / Cr Advance — M)
 */
export async function recordMemberMoney(
  tx: Prisma.TransactionClient,
  args: {
    entityId: string
    memberId: string
    amount: string
    date: Date
    sourceAccountId: string // bank or cash-location ledger account
    direction: MemberMoneyDirection
    note?: string | null
    actorId: string
  },
) {
  if (parsePaise(args.amount) <= 0n) throw new OpsError('Amount must be positive')
  const member = await tx.user.findUniqueOrThrow({ where: { id: args.memberId } })
  const account = await memberAccount(tx, args.entityId, member.name)
  const amount = formatPaise(parsePaise(args.amount))
  const paid = args.direction === 'paid'
  const base = paid ? `Advance paid — ${member.name}` : `Advance returned — ${member.name}`
  const narration = args.note?.trim() ? `${base}: ${args.note.trim()}` : base
  const { doc } = await createJournalDocument(tx, {
    entityId: args.entityId,
    sourceType: 'member_advance',
    sourceId: args.memberId,
    actorId: args.actorId,
    content: {
      date: args.date,
      narration,
      lines: paid
        ? [
            { accountId: account.id, debit: amount },
            { accountId: args.sourceAccountId, credit: amount },
          ]
        : [
            { accountId: args.sourceAccountId, debit: amount },
            { accountId: account.id, credit: amount },
          ],
    },
  })
  return doc
}
