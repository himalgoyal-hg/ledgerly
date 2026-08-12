'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin, requirePermission } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { submitClaim, approveClaim, rejectClaim, settleMember } from '@/lib/ops/reimburse'
import { resolveCostCentre } from '@/lib/ops/cost-centres'
import { resolveHeadAccount } from '@/lib/ops/heads'
import { saveUpload } from '@/lib/files'

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

  // Attached receipt beats a pasted link — stored in uploads/, served at
  // /files/<id> behind auth.
  const upload = formData.get('file')
  const link =
    upload instanceof File && upload.size > 0
      ? await saveUpload(upload, user.id)
      : parsed.data.link || null

  await auditedTransaction(async (tx) => {
    const claim = await submitClaim(tx, {
      ...parsed.data,
      link,
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
  const pickedHeadId = String(formData.get('expenseAccountId') ?? '') || null
  const headText = String(formData.get('headText') ?? '').trim() || null
  if (!pickedHeadId && !headText) throw new Error('Pick the expense head')

  await auditedTransaction(async (tx) => {
    const pending = await tx.reimbursement.findUniqueOrThrow({ where: { id: claimId } })
    const expenseAccountId = await resolveHeadAccount(tx, {
      entityId: pending.entityId,
      headAccountId: pickedHeadId,
      headText,
      isOutflow: true, // claims are always expenses
    })
    const costCentreId = await resolveCostCentre(tx, {
      entityId: pending.entityId,
      costCentreId: String(formData.get('costCentreId') ?? '') || null,
      costCentreText: String(formData.get('costCentreText') ?? '').trim() || null,
    })
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
