import { Prisma, type Invoice } from '@/generated/prisma/client'
import { COA, getSystemAccount } from '@/lib/ledger/coa'
import { createJournalDocument, type LineInput } from '@/lib/ledger/posting'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { rateBp, gstOnNet } from '@/lib/tax/calc'
import { writeTaxLine } from '@/lib/tax/register'
import { getPartyAccount } from './party'
import { OpsError } from './reimburse'

// Invoices & receivables (spec §6.6 + §7.1): auto numbering per entity,
// due-date tracking, partial payments, aging buckets, settled archive.
// With GST: `amount` input is the TAXABLE value; posting splits
// Dr Debtor (total) / Cr Income (taxable) / Cr GST Output Liability.

export async function createInvoice(
  tx: Prisma.TransactionClient,
  args: {
    entityId: string
    customer: string
    date: Date
    dueDate: Date
    amount: string // taxable value
    narration?: string | null
    incomeAccountId: string
    costCentreId?: string | null
    gstType?: string | null
    gstRate?: string | null
    hsn?: string | null
    customerGstin?: string | null
    actorId: string
  },
) {
  const customer = args.customer.trim()
  if (!customer) throw new OpsError('Customer is required')
  const taxable = parsePaise(args.amount)
  if (taxable <= 0n) throw new OpsError('Amount must be positive')
  const gst = args.gstRate ? gstOnNet(taxable, rateBp(args.gstRate)) : 0n
  const total = taxable + gst

  // Auto numbering (spec §6.6): per-entity prefix + counter, atomically.
  const entity = await tx.entity.update({
    where: { id: args.entityId },
    data: { nextInvoiceNumber: { increment: 1 } },
  })
  const number = `${entity.invoicePrefix}-${String(entity.nextInvoiceNumber - 1).padStart(4, '0')}`

  const debtor = await getPartyAccount(tx, args.entityId, COA.DEBTORS_GROUP, customer)
  const invoice = await tx.invoice.create({
    data: {
      entityId: args.entityId,
      number,
      customer,
      date: args.date,
      dueDate: args.dueDate,
      amount: formatPaise(total),
      narration: args.narration ?? null,
      incomeAccountId: args.incomeAccountId,
      costCentreId: args.costCentreId ?? null,
      debtorAccountId: debtor.id,
      gstType: gst > 0n ? (args.gstType ?? 'intra') : null,
      gstRate: gst > 0n ? args.gstRate : null,
      hsn: args.hsn ?? null,
      customerGstin: args.customerGstin ?? null,
      gstAmount: formatPaise(gst),
      createdById: args.actorId,
    },
  })
  const lines: LineInput[] = [
    { accountId: debtor.id, debit: formatPaise(total) },
    { accountId: args.incomeAccountId, credit: formatPaise(taxable), costCentreId: args.costCentreId ?? undefined },
  ]
  if (gst > 0n) {
    const output = await getSystemAccount(tx, args.entityId, '2210')
    lines.push({ accountId: output.id, credit: formatPaise(gst) })
  }
  const { doc } = await createJournalDocument(tx, {
    entityId: args.entityId,
    sourceType: 'invoice',
    sourceId: invoice.id,
    actorId: args.actorId,
    content: {
      date: args.date,
      narration: `Invoice ${number} — ${customer}`,
      reference: number,
      lines,
    },
  })
  if (gst > 0n) {
    await writeTaxLine(tx, {
      entityId: args.entityId,
      docId: doc.id,
      date: args.date,
      direction: 'output',
      party: customer,
      gstType: args.gstType ?? 'intra',
      gstRate: args.gstRate,
      hsn: args.hsn,
      counterpartyGstin: args.customerGstin,
      taxableValue: formatPaise(taxable),
      gstAmount: formatPaise(gst),
      sourceType: 'invoice',
      sourceId: invoice.id,
    })
  }
  return tx.invoice.update({ where: { id: invoice.id }, data: { docId: doc.id } })
}

export async function paidSoFar(
  tx: Prisma.TransactionClient,
  invoiceId: string,
): Promise<bigint> {
  const payments = await tx.invoicePayment.findMany({ where: { invoiceId } })
  return payments.reduce((sum, p) => sum + parsePaise(String(p.amount)), 0n)
}

/** Record a (partial) payment: Dr Bank-Cash / Cr Debtor. */
export async function recordInvoicePayment(
  tx: Prisma.TransactionClient,
  args: {
    invoiceId: string
    date: Date
    amount: string
    sourceAccountId: string // receiving bank / cash-location ledger account
    actorId: string
  },
) {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: args.invoiceId } })
  if (invoice.status === 'SETTLED') throw new OpsError('Invoice is already settled')
  const amount = parsePaise(args.amount)
  if (amount <= 0n) throw new OpsError('Amount must be positive')
  const outstanding = parsePaise(String(invoice.amount)) - (await paidSoFar(tx, invoice.id))
  if (amount > outstanding) {
    throw new OpsError(`Payment exceeds the outstanding ${formatPaise(outstanding)}`)
  }

  const { doc } = await createJournalDocument(tx, {
    entityId: invoice.entityId,
    sourceType: 'invoice_payment',
    sourceId: invoice.id,
    actorId: args.actorId,
    content: {
      date: args.date,
      narration: `Payment against ${invoice.number} — ${invoice.customer}`,
      reference: invoice.number,
      lines: [
        { accountId: args.sourceAccountId, debit: formatPaise(amount) },
        { accountId: invoice.debtorAccountId, credit: formatPaise(amount) },
      ],
    },
  })
  const payment = await tx.invoicePayment.create({
    data: {
      invoiceId: invoice.id,
      date: args.date,
      amount: formatPaise(amount),
      docId: doc.id,
      createdById: args.actorId,
    },
  })
  const settled = amount === outstanding
  await tx.invoice.update({
    where: { id: invoice.id },
    data: { status: settled ? 'SETTLED' : 'PARTIAL' },
  })
  return { payment, settled }
}

export const AGING_BUCKETS = ['current', '1–30', '31–60', '61–90', '90+'] as const

/** Aging bucket for an unsettled invoice as of a given day (spec §6.6). */
export function agingBucket(dueDate: Date, asOf: Date): (typeof AGING_BUCKETS)[number] {
  const days = Math.floor((asOf.getTime() - dueDate.getTime()) / 86_400_000)
  if (days <= 0) return 'current'
  if (days <= 30) return '1–30'
  if (days <= 60) return '31–60'
  if (days <= 90) return '61–90'
  return '90+'
}

/** Outstanding = invoice amount − payments, as display strings. */
export function outstandingOf(invoice: Invoice & { payments: { amount: Prisma.Decimal }[] }) {
  const paid = invoice.payments.reduce((sum, p) => sum + parsePaise(String(p.amount)), 0n)
  return formatPaise(parsePaise(String(invoice.amount)) - paid)
}
