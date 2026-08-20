import type { Prisma } from '@/generated/prisma/client'
import { parsePaise, formatPaise } from './money'

// The posting service (spec §4–5). All writes are append-only:
//   create → FORWARD v1
//   edit   → REVERSAL of current + FORWARD v(n+1)      (ledger stays balanced)
//   delete → REVERSAL of current (doc enters the bin)
//   undo   → LIFO inverse of the last operation, unlimited depth:
//            undo after delete restores; undo after edit reverts one edit.
// The DB enforces Dr=Cr, append-only lines, and period locks underneath —
// these functions add friendly errors and the document bookkeeping.

export interface LineInput {
  accountId: string
  debit?: string // exactly one of debit/credit, positive, 2dp
  credit?: string
  memo?: string
  costCentreId?: string // tier-3 tag (Phase 3) — carried through reversals
  accountingHeadId?: string // the tag's 2nd head (mirror when absent) — carried through reversals
}

export interface EntryContent {
  date: Date
  narration: string
  reference?: string | null
  lines: LineInput[]
}

export class PostingError extends Error {}

function validateLines(lines: LineInput[]) {
  if (lines.length < 2) throw new PostingError('An entry needs at least two lines')
  let dr = 0n
  let cr = 0n
  for (const line of lines) {
    const d = line.debit ? parsePaise(line.debit) : 0n
    const c = line.credit ? parsePaise(line.credit) : 0n
    if ((d === 0n) === (c === 0n) || d < 0n || c < 0n) {
      throw new PostingError('Each line must have a positive amount on exactly one side')
    }
    dr += d
    cr += c
  }
  if (dr !== cr) {
    throw new PostingError(
      `Entry does not balance: Dr ${formatPaise(dr)} ≠ Cr ${formatPaise(cr)}`,
    )
  }
  return { total: dr }
}

export async function assertPeriodOpen(
  tx: Prisma.TransactionClient,
  entityId: string,
  date: Date,
) {
  const lock = await tx.periodLock.findUnique({
    where: {
      entityId_year_month: {
        entityId,
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
      },
    },
  })
  if (lock) {
    throw new PostingError(
      `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')} is locked — unlock the period first`,
    )
  }
}

async function assertAccountsPostable(
  tx: Prisma.TransactionClient,
  entityId: string,
  lines: LineInput[],
) {
  const ids = [...new Set(lines.map((l) => l.accountId))]
  const accounts = await tx.ledgerAccount.findMany({ where: { id: { in: ids } } })
  for (const id of ids) {
    const account = accounts.find((a) => a.id === id)
    if (!account || account.entityId !== entityId)
      throw new PostingError('Line account does not belong to this entity')
    if (account.isGroup)
      throw new PostingError(`"${account.name}" is a group head — post to a leaf account`)
    if (account.archivedAt)
      throw new PostingError(`"${account.name}" is archived`)
  }
}

interface PostArgs {
  entityId: string
  docId: string
  version: number
  kind: 'FORWARD' | 'REVERSAL'
  action: string
  content: EntryContent
  reversesId?: string
  actorId: string
}

/** Low-level: insert one balanced entry + lines. */
async function postEntry(tx: Prisma.TransactionClient, args: PostArgs) {
  validateLines(args.content.lines)
  await assertAccountsPostable(tx, args.entityId, args.content.lines)
  await assertPeriodOpen(tx, args.entityId, args.content.date)
  return tx.journalEntry.create({
    data: {
      entityId: args.entityId,
      docId: args.docId,
      version: args.version,
      kind: args.kind,
      action: args.action,
      date: args.content.date,
      narration: args.content.narration,
      reference: args.content.reference ?? null,
      reversesId: args.reversesId,
      createdById: args.actorId,
      lines: {
        create: args.content.lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit ?? '0',
          credit: l.credit ?? '0',
          memo: l.memo,
          costCentreId: l.costCentreId,
          accountingHeadId: l.accountingHeadId,
        })),
      },
    },
  })
}

