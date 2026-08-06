'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import {
  createJournalDocument,
  editJournalDocument,
  deleteJournalDocument,
  undoJournalDocument,
  type LineInput,
} from '@/lib/ledger/posting'

// Manual journal entries — Admin-only in Phase 2. (Member-facing flows with
// the "Transaction edit / delete / undo" flag arrive with the Phase 3
// statement pipeline, where members work on tagged transactions.)

const headerSchema = z.object({
  date: z.coerce.date(),
  narration: z.string().trim().min(1, 'Narration is required'),
  reference: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
})

function parseLines(formData: FormData): LineInput[] {
  const accountIds = formData.getAll('accountId').map(String)
  const debits = formData.getAll('debit').map(String)
  const credits = formData.getAll('credit').map(String)
  const memos = formData.getAll('memo').map(String)
  const lines: LineInput[] = []
  for (let i = 0; i < accountIds.length; i++) {
    if (!accountIds[i]) continue // blank template row
    lines.push({
      accountId: accountIds[i],
      debit: debits[i]?.trim() ? debits[i].trim() : undefined,
      credit: credits[i]?.trim() ? credits[i].trim() : undefined,
      memo: memos[i]?.trim() ? memos[i].trim() : undefined,
    })
  }
  return lines
}

export async function createEntry(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const parsed = headerSchema.safeParse({
    date: formData.get('date'),
    narration: formData.get('narration'),
    reference: formData.get('reference') ?? undefined,
  })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)
  const lines = parseLines(formData)

  await auditedTransaction(async (tx) => {
    const { doc } = await createJournalDocument(tx, {
      entityId,
      sourceType: 'manual',
      actorId: admin.id,
      content: { ...parsed.data, lines },
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'journal.create',
      targetType: 'JournalDoc',
      targetId: doc.id,
      summary: `Posted journal entry: ${parsed.data.narration}`,
      after: { date: parsed.data.date.toISOString().slice(0, 10), lines },
    })
  })
  revalidatePath('/journal')
}

export async function editEntry(formData: FormData) {
  const admin = await requireAdmin()
  const docId = String(formData.get('docId') ?? '')
  const parsed = headerSchema.safeParse({
    date: formData.get('date'),
    narration: formData.get('narration'),
    reference: formData.get('reference') ?? undefined,
  })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)
  const lines = parseLines(formData)

  await auditedTransaction(async (tx) => {
    await editJournalDocument(tx, {
      docId,
      actorId: admin.id,
      content: { ...parsed.data, lines },
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'journal.edit',
      targetType: 'JournalDoc',
      targetId: docId,
      summary: `Edited journal entry: ${parsed.data.narration}`,
      after: { date: parsed.data.date.toISOString().slice(0, 10), lines },
    })
  })
  revalidatePath('/journal')
}

export async function deleteEntry(formData: FormData) {
  const admin = await requireAdmin()
  const docId = String(formData.get('docId') ?? '')

  await auditedTransaction(async (tx) => {
    await deleteJournalDocument(tx, { docId, actorId: admin.id })
    await audit(tx, {
      actorId: admin.id,
      action: 'journal.delete',
      targetType: 'JournalDoc',
      targetId: docId,
      summary: 'Deleted journal entry (reversal posted, restorable from bin)',
    })
  })
  revalidatePath('/journal')
}

export async function undoEntry(formData: FormData) {
  const admin = await requireAdmin()
  const docId = String(formData.get('docId') ?? '')

  await auditedTransaction(async (tx) => {
    await undoJournalDocument(tx, { docId, actorId: admin.id })
    await audit(tx, {
      actorId: admin.id,
      action: 'journal.undo',
      targetType: 'JournalDoc',
      targetId: docId,
      summary: 'Undid last operation on journal entry',
    })
  })
  revalidatePath('/journal')
}
