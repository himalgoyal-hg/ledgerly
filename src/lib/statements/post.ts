import type { Prisma, StatementTransaction } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import {
  createJournalDocument,
  editJournalDocument,
  PostingError,
  type LineInput,
} from '@/lib/ledger/posting'
import { getSystemAccount, COA } from '@/lib/ledger/coa'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { rateBp, splitGrossGst, grossFromNetTds, TDS_SECTIONS } from '@/lib/tax/calc'
import { writeTaxLine } from '@/lib/tax/register'
import { learnRule, partyToken } from './rules'
import { isNature } from './natures'

// Tagging + posting (spec §3 steps 5–6, tax details §7). Members tag; the
// engine posts the balanced journal underneath — they never see Dr/Cr.

export interface TagTaxInput {
  gstType?: string | null
  gstRate?: string | null
  hsn?: string | null
  counterpartyGstin?: string | null
  tdsSection?: string | null
  tdsRate?: string | null
  deducteePan?: string | null
}

function validateTax(tax: TagTaxInput, nature: string) {
  const hasGst = Boolean(tax.gstRate)
  const hasTds = Boolean(tax.tdsRate)
  if (!hasGst && !hasTds) return
  if (nature !== 'expense' && nature !== 'income') {
    throw new TagError('Tax details apply only to expense / income rows')
  }
  if (hasGst && hasTds) throw new TagError('Use GST or TDS on a row, not both')
  if (hasGst) rateBp(tax.gstRate!) // throws on junk
  if (hasTds) {
    rateBp(tax.tdsRate!)
    if (!tax.tdsSection || !(TDS_SECTIONS as readonly string[]).includes(tax.tdsSection)) {
      throw new TagError('Pick the TDS section')
    }
  }
}

export class TagError extends Error {}

/** Days of slack when matching the two sides of an own-account transfer. */
const MIRROR_WINDOW_DAYS = 3

async function loadTaggable(tx: Prisma.TransactionClient, txnId: string) {
  const txn = await tx.statementTransaction.findUniqueOrThrow({ where: { id: txnId } })
  if (txn.status === 'DUPLICATE') throw new TagError('Previously-imported rows cannot be tagged')
  return txn
}

async function assertHeadTaggable(
  tx: Prisma.TransactionClient,
  entityId: string,
  headAccountId: string,
  costCentreId: string | null,
) {
  const head = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: headAccountId } })
  if (head.entityId !== entityId) throw new TagError('Head does not belong to this entity')
  if (head.isGroup) throw new TagError(`"${head.name}" is a group head — pick a leaf account`)
  if (head.archivedAt) throw new TagError(`"${head.name}" is archived`)
  if (costCentreId) {
    const cc = await tx.costCentre.findUniqueOrThrow({ where: { id: costCentreId } })
    if (cc.entityId !== entityId || cc.archivedAt) throw new TagError('Invalid cost centre')
  }
  return head
}

/**
 * Step 5: apply a 3-tier tag. Manual tags feed the learning engine so the
 * next import auto-verifies the same party (spec §3 step 4).
 */
