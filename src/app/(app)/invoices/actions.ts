'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { createInvoice, recordInvoicePayment, recordFxReceipt } from '@/lib/ops/invoices'
import { resolveCostCentre } from '@/lib/ops/cost-centres'
import { resolveHeadAccount } from '@/lib/ops/heads'
import { deleteJournalDocument } from '@/lib/ledger/posting'

// Invoices & receivables (spec §6.6) — Admin-only.

const invoiceSchema = z.object({
  entityId: z.string().min(1),
  customer: z.string().trim().min(1, 'Customer is required'),
  date: z.coerce.date(),
  dueDate: z.coerce.date(),
  amount: z.string().trim().min(1, 'Amount is required'),
  narration: z.string().trim().optional(),
  // Empty when the combobox carries new-head text instead (headText).
  incomeAccountId: z.string().optional(),
  costCentreId: z.string().optional(),
  gstType: z.string().optional(),
  gstRate: z.string().optional(),
  hsn: z.string().trim().optional(),
  customerGstin: z.string().trim().optional(),
})

export async function createInvoiceAction(formData: FormData) {
  const admin = await requireAdmin()
  const parsed = invoiceSchema.safeParse({
    entityId: formData.get('entityId'),
    customer: formData.get('customer'),
    date: formData.get('date'),
    dueDate: formData.get('dueDate'),
    amount: formData.get('amount'),
    narration: formData.get('narration') ?? undefined,
    incomeAccountId: formData.get('incomeAccountId'),
    costCentreId: formData.get('costCentreId') ?? undefined,
    gstType: formData.get('gstType') ?? undefined,
    gstRate: formData.get('gstRate') ?? undefined,
    hsn: formData.get('hsn') ?? undefined,
    customerGstin: formData.get('customerGstin') ?? undefined,
  })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)

  await auditedTransaction(async (tx) => {
    // FX metadata (v2 prototype) — display-only; the posting stays INR.
    const fx = {
      currency: String(formData.get('currency') || 'INR'),
      amountFx: formData.get('amountFx') ? String(formData.get('amountFx')) : null,
      fxRate: formData.get('fxRate') ? String(formData.get('fxRate')) : null,
      bankCharges: String(formData.get('bankCharges') || '0'),
      firc: formData.get('firc') ? String(formData.get('firc')) : null,
    }
    const invoice = await createInvoice(tx, {
      ...parsed.data,
      narration: parsed.data.narration || null,
      incomeAccountId: await resolveHeadAccount(tx, {
        entityId: parsed.data.entityId,
        headAccountId: parsed.data.incomeAccountId || null,
        headText: String(formData.get('headText') ?? '').trim() || null,
        isOutflow: false, // invoices always bill income
      }),
      costCentreId: await resolveCostCentre(tx, {
        entityId: parsed.data.entityId,
        costCentreId: parsed.data.costCentreId || null,
        costCentreText: String(formData.get('costCentreText') ?? '').trim() || null,
      }),
      gstType: parsed.data.gstType || null,
      gstRate: parsed.data.gstRate || null,
      hsn: parsed.data.hsn || null,
      customerGstin: parsed.data.customerGstin || null,
      actorId: admin.id,
    })
    await tx.invoice.update({ where: { id: invoice.id }, data: fx })
    await audit(tx, {
      actorId: admin.id,
      action: 'invoice.create',
      targetType: 'Invoice',
      targetId: invoice.id,
      summary: `Invoice ${invoice.number} — ${invoice.customer} ₹${invoice.amount}`,
    })
  })
  revalidatePath('/invoices')
}

/**
 * Export invoice ($): at billing time only the client, the $ amount and the
 * date are known — the due date defaults to +7 days (follow up after the
 * 10th). Nothing posts; recordFxReceiptAction fills the money in when the
 * credit lands.
 */
