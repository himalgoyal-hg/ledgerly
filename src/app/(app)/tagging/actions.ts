'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission, hasPermission } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import {
  applyTag,
  clearTag,
  postAllConfirmed,
  retagPostedTransaction,
} from '@/lib/statements/post'
import { partyToken } from '@/lib/statements/rules'
import { suggestNature } from '@/lib/statements/natures'
import { resolveCostCentre } from '@/lib/ops/cost-centres'
import { resolveHeadAccount } from '@/lib/ops/heads'

// Tagging queue actions (spec §3 steps 5–6). Queue work needs the
// "Transaction tagging" flag; touching posted rows needs
// "Transaction edit / delete / undo". Checked server-side, always.

function tagFields(formData: FormData) {
  const headAccountId = String(formData.get('headAccountId') ?? '')
  const nature = String(formData.get('nature') ?? '')
  const costCentreId = String(formData.get('costCentreId') ?? '') || null
  // The tag's 2nd head — the Accounting Head column. It arrives prefilled
  // with the Expense Head (mirror); a different pick is the user's own and
  // never writes back into the Expense Head. Unmatched text creates the
  // head (find-or-create), same as the Expense Head combobox.
  const accountingHeadId = String(formData.get('accountingHeadId') ?? '') || null
  const accountingHeadText = String(formData.get('accountingHeadText') ?? '').trim() || null
  // the row's own comment — absent field leaves whatever is stored
  const note = formData.has('note') ? String(formData.get('note') ?? '').trim() : undefined
  // Creatable comboboxes: text that matched no head / cost centre arrives
  // here and is found-or-created in the books being tagged.
  const headText = String(formData.get('headText') ?? '').trim() || null
  const costCentreText = String(formData.get('costCentreText') ?? '').trim() || null
  if (!headAccountId && !headText) throw new Error('Pick a head')
  if (!nature) throw new Error('Pick a nature')
  // Optional tax details (spec §3 step 5 / §7) — validated in the service.
  const field = (name: string) => String(formData.get(name) ?? '').trim() || null
  const taxRaw = {
    gstType: field('gstType'),
    gstRate: field('gstRate'),
    hsn: field('hsn'),
    counterpartyGstin: field('counterpartyGstin'),
    tdsSection: field('tdsSection'),
    tdsRate: field('tdsRate'),
    deducteePan: field('deducteePan'),
  }
  // The row's GST/TDS panel posts a marker when it is on screen. With it,
  // the panel is the truth — clearing every field really clears the tax.
  // Without it (a form that has no panel), say nothing, so a retag keeps
  // whatever the row already stores instead of blanking it.
  const tax = formData.has('taxPanel') || Object.values(taxRaw).some(Boolean) ? taxRaw : undefined
  return { headAccountId, nature, costCentreId, accountingHeadId, accountingHeadText, note, headText, costCentreText, tax }
}

