'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { createBill, payBill } from '@/lib/ops/bills'
import { deleteJournalDocument } from '@/lib/ledger/posting'
import { saveUpload } from '@/lib/files'

// Bills & insurance (spec §6.3) — Admin-only.

const billSchema = z.object({
  entityId: z.string().min(1),
  vendor: z.string().trim().min(1, 'Vendor is required'),
  billType: z.string().trim().min(1, 'Bill type is required'),
  amount: z.string().trim().min(1, 'Amount is required'),
  billDate: z.coerce.date(),
  dueDate: z.coerce.date(),
  renewalDate: z.coerce.date().optional(),
  policyNumber: z.string().trim().optional(),
  insuredValue: z.string().trim().optional(),
  insuredFor: z.string().trim().optional(),
  link: z.string().trim().optional(),
  remarks: z.string().trim().optional(),
  payFrom: z.string().trim().optional(),
  recurrence: z.enum(['NONE', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY']),
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
    policyNumber: formData.get('policyNumber') ?? undefined,
    insuredValue: formData.get('insuredValue') ?? undefined,
    insuredFor: formData.get('insuredFor') ?? undefined,
    link: formData.get('link') ?? undefined,
    remarks: formData.get('remarks') ?? undefined,
    payFrom: formData.get('payFrom') ?? undefined,
    recurrence: formData.get('recurrence') ?? 'NONE',
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

  // An attached file beats a pasted link — it lands in uploads/ and the
  // bill's link points at /files/<id>.
  const upload = formData.get('file')
  const link =
    upload instanceof File && upload.size > 0
      ? await saveUpload(upload, admin.id)
      : parsed.data.link || null

  await auditedTransaction(async (tx) => {
    const bill = await createBill(tx, {
      ...parsed.data,
      renewalDate: parsed.data.renewalDate ?? null,
      policyNumber: parsed.data.policyNumber || null,
      insuredValue: parsed.data.insuredValue || null,
      insuredFor: parsed.data.insuredFor || null,
      link,
      remarks: parsed.data.remarks || null,
      payFrom: parsed.data.payFrom || null,
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
      }${Number(bill.tdsAmount) ? ` − TDS ₹${bill.tdsAmount}` : ''} — document stored, books post from the statement`,
    })
  })
  revalidatePath('/bills')
}

export async function payBillAction(formData: FormData) {
  const admin = await requireAdmin()
  const billId = String(formData.get('billId') ?? '')
  const date = new Date(String(formData.get('date') ?? ''))
  if (isNaN(date.getTime())) throw new Error('Pick a date')

  await auditedTransaction(async (tx) => {
    const { bill, nextBill } = await payBill(tx, { billId, date, actorId: admin.id })
    await audit(tx, {
      actorId: admin.id,
      action: 'bill.pay',
      targetType: 'Bill',
      targetId: bill.id,
      summary: `Marked ${bill.vendor} ₹${bill.amount} paid${nextBill ? ` — next ${nextBill.recurrence.toLowerCase().replace('_', '-')} instance created` : ''}`,
    })
  })
  revalidatePath('/bills')
}

/**
 * Delete a bill outright: reverse its payment posting (if paid) and its
 * accrual posting, then remove the record. Reversals keep the ledger
 * balanced and land in the recently-deleted bin; a locked month refuses.
 */
export async function deleteBillAction(formData: FormData) {
  const admin = await requireAdmin()
  const billId = String(formData.get('billId') ?? '')

  await auditedTransaction(async (tx) => {
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: billId } })
    if (bill.paymentDocId) await deleteJournalDocument(tx, { docId: bill.paymentDocId, actorId: admin.id })
    if (bill.entryDocId) await deleteJournalDocument(tx, { docId: bill.entryDocId, actorId: admin.id })
    await tx.bill.delete({ where: { id: billId } })
    await audit(tx, {
      actorId: admin.id,
      action: 'bill.delete',
      targetType: 'Bill',
      targetId: billId,
      summary: `Deleted bill ${bill.vendor} — ${bill.billType} (postings reversed)`,
      before: { vendor: bill.vendor, billType: bill.billType, amount: String(bill.amount), status: bill.status },
    })
  })
  revalidatePath('/bills')
  revalidatePath('/')
}