export async function applyTag(
  tx: Prisma.TransactionClient,
  args: {
    txnId: string
    headAccountId: string
    nature: string
    costCentreId?: string | null
    tax?: TagTaxInput
    actorId: string
  },
) {
  const txn = await loadTaggable(tx, args.txnId)
  if (txn.status === 'POSTED') throw new TagError('Already posted — use retag instead')
  if (!isNature(args.nature)) throw new TagError('Unknown nature')
  const head = await assertHeadTaggable(tx, txn.entityId, args.headAccountId, args.costCentreId ?? null)
  // v2 prototype: a blank cost centre falls back to the head's default (a
  // stale default — archived or wrong entity — is silently skipped).
  let costCentreId = args.costCentreId ?? null
  if (!costCentreId && head.defaultCostCentreId) {
    const cc = await tx.costCentre.findUnique({ where: { id: head.defaultCostCentreId } })
    if (cc && cc.entityId === txn.entityId && !cc.archivedAt) costCentreId = cc.id
  }
  const tax = args.tax ?? {}
  validateTax(tax, args.nature)
  const hasGst = Boolean(tax.gstRate)
  const hasTds = Boolean(tax.tdsRate)

  await tx.statementTransaction.update({
    where: { id: txn.id },
    data: {
      status: 'TAGGED',
      headAccountId: args.headAccountId,
      nature: args.nature,
      costCentreId,
      gstType: hasGst ? (tax.gstType ?? 'intra') : null,
      gstRate: hasGst ? tax.gstRate : null,
      hsn: hasGst ? tax.hsn ?? null : null,
      counterpartyGstin: hasGst ? tax.counterpartyGstin ?? null : null,
      tdsSection: hasTds ? tax.tdsSection : null,
      tdsRate: hasTds ? tax.tdsRate : null,
      deducteePan: hasTds ? tax.deducteePan ?? null : null,
      autoTagged: false,
      taggedById: args.actorId,
      taggedAt: new Date(),
    },
  })
  await learnRule(tx, {
    entityId: txn.entityId,
    narration: txn.narration,
    headAccountId: args.headAccountId,
    nature: args.nature,
    costCentreId,
  })
}

/** Send a tagged-but-unposted row back to the pending queue. */
export async function clearTag(tx: Prisma.TransactionClient, txnId: string) {
  const txn = await loadTaggable(tx, txnId)
  if (txn.status !== 'TAGGED') throw new TagError('Only tagged (unposted) rows can be untagged')
  await tx.statementTransaction.update({
    where: { id: txn.id },
    data: {
      status: 'PENDING',
      headAccountId: null,
      nature: null,
      costCentreId: null,
      gstType: null,
      gstRate: null,
      hsn: null,
      counterpartyGstin: null,
      tdsSection: null,
      tdsRate: null,
      deducteePan: null,
      autoTagged: false,
      taggedById: null,
      taggedAt: null,
    },
  })
}

interface BuiltPosting {
  lines: LineInput[]
  // Register row to write once the doc exists (spec §7). Null when untaxed.
  tax: {
    direction: 'output' | 'input'
    taxableValue: string
    gstAmount: string
    tdsAmount: string
    withholdsTds: boolean // we deducted → deposit task + TDS register
  } | null
}

/**
 * The posting rule (spec §3 step 6 table), tax-aware (§7):
 * - GST expense (outflow): bank gross splits into Dr head (taxable) + Dr Input Credit
 * - GST income (inflow): Cr head (taxable) + Cr Output Liability
 * - TDS payment (outflow): bank outflow is NET; Dr head gross / Cr TDS Payable
 * - TDS-hit income (inflow): client withheld; Dr TDS Receivable rides along
 */
