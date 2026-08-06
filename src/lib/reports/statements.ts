import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { COA } from '@/lib/ledger/coa'

// Financial statements (spec §10) — all live queries over the append-only
// journal, so reversal pairs cancel and the statements agree with the trial
// balance by construction. Nothing is stored or cached.

export interface DateRange {
  from?: Date
  to?: Date
}

export interface StatementLine {
  accountId: string
  code: string
  name: string
  group: string // immediate parent group, for sectioning
  amount: string // signed on the account's normal side (always ≥ 0 in practice)
}

export interface StatementSection {
  title: string
  lines: StatementLine[]
  total: string
}

interface RawBalance {
  accountId: string
  code: string
  name: string
  kind: string
  parentId: string | null
  debit: string
  credit: string
}

/** Per-account movement in a range, with tree metadata. Leaf accounts only. */
async function accountMovements(entityId: string, range: DateRange): Promise<RawBalance[]> {
  const rows = await prisma.$queryRaw<
    { accountId: string; code: string; name: string; kind: string; parentId: string | null; debit: string | null; credit: string | null }[]
  >`
    SELECT a.id as "accountId", a.code, a.name, a.kind::text as kind, a."parentId",
           SUM(l.debit)::text as debit, SUM(l.credit)::text as credit
    FROM "LedgerAccount" a
    JOIN "JournalLine" l ON l."accountId" = a.id
    JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE a."entityId" = ${entityId} AND a."isGroup" = false
      AND (${range.from ?? null}::date IS NULL OR e.date >= ${range.from ?? null}::date)
      AND (${range.to ?? null}::date IS NULL OR e.date <= ${range.to ?? null}::date)
    GROUP BY a.id, a.code, a.name, a.kind, a."parentId"
    ORDER BY a.code
  `
  return rows.map((r) => ({ ...r, debit: r.debit ?? '0', credit: r.credit ?? '0' }))
}

async function groupNames(entityId: string): Promise<Map<string, string>> {
  const groups = await prisma.ledgerAccount.findMany({
    where: { entityId, isGroup: true },
    select: { id: true, name: true },
  })
  return new Map(groups.map((g) => [g.id, g.name]))
}

function section(
  title: string,
  rows: RawBalance[],
  groups: Map<string, string>,
  normal: 'debit' | 'credit',
): StatementSection {
  const lines: StatementLine[] = []
  let total = new Prisma.Decimal(0)
  for (const row of rows) {
    const debit = new Prisma.Decimal(row.debit)
    const credit = new Prisma.Decimal(row.credit)
    const amount = normal === 'debit' ? debit.minus(credit) : credit.minus(debit)
    if (amount.isZero()) continue // fully reversed — not a real line
    total = total.plus(amount)
    lines.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      group: (row.parentId && groups.get(row.parentId)) || title,
      amount: amount.toFixed(2),
    })
  }
  return { title, lines, total: total.toFixed(2) }
}

export interface ProfitAndLoss {
  income: StatementSection
  expenses: StatementSection
  netProfit: string
}

/** P&L for a period (spec §10). Income − Expenses. */
export async function profitAndLoss(entityId: string, range: DateRange): Promise<ProfitAndLoss> {
  const [rows, groups] = await Promise.all([accountMovements(entityId, range), groupNames(entityId)])
  const income = section('Income', rows.filter((r) => r.kind === 'INCOME'), groups, 'credit')
  const expenses = section('Expenses', rows.filter((r) => r.kind === 'EXPENSE'), groups, 'debit')
  return {
    income,
    expenses,
    netProfit: new Prisma.Decimal(income.total).minus(expenses.total).toFixed(2),
  }
}

export interface BalanceSheet {
  assets: StatementSection
  liabilities: StatementSection
  equity: StatementSection
  /** Cumulative P&L to date — the books are never closed to reserves. */
  retainedEarnings: string
  assetsTotal: string
  liabilitiesEquityTotal: string
  balances: boolean
}

/**
 * Balance Sheet as at a date (spec §10). Since the ledger is never closed
 * into reserves, cumulative profit shows as its own equity line — which is
 * exactly what makes Assets = Liabilities + Equity hold.
 */
export async function balanceSheet(entityId: string, asOf?: Date): Promise<BalanceSheet> {
  const range: DateRange = { to: asOf }
  const [rows, groups] = await Promise.all([accountMovements(entityId, range), groupNames(entityId)])
  const assets = section('Assets', rows.filter((r) => r.kind === 'ASSET'), groups, 'debit')
  const liabilities = section('Liabilities', rows.filter((r) => r.kind === 'LIABILITY'), groups, 'credit')
  const equity = section('Equity', rows.filter((r) => r.kind === 'EQUITY'), groups, 'credit')

  const income = section('Income', rows.filter((r) => r.kind === 'INCOME'), groups, 'credit')
  const expenses = section('Expenses', rows.filter((r) => r.kind === 'EXPENSE'), groups, 'debit')
  const retained = new Prisma.Decimal(income.total).minus(expenses.total)

  const assetsTotal = new Prisma.Decimal(assets.total)
  const liabEquity = new Prisma.Decimal(liabilities.total).plus(equity.total).plus(retained)
  return {
    assets,
    liabilities,
    equity,
    retainedEarnings: retained.toFixed(2),
    assetsTotal: assetsTotal.toFixed(2),
    liabilitiesEquityTotal: liabEquity.toFixed(2),
    balances: assetsTotal.equals(liabEquity),
  }
}