export async function createFxInvoiceAction(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const customer = String(formData.get('customer') ?? '').trim()
  const country = String(formData.get('country') ?? '').trim() || null
  const currency = String(formData.get('currency') ?? 'USD') || 'USD'
  const amountFx = String(formData.get('amountFx') ?? '').trim()
  const date = new Date(String(formData.get('date') ?? ''))
  if (!customer) throw new Error('Client is required')
  if (!amountFx || Number(amountFx) <= 0) throw new Error('Enter the invoiced $ amount')
  if (isNaN(date.getTime())) throw new Error('Pick the invoice date')
  const dueRaw = String(formData.get('dueDate') ?? '')
  const dueDate = dueRaw ? new Date(dueRaw) : new Date(date.getTime() + 7 * 86_400_000)

  await auditedTransaction(async (tx) => {
    const invoice = await createInvoice(tx, {
      entityId,
      customer,
      date,
      dueDate,
      amount: '0', // register-only: INR unknown until the credit lands
      narration: String(formData.get('narration') ?? '').trim() || null,
      actorId: admin.id,
    })
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { currency, amountFx, country, firc: 'Awaited' },
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'invoice.create',
      targetType: 'Invoice',
      targetId: invoice.id,
      summary: `Export invoice ${invoice.number} — ${customer} ${currency} ${amountFx} (due ${dueDate.toISOString().slice(0, 10)})`,
    })
  })
  revalidatePath('/invoices')
}

/**
 * Edit an invoice in place. FX register invoices (no posting) are fully
 * editable — client, country, $, dates, and for settled ones the whole
 * realization (the rate recomputes). Posted INR invoices only allow the
 * metadata that doesn't touch the ledger (dates, country, narration);
 * amounts/GST need delete & re-raise, which reverses the posting properly.
 */
export async function updateInvoiceAction(formData: FormData) {
  const admin = await requireAdmin()
  const invoiceId = String(formData.get('invoiceId') ?? '')
  const field = (name: string) => String(formData.get(name) ?? '').trim()

  await auditedTransaction(async (tx) => {
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    const fx = invoice.currency !== 'INR'
    const posted = Boolean(invoice.docId)

    const data: Record<string, unknown> = {}
    const date = field('date') ? new Date(field('date')) : null
    const dueDate = field('dueDate') ? new Date(field('dueDate')) : null
    if (date && !isNaN(date.getTime())) data.date = date
    if (dueDate && !isNaN(dueDate.getTime())) data.dueDate = dueDate
    if (formData.has('country')) data.country = field('country') || null
    if (formData.has('narration')) data.narration = field('narration') || null
    if (field('firc')) data.firc = field('firc')
    if (formData.has('fcDisposal')) data.fcDisposal = field('fcDisposal') || null
    if (!posted && field('customer')) data.customer = field('customer')
    if (fx && field('amountFx')) {
      if (Number(field('amountFx')) <= 0) throw new Error('Invoiced $ must be positive')
      data.amountFx = field('amountFx')
    }

    // Realization (FX): a settled row recomputes from what changed; an OPEN
    // row with ₹ credited + credit date filled in IS the receipt — saving
    // the line settles it (Excel-style: fill the row, done).
    if (fx && invoice.status === 'SETTLED') {
      const receivedFx = field('receivedFx') || String(invoice.receivedFx ?? '')
      const realizedInr = field('realizedInr') || String(invoice.realizedInr ?? '')
      if (Number(receivedFx) <= 0 || Number(realizedInr) <= 0) {
        throw new Error('Received $ and ₹ must stay positive')
      }
      data.receivedFx = receivedFx
      data.realizedInr = realizedInr
      data.fxRate = (Number(realizedInr) / Number(receivedFx)).toFixed(4)
      if (formData.has('bankCharges')) data.bankCharges = field('bankCharges') || '0'
      if (formData.has('providerFees')) data.providerFees = field('providerFees') || '0'
      const creditDate = field('creditDate') ? new Date(field('creditDate')) : null
      if (creditDate && !isNaN(creditDate.getTime())) data.creditDate = creditDate
    } else if (fx && field('realizedInr') && field('creditDate')) {
      const receivedFx =
        field('receivedFx') || field('amountFx') || String(invoice.amountFx ?? '')
      const realizedInr = field('realizedInr')
      const creditDate = new Date(field('creditDate'))
      if (Number(receivedFx) <= 0 || Number(realizedInr) <= 0) {
        throw new Error('Received $ and ₹ must be positive')
      }
      if (isNaN(creditDate.getTime())) throw new Error('Pick the credit date')
      data.receivedFx = receivedFx
      data.realizedInr = realizedInr
      data.fxRate = (Number(realizedInr) / Number(receivedFx)).toFixed(4)
      data.bankCharges = field('bankCharges') || '0'
      data.providerFees = field('providerFees') || '0'
      data.creditDate = creditDate
      data.status = 'SETTLED'
    }

    const updated = await tx.invoice.update({ where: { id: invoiceId }, data })
    await audit(tx, {
      actorId: admin.id,
      action: 'invoice.edit',
      targetType: 'Invoice',
      targetId: invoiceId,
      summary: `Edited ${updated.number} — ${updated.customer}`,
      before: {
        customer: invoice.customer, date: invoice.date, dueDate: invoice.dueDate,
        amountFx: String(invoice.amountFx ?? ''), receivedFx: String(invoice.receivedFx ?? ''),
        realizedInr: String(invoice.realizedInr ?? ''), firc: invoice.firc,
      },
      after: data,
    })
  })
  revalidatePath('/invoices')
}