async function buildLines(
  tx: Prisma.TransactionClient,
  txn: Pick<
    StatementTransaction,
    'entityId' | 'debit' | 'credit' | 'costCentreId' | 'gstRate' | 'tdsRate' | 'tdsSection'
  >,
  headAccountId: string,
  bankLedgerAccountId: string,
): Promise<BuiltPosting> {
  const outflow = Number(txn.debit) > 0
  const bankAmount = parsePaise(outflow ? String(txn.debit) : String(txn.credit))
  const cc = txn.costCentreId ?? undefined

  if (txn.gstRate) {
    const { taxable, gst } = splitGrossGst(bankAmount, rateBp(String(txn.gstRate)))
    if (outflow) {
      const inputCredit = await getSystemAccount(tx, txn.entityId, '1500')
      return {
        lines: [
          { accountId: headAccountId, debit: formatPaise(taxable), costCentreId: cc },
          { accountId: inputCredit.id, debit: formatPaise(gst) },
          { accountId: bankLedgerAccountId, credit: formatPaise(bankAmount) },
        ],
        tax: { direction: 'input', taxableValue: formatPaise(taxable), gstAmount: formatPaise(gst), tdsAmount: '0', withholdsTds: false },
      }
    }
    const output = await getSystemAccount(tx, txn.entityId, '2210')
    return {
      lines: [
        { accountId: bankLedgerAccountId, debit: formatPaise(bankAmount) },
        { accountId: headAccountId, credit: formatPaise(taxable), costCentreId: cc },
        { accountId: output.id, credit: formatPaise(gst) },
      ],
      tax: { direction: 'output', taxableValue: formatPaise(taxable), gstAmount: formatPaise(gst), tdsAmount: '0', withholdsTds: false },
    }
  }

  if (txn.tdsRate) {
    const { gross, tds } = grossFromNetTds(bankAmount, rateBp(String(txn.tdsRate)))
    if (outflow) {
      // We paid net after withholding TDS — we owe the department.
      const tdsPayable = await getSystemAccount(tx, txn.entityId, COA.TDS_PAYABLE)
      return {
        lines: [
          { accountId: headAccountId, debit: formatPaise(gross), costCentreId: cc },
          { accountId: tdsPayable.id, credit: formatPaise(tds) },
          { accountId: bankLedgerAccountId, credit: formatPaise(bankAmount) },
        ],
        tax: { direction: 'input', taxableValue: formatPaise(gross), gstAmount: '0', tdsAmount: formatPaise(tds), withholdsTds: true },
      }
    }
    // The payer withheld TDS on our income — TDS Receivable rides along.
    const tdsReceivable = await getSystemAccount(tx, txn.entityId, '1600')
    return {
      lines: [
        { accountId: bankLedgerAccountId, debit: formatPaise(bankAmount) },
        { accountId: tdsReceivable.id, debit: formatPaise(tds) },
        { accountId: headAccountId, credit: formatPaise(gross), costCentreId: cc },
      ],
      tax: null, // their deduction, not our register
    }
  }

  const amount = formatPaise(bankAmount)
  return {
    lines: outflow
      ? [
          { accountId: headAccountId, debit: amount, costCentreId: cc },
          { accountId: bankLedgerAccountId, credit: amount },
        ]
      : [
          { accountId: bankLedgerAccountId, debit: amount },
          { accountId: headAccountId, credit: amount, costCentreId: cc },
        ],
    tax: null,
  }
}

/**
 * Own-account transfer mirror (spec §3 step 6): the other side, if already
 * posted, carries the journal for both rows — link instead of double-posting.
 */
async function findMirror(tx: Prisma.TransactionClient, txn: StatementTransaction) {
  if (txn.nature !== 'transfer_own' || !txn.headAccountId) return null
  const otherBank = await tx.bankAccount.findFirst({
    where: { ledgerAccountId: txn.headAccountId },
  })
  if (!otherBank) return null
  const thisBank = await tx.bankAccount.findUniqueOrThrow({ where: { id: txn.bankAccountId } })
  if (!thisBank.ledgerAccountId) return null
  const from = new Date(txn.date)
  from.setUTCDate(from.getUTCDate() - MIRROR_WINDOW_DAYS)
  const to = new Date(txn.date)
  to.setUTCDate(to.getUTCDate() + MIRROR_WINDOW_DAYS)
  return tx.statementTransaction.findFirst({
    where: {
      id: { not: txn.id },
      bankAccountId: otherBank.id,
      entityId: txn.entityId,
      status: 'POSTED',
      nature: 'transfer_own',
      headAccountId: thisBank.ledgerAccountId, // points back at this account
      mirrorTxnId: null,
      docId: { not: null },
      date: { gte: from, lte: to },
      // opposite direction, same amount: its debit is my credit and vice versa
      debit: txn.credit,
      credit: txn.debit,
    },
    orderBy: { date: 'asc' },
  })
}