export async function tagTransaction(formData: FormData) {
  const user = await requirePermission('transactionTagging')
  const txnId = String(formData.get('txnId') ?? '')
  const { costCentreText, headText, accountingHeadText, ...raw } = tagFields(formData)

  await auditedTransaction(async (tx) => {
    const txn = await tx.statementTransaction.findUniqueOrThrow({ where: { id: txnId } })
    const fields = {
      ...raw,
      headAccountId: await resolveHeadAccount(tx, {
        entityId: txn.entityId,
        headAccountId: raw.headAccountId || null,
        headText,
        isOutflow: Number(txn.debit) > 0,
      }),
      costCentreId: await resolveCostCentre(tx, {
        entityId: txn.entityId,
        costCentreId: raw.costCentreId,
        costCentreText,
      }),
      // typed-but-unknown Accounting Head is born like an Expense Head would
      // be — under the master's nature and cost-centre rules
      accountingHeadId:
        raw.accountingHeadId ||
        (accountingHeadText
          ? await resolveHeadAccount(tx, {
              entityId: txn.entityId,
              headText: accountingHeadText,
              isOutflow: Number(txn.debit) > 0,
            })
          : null),
    }
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

/**
 * Bulk tag: the checked rows all get the same head / cost centre /
 * Accounting Head / tax in one go (Himal, 20 Aug: "select karun apply to
 * all"). Works on every status: pending and tagged rows tag in place;
 * POSTED rows go through retag (reversal + new version — needs the
 * edit/delete permission). Mirrors, deleted docs and other-books rows are
 * skipped and reported. Nature left blank auto-derives per row.
 */
export async function bulkTag(formData: FormData) {
  const user = await requirePermission('transactionTagging')
  const canEditPosted = hasPermission(user, 'transactionEditDelete')
  const ids = formData.getAll('ids').map(String).filter(Boolean)
  if (ids.length === 0) throw new Error('Tick at least one row first')
  const pickedHeadId = String(formData.get('headAccountId') ?? '') || null
  const headText = String(formData.get('headText') ?? '').trim() || null
  if (!pickedHeadId && !headText) throw new Error('Pick a head')
  const natureRaw = String(formData.get('nature') ?? '')
  const bulkAcctId = String(formData.get('accountingHeadId') ?? '') || null
  const bulkAcctText = String(formData.get('accountingHeadText') ?? '').trim() || null
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

  await auditedTransaction(async (tx) => {
    // A brand-new head takes its books and direction from the first ticked row.
    const first = await tx.statementTransaction.findUniqueOrThrow({ where: { id: ids[0] } })
    const headAccountId = await resolveHeadAccount(tx, {
      entityId: first.entityId,
      headAccountId: pickedHeadId,
      headText,
      isOutflow: Number(first.debit) > 0,
    })
    const head = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: headAccountId } })
    const costCentreId = await resolveCostCentre(tx, {
      entityId: head.entityId,
      costCentreId: String(formData.get('costCentreId') ?? '') || null,
      costCentreText: String(formData.get('costCentreText') ?? '').trim() || null,
    })
    // one Accounting Head for every ticked row — blank means mirror the head
    const accountingHeadId =
      bulkAcctId ||
      (bulkAcctText
        ? await resolveHeadAccount(tx, {
            entityId: head.entityId,
            headText: bulkAcctText,
            isOutflow: Number(first.debit) > 0,
          })
        : null)
    let tagged = 0
    let retagged = 0
    let skipped = 0
    for (const id of ids) {
      const txn = await tx.statementTransaction.findUniqueOrThrow({ where: { id } })
      if (txn.entityId !== head.entityId) {
        skipped++
        continue
      }
      const nature = natureRaw || suggestNature(head, Number(txn.debit) > 0)
      if (txn.status === 'PENDING' || txn.status === 'TAGGED') {
        await applyTag(tx, { txnId: id, headAccountId, nature, costCentreId, accountingHeadId, tax, actorId: user.id })
        await tx.statementTransaction.update({ where: { id }, data: { tagSource: 'manual' } })
        tagged++
      } else if (txn.status === 'POSTED' && canEditPosted && txn.docId) {
        const doc = await tx.journalDoc.findUniqueOrThrow({ where: { id: txn.docId } })
        if (doc.deletedAt) {
          skipped++
          continue
        }
        // blank GST/TDS in the bulk bar means "leave each row's stored tax
        // alone" (retag falls back to it), never "wipe it on 20 rows"
        const taxProvided = Object.values(tax).some(Boolean)
        await retagPostedTransaction(tx, {
          txnId: id,
          headAccountId,
          nature,
          costCentreId,
          accountingHeadId,
          tax: taxProvided ? tax : undefined,
          actorId: user.id,
        })
        retagged++
      } else {
        skipped++ // duplicate, mirror, or no edit permission for posted
      }
    }
    if (tagged + retagged === 0) throw new Error('None of the selected rows could take this tag')
    await audit(tx, {
      actorId: user.id,
      action: 'statement_txn.bulk_tag',
      targetType: 'LedgerAccount',
      targetId: headAccountId,
      summary: `Bulk-applied ${head.name} — ${tagged} tagged, ${retagged} retagged (reversal + new version)${skipped ? `, ${skipped} skipped` : ''}`,
    })
  })
  revalidatePath('/tagging')
}

/**
 * Accept every pending AI suggestion in one click (v2 prototype's
 * "Accept N suggestions"). Each acceptance also teaches the rule engine,
 * same as accepting one by one.
 */