export interface CashFlowLine {
  accountId: string
  code: string
  name: string
  amount: string // positive = cash in
}

export interface CashFlow {
  opening: string
  closing: string
  netMovement: string
  operating: { lines: CashFlowLine[]; total: string }
  investing: { lines: CashFlowLine[]; total: string }
  financing: { lines: CashFlowLine[]; total: string }
  reconciles: boolean
}

/** Leaf bank + cash-location accounts — the "cash" set. */
async function cashAccountIds(entityId: string): Promise<string[]> {
  const groups = await prisma.ledgerAccount.findMany({
    where: { entityId, code: { in: [COA.BANK_GROUP, COA.CASH_GROUP] } },
    select: { id: true },
  })
  if (groups.length === 0) return []
  const leaves = await prisma.ledgerAccount.findMany({
    where: { entityId, isGroup: false, parentId: { in: groups.map((g) => g.id) } },
    select: { id: true },
  })
  return leaves.map((l) => l.id)
}

async function cashBalanceAt(accountIds: string[], to?: Date): Promise<Prisma.Decimal> {
  if (accountIds.length === 0) return new Prisma.Decimal(0)
  const rows = await prisma.$queryRaw<{ total: string | null }[]>`
    SELECT (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0))::text as total
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE l."accountId" IN (${Prisma.join(accountIds)})
      AND (${to ?? null}::date IS NULL OR e.date <= ${to ?? null}::date)
  `
  return new Prisma.Decimal(rows[0]?.total ?? 0)
}

/**
 * Cash Flow for a period (spec §10), direct method. Every entry touching a
 * cash account contributes its non-cash lines: Cr − Dr on those lines is
 * exactly the cash that came in. Transfers between own cash accounts have no
 * non-cash line, so they self-eliminate. Classified by counter-account:
 * fixed assets → investing, equity/loans → financing, everything else →
 * operating (including working-capital movements).
 */
export async function cashFlow(entityId: string, range: DateRange): Promise<CashFlow> {
  const cashIds = await cashAccountIds(entityId)
  if (cashIds.length === 0) {
    const zero = { lines: [], total: '0.00' }
    return {
      opening: '0.00', closing: '0.00', netMovement: '0.00',
      operating: zero, investing: zero, financing: zero, reconciles: true,
    }
  }

  const rows = await prisma.$queryRaw<
    { accountId: string; code: string; name: string; kind: string; inflow: string | null }[]
  >`
    WITH cash_entries AS (
      SELECT DISTINCT e.id
      FROM "JournalEntry" e
      JOIN "JournalLine" l ON l."entryId" = e.id
      WHERE e."entityId" = ${entityId}
        AND l."accountId" IN (${Prisma.join(cashIds)})
        AND (${range.from ?? null}::date IS NULL OR e.date >= ${range.from ?? null}::date)
        AND (${range.to ?? null}::date IS NULL OR e.date <= ${range.to ?? null}::date)
    )
    SELECT a.id as "accountId", a.code, a.name, a.kind::text as kind,
           (COALESCE(SUM(l.credit), 0) - COALESCE(SUM(l.debit), 0))::text as inflow
    FROM "JournalLine" l
    JOIN "LedgerAccount" a ON a.id = l."accountId"
    WHERE l."entryId" IN (SELECT id FROM cash_entries)
      AND l."accountId" NOT IN (${Prisma.join(cashIds)})
    GROUP BY a.id, a.code, a.name, a.kind
    ORDER BY a.code
  `

  const buckets = {
    operating: [] as CashFlowLine[],
    investing: [] as CashFlowLine[],
    financing: [] as CashFlowLine[],
  }
  const totals = {
    operating: new Prisma.Decimal(0),
    investing: new Prisma.Decimal(0),
    financing: new Prisma.Decimal(0),
  }
  for (const row of rows) {
    const amount = new Prisma.Decimal(row.inflow ?? 0)
    if (amount.isZero()) continue
    const bucket: keyof typeof buckets = row.code.startsWith('19')
      ? 'investing'
      : row.kind === 'EQUITY' || row.code.startsWith('23') || row.code.startsWith('14')
        ? 'financing'
        : 'operating'
    buckets[bucket].push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      amount: amount.toFixed(2),
    })
    totals[bucket] = totals[bucket].plus(amount)
  }

  const openingBefore = range.from
    ? new Date(range.from.getTime() - 86_400_000)
    : undefined
  const opening = range.from ? await cashBalanceAt(cashIds, openingBefore) : new Prisma.Decimal(0)
  const closing = await cashBalanceAt(cashIds, range.to)
  const net = totals.operating.plus(totals.investing).plus(totals.financing)

  return {
    opening: opening.toFixed(2),
    closing: closing.toFixed(2),
    netMovement: net.toFixed(2),
    operating: { lines: buckets.operating, total: totals.operating.toFixed(2) },
    investing: { lines: buckets.investing, total: totals.investing.toFixed(2) },
    financing: { lines: buckets.financing, total: totals.financing.toFixed(2) },
    // The statement proves itself: opening + movements = closing.
    reconciles: opening.plus(net).equals(closing),
  }
}