/** Step 6: post one tagged row — a balanced journal entry underneath. */
export async function postStatementTransaction(
  tx: Prisma.TransactionClient,
  args: { txnId: string; actorId: string },
) {
  const txn = await tx.statementTransaction.findUniqueOrThrow({ where: { id: args.txnId } })
  if (txn.status !== 'TAGGED') throw new TagError('Only tagged rows can be posted')
  if (!txn.headAccountId || !txn.nature) throw new TagError('Row has no tag')
  const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: txn.bankAccountId } })
  if (!bank.ledgerAccountId) throw new TagError(`${bank.nickname} has no ledger account`)

  const mirror = await findMirror(tx, txn)
  if (mirror) {
    await tx.statementTransaction.update({
      where: { id: txn.id },
      data: { status: 'POSTED', mirrorTxnId: mirror.id },
    })
    await tx.statementTransaction.update({
      where: { id: mirror.id },
      data: { mirrorTxnId: txn.id },
    })
    return { docId: mirror.docId!, mirrored: true }
  }

  const built = await buildLines(tx, txn, txn.headAccountId, bank.ledgerAccountId)
  const { doc } = await createJournalDocument(tx, {
    entityId: txn.entityId,
    sourceType: 'statement_txn',
    sourceId: txn.id,
    actorId: args.actorId,
    content: {
      date: txn.date,
      narration: txn.narration,
      reference: txn.reference,
      lines: built.lines,
    },
  })
  if (built.tax) {
    await writeTaxLine(tx, {
      entityId: txn.entityId,
      docId: doc.id,
      date: txn.date,
      direction: built.tax.direction,
      party: partyToken(txn.narration) ?? txn.narration.slice(0, 40),
      gstType: txn.gstType,
      gstRate: txn.gstRate === null ? null : String(txn.gstRate),
      hsn: txn.hsn,
      counterpartyGstin: txn.counterpartyGstin,
      taxableValue: built.tax.taxableValue,
      gstAmount: built.tax.gstAmount,
      tdsSection: txn.tdsSection,
      tdsRate: txn.tdsRate === null ? null : String(txn.tdsRate),
      deducteePan: txn.deducteePan,
      tdsAmount: built.tax.tdsAmount,
      sourceType: 'statement_txn',
      sourceId: txn.id,
    })
  }
  await tx.statementTransaction.update({
    where: { id: txn.id },
    data: { status: 'POSTED', docId: doc.id },
  })
  return { docId: doc.id, mirrored: false }
}

/**
 * "Post All Confirmed" (spec §3 step 6): batch-post every tagged row for the
 * entity, oldest first, each atomically. One bad row (e.g. locked period)
 * doesn't sink the batch — failures are reported per row.
 */
export async function postAllConfirmed(entityId: string, actorId: string) {
  const tagged = await prisma.statementTransaction.findMany({
    where: { entityId, status: 'TAGGED' },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    select: { id: true, narration: true },
  })
  const posted: string[] = []
  const failed: { id: string; narration: string; error: string }[] = []
  for (const txn of tagged) {
    try {
      await prisma.$transaction((tx) => postStatementTransaction(tx, { txnId: txn.id, actorId }))
      posted.push(txn.id)
    } catch (e) {
      const message =
        e instanceof PostingError || e instanceof TagError
          ? e.message
          : 'Unexpected error'
      failed.push({ id: txn.id, narration: txn.narration, error: message })
    }
  }
  return { posted, failed }
}

/**
 * Retag a posted row (spec §5 edit): reversal of the original journal + post
 * of the new version, tag fields updated, rule retrained. The GST/TDS
 * details ride along like on a first-time tag — the split lines rebuild
 * with the new values and the tax register row (the GST/TDS reports'
 * source) is rewritten for the doc.
 */
