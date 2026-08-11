import type { Prisma, Bill } from '@/generated/prisma/client'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { rateBp, gstOnNet, tdsOnGross } from '@/lib/tax/calc'
import { OpsError } from './reimburse'

// Bills & insurance (spec §6.3): a bill is a document + reminder — vendor,
// amounts, due/renewal dates and the attached file. It posts NOTHING: the
// expense reaches the books when the bank-statement row is tagged, so an
// entry here would count it twice. GST/TDS amounts are still computed and
// stored as metadata for the record. Marking a recurring bill paid spawns
// the next PENDING instance one period ahead.

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
    expenseAccountId?: string | null
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
      expenseAccountId: args.expenseAccountId ?? null,
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
    return tx.bill.update({
      where: { id: bill.id },
      data: { seriesId: bill.id, periodKey: periodKeyOf(args.dueDate) },
    })
  }
  return bill
}

/**
 * Mark a pending bill paid; a recurring one spawns its next instance.
 * No posting happens here — the actual payment reaches the books when its
 * bank-statement row is tagged.
 */
export async function payBill(
  tx: Prisma.TransactionClient,
  args: { billId: string; date: Date; actorId: string },
): Promise<{ bill: Bill; nextBill: Bill | null }> {
  const bill = await tx.bill.findUniqueOrThrow({ where: { id: args.billId } })
  if (bill.status !== 'PENDING') throw new OpsError('Bill is already paid')
  const paid = await tx.bill.update({
    where: { id: bill.id },
    data: { status: 'PAID', paidAt: args.date },
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