/** The realization: $ received, INR credited, charges & fees — rate computed. */
export async function recordFxReceiptAction(formData: FormData) {
  const admin = await requireAdmin()
  const invoiceId = String(formData.get('invoiceId') ?? '')
  const creditDate = new Date(String(formData.get('creditDate') ?? ''))
  if (isNaN(creditDate.getTime())) throw new Error('Pick the credit date')

  await auditedTransaction(async (tx) => {
    const invoice = await recordFxReceipt(tx, {
      invoiceId,
      receivedFx: String(formData.get('receivedFx') ?? ''),
      realizedInr: String(formData.get('realizedInr') ?? ''),
      bankCharges: String(formData.get('bankCharges') ?? '') || null,
      providerFees: String(formData.get('providerFees') ?? '') || null,
      creditDate,
      firc: String(formData.get('firc') ?? '') || null,
      actorId: admin.id,
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'invoice.fx_receipt',
      targetType: 'Invoice',
      targetId: invoice.id,
      summary: `Realized ${invoice.number}: $${invoice.receivedFx} → ₹${invoice.realizedInr} @ ${invoice.fxRate} (charges ₹${invoice.bankCharges}, fees ₹${invoice.providerFees})`,
    })
  })
  revalidatePath('/invoices')
}

export async function recordPaymentAction(formData: FormData) {
  const admin = await requireAdmin()
  const invoiceId = String(formData.get('invoiceId') ?? '')
  const amount = String(formData.get('amount') ?? '')
  const sourceAccountId = String(formData.get('sourceAccountId') ?? '')
  const date = new Date(String(formData.get('date') ?? ''))
  if (!sourceAccountId) throw new Error('Pick the receiving account')
  if (isNaN(date.getTime())) throw new Error('Pick a date')

  await auditedTransaction(async (tx) => {
    const { payment, settled } = await recordInvoicePayment(tx, {
      invoiceId, date, amount, sourceAccountId, actorId: admin.id,
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'invoice.payment',
      targetType: 'InvoicePayment',
      targetId: payment.id,
      summary: `Received ₹${amount}${settled ? ' — invoice settled' : ' (partial)'}`,
    })
  })
  revalidatePath('/invoices')
}

/**
 * Delete an invoice and its payments: reverse every payment posting, then
 * the invoice posting, then remove the records (payments cascade). The
 * reversals keep the ledger balanced; a locked month refuses.
 */
export async function deleteInvoiceAction(formData: FormData) {
  const admin = await requireAdmin()
  const invoiceId = String(formData.get('invoiceId') ?? '')

  await auditedTransaction(async (tx) => {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { payments: true },
    })
    for (const payment of invoice.payments) {
      if (payment.docId) await deleteJournalDocument(tx, { docId: payment.docId, actorId: admin.id })
    }
    if (invoice.docId) await deleteJournalDocument(tx, { docId: invoice.docId, actorId: admin.id })
    await tx.invoice.delete({ where: { id: invoiceId } })
    await audit(tx, {
      actorId: admin.id,
      action: 'invoice.delete',
      targetType: 'Invoice',
      targetId: invoiceId,
      summary: `Deleted invoice ${invoice.number} (${invoice.customer}) — ${invoice.payments.length} payment(s) and the invoice posting reversed`,
      before: { number: invoice.number, customer: invoice.customer, amount: String(invoice.amount), status: invoice.status },
    })
  })
  revalidatePath('/invoices')
  revalidatePath('/')
}