export async function retagPostedTransaction(
  tx: Prisma.TransactionClient,
  args: {
    txnId: string
    headAccountId: string
    nature: string
    costCentreId?: string | null
    tax?: TagTaxInput
    actorId: string
  },
) {
  const txn = await tx.statementTransaction.findUniqueOrThrow({ where: { id: args.txnId } })
  if (txn.status !== 'POSTED') throw new TagError('Only posted rows can be retagged')
  if (!txn.docId) {
    throw new TagError(
      'This row is the mirror of a transfer posted from the other account — edit that side instead',
    )
  }
  if (!isNature(args.nature)) throw new TagError('Unknown nature')
  const head = await assertHeadTaggable(tx, txn.entityId, args.headAccountId, args.costCentreId ?? null)
  const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: txn.bankAccountId } })
  if (!bank.ledgerAccountId) throw new TagError(`${bank.nickname} has no ledger account`)

  // The form's GST/TDS panel is the source of truth (it arrives prefilled
  // with the stored values); no tax arg falls back to what's stored.
  const tax: TagTaxInput = args.tax ?? {
    gstType: txn.gstType,
    gstRate: txn.gstRate === null ? null : String(txn.gstRate),
    hsn: txn.hsn,
    counterpartyGstin: txn.counterpartyGstin,
    tdsSection: txn.tdsSection,
    tdsRate: txn.tdsRate === null ? null : String(txn.tdsRate),
    deducteePan: txn.deducteePan,
  }
  validateTax(tax, args.nature)
  const hasGst = Boolean(tax.gstRate)
  const hasTds = Boolean(tax.tdsRate)

  // Same default-cost-centre fallback as a first-time tag: a blank cost
  // centre lands in the new head's default, never in the old tag's.
  let costCentreId = args.costCentreId ?? null
  if (!costCentreId && head.defaultCostCentreId) {
    const cc = await tx.costCentre.findUnique({ where: { id: head.defaultCostCentreId } })
    if (cc && cc.entityId === txn.entityId && !cc.archivedAt) costCentreId = cc.id
  }

  const taxFields = {
    gstType: hasGst ? (tax.gstType ?? 'intra') : null,
    gstRate: hasGst ? tax.gstRate : null,
    hsn: hasGst ? tax.hsn ?? null : null,
    counterpartyGstin: hasGst ? tax.counterpartyGstin ?? null : null,
    tdsSection: hasTds ? tax.tdsSection : null,
    tdsRate: hasTds ? tax.tdsRate : null,
    deducteePan: hasTds ? tax.deducteePan ?? null : null,
  }
  // buildLines types the rates as Prisma.Decimal, but only ever stringifies
  // them — the form's plain strings are fine.
  const built = await buildLines(
    tx,
    {
      entityId: txn.entityId,
      debit: txn.debit,
      credit: txn.credit,
      costCentreId,
      gstRate: taxFields.gstRate,
      tdsRate: taxFields.tdsRate,
      tdsSection: taxFields.tdsSection,
    } as Parameters<typeof buildLines>[1],
    args.headAccountId,
    bank.ledgerAccountId,
  )
  await editJournalDocument(tx, {
    docId: txn.docId,
    actorId: args.actorId,
    content: {
      date: txn.date,
      narration: txn.narration,
      reference: txn.reference,
      lines: built.lines,
    },
  })
  await tx.statementTransaction.update({
    where: { id: txn.id },
    data: {
      headAccountId: args.headAccountId,
      nature: args.nature,
      costCentreId,
      ...taxFields,
      autoTagged: false,
      taggedById: args.actorId,
      taggedAt: new Date(),
    },
  })

  // Keep the tax register in step with the new version — the GST/TDS
  // reports read TaxLine, so the retagged row must show up (or drop out)
  // there immediately.
  await tx.taxLine.deleteMany({ where: { docId: txn.docId } })
  if (built.tax) {
    await writeTaxLine(tx, {
      entityId: txn.entityId,
      docId: txn.docId,
      date: txn.date,
      direction: built.tax.direction,
      party: partyToken(txn.narration) ?? txn.narration.slice(0, 40),
      gstType: taxFields.gstType,
      gstRate: taxFields.gstRate,
      hsn: taxFields.hsn,
      counterpartyGstin: taxFields.counterpartyGstin,
      taxableValue: built.tax.taxableValue,
      gstAmount: built.tax.gstAmount,
      tdsSection: taxFields.tdsSection,
      tdsRate: taxFields.tdsRate,
      deducteePan: taxFields.deducteePan,
      tdsAmount: built.tax.tdsAmount,
      sourceType: 'statement_txn',
      sourceId: txn.id,
    })
  }

  await learnRule(tx, {
    entityId: txn.entityId,
    narration: txn.narration,
    headAccountId: args.headAccountId,
    nature: args.nature,
    costCentreId,
  })
}
