'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin, requirePermission } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import {
  submitClaim, approveClaim, rejectClaim, recordMemberMoney, submitAdvanceReceived, approveAdvance,
  deleteRecord, deleteMemberMoney,
} from '@/lib/ops/reimburse'
import { isAdmin } from '@/lib/auth'
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

/** Member: "I received ₹X from the books" — pending until Admin confirms it. */
export async function submitAdvanceAction(formData: FormData) {
  const user = await requirePermission('reimbursementSubmit')
  const entityId = String(formData.get('entityId') ?? '')
  const amount = String(formData.get('amount') ?? '').trim()
  const remarks = String(formData.get('remarks') ?? '').trim() || null
  const date = new Date(String(formData.get('date') ?? ''))
  if (!entityId) throw new Error('No books selected')
  if (!amount) throw new Error('Amount is required')
  if (isNaN(date.getTime())) throw new Error('Pick a date')

  await auditedTransaction(async (tx) => {
    const row = await submitAdvanceReceived(tx, { entityId, memberId: user.id, date, amount, remarks })
    await audit(tx, {
      actorId: user.id,
      action: 'member.advance_recorded',
      targetType: 'Reimbursement',
      targetId: row.id,
      summary: `Recorded advance received ₹${amount}`,
    })
  })
  revalidatePath('/reimbursements')
}

/** Admin: confirm a member-recorded advance, naming the account it was paid from. */
export async function approveAdvanceAction(formData: FormData) {
  const admin = await requireAdmin()
  const claimId = String(formData.get('claimId') ?? '')
  const sourceAccountId = String(formData.get('sourceAccountId') ?? '')
  if (!sourceAccountId) throw new Error('Pick the bank or cash account it was paid from')

  await auditedTransaction(async (tx) => {
    const row = await approveAdvance(tx, { claimId, sourceAccountId, actorId: admin.id })
    await audit(tx, {
      actorId: admin.id,
      action: 'member.advance_confirmed',
      targetType: 'Reimbursement',
      targetId: row.id,
      summary: `Confirmed advance ₹${row.amount} paid to member`,
    })
  })
  revalidatePath('/reimbursements')
}

/** Delete a claim / advance record — own pending ones for members, anything for Admin. */
export async function deleteReimbursementAction(formData: FormData) {
  const user = await requirePermission('reimbursementSubmit')
  const claimId = String(formData.get('claimId') ?? '')
  await auditedTransaction(async (tx) => {
    const row = await deleteRecord(tx, { claimId, actor: { id: user.id, isAdmin: isAdmin(user) } })
    await audit(tx, {
      actorId: user.id,
      action: 'reimbursement.delete',
      targetType: 'Reimbursement',
      targetId: claimId,
      summary: `Deleted ${row.kind === 'ADVANCE' ? 'advance record' : 'claim'} ₹${row.amount} (${row.category})${row.docId ? ' — posting reversed' : ''}`,
      before: { kind: row.kind, status: row.status, amount: String(row.amount), category: row.category },
    })
  })
  revalidatePath('/reimbursements')
}

/** Admin: reverse an advance / settlement entered directly on this page. */
export async function deleteMemberMoneyAction(formData: FormData) {
  const admin = await requireAdmin()
  const docId = String(formData.get('docId') ?? '')
  const entityId = String(formData.get('entityId') ?? '')
  await auditedTransaction(async (tx) => {
    await deleteMemberMoney(tx, { docId, entityId, actorId: admin.id })
    await audit(tx, {
      actorId: admin.id,
      action: 'member.advance_deleted',
      targetType: 'JournalDoc',
      targetId: docId,
      summary: 'Deleted an advance / settlement record (posting reversed)',
    })
  })
  revalidatePath('/reimbursements')
}

/** Admin: advance paid out, settlement paid, or unused advance received back. */
export async function memberMoneyAction(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const memberId = String(formData.get('memberId') ?? '')
  const amount = String(formData.get('amount') ?? '')
  const sourceAccountId = String(formData.get('sourceAccountId') ?? '')
  const note = String(formData.get('note') ?? '').trim() || null
  const direction = String(formData.get('direction') ?? 'paid') === 'received' ? 'received' : 'paid'
  const date = new Date(String(formData.get('date') ?? ''))
  if (!sourceAccountId) throw new Error('Pick the bank or cash account')
  if (isNaN(date.getTime())) throw new Error('Pick a date')

  await auditedTransaction(async (tx) => {
    const doc = await recordMemberMoney(tx, {
      entityId, memberId, amount, date, sourceAccountId, direction, note, actorId: admin.id,
    })
    await audit(tx, {
      actorId: admin.id,
      action: direction === 'paid' ? 'member.advance_paid' : 'member.advance_returned',
      targetType: 'JournalDoc',
      targetId: doc.id,
      summary: direction === 'paid' ? `Paid ₹${amount} to member (advance / settlement)` : `Received ₹${amount} back from member`,
    })
  })
  revalidatePath('/reimbursements')
}
