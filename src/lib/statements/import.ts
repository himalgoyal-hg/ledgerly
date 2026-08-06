import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import {
  parseStatementFile,
  dedupeHash,
  detectBankAccount,
  type ParsedRow,
  type ParsedStatement,
} from './parse'
import { partyToken } from './rules'

// Import service (spec §3 steps 1–4): a parsed file becomes a StatementImport
// (DETECTED, awaiting the confirmation banner), then confirmation materializes
// StatementTransactions — deduped against everything ever imported, auto-tagged
// where a rule matches, queued for tagging otherwise.

export class ImportError extends Error {}

export interface DetectionResult {
  bankAccountId: string | null
  entityId: string | null
  via: 'account_number' | 'ifsc' | 'mapping' | 'unrecognized'
}

/** Spec §3 step 2: metadata scan first, then the remembered layout mapping. */
export async function detectAccountForStatement(
  tx: Prisma.TransactionClient,
  parsed: ParsedStatement,
): Promise<DetectionResult> {
  const accounts = await tx.bankAccount.findMany({
    where: { archivedAt: null },
    select: { id: true, entityId: true, accountNumber: true, ifsc: true, bankName: true, nickname: true },
  })
  const hit = detectBankAccount(parsed.metaText, accounts)
  if (hit) {
    const account = accounts.find((a) => a.id === hit.account.id)!
    return {
      bankAccountId: account.id,
      entityId: account.entityId,
      via: hit.via as 'account_number' | 'ifsc',
    }
  }
  const mapping = await tx.statementMapping.findUnique({
    where: { signature: parsed.headerSignature },
  })
  if (mapping) {
    const account = accounts.find((a) => a.id === mapping.bankAccountId)
    if (account) return { bankAccountId: account.id, entityId: account.entityId, via: 'mapping' }
  }
  return { bankAccountId: null, entityId: null, via: 'unrecognized' }
}

/** Parse the uploaded file (throws ImportError with a user-facing message). */
export function parseUpload(fileName: string, buffer: Buffer): ParsedStatement {
  let parsed: ParsedStatement
  try {
    parsed = parseStatementFile(fileName, buffer)
  } catch (e) {
    throw new ImportError(`${fileName}: ${e instanceof Error ? e.message : 'could not parse'}`)
  }
  if (parsed.rows.length === 0) {
    throw new ImportError(`${fileName}: no transaction rows found`)
  }
  return parsed
}

export interface UploadParse {
  parsed: ParsedStatement
  via: 'heuristic' | 'ai'
}

/**
 * Parse any supported upload. Spreadsheet formats go through the column
 * detector; PDFs (text or scanned) go to the AI layer (Phase 8), which
 * returns the same normalized rows.
 */
export async function parseAnyUpload(fileName: string, buffer: Buffer): Promise<UploadParse> {
  if (!/\.pdf$/i.test(fileName)) {
    return { parsed: parseUpload(fileName, buffer), via: 'heuristic' }
  }
  const { aiConfigured, AI_UNCONFIGURED_MESSAGE, AiError } = await import('@/lib/ai/client')
  if (!aiConfigured()) throw new ImportError(`${fileName}: ${AI_UNCONFIGURED_MESSAGE}`)
  const { extractStatementFromPdf } = await import('@/lib/ai/extract')
  try {
    return { parsed: await extractStatementFromPdf(fileName, buffer), via: 'ai' }
  } catch (e) {
    if (e instanceof AiError) throw new ImportError(`${fileName}: ${e.message}`)
    throw e
  }
}

/** Step 2: store the parsed file as a DETECTED import — never silent. */
export async function createStatementImport(
  tx: Prisma.TransactionClient,
  args: {
    fileName: string
    parsed: ParsedStatement
    actorId: string
    parsedVia?: 'heuristic' | 'ai'
  },
) {
  const detection = await detectAccountForStatement(tx, args.parsed)
  const record = await tx.statementImport.create({
    data: {
      fileName: args.fileName,
      bankAccountId: detection.bankAccountId,
      entityId: detection.entityId,
      detectedVia: detection.via,
      // Dates serialize to ISO strings; reviveRows brings them back.
      rawRows: JSON.parse(JSON.stringify(args.parsed.rows)) as Prisma.InputJsonValue,
      headerSignature: args.parsed.headerSignature,
      closingBalance: args.parsed.closingBalance,
      rowsTotal: args.parsed.rows.length,
      parsedVia: args.parsedVia ?? 'heuristic',
      uploadedById: args.actorId,
    },
  })
  return { record, detection }
}

function reviveRows(rawRows: Prisma.JsonValue): ParsedRow[] {
  return (rawRows as { date: string; narration: string; reference?: string; debit: string; credit: string; balance?: string }[]).map(
    (r) => ({ ...r, date: new Date(r.date) }),
  )
}

/**
 * Steps 3–4: confirm the (possibly corrected) account and materialize rows.
 * Already-imported rows are skipped and counted as "previously imported";
 * rows a rule recognizes are auto-tagged "Verified by System"; the rest join
 * the pending tagging queue.
 */