function negate(lines: { accountId: string; debit: unknown; credit: unknown; memo: string | null; costCentreId: string | null; accountingHeadId?: string | null }[]): LineInput[] {
  // Reversal = swap sides. Cost centres and the Accounting Head ride along
  // so their reports cancel too.
  return lines.map((l) => {
    const d = String(l.debit)
    const c = String(l.credit)
    return {
      accountId: l.accountId,
      debit: parsePaise(c) > 0n ? c : undefined,
      credit: parsePaise(d) > 0n ? d : undefined,
      memo: l.memo ?? undefined,
      costCentreId: l.costCentreId ?? undefined,
      accountingHeadId: l.accountingHeadId ?? undefined,
    }
  })
}

async function loadCurrent(tx: Prisma.TransactionClient, docId: string) {
  const doc = await tx.journalDoc.findUniqueOrThrow({
    where: { id: docId },
    include: { currentEntry: { include: { lines: true } } },
  })
  return doc
}

/** Create a new document with its v1 forward entry. */
export async function createJournalDocument(
  tx: Prisma.TransactionClient,
  args: {
    entityId: string
    sourceType: string
    sourceId?: string
    content: EntryContent
    actorId: string
  },
) {
  const doc = await tx.journalDoc.create({
    data: { entityId: args.entityId, sourceType: args.sourceType, sourceId: args.sourceId },
  })
  const entry = await postEntry(tx, {
    entityId: args.entityId,
    docId: doc.id,
    version: 1,
    kind: 'FORWARD',
    action: 'create',
    content: args.content,
    actorId: args.actorId,
  })
  await tx.journalDoc.update({ where: { id: doc.id }, data: { currentEntryId: entry.id } })
  return { doc, entry }
}

/** Edit (spec §5): reversal of the original + post of the new version. */
export async function editJournalDocument(
  tx: Prisma.TransactionClient,
  args: { docId: string; content: EntryContent; actorId: string },
) {
  const doc = await loadCurrent(tx, args.docId)
  const current = doc.currentEntry
  if (!current) throw new PostingError('Record is deleted — undo the delete first')

  // Reversal is dated like the original: blocked if that month is locked.
  await assertPeriodOpen(tx, doc.entityId, current.date)
  await postEntry(tx, {
    entityId: doc.entityId,
    docId: doc.id,
    version: current.version,
    kind: 'REVERSAL',
    action: 'edit',
    reversesId: current.id,
    content: {
      date: current.date,
      narration: `Reversal (edit): ${current.narration}`,
      reference: current.reference,
      lines: negate(current.lines),
    },
    actorId: args.actorId,
  })
  await tx.journalEntry.update({ where: { id: current.id }, data: { state: 'REVERSED' } })

  const maxVersion = await tx.journalEntry.aggregate({
    where: { docId: doc.id, kind: 'FORWARD' },
    _max: { version: true },
  })
  const entry = await postEntry(tx, {
    entityId: doc.entityId,
    docId: doc.id,
    version: (maxVersion._max.version ?? current.version) + 1,
    kind: 'FORWARD',
    action: 'edit',
    content: args.content,
    actorId: args.actorId,
  })
  await tx.journalDoc.update({ where: { id: doc.id }, data: { currentEntryId: entry.id } })
  return entry
}

/** Delete (spec §5): reversal + soft delete. Ledger stays balanced. */
export async function deleteJournalDocument(
  tx: Prisma.TransactionClient,
  args: { docId: string; actorId: string },
) {
  const doc = await loadCurrent(tx, args.docId)
  const current = doc.currentEntry
  if (!current) throw new PostingError('Record is already deleted')

  await assertPeriodOpen(tx, doc.entityId, current.date)
  await postEntry(tx, {
    entityId: doc.entityId,
    docId: doc.id,
    version: current.version,
    kind: 'REVERSAL',
    action: 'delete',
    reversesId: current.id,
    content: {
      date: current.date,
      narration: `Reversal (delete): ${current.narration}`,
      reference: current.reference,
      lines: negate(current.lines),
    },
    actorId: args.actorId,
  })
  await tx.journalEntry.update({ where: { id: current.id }, data: { state: 'REVERSED' } })
  await tx.journalDoc.update({
    where: { id: doc.id },
    data: { currentEntryId: null, deletedAt: new Date(), deletedById: args.actorId },
  })
}

/**
 * Replay a document's history into its logical state: a stack of
 * content-bearing forward entries + whether the record is deleted.
 */
