'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin, requirePermission } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { submitClaim, approveClaim, rejectClaim, settleMember } from '@/lib/ops/reimburse'

// Reimbursements (spec §6.1): members submit their own; Approve / Reject /
// Settle are Admin-only — enforced here, never in the UI.

const claimSchema = z.object({
  entityId: z.string().min(1),
  date: z.coerce.date(),
  category: z.string().trim().min(1, 'Category is required'),
  amount: z.string().trim().min(1, 'Amount is required'),
  link: z.string().trim().optional(),
  remarks: z.string().trim().optional(),
})

export async function submitClaimAction(formData: FormData) {
  const user = await requirePermission('reimbursementSubmit')
  const parsed = claimSchema.safeParse({
    entityId: formData.get('entityId'),
    date: formData.get('date'),
    category: formData.get('category'),
    amount: formData.get('amount'),
    link: formData.get('link') ?? undefined,
    remarks: formData.get('remarks') ?? undefined,
  })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)

  await auditedTransaction(async (tx) => {
    const claim = await submitClaim(tx, {
      ...parsed.data,
      link: parsed.data.link || null,
      remarks: parsed.data.remarks || null,
      memberId: user.id, // own claims only
    })
    await audit(tx, {
      actorId: user.id,
      action: 'reimbursement.submit',
      targetType: 'Reimbursement',
      targetId: claim.id,
      summary: `Submitted claim ₹${parsed.data.amount} (${parsed.data.category})`,
    })
  })
  revalidatePath('/reimbursements')
}

export async function approveClaimAction(formData: FormData) {
  const admin = await requireAdmin()
  const claimId = String(formData.get('claimId') ?? '')
  const expenseAccountId = String(formData.get('expenseAccountId') ?? '')
  const costCentreId = String(formData.get('costCentreId') ?? '') || null
  if (!expenseAccountId) throw new Error('Pick the expense head')

  await auditedTransaction(async (tx) => {
    const claim = await approveClaim(tx, { claimId, expenseAccountId, costCentreId, actorId: admin.id })
    await audit(tx, {
      actorId: admin.id,
      action: 'reimbursement.approve',
      targetType: 'Reimbursement',
      targetId: claim.id,
      summary: `Approved claim ₹${claim.amount} (${claim.category}) — expense posted`,
    })
  })
  revalidatePath('/reimbursements')
}

export async function rejectClaimAction(formData: FormData) {
  const admin = await requireAdmin()
  const claimId = String(formData.get('claimId') ?? '')
  const reason = String(formData.get('reason') ?? '')

  await auditedTransaction(async (tx) => {
    const claim = await rejectClaim(tx, { claimId, reason, actorId: admin.id })
    await audit(tx, {
      actorId: admin.id,
      action: 'reimbursement.reject',
      targetType: 'Reimbursement',
      targetId: claim.id,
      summary: `Rejected claim ₹${claim.amount}: ${reason}`,
    })
  })
  revalidatePath('/reimbursements')
}

export async function settleMemberAction(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const memberId = String(formData.get('memberId') ?? '')
  const amount = String(formData.get('amount') ?? '')
  const sourceAccountId = String(formData.get('sourceAccountId') ?? '')
  const date = new Date(String(formData.get('date') ?? ''))
  if (!sourceAccountId) throw new Error('Pick the paying account')
  if (isNaN(date.getTime())) throw new Error('Pick a date')

  await auditedTransaction(async (tx) => {
    const doc = await settleMember(tx, { entityId, memberId, amount, date, sourceAccountId, actorId: admin.id })
    await audit(tx, {
      actorId: admin.id,
      action: 'reimbursement.settle',
      targetType: 'JournalDoc',
      targetId: doc.id,
      summary: `Settled ₹${amount} of reimbursements`,
    })
  })
  revalidatePath('/reimbursements')
}
