'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { createBill, payBill } from '@/lib/ops/bills'

// Bills & insurance (spec §6.3) — Admin-only.

const billSchema = z.object({
  entityId: z.string().min(1),
  vendor: z.string().trim().min(1, 'Vendor is required'),
  billType: z.string().trim().min(1, 'Bill type is required'),
  amount: z.string().trim().min(1, 'Amount is required'),
  billDate: z.coerce.date(),
  dueDate: z.coerce.date(),
  renewalDate: z.coerce.date().optional(),
  link: z.string().trim().optional(),
  remarks: z.string().trim().optional(),
  recurrence: z.enum(['NONE', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
  expenseAccountId: z.string().min(1, 'Pick the expense head'),
  costCentreId: z.string().optional(),
  gstType: z.string().optional(),
  gstRate: z.string().optional(),
  hsn: z.string().trim().optional(),
  vendorGstin: z.string().trim().optional(),
  tdsSection: z.string().optional(),
  tdsRate: z.string().optional(),
  vendorPan: z.string().trim().optional(),
})

export async function createBillAction(formData: FormData) {
  const admin = await requireAdmin()
  const parsed = billSchema.safeParse({
    entityId: formData.get('entityId'),
    vendor: formData.get('vendor'),
    billType: formData.get('billType'),
    amount: formData.get('amount'),
    billDate: formData.get('billDate'),
    dueDate: formData.get('dueDate'),
    renewalDate: formData.get('renewalDate') || undefined,
    link: formData.get('link') ?? undefined,
    remarks: formData.get('remarks') ?? undefined,
    recurrence: formData.get('recurrence') ?? 'NONE',
    expenseAccountId: formData.get('expenseAccountId'),
    costCentreId: formData.get('costCentreId') ?? undefined,
    gstType: formData.get('gstType') ?? undefined,
    gstRate: formData.get('gstRate') ?? undefined,
    hsn: formData.get('hsn') ?? undefined,
    vendorGstin: formData.get('vendorGstin') ?? undefined,
    tdsSection: formData.get('tdsSection') ?? undefined,
    tdsRate: formData.get('tdsRate') ?? undefined,
    vendorPan: formData.get('vendorPan') ?? undefined,
  })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)

  await auditedTransaction(async (tx) => {
    const bill = await createBill(tx, {
      ...parsed.data,
      renewalDate: parsed.data.renewalDate ?? null,
      link: parsed.data.link || null,
      remarks: parsed.data.remarks || null,
      costCentreId: parsed.data.costCentreId || null,
      gstType: parsed.data.gstType || null,
      gstRate: parsed.data.gstRate || null,
      hsn: parsed.data.hsn || null,
      vendorGstin: parsed.data.vendorGstin || null,
      tdsSection: parsed.data.tdsSection || null,
      tdsRate: parsed.data.tdsRate || null,
      vendorPan: parsed.data.vendorPan || null,
      actorId: admin.id,
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'bill.create',
      targetType: 'Bill',
      targetId: bill.id,
      summary: `Bill ${bill.vendor} (${bill.billType}) taxable ₹${bill.amount}${
        Number(bill.gstAmount) ? ` + GST ₹${bill.gstAmount}` : ''
      }${Number(bill.tdsAmount) ? ` − TDS ₹${bill.tdsAmount}` : ''} — payable posted`,
    })
  })
  revalidatePath('/bills')
}

export async function payBillAction(formData: FormData) {
  const admin = await requireAdmin()
  const billId = String(formData.get('billId') ?? '')
  const sourceAccountId = String(formData.get('sourceAccountId') ?? '')
  const date = new Date(String(formData.get('date') ?? ''))
  if (!sourceAccountId) throw new Error('Pick the paying account')
  if (isNaN(date.getTime())) throw new Error('Pick a date')

  await auditedTransaction(async (tx) => {
    const { bill, nextBill } = await payBill(tx, { billId, date, sourceAccountId, actorId: admin.id })
    await audit(tx, {
      actorId: admin.id,
      action: 'bill.pay',
      targetType: 'Bill',
      targetId: bill.id,
      summary: `Paid ${bill.vendor} ₹${bill.amount}${nextBill ? ` — next ${nextBill.recurrence.toLowerCase()} instance created` : ''}`,
    })
  })
  revalidatePath('/bills')
}