export async function getDocState(tx: Prisma.TransactionClient, docId: string) {
  const entries = await tx.journalEntry.findMany({
    where: { docId },
    include: { lines: true },
    orderBy: [{ createdAt: 'asc' }, { version: 'asc' }],
  })
  const stack: typeof entries = []
  let deleted = false
  for (const entry of entries) {
    if (entry.kind === 'REVERSAL') {
      if (entry.action === 'delete') deleted = true
      continue
    }
    switch (entry.action) {
      case 'create':
      case 'edit':
        stack.push(entry)
        break
      case 'undo_delete':
        deleted = false
        // content duplicates the stack top — no push
        break
      case 'undo_edit':
        stack.pop()
        break
    }
  }
  return { entries, stack, deleted }
}

/** Undo (spec §5): LIFO inverse of the last operation, unlimited depth. */
export async function undoJournalDocument(
  tx: Prisma.TransactionClient,
  args: { docId: string; actorId: string },
) {
  const doc = await loadCurrent(tx, args.docId)
  const { stack, deleted } = await getDocState(tx, args.docId)
  const maxVersion = await tx.journalEntry.aggregate({
    where: { docId: doc.id, kind: 'FORWARD' },
    _max: { version: true },
  })
  const nextVersion = (maxVersion._max.version ?? 0) + 1

  if (deleted) {
    // Restore: re-post the last content as a fresh forward entry.
    const restore = stack[stack.length - 1]
    if (!restore) throw new PostingError('Nothing to restore')
    const entry = await postEntry(tx, {
      entityId: doc.entityId,
      docId: doc.id,
      version: nextVersion,
      kind: 'FORWARD',
      action: 'undo_delete',
      content: {
        date: restore.date,
        narration: restore.narration,
        reference: restore.reference,
        lines: restore.lines.map((l) => ({
          accountId: l.accountId,
          debit: parsePaise(String(l.debit)) > 0n ? String(l.debit) : undefined,
          credit: parsePaise(String(l.credit)) > 0n ? String(l.credit) : undefined,
          memo: l.memo ?? undefined,
          costCentreId: l.costCentreId ?? undefined,
          accountingHeadId: l.accountingHeadId ?? undefined,
        })),
      },
      actorId: args.actorId,
    })
    await tx.journalDoc.update({
      where: { id: doc.id },
      data: { currentEntryId: entry.id, deletedAt: null, deletedById: null },
    })
    return entry
  }

  // Revert the last edit: reverse current, re-post the previous content.
  if (stack.length < 2) throw new PostingError('Nothing to undo')
  const current = doc.currentEntry
  if (!current) throw new PostingError('Record has no current entry')
  const previous = stack[stack.length - 2]

  await assertPeriodOpen(tx, doc.entityId, current.date)
  await postEntry(tx, {
    entityId: doc.entityId,
    docId: doc.id,
    version: current.version,
    kind: 'REVERSAL',
    action: 'undo_edit',
    reversesId: current.id,
    content: {
      date: current.date,
      narration: `Reversal (undo): ${current.narration}`,
      reference: current.reference,
      lines: negate(current.lines),
    },
    actorId: args.actorId,
  })
  await tx.journalEntry.update({ where: { id: current.id }, data: { state: 'REVERSED' } })

  const entry = await postEntry(tx, {
    entityId: doc.entityId,
    docId: doc.id,
    version: nextVersion,
    kind: 'FORWARD',
    action: 'undo_edit',
    content: {
      date: previous.date,
      narration: previous.narration,
      reference: previous.reference,
      lines: previous.lines.map((l) => ({
        accountId: l.accountId,
        debit: parsePaise(String(l.debit)) > 0n ? String(l.debit) : undefined,
        credit: parsePaise(String(l.credit)) > 0n ? String(l.credit) : undefined,
        memo: l.memo ?? undefined,
        // tags travel with the restored version (costCentreId was silently
        // dropped here before — the restore path above always kept it)
        costCentreId: l.costCentreId ?? undefined,
        accountingHeadId: l.accountingHeadId ?? undefined,
      })),
    },
    actorId: args.actorId,
  })
  await tx.journalDoc.update({ where: { id: doc.id }, data: { currentEntryId: entry.id } })
  return entry
}
