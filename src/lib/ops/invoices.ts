import { Prisma, type Invoice } from '@/generated/prisma/client'
import { COA } from '@/lib/ledger/coa'
import { createJournalDocument } from '@/lib/ledger/posting'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { getPartyAccount } from './party'
import { OpsError } from './reimburse'

// Invoices & receivables (spec §6.6): auto numbering per entity, due-date
// tracking, partial payments, aging buckets, settled archive. GST fields
// (§7) arrive with Phase 5 — posting today is Dr Debtor / Cr Income.

export async function createInvoice(
  tx: Prisma.TransactionClient,
  args: {
    entityId: string
    customer: string
    date: Date
    dueDate: Date
    amount: string
    narration?: string | null
    incomeAccountId: string
    costCentreId?: string | null
    actorId: string
  },
) {
  const customer = args.customer.trim()
  if (!customer) throw new OpsError('Customer is required')
  if (parsePaise(args.amount) <= 0n) throw new OpsError('Amount must be positive')
  const amount = formatPaise(parsePaise(args.amount))

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
      amount,
      narration: args.narration ?? null,
      incomeAccountId: args.incomeAccountId,
      costCentreId: args.costCentreId ?? null,
      debtorAccountId: debtor.id,
      createdById: args.actorId,
    },
  })
  const { doc } = await createJournalDocument(tx, {
    entityId: args.entityId,
    sourceType: 'invoice',
    sourceId: invoice.id,
    actorId: args.actorId,
    content: {
      date: args.date,
      narration: `Invoice ${number} — ${customer}`,
      reference: number,
      lines: [
        { accountId: debtor.id, debit: amount },
        { accountId: args.incomeAccountId, credit: amount, costCentreId: args.costCentreId ?? undefined },
      ],
    },
  })
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
