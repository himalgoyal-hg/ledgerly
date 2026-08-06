import type { Prisma, Bill } from '@/generated/prisma/client'
import { COA } from '@/lib/ledger/coa'
import { createJournalDocument } from '@/lib/ledger/posting'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { getPartyAccount } from './party'
import { OpsError } from './reimburse'

// Bills & insurance (spec §6.3): entry posts Dr Expense / Cr Vendor payable;
// payment posts Dr Vendor payable / Cr Bank-Cash. Paying a recurring bill
// spawns the next PENDING instance one period ahead.

function addPeriod(date: Date, recurrence: string): Date {
  const next = new Date(date)
  if (recurrence === 'MONTHLY') next.setUTCMonth(next.getUTCMonth() + 1)
  else if (recurrence === 'QUARTERLY') next.setUTCMonth(next.getUTCMonth() + 3)
  else next.setUTCFullYear(next.getUTCFullYear() + 1)
  return next
}

export function periodKeyOf(date: Date): string {
  return date.toISOString().slice(0, 7) // "2026-08"
}

export async function createBill(
  tx: Prisma.TransactionClient,
  args: {
    entityId: string
    vendor: string
    billType: string
    amount: string
    billDate: Date
    dueDate: Date
    renewalDate?: Date | null
    link?: string | null
    remarks?: string | null
    recurrence?: 'NONE' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY'
    expenseAccountId: string
    costCentreId?: string | null
    actorId: string
    seriesId?: string | null
  },
) {
  if (parsePaise(args.amount) <= 0n) throw new OpsError('Amount must be positive')
  const vendor = args.vendor.trim()
  if (!vendor) throw new OpsError('Vendor is required')
  const amount = formatPaise(parsePaise(args.amount))
  const payable = await getPartyAccount(tx, args.entityId, COA.CREDITORS_GROUP, vendor)

  const bill = await tx.bill.create({
    data: {
      entityId: args.entityId,
      vendor,
      billType: args.billType,
      amount,
      billDate: args.billDate,
      dueDate: args.dueDate,
      renewalDate: args.renewalDate ?? null,
      link: args.link ?? null,
      remarks: args.remarks ?? null,
      recurrence: args.recurrence ?? 'NONE',
      expenseAccountId: args.expenseAccountId,
      costCentreId: args.costCentreId ?? null,
      seriesId: args.seriesId,
      periodKey: args.seriesId ? periodKeyOf(args.dueDate) : null,
      createdById: args.actorId,
    },
  })
  // A recurring bill roots its own series.
  if ((args.recurrence ?? 'NONE') !== 'NONE' && !args.seriesId) {
    await tx.bill.update({
      where: { id: bill.id },
      data: { seriesId: bill.id, periodKey: periodKeyOf(args.dueDate) },
    })
  }

  const { doc } = await createJournalDocument(tx, {
    entityId: args.entityId,
    sourceType: 'bill',
    sourceId: bill.id,
    actorId: args.actorId,
    content: {
      date: args.billDate,
      narration: `Bill — ${vendor}: ${args.billType}`,
      lines: [
        { accountId: args.expenseAccountId, debit: amount, costCentreId: args.costCentreId ?? undefined },
        { accountId: payable.id, credit: amount },
      ],
    },
  })
  return tx.bill.update({ where: { id: bill.id }, data: { entryDocId: doc.id } })
}

/** Pay a pending bill; a recurring one spawns its next instance. */
export async function payBill(
  tx: Prisma.TransactionClient,
  args: { billId: string; date: Date; sourceAccountId: string; actorId: string },
): Promise<{ bill: Bill; nextBill: Bill | null }> {
  const bill = await tx.bill.findUniqueOrThrow({ where: { id: args.billId } })
  if (bill.status !== 'PENDING') throw new OpsError('Bill is already paid')
  const payable = await getPartyAccount(tx, bill.entityId, COA.CREDITORS_GROUP, bill.vendor)
  const amount = formatPaise(parsePaise(String(bill.amount)))

  const { doc } = await createJournalDocument(tx, {
    entityId: bill.entityId,
    sourceType: 'bill_payment',
    sourceId: bill.id,
    actorId: args.actorId,
    content: {
      date: args.date,
      narration: `Bill payment — ${bill.vendor}: ${bill.billType}`,
      lines: [
        { accountId: payable.id, debit: amount },
        { accountId: args.sourceAccountId, credit: amount },
      ],
    },
  })
  const paid = await tx.bill.update({
    where: { id: bill.id },
    data: { status: 'PAID', paidAt: new Date(), paymentDocId: doc.id },
  })

  let nextBill: Bill | null = null
  if (bill.recurrence !== 'NONE') {
    const nextDue = addPeriod(bill.dueDate, bill.recurrence)
    const exists = await tx.bill.findFirst({
      where: { seriesId: bill.seriesId, periodKey: periodKeyOf(nextDue) },
    })
    if (!exists) {
      nextBill = await createBill(tx, {
        entityId: bill.entityId,
        vendor: bill.vendor,
        billType: bill.billType,
        amount: String(bill.amount),
        billDate: addPeriod(bill.billDate, bill.recurrence),
        dueDate: nextDue,
        renewalDate: bill.renewalDate ? addPeriod(bill.renewalDate, bill.recurrence) : null,
        link: bill.link,
        remarks: bill.remarks,
        recurrence: bill.recurrence,
        expenseAccountId: bill.expenseAccountId,
        costCentreId: bill.costCentreId,
        actorId: args.actorId,
        seriesId: bill.seriesId,
      })
    }
  }
  return { bill: paid, nextBill }
}
