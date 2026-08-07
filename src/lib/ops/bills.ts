import type { Prisma, Bill } from '@/generated/prisma/client'
import { COA, getSystemAccount } from '@/lib/ledger/coa'
import { createJournalDocument, type LineInput } from '@/lib/ledger/posting'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { rateBp, gstOnNet, tdsOnGross } from '@/lib/tax/calc'
import { writeTaxLine, ensureTdsDepositTask } from '@/lib/tax/register'
import { getPartyAccount } from './party'
import { OpsError } from './reimburse'

// Bills & insurance (spec §6.3 + §7): entry posts Dr Expense (taxable)
// [+ Dr GST Input Credit] / [Cr TDS Payable] / Cr Vendor payable; payment
// clears the vendor payable (taxable + GST − TDS). Paying a recurring bill
// spawns the next PENDING instance one period ahead.

function addPeriod(date: Date, recurrence: string): Date {
  const next = new Date(date)
  if (recurrence === 'MONTHLY') next.setUTCMonth(next.getUTCMonth() + 1)
  else if (recurrence === 'QUARTERLY') next.setUTCMonth(next.getUTCMonth() + 3)
  else if (recurrence === 'HALF_YEARLY') next.setUTCMonth(next.getUTCMonth() + 6)
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
    policyNumber?: string | null
    insuredValue?: string | null
    insuredFor?: string | null
    link?: string | null
    remarks?: string | null
    recurrence?: 'NONE' | 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY'
    expenseAccountId: string
    costCentreId?: string | null
    gstType?: string | null
    gstRate?: string | null
    hsn?: string | null
    vendorGstin?: string | null
    tdsSection?: string | null
    tdsRate?: string | null
    vendorPan?: string | null
    actorId: string
    seriesId?: string | null
  },
) {
  const taxable = parsePaise(args.amount)
  if (taxable <= 0n) throw new OpsError('Amount must be positive')
  const vendor = args.vendor.trim()
  if (!vendor) throw new OpsError('Vendor is required')
  // GST rides on the taxable value; TDS is withheld on the taxable value too
  // (never on the GST component).
  const gst = args.gstRate ? gstOnNet(taxable, rateBp(args.gstRate)) : 0n
  const tds = args.tdsRate ? tdsOnGross(taxable, rateBp(args.tdsRate)) : 0n
  if (tds > 0n && !args.tdsSection) throw new OpsError('Pick the TDS section')
  const payableAmount = taxable + gst - tds
  const payable = await getPartyAccount(tx, args.entityId, COA.CREDITORS_GROUP, vendor)

  const bill = await tx.bill.create({
    data: {
      entityId: args.entityId,
      vendor,
      billType: args.billType,
      amount: formatPaise(taxable),
      billDate: args.billDate,
      dueDate: args.dueDate,
      renewalDate: args.renewalDate ?? null,
      policyNumber: args.policyNumber ?? null,
      insuredValue: args.insuredValue ?? null,
      insuredFor: args.insuredFor ?? null,
      link: args.link ?? null,
      remarks: args.remarks ?? null,
      recurrence: args.recurrence ?? 'NONE',
      expenseAccountId: args.expenseAccountId,
      costCentreId: args.costCentreId ?? null,
      gstType: gst > 0n ? (args.gstType ?? 'intra') : null,
      gstRate: gst > 0n ? args.gstRate : null,
      hsn: args.hsn ?? null,
      vendorGstin: args.vendorGstin ?? null,
      gstAmount: formatPaise(gst),
      tdsSection: tds > 0n ? args.tdsSection : null,
      tdsRate: tds > 0n ? args.tdsRate : null,
      vendorPan: args.vendorPan ?? null,
      tdsAmount: formatPaise(tds),
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

  const lines: LineInput[] = [
    { accountId: args.expenseAccountId, debit: formatPaise(taxable), costCentreId: args.costCentreId ?? undefined },
  ]
  if (gst > 0n) {
    const inputCredit = await getSystemAccount(tx, args.entityId, '1500')
    lines.push({ accountId: inputCredit.id, debit: formatPaise(gst) })
  }
  if (tds > 0n) {
    const tdsPayable = await getSystemAccount(tx, args.entityId, COA.TDS_PAYABLE)
    lines.push({ accountId: tdsPayable.id, credit: formatPaise(tds) })
  }
  lines.push({ accountId: payable.id, credit: formatPaise(payableAmount) })

  const { doc } = await createJournalDocument(tx, {
    entityId: args.entityId,
    sourceType: 'bill',
    sourceId: bill.id,
    actorId: args.actorId,
    content: {
      date: args.billDate,
      narration: `Bill — ${vendor}: ${args.billType}`,
      lines,
    },
  })
  if (gst > 0n || tds > 0n) {
    await writeTaxLine(tx, {
      entityId: args.entityId,
      docId: doc.id,
      date: args.billDate,
      direction: 'input',
      party: vendor,
      gstType: gst > 0n ? (args.gstType ?? 'intra') : null,
      gstRate: gst > 0n ? args.gstRate : null,
      hsn: args.hsn,
      counterpartyGstin: args.vendorGstin,
      taxableValue: formatPaise(taxable),
      gstAmount: formatPaise(gst),
      tdsSection: tds > 0n ? args.tdsSection : null,
      tdsRate: tds > 0n ? args.tdsRate : null,
      deducteePan: args.vendorPan,
      tdsAmount: formatPaise(tds),
      sourceType: 'bill',
      sourceId: bill.id,
    })
  }
  if (tds > 0n) {
    await ensureTdsDepositTask(tx, {
      entityId: args.entityId,
      deductionDate: args.billDate,
      amount: formatPaise(tds),
      actorId: args.actorId,
    })
  }
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
  // Vendor gets taxable + GST − TDS withheld.
  const amount = formatPaise(
    parsePaise(String(bill.amount)) + parsePaise(String(bill.gstAmount)) - parsePaise(String(bill.tdsAmount)),
  )

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
        policyNumber: bill.policyNumber,
        insuredValue: bill.insuredValue === null ? null : String(bill.insuredValue),
        insuredFor: bill.insuredFor,
        link: bill.link,
        remarks: bill.remarks,
        recurrence: bill.recurrence,
        expenseAccountId: bill.expenseAccountId,
        costCentreId: bill.costCentreId,
        gstType: bill.gstType,
        gstRate: bill.gstRate === null ? null : String(bill.gstRate),
        hsn: bill.hsn,
        vendorGstin: bill.vendorGstin,
        tdsSection: bill.tdsSection,
        tdsRate: bill.tdsRate === null ? null : String(bill.tdsRate),
        vendorPan: bill.vendorPan,
        actorId: args.actorId,
        seriesId: bill.seriesId,
      })
    }
  }
  return { bill: paid, nextBill }
}
