import * as XLSX from 'xlsx'
import { createHash } from 'crypto'
import { parsePaise, formatPaise } from '@/lib/ledger/money'

// Statement extraction (spec §3 steps 1–3): any format in → normalized rows
// out. Handles CSV / TSV / TXT / XLSX / XLS with bank-specific layouts via
// header-synonym detection. (PDF/OCR arrives with the Phase 8 AI layer.)

export interface ParsedRow {
  date: Date
  narration: string
  reference?: string
  debit: string // "0.00" when credit side
  credit: string
  balance?: string
}

export interface ParsedStatement {
  rows: ParsedRow[]
  closingBalance?: string
  headerSignature: string
  metaText: string[] // pre-header cells — used for account auto-detection
}

const SYNONYMS = {
  date: ['transaction date', 'txn date', 'value date', 'tran date', 'post date', 'date'],
  narration: ['transaction remarks', 'transaction details', 'narration', 'description', 'particulars', 'remarks', 'details'],
  debit: ['withdrawal amount', 'withdrawal amt', 'withdrawals', 'withdrawal', 'debit amount', 'debit'],
  credit: ['deposit amount', 'deposit amt', 'deposits', 'deposit', 'credit amount', 'credit'],
  amount: ['transaction amount', 'amount'],
  drcr: ['dr / cr', 'dr/cr', 'cr/dr', 'type'],
  balance: ['closing balance', 'available balance', 'running balance', 'balance'],
  reference: ['ref no./cheque no', 'cheque no', 'chq no', 'cheque number', 'ref no', 'reference', 'utr', 'transaction id', 'tran id'],
} as const

function norm(cell: unknown): string {
  return String(cell ?? '').trim().toLowerCase().replace(/[^a-z/ ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function matchSynonym(cell: string, synonyms: readonly string[]): boolean {
  return synonyms.some((s) => cell === s || cell.includes(s))
}

interface ColumnMap {
  date: number
  narration: number
  debit?: number
  credit?: number
  amount?: number
  drcr?: number
  balance?: number
  reference?: number
}

function detectHeader(grid: unknown[][]): { rowIndex: number; cols: ColumnMap } | null {
  let best: { rowIndex: number; cols: ColumnMap; score: number } | null = null
  const limit = Math.min(grid.length, 40)
  for (let i = 0; i < limit; i++) {
    const row = grid[i]
    if (!row || row.length < 3) continue
    const cols: Partial<ColumnMap> = {}
    let score = 0
    row.forEach((cell, index) => {
      const c = norm(cell)
      if (!c) return
      // first match wins per column kind; priority order matters
      if (cols.date === undefined && matchSynonym(c, SYNONYMS.date)) { cols.date = index; score += 2; return }
      if (cols.narration === undefined && matchSynonym(c, SYNONYMS.narration)) { cols.narration = index; score += 2; return }
      if (cols.debit === undefined && matchSynonym(c, SYNONYMS.debit)) { cols.debit = index; score += 2; return }
      if (cols.credit === undefined && matchSynonym(c, SYNONYMS.credit)) { cols.credit = index; score += 2; return }
      if (cols.balance === undefined && matchSynonym(c, SYNONYMS.balance)) { cols.balance = index; score += 1; return }
      if (cols.drcr === undefined && matchSynonym(c, SYNONYMS.drcr)) { cols.drcr = index; score += 1; return }
      if (cols.amount === undefined && matchSynonym(c, SYNONYMS.amount)) { cols.amount = index; score += 1; return }
      if (cols.reference === undefined && matchSynonym(c, SYNONYMS.reference)) { cols.reference = index; score += 1; return }
    })
    const hasAmounts = (cols.debit !== undefined && cols.credit !== undefined) || cols.amount !== undefined
    if (cols.date !== undefined && cols.narration !== undefined && hasAmounts) {
      if (!best || score > best.score) best = { rowIndex: i, cols: cols as ColumnMap, score }
    }
  }
  return best ? { rowIndex: best.rowIndex, cols: best.cols } : null
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

export function parseDateFlexible(value: unknown): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()))
  }
  const s = String(value ?? '').trim()
  if (!s) return null
  // dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy (Indian bank convention: day first)
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/)
  if (m) {
    const [, d, mo, y] = m
    const year = y.length === 2 ? 2000 + Number(y) : Number(y)
    const date = new Date(Date.UTC(year, Number(mo) - 1, Number(d)))
    return isNaN(date.getTime()) ? null : date
  }
  // yyyy-mm-dd
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) {
    const [, y, mo, d] = m
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
    return isNaN(date.getTime()) ? null : date
  }
  // dd MMM yyyy / dd-MMM-yyyy ("05 Jul 2026", "05-Jul-26")
  m = s.match(/^(\d{1,2})[ \-]([A-Za-z]{3,})[ \-](\d{2,4})/)
  if (m) {
    const [, d, mon, y] = m
    const month = MONTHS[mon.slice(0, 3).toLowerCase()]
    if (month === undefined) return null
    const year = y.length === 2 ? 2000 + Number(y) : Number(y)
    const date = new Date(Date.UTC(year, month, Number(d)))
    return isNaN(date.getTime()) ? null : date
  }
  return null
}

/** "1,23,456.78", "₹ 500", "1234.5 Cr", "(200)" → paise (bigint) or null. */
export function parseAmountFlexible(value: unknown): bigint | null {
  let s = String(value ?? '').trim()
  if (!s) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1) }
  s = s.replace(/(dr|cr)\.?$/i, '').replace(/[₹,\s]/g, '').replace(/inr/gi, '')
  if (!s || s === '-') return null
  if (s.startsWith('-')) { negative = true; s = s.slice(1) }
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const rounded = Number(s).toFixed(2) // normalize >2dp
  const paise = parsePaise(rounded)
  return negative ? -paise : paise
}

