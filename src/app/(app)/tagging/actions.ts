'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import {
  applyTag,
  clearTag,
  postAllConfirmed,
  retagPostedTransaction,
} from '@/lib/statements/post'
import { deleteJournalDocument, undoJournalDocument } from '@/lib/ledger/posting'

// Tagging queue actions (spec §3 steps 5–6). Queue work needs the
// "Transaction tagging" flag; touching posted rows needs
// "Transaction edit / delete / undo". Checked server-side, always.

function tagFields(formData: FormData) {
  const headAccountId = String(formData.get('headAccountId') ?? '')
  const nature = String(formData.get('nature') ?? '')
  const costCentreId = String(formData.get('costCentreId') ?? '') || null
  if (!headAccountId) throw new Error('Pick a head')
  if (!nature) throw new Error('Pick a nature')
  return { headAccountId, nature, costCentreId }
}

export async function tagTransaction(formData: FormData) {
  const user = await requirePermission('transactionTagging')
  const txnId = String(formData.get('txnId') ?? '')
  const fields = tagFields(formData)

  await auditedTransaction(async (tx) => {
    await applyTag(tx, { txnId, ...fields, actorId: user.id })
    await audit(tx, {
      actorId: user.id,
      action: 'statement_txn.tag',
      targetType: 'StatementTransaction',
      targetId: txnId,
      summary: 'Tagged statement transaction',
      after: fields,
    })
  })
  revalidatePath('/tagging')
}

export async function untagTransaction(formData: FormData) {
  const user = await requirePermission('transactionTagging')
  const txnId = String(formData.get('txnId') ?? '')

  await auditedTransaction(async (tx) => {
    const before = await tx.statementTransaction.findUniqueOrThrow({ where: { id: txnId } })
    await clearTag(tx, txnId)
    await audit(tx, {
      actorId: user.id,
      action: 'statement_txn.untag',
      targetType: 'StatementTransaction',
      targetId: txnId,
      summary: 'Sent statement transaction back to the pending queue',
      before: { headAccountId: before.headAccountId, nature: before.nature },
    })
  })
  revalidatePath('/tagging')
}

/** "Post All Confirmed" — every tagged row gets its journal entry (step 6). */
export async function postAll(formData: FormData) {
  const user = await requirePermission('transactionTagging')
  const entityId = String(formData.get('entityId') ?? '')

  const result = await postAllConfirmed(entityId, user.id)
  if (result.posted.length > 0) {
    await auditedTransaction((tx) =>
      audit(tx, {
        actorId: user.id,
        action: 'statement_txn.post_all',
        targetType: 'Entity',
        targetId: entityId,
        summary: `Posted ${result.posted.length} tagged transaction(s)${
          result.failed.length ? `, ${result.failed.length} failed` : ''
        }`,
      }),
    )
  }
  revalidatePath('/tagging')
  revalidatePath('/statements')
  if (result.failed.length > 0) {
    throw new Error(
      result.failed.map((f) => `"${f.narration.slice(0, 40)}": ${f.error}`).join(' · '),
    )
  }
}

export async function retagPosted(formData: FormData) {
  const user = await requirePermission('transactionEditDelete')
  const txnId = String(formData.get('txnId') ?? '')
  const fields = tagFields(formData)

  await auditedTransaction(async (tx) => {
    const before = await tx.statementTransaction.findUniqueOrThrow({ where: { id: txnId } })
    await retagPostedTransaction(tx, { txnId, ...fields, actorId: user.id })
    await audit(tx, {
      actorId: user.id,
      action: 'statement_txn.retag',
      targetType: 'StatementTransaction',
      targetId: txnId,
      summary: 'Retagged posted transaction (reversal + new version underneath)',
      before: { headAccountId: before.headAccountId, nature: before.nature, costCentreId: before.costCentreId },
      after: fields,
    })
  })
  revalidatePath('/tagging')
}

export async function deletePosted(formData: FormData) {
  const user = await requirePermission('transactionEditDelete')
  const txnId = String(formData.get('txnId') ?? '')

  await auditedTransaction(async (tx) => {
    const txn = await tx.statementTransaction.findUniqueOrThrow({ where: { id: txnId } })
    if (!txn.docId) throw new Error('Mirror rows have no journal of their own — delete the other side')
    await deleteJournalDocument(tx, { docId: txn.docId, actorId: user.id })
    await audit(tx, {
      actorId: user.id,
      action: 'statement_txn.delete',
      targetType: 'StatementTransaction',
      targetId: txnId,
      summary: 'Deleted posted transaction (reversal posted, restorable)',
    })
  })
  revalidatePath('/tagging')
}

export async function undoPosted(formData: FormData) {
  const user = await requirePermission('transactionEditDelete')
  const txnId = String(formData.get('txnId') ?? '')

  await auditedTransaction(async (tx) => {
    const txn = await tx.statementTransaction.findUniqueOrThrow({ where: { id: txnId } })
    if (!txn.docId) throw new Error('Mirror rows have no journal of their own — undo the other side')
    await undoJournalDocument(tx, { docId: txn.docId, actorId: user.id })

    // Re-sync the visible tag with the journal the undo restored: the head is
    // whichever line isn't the bank ledger account. (Nature is display-only
    // metadata and keeps its last value.)
    const doc = await tx.journalDoc.findUniqueOrThrow({
      where: { id: txn.docId },
      include: { currentEntry: { include: { lines: true } } },
    })
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: txn.bankAccountId } })
    const headLine = doc.currentEntry?.lines.find((l) => l.accountId !== bank.ledgerAccountId)
    if (headLine) {
      await tx.statementTransaction.update({
        where: { id: txn.id },
        data: { headAccountId: headLine.accountId, costCentreId: headLine.costCentreId },
      })
    }
    await audit(tx, {
      actorId: user.id,
      action: 'statement_txn.undo',
      targetType: 'StatementTransaction',
      targetId: txnId,
      summary: 'Undid last operation on posted transaction',
    })
  })
  revalidatePath('/tagging')
}
