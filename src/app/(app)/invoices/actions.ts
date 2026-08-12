'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { createInvoice, recordInvoicePayment } from '@/lib/ops/invoices'
import { resolveCostCentre } from '@/lib/ops/cost-centres'
import { deleteJournalDocument } from '@/lib/ledger/posting'

// Invoices & receivables (spec §6.6) — Admin-only.

const invoiceSchema = z.object({
  entityId: z.string().min(1),
  customer: z.string().trim().min(1, 'Customer is required'),
  date: z.coerce.date(),
  dueDate: z.coerce.date(),
  amount: z.string().trim().min(1, 'Amount is required'),
  narration: z.string().trim().optional(),
  incomeAccountId: z.string().min(1, 'Pick the income head'),
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
