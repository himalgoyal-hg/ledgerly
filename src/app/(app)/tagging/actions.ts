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
import { partyToken } from '@/lib/statements/rules'

// Tagging queue actions (spec §3 steps 5–6). Queue work needs the
// "Transaction tagging" flag; touching posted rows needs
// "Transaction edit / delete / undo". Checked server-side, always.

function tagFields(formData: FormData) {
  const headAccountId = String(formData.get('headAccountId') ?? '')
  const nature = String(formData.get('nature') ?? '')
  const costCentreId = String(formData.get('costCentreId') ?? '') || null
  if (!headAccountId) throw new Error('Pick a head')
  if (!nature) throw new Error('Pick a nature')
  // Optional tax details (spec §3 step 5 / §7) — validated in the service.
  const field = (name: string) => String(formData.get(name) ?? '').trim() || null
  const tax = {
    gstType: field('gstType'),
    gstRate: field('gstRate'),
    hsn: field('hsn'),
    counterpartyGstin: field('counterpartyGstin'),
    tdsSection: field('tdsSection'),
    tdsRate: field('tdsRate'),
    deducteePan: field('deducteePan'),
  }
  return { headAccountId, nature, costCentreId, tax }
}

export async function tagTransaction(formData: FormData) {
  const user = await requirePermission('transactionTagging')
  const txnId = String(formData.get('txnId') ?? '')
  const fields = tagFields(formData)

  await auditedTransaction(async (tx) => {
    const txn = await tx.statementTransaction.findUniqueOrThrow({ where: { id: txnId } })
    await applyTag(tx, { txnId, ...fields, actorId: user.id })
    await tx.statementTransaction.update({
      where: { id: txnId },
      data: { tagSource: 'manual' },
    })

    // One tag clears the whole party: the rule just learned from this row is
    // applied to every same-party row still pending in these books, so 8
    // DigitalOcean rows need one decision, not eight.
    const token = partyToken(txn.narration)
    let spread = 0
    if (token) {
      const pending = await tx.statementTransaction.findMany({
        where: { entityId: txn.entityId, status: 'PENDING', id: { not: txnId } },
      })
      for (const sibling of pending) {
        if (partyToken(sibling.narration) !== token) continue
        await applyTag(tx, { txnId: sibling.id, ...fields, actorId: user.id })
        await tx.statementTransaction.update({
          where: { id: sibling.id },
          data: { tagSource: 'rule' },
        })
        spread++
      }
    }

    await audit(tx, {
      actorId: user.id,
      action: 'statement_txn.tag',
      targetType: 'StatementTransaction',
      targetId: txnId,
      summary:
        'Tagged statement transaction' +
        (spread > 0 ? ` — rule applied to ${spread} more ${token} row(s) in the queue` : ''),
      after: fields,
    })
  })
  revalidatePath('/tagging')
}

/** Ask Claude to suggest tags for pending rows the rule engine couldn't match. */
export async function requestAiSuggestions(formData: FormData) {
  const user = await requirePermission('transactionTagging')
  const entityId = String(formData.get('entityId') ?? '')

  const { aiConfigured, AI_UNCONFIGURED_MESSAGE, AiError } = await import('@/lib/ai/client')
  if (!aiConfigured()) throw new Error(AI_UNCONFIGURED_MESSAGE)
  const { suggestForPending } = await import('@/lib/ai/tag')

  let result: { considered: number; suggested: number }
  try {
    result = await suggestForPending(entityId)
  } catch (e) {
    throw new Error(e instanceof AiError ? e.message : 'AI suggestions failed')
  }
  await auditedTransaction((tx) =>
    audit(tx, {
      actorId: user.id,
      action: 'ai.suggest_tags',
      targetType: 'Entity',
      targetId: entityId,
      summary: `AI reviewed ${result.considered} pending row(s), suggested ${result.suggested}`,
    }),
  )
  revalidatePath('/tagging')
}

/**
 * Accept an AI suggestion: it becomes a real tag, and the rule engine learns
 * it — so the same party is matched by rule next time, not by the model.
 */
export async function acceptAiSuggestion(formData: FormData) {
  const user = await requirePermission('transactionTagging')
  const txnId = String(formData.get('txnId') ?? '')

  await auditedTransaction(async (tx) => {
    const txn = await tx.statementTransaction.findUniqueOrThrow({ where: { id: txnId } })
    if (!txn.aiHeadAccountId || !txn.aiNature) throw new Error('No suggestion on this row')
    await applyTag(tx, {
      txnId,
      headAccountId: txn.aiHeadAccountId,
      nature: txn.aiNature,
      costCentreId: txn.aiCostCentreId,
      actorId: user.id,
    })
    await tx.statementTransaction.update({
      where: { id: txnId },
      data: { tagSource: 'ai' },
    })
    await audit(tx, {
      actorId: user.id,
      action: 'statement_txn.accept_ai',
      targetType: 'StatementTransaction',
      targetId: txnId,
      summary: `Accepted AI suggestion (confidence ${txn.aiConfidence ?? '—'}): ${txn.aiReason ?? ''}`,
    })
  })
  revalidatePath('/tagging')
}

/** Clear a suggestion the member disagrees with; the row stays pending. */
export async function dismissAiSuggestion(formData: FormData) {
  await requirePermission('transactionTagging')
  const txnId = String(formData.get('txnId') ?? '')
  await auditedTransaction((tx) =>
    tx.statementTransaction.update({
      where: { id: txnId },
      data: {
        aiHeadAccountId: null,
        aiNature: null,
        aiCostCentreId: null,
        aiConfidence: null,
        aiReason: 'Dismissed by reviewer',
      },
    }),
  )
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
