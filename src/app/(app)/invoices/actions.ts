'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { createInvoice, recordInvoicePayment } from '@/lib/ops/invoices'

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
  })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)

  await auditedTransaction(async (tx) => {
    const invoice = await createInvoice(tx, {
      ...parsed.data,
      narration: parsed.data.narration || null,
      costCentreId: parsed.data.costCentreId || null,
      actorId: admin.id,
    })
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