export async function acceptAllSuggestions(formData: FormData) {
  const user = await requirePermission('transactionTagging')
  const entityId = String(formData.get('entityId') ?? '')

  await auditedTransaction(async (tx) => {
    const rows = await tx.statementTransaction.findMany({
      where: {
        entityId,
        status: 'PENDING',
        aiHeadAccountId: { not: null },
        aiNature: { not: null },
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    })
    if (rows.length === 0) throw new Error('No suggestions waiting')
    for (const txn of rows) {
      // A suggestion accepted earlier in this loop may have spread a learned
      // rule onto this row already — re-check before tagging.
      const fresh = await tx.statementTransaction.findUniqueOrThrow({ where: { id: txn.id } })
      if (fresh.status !== 'PENDING') continue
      await applyTag(tx, {
        txnId: txn.id,
        headAccountId: txn.aiHeadAccountId!,
        nature: txn.aiNature!,
        costCentreId: txn.aiCostCentreId,
        costCentreIsSuggestion: true,
        actorId: user.id,
      })
      await tx.statementTransaction.update({ where: { id: txn.id }, data: { tagSource: 'ai' } })
    }
    await audit(tx, {
      actorId: user.id,
      action: 'statement_txn.accept_ai_all',
      targetType: 'Entity',
      targetId: entityId,
      summary: `Accepted ${rows.length} AI suggestion(s) in bulk`,
    })
  })
  revalidatePath('/tagging')
}

/**
 * Suggest tags for pending rows the rule engine couldn't match: first from
 * the user's own tagging history (fuzzy narration match + same party in
 * other books — needs no key), then from Claude for whatever is left, when
 * AI is configured.
 */
export async function requestAiSuggestions(formData: FormData) {
  const user = await requirePermission('transactionTagging')
  const entityId = String(formData.get('entityId') ?? '')

  const { suggestFromHistory } = await import('@/lib/statements/suggest-local')
  const local = await suggestFromHistory(entityId)

  let ai = { considered: 0, suggested: 0 }
  const { aiConfigured, AiError } = await import('@/lib/ai/client')
  if (aiConfigured()) {
    const { suggestForPending } = await import('@/lib/ai/tag')
    try {
      ai = await suggestForPending(entityId)
    } catch (e) {
      throw new Error(e instanceof AiError ? e.message : 'AI suggestions failed')
    }
  }
  await auditedTransaction((tx) =>
    audit(tx, {
      actorId: user.id,
      action: 'ai.suggest_tags',
      targetType: 'Entity',
      targetId: entityId,
      summary: `Suggested tags for ${local.suggested + ai.suggested} of ${Math.max(local.considered, ai.considered + local.suggested)} pending row(s) (${local.suggested} from history, ${ai.suggested} from AI)`,
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
      costCentreIsSuggestion: true,
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
  const { costCentreText, headText, accountingHeadText, ...raw } = tagFields(formData)

  await auditedTransaction(async (tx) => {
    const before = await tx.statementTransaction.findUniqueOrThrow({ where: { id: txnId } })
    const fields = {
      ...raw,
      headAccountId: await resolveHeadAccount(tx, {
        entityId: before.entityId,
        headAccountId: raw.headAccountId || null,
        headText,
        isOutflow: Number(before.debit) > 0,
      }),
      costCentreId: await resolveCostCentre(tx, {
        entityId: before.entityId,
        costCentreId: raw.costCentreId,
        costCentreText,
      }),
      accountingHeadId:
        raw.accountingHeadId ||
        (accountingHeadText
          ? await resolveHeadAccount(tx, {
              entityId: before.entityId,
              headText: accountingHeadText,
              isOutflow: Number(before.debit) > 0,
            })
          : null),
    }
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

// Posted rows are never deleted one by one — a wrong tag is corrected with
// retagPosted (reversal + new version), and a wrong import goes out through
// the Statements page's "Delete import", which reverses everything together.


/**
 * Auto-tag the repeats — the sweep itself lives in
 * `lib/statements/auto-tag.ts` so it can be tested without Next's
 * server-action plumbing.
 */
export async function autoTagRepeats(formData: FormData) {
  const user = await requirePermission('transactionTagging')
  const entityId = String(formData.get('entityId') ?? '')

  await auditedTransaction(async (tx) => {
    const { autoTagKnownParties } = await import('@/lib/statements/auto-tag')
    const { tagged, parties } = await autoTagKnownParties(tx, { entityId, actorId: user.id })
    if (tagged === 0) throw new Error('No pending row matches a party you have tagged before')
    await audit(tx, {
      actorId: user.id,
      action: 'statement_txn.auto_tag_repeats',
      targetType: 'Entity',
      targetId: entityId,
      summary: `Auto-tagged ${tagged} repeat row(s) across ${parties} known part${parties === 1 ? 'y' : 'ies'}`,
    })
  })
  revalidatePath('/tagging')
}
