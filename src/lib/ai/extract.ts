import { createHash } from 'crypto'
import { z } from 'zod'
import { parseAmountFlexible, parseDateFlexible, type ParsedStatement, type ParsedRow } from '@/lib/statements/parse'
import { formatPaise } from '@/lib/ledger/money'
import { runStructured, AiError } from './client'

// PDF and scanned statement extraction (spec §12.8). Claude reads the
// document natively — text PDFs and scans both — and returns the same
// normalized rows the CSV/XLSX parser produces, so everything downstream
// (dedupe, auto-verify, tagging, posting) is unchanged.
//
// The extraction is still *proposed*, not trusted: it lands as a DETECTED
// import that a human confirms, and the closing-balance check in §3 step 3
// catches a misread the same way it catches a bad CSV.

const ROW_SCHEMA = {
  type: 'object',
  properties: {
    accountNumber: {
      type: ['string', 'null'],
      description: 'Account number exactly as printed, including any masking (e.g. "XXXX7838").',
    },
    ifsc: { type: ['string', 'null'], description: 'IFSC code if printed.' },
    bankName: { type: ['string', 'null'] },
    closingBalance: {
      type: ['string', 'null'],
      description: 'Closing balance as printed, digits and decimal point only.',
    },
    rows: {
      type: 'array',
      description: 'Every transaction row, in the order printed.',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Transaction date exactly as printed.' },
          narration: { type: 'string', description: 'Full narration / particulars text.' },
          reference: { type: ['string', 'null'], description: 'Cheque or reference number if present.' },
          debit: { type: ['string', 'null'], description: 'Withdrawal amount, digits only, or null.' },
          credit: { type: ['string', 'null'], description: 'Deposit amount, digits only, or null.' },
          balance: { type: ['string', 'null'], description: 'Running balance if printed.' },
        },
        required: ['date', 'narration', 'reference', 'debit', 'credit', 'balance'],
        additionalProperties: false,
      },
    },
  },
  required: ['accountNumber', 'ifsc', 'bankName', 'closingBalance', 'rows'],
  additionalProperties: false,
} as const

const replySchema = z.object({
  accountNumber: z.string().nullable(),
  ifsc: z.string().nullable(),
  bankName: z.string().nullable(),
  closingBalance: z.string().nullable(),
  rows: z.array(
    z.object({
      date: z.string(),
      narration: z.string(),
      reference: z.string().nullable(),
      debit: z.string().nullable(),
      credit: z.string().nullable(),
      balance: z.string().nullable(),
    }),
  ),
})

const SYSTEM = `You transcribe Indian bank statements into structured rows.

Transcribe only what is printed. Never infer, correct, complete, or invent a
value: if a field is not legible or not present, return null for it. Do not
skip rows, reorder them, or merge them. Do not include opening-balance,
closing-balance, carried-forward, subtotal, or page-header lines among the
transaction rows — those are not transactions.

Amounts: digits and a decimal point only, no currency symbols, no thousands
separators, no Dr/Cr suffix. Put a withdrawal in "debit" and a deposit in
"credit" — exactly one of the two per row, the other null. If the statement
uses a single amount column with a Dr/Cr marker, resolve it to the correct
side. Dates: copy the printed form exactly; do not reformat.

Accuracy matters more than completeness: a row you return wrong is worse than
a row you flag by returning null fields.`

const PROMPT = `Transcribe every transaction row from this bank statement, plus the account
metadata printed on it (account number as shown including masking, IFSC, bank
name, and the closing balance).`

export interface AiExtraction extends ParsedStatement {
  /** Account hints Claude read off the statement, fed into detection. */
  detectedAccountNumber: string | null
  detectedIfsc: string | null
}

export type AiRawRow = z.infer<typeof replySchema>['rows'][number]

/**
 * Normalize one AI row into the shape the rest of the pipeline expects.
 * Returns null for anything unusable — a dropped row is recoverable (the
 * closing-balance check will flag the gap), a wrong one is not.
 */
export function normalizeAiRow(row: AiRawRow): ParsedRow | null {
  const date = parseDateFlexible(row.date)
  const narration = row.narration.trim()
  if (!date || !narration) return null

  let debit = row.debit ? (parseAmountFlexible(row.debit) ?? 0n) : 0n
  let credit = row.credit ? (parseAmountFlexible(row.credit) ?? 0n) : 0n
  if (debit < 0n) debit = -debit
  if (credit < 0n) credit = -credit
  // Exactly one side must carry the amount — anything else is a misread row.
  if ((debit === 0n) === (credit === 0n)) return null

  const balance = row.balance ? parseAmountFlexible(row.balance) : null
  return {
    date,
    narration,
    reference: row.reference?.trim() || undefined,
    debit: formatPaise(debit),
    credit: formatPaise(credit),
    balance: balance !== null ? formatPaise(balance) : undefined,
  }
}

/**
 * Read a PDF (text or scanned) into normalized statement rows. Streams the
 * reply because statement PDFs are long inputs.
 */
export async function extractStatementFromPdf(
  fileName: string,
  buffer: Buffer,
): Promise<AiExtraction> {
  // The API caps a request at 32MB; base64 inflates by ~4/3.
  if (buffer.byteLength > 20 * 1024 * 1024) {
    throw new AiError(
      `${fileName} is ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB — too large to read. Split it into smaller files.`,
    )
  }

  const reply = await runStructured({
    kind: 'statement_pdf',
    system: SYSTEM,
    prompt: PROMPT,
    document: { base64: buffer.toString('base64'), mediaType: 'application/pdf' },
    schema: ROW_SCHEMA,
    validate: (value) => replySchema.parse(value),
    maxTokens: 32000,
    stream: true,
  })

  const rows = reply.rows.map(normalizeAiRow).filter((r): r is ParsedRow => r !== null)
  if (rows.length === 0) {
    throw new AiError(
      `No usable transaction rows were read from ${fileName}. If it is a scan, a clearer copy may work; otherwise export CSV from netbanking.`,
    )
  }

  // Metadata goes into metaText so the existing account detection (account
  // number, masked tail, IFSC) works unchanged on AI-parsed statements.
  const metaText = [reply.accountNumber, reply.ifsc, reply.bankName]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map((v) => v.trim())

  const closing = reply.closingBalance ? parseAmountFlexible(reply.closingBalance) : null
  const fallbackClosing = (() => {
    const withBalance = rows.filter((r) => r.balance !== undefined)
    if (withBalance.length === 0) return undefined
    return withBalance.reduce((a, b) => (b.date >= a.date ? b : a)).balance
  })()

  return {
    rows,
    closingBalance: closing !== null ? formatPaise(closing) : fallbackClosing,
    // Signature keyed on the layout Claude saw, so a remembered mapping for
    // one bank's PDF layout applies to the next statement from that bank.
    headerSignature: createHash('sha256')
      .update(`ai:${reply.bankName ?? ''}:${(reply.accountNumber ?? '').replace(/\d/g, '#')}`)
      .digest('hex'),
    metaText,
    detectedAccountNumber: reply.accountNumber,
    detectedIfsc: reply.ifsc,
  }
}