export async function confirmStatementImport(
  tx: Prisma.TransactionClient,
  args: {
    importId: string
    bankAccountId: string
    actorId: string
    /** Remember this layout → account (unrecognized statements, Admin only). */
    rememberMapping?: boolean
  },
) {
  const imp = await tx.statementImport.findUniqueOrThrow({ where: { id: args.importId } })
  if (imp.status !== 'DETECTED') throw new ImportError('Import is already confirmed')
  const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: args.bankAccountId } })
  if (bank.archivedAt) throw new ImportError('That bank account is archived')

  const rows = reviveRows(imp.rawRows)

  // Occurrence-aware hashes: the same (date, amount, narration) twice in one
  // file is two real transactions; across files it's a duplicate.
  const seen = new Map<string, number>()
  const hashed = rows.map((row) => {
    const key = [row.date.toISOString().slice(0, 10), row.debit, row.credit, row.narration.toUpperCase().replace(/\s+/g, ' ').trim()].join('|')
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)
    return { row, hash: dedupeHash(bank.id, row, occurrence) }
  })

  const existing = await tx.statementTransaction.findMany({
    where: { bankAccountId: bank.id, dedupeHash: { in: hashed.map((h) => h.hash) } },
    select: { dedupeHash: true },
  })
  const existingHashes = new Set(existing.map((e) => e.dedupeHash))
  const fresh = hashed.filter((h) => !existingHashes.has(h.hash))

  // Rules engine (step 4), bulk: one query for every party token in the file.
  const tokens = [...new Set(fresh.map((h) => partyToken(h.row.narration)).filter((t): t is string => t !== null))]
  const rules = tokens.length
    ? await tx.tagRule.findMany({ where: { entityId: bank.entityId, pattern: { in: tokens } } })
    : []
  const ruleByToken = new Map(rules.map((r) => [r.pattern, r]))

  let autoTagged = 0
  const ruleHits = new Map<string, number>()
  for (const { row, hash } of fresh) {
    const token = partyToken(row.narration)
    const rule = token ? ruleByToken.get(token) : undefined
    if (rule) {
      autoTagged++
      ruleHits.set(rule.id, (ruleHits.get(rule.id) ?? 0) + 1)
    }
    await tx.statementTransaction.create({
      data: {
        importId: imp.id,
        bankAccountId: bank.id,
        entityId: bank.entityId,
        date: row.date,
        narration: row.narration,
        reference: row.reference,
        debit: row.debit,
        credit: row.credit,
        balance: row.balance,
        dedupeHash: hash,
        status: rule ? 'TAGGED' : 'PENDING',
        headAccountId: rule?.headAccountId,
        nature: rule?.nature,
        costCentreId: rule?.costCentreId,
        autoTagged: Boolean(rule), // "Verified by System"
        taggedAt: rule ? new Date() : undefined,
      },
    })
  }
  for (const [ruleId, hits] of ruleHits) {
    await tx.tagRule.update({ where: { id: ruleId }, data: { hits: { increment: hits } } })
  }

  await tx.statementImport.update({
    where: { id: imp.id },
    data: {
      bankAccountId: bank.id,
      entityId: bank.entityId,
      status: 'CONFIRMED',
      detectedVia: imp.bankAccountId === bank.id ? imp.detectedVia : 'manual',
      rowsTotal: rows.length,
      rowsDuplicate: rows.length - fresh.length,
    },
  })

  if (args.rememberMapping) {
    await tx.statementMapping.upsert({
      where: { signature: imp.headerSignature },
      create: { signature: imp.headerSignature, bankAccountId: bank.id, createdById: args.actorId },
      update: { bankAccountId: bank.id, createdById: args.actorId },
    })
  }

  return { created: fresh.length, duplicates: rows.length - fresh.length, autoTagged }
}

export interface BalanceCheck {
  expected: string // statement closing balance
  actual: string // ledger balance of the bank account as of the last row date
  difference: string // expected − actual
  matched: boolean
}

/**
 * Spec §3 step 3 closing-balance validation: the statement's closing balance
 * must equal the ledger balance once every row is posted. Until then the
 * import is "held open" with the difference shown.
 */
export async function importBalanceCheck(imp: {
  closingBalance: Prisma.Decimal | null
  bankAccountId: string | null
  rawRows: Prisma.JsonValue
}): Promise<BalanceCheck | null> {
  if (imp.closingBalance === null || !imp.bankAccountId) return null
  const bank = await prisma.bankAccount.findUnique({ where: { id: imp.bankAccountId } })
  if (!bank?.ledgerAccountId) return null
  const asOf = reviveRows(imp.rawRows).reduce<Date | null>(
    (max, r) => (max === null || r.date > max ? r.date : max),
    null,
  )
  if (!asOf) return null
  const rows = await prisma.$queryRaw<{ balance: string | null }[]>`
    SELECT (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0))::text as balance
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE l."accountId" = ${bank.ledgerAccountId}
      AND e.date <= ${asOf}::date
  `
  const actual = new Prisma.Decimal(rows[0]?.balance ?? 0)
  const expected = new Prisma.Decimal(imp.closingBalance)
  return {
    expected: expected.toFixed(2),
    actual: actual.toFixed(2),
    difference: expected.minus(actual).toFixed(2),
    matched: expected.equals(actual),
  }
}
