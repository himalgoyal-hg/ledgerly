'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission, hasPermission, isAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { deleteJournalDocument } from '@/lib/ledger/posting'
import {
  parseAnyUpload,
  createStatementImport,
  confirmStatementImport,
  ImportError,
} from '@/lib/statements/import'

// Statement upload & import (spec §3 steps 1–3). Permission-gated server-side:
// "Statement upload & import" flag; mapping an unrecognized layout is Admin.

export async function uploadStatements(formData: FormData) {
  const user = await requirePermission('statementUpload')
  const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0)
  if (files.length === 0) throw new Error('Choose at least one statement file')

  const failures: string[] = []
  for (const file of files) {
    let upload
    try {
      upload = await parseAnyUpload(file.name, Buffer.from(await file.arrayBuffer()))
    } catch (e) {
      failures.push(e instanceof ImportError ? e.message : `${file.name}: could not parse`)
      continue
    }
    const { parsed, via } = upload
    await auditedTransaction(async (tx) => {
      const { record, detection } = await createStatementImport(tx, {
        fileName: file.name,
        parsed,
        parsedVia: via,
        actorId: user.id,
      })
      await audit(tx, {
        actorId: user.id,
        action: 'statement.upload',
        targetType: 'StatementImport',
        targetId: record.id,
        summary: `Uploaded ${file.name} (${parsed.rows.length} rows, read by ${
          via === 'ai' ? 'AI' : 'column detection'
        }, detected via ${detection.via})`,
      })
    })
  }
  revalidatePath('/statements')
  if (failures.length > 0) throw new Error(failures.join(' · '))
}

/** Confirmation banner (step 2): ✓ Correct, or Change to the right account. */
export async function confirmImport(formData: FormData) {
  const user = await requirePermission('statementUpload')
  const importId = String(formData.get('importId') ?? '')
  const bankAccountId = String(formData.get('bankAccountId') ?? '')
  if (!bankAccountId) throw new Error('Pick a bank account')

  await auditedTransaction(async (tx) => {
    const imp = await tx.statementImport.findUniqueOrThrow({ where: { id: importId } })
    // Unrecognized statements: Admin maps once, the mapping is remembered.
    const unrecognized = imp.detectedVia === 'unrecognized'
    if (unrecognized && !isAdmin(user)) {
      throw new Error('Unrecognized statement — ask the Admin to map it to an account')
    }
    const result = await confirmStatementImport(tx, {
      importId,
      bankAccountId,
      actorId: user.id,
      rememberMapping: unrecognized,
    })
    await audit(tx, {
      actorId: user.id,
      action: unrecognized ? 'statement.map' : 'statement.confirm',
      targetType: 'StatementImport',
      targetId: importId,
      summary: `Confirmed ${imp.fileName}: ${result.created} new (${result.autoTagged} auto-tagged), ${result.duplicates} previously imported`,
      after: result,
    })
  })
  revalidatePath('/statements')
  revalidatePath('/tagging')
}

/** Throw away a parsed-but-unconfirmed upload (no transactions exist yet). */
export async function discardImport(formData: FormData) {
  const user = await requirePermission('statementUpload')
  const importId = String(formData.get('importId') ?? '')

  await auditedTransaction(async (tx) => {
    const imp = await tx.statementImport.findUniqueOrThrow({ where: { id: importId } })
    if (imp.status !== 'DETECTED') throw new Error('Confirmed imports cannot be discarded')
    if (!isAdmin(user) && imp.uploadedById !== user.id) {
      throw new Error('Only the uploader or Admin can discard this')
    }
    await tx.statementImport.delete({ where: { id: importId } })
    await audit(tx, {
      actorId: user.id,
      action: 'statement.discard',
      targetType: 'StatementImport',
      targetId: importId,
      summary: `Discarded unconfirmed upload ${imp.fileName}`,
    })
  })
  revalidatePath('/statements')
}

/**
 * Delete a CONFIRMED import and everything it brought in. Unposted rows
 * (pending/tagged/duplicate) vanish outright; posted rows are deleted the
 * only way the ledger allows — a reversal, restorable from the recently
 * deleted bin. Removing the rows also forgets their dedupe hashes, so
 * re-uploading the same file starts clean.
 */
export async function deleteImport(formData: FormData) {
  const user = await requirePermission('statementUpload')
  const importId = String(formData.get('importId') ?? '')

  await auditedTransaction(async (tx) => {
    const imp = await tx.statementImport.findUniqueOrThrow({ where: { id: importId } })
    if (imp.status !== 'CONFIRMED') throw new Error('Use Discard for unconfirmed uploads')
    if (!isAdmin(user) && imp.uploadedById !== user.id) {
      throw new Error('Only the uploader or Admin can delete this import')
    }

    const txns = await tx.statementTransaction.findMany({ where: { importId } })
    const posted = txns.filter((t) => t.status === 'POSTED' && t.docId)
    if (posted.length > 0 && !isAdmin(user) && !hasPermission(user, 'transactionEditDelete')) {
      throw new Error(
        `${posted.length} row(s) are already posted to the ledger — deleting them needs the edit/delete permission`,
      )
    }

    // Posted rows first: each reversal keeps Dr = Cr and stays undoable.
    // A period lock on any month will refuse here and roll the whole
    // delete back — that is the lock doing its job.
    for (const txn of posted) {
      await deleteJournalDocument(tx, { docId: txn.docId!, actorId: user.id })
    }

    await tx.statementTransaction.deleteMany({ where: { importId } })
    await tx.statementImport.delete({ where: { id: importId } })

    await audit(tx, {
      actorId: user.id,
      action: 'statement.delete',
      targetType: 'StatementImport',
      targetId: importId,
      summary:
        `Deleted import ${imp.fileName}: ${txns.length} row(s) removed` +
        (posted.length ? `, ${posted.length} posted row(s) reversed` : ''),
      before: { fileName: imp.fileName, rowsTotal: imp.rowsTotal, posted: posted.length },
    })
  })
  revalidatePath('/statements')
  revalidatePath('/tagging')
  revalidatePath('/')
}