export function parseStatementFile(fileName: string, buffer: Buffer): ParsedStatement {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.pdf')) {
    throw new Error('PDF statements need the OCR layer (build phase 8) — export CSV/XLSX from netbanking for now')
  }
  // Text formats are read raw: xlsx's own CSV date detection is month-first
  // (US), which silently flips Indian dd/mm dates. Real spreadsheets keep
  // cellDates — Excel date cells are unambiguous serials.
  const isText = /\.(csv|tsv|txt)$/.test(lower)
  const workbook = XLSX.read(
    buffer,
    isText ? { type: 'buffer', raw: true } : { type: 'buffer', cellDates: true },
  )
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: true })

  const header = detectHeader(grid)
  if (!header) {
    throw new Error(
      'Could not find the statement table (need date, narration and amount columns)',
    )
  }
  const { rowIndex, cols } = header

  const metaText: string[] = []
  for (let i = 0; i < rowIndex; i++) {
    for (const cell of grid[i] ?? []) {
      const s = String(cell ?? '').trim()
      if (s) metaText.push(s)
    }
  }

  const headerSignature = createHash('sha256')
    .update((grid[rowIndex] ?? []).map(norm).filter(Boolean).join('|'))
    .digest('hex')

  const rows: ParsedRow[] = []
  for (let i = rowIndex + 1; i < grid.length; i++) {
    const row = grid[i]
    if (!row) continue
    const narration = String(row[cols.narration] ?? '').trim()
    const date = parseDateFlexible(row[cols.date])
    if (!date) {
      // footer rows ("Closing Balance", "Total", blanks) end the table
      if (/closing balance|opening balance|total|statement/i.test(narration)) continue
      continue
    }
    if (!narration) continue

    let debit = 0n
    let credit = 0n
    if (cols.debit !== undefined && cols.credit !== undefined) {
      debit = parseAmountFlexible(row[cols.debit]) ?? 0n
      credit = parseAmountFlexible(row[cols.credit]) ?? 0n
      if (debit < 0n) debit = -debit
      if (credit < 0n) credit = -credit
    } else if (cols.amount !== undefined) {
      const amount = parseAmountFlexible(row[cols.amount])
      if (amount === null) continue
      const marker = cols.drcr !== undefined ? String(row[cols.drcr] ?? '').trim().toLowerCase() : ''
      const isDebit = marker
        ? /^(dr|d|debit|withdrawal)/.test(marker)
        : amount < 0n // signed single-column convention: negative = outflow
      const abs = amount < 0n ? -amount : amount
      if (isDebit) debit = abs
      else credit = abs
    }
    if (debit === 0n && credit === 0n) continue
    if (debit > 0n && credit > 0n) continue // malformed row

    const balancePaise =
      cols.balance !== undefined ? parseAmountFlexible(row[cols.balance]) : null

    rows.push({
      date,
      narration,
      reference:
        cols.reference !== undefined
          ? String(row[cols.reference] ?? '').trim() || undefined
          : undefined,
      debit: formatPaise(debit),
      credit: formatPaise(credit),
      balance: balancePaise !== null ? formatPaise(balancePaise) : undefined,
    })
  }

  // Statement closing balance = the last row's running balance (rows may be
  // newest-first or oldest-first; take the chronologically-last row's value).
  let closingBalance: string | undefined
  const withBalance = rows.filter((r) => r.balance !== undefined)
  if (withBalance.length > 0) {
    const last = withBalance.reduce((a, b) => (b.date >= a.date ? b : a))
    closingBalance = last.balance
  }

  return { rows, closingBalance, headerSignature, metaText }
}

/** Spec §3 step 3: hash of (account + date + amount + narration) + occurrence. */
export function dedupeHash(
  bankAccountId: string,
  row: ParsedRow,
  occurrence: number,
): string {
  return createHash('sha256')
    .update(
      [
        bankAccountId,
        row.date.toISOString().slice(0, 10),
        row.debit,
        row.credit,
        row.narration.toUpperCase().replace(/\s+/g, ' ').trim(),
        String(occurrence),
      ].join('|'),
    )
    .digest('hex')
}

export interface DetectableAccount {
  id: string
  accountNumber: string
  ifsc: string
  bankName: string
  nickname: string
}

/**
 * Spec §3 step 2: scan metadata for account number / IFSC / bank name and
 * route to the right account. Masked numbers (XXXX7838) match on trailing
 * digits.
 */
export function detectBankAccount(
  metaText: string[],
  accounts: DetectableAccount[],
): { account: DetectableAccount; via: string } | null {
  const blob = metaText.join(' ').toUpperCase().replace(/[\s-]+/g, '')

  // 1. Full account number present
  for (const account of accounts) {
    const number = account.accountNumber.replace(/\s+/g, '')
    if (number.length >= 6 && blob.includes(number)) {
      return { account, via: 'account_number' }
    }
  }
  // 2. Masked account number: X/*/• prefix + trailing digits (≥4)
  const maskedMatches = [...blob.matchAll(/[X*•]{2,}(\d{4,})/g)].map((m) => m[1])
  for (const tail of maskedMatches) {
    const hits = accounts.filter((a) => a.accountNumber.endsWith(tail))
    if (hits.length === 1) return { account: hits[0], via: 'account_number' }
  }
  // 3. IFSC (only if it maps to exactly one account)
  for (const account of accounts) {
    if (account.ifsc && blob.includes(account.ifsc.toUpperCase())) {
      const sameIfsc = accounts.filter((a) => a.ifsc === account.ifsc)
      if (sameIfsc.length === 1) return { account, via: 'ifsc' }
    }
  }
  return null
}
