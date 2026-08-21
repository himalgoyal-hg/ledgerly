import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { COA } from '@/lib/ledger/coa'

// Financial statements (spec §10) — all live queries over the append-only
// journal, so reversal pairs cancel and the statements agree with the trial
// balance by construction. Nothing is stored or cached.

export interface DateRange {
  from?: Date
  to?: Date
  /** Only lines posted to this head (Himal, 20 Aug — P&L filters). */
  headAccountId?: string
  /**
   * Only lines whose EFFECTIVE Accounting Head is this one: the line's own
   * pick, else the master register's mapping for the posting head, else the
   * posting head itself — the same ladder Reports → By walks.
   */
  accountingHeadId?: string
  /**
   * 'head' — the ordinary statement. 'ah' — the SAME statement (Himal,
   * 21 Aug: "normal report dakv sagla" — same rows, same figures), with
   * the money that was filed under a different Accounting Head listed
   * first, highlighted, as a memo band: which head it went to and which
   * row it came out of. The rows keep their full figures — nothing is
   * moved out of them — so the two lenses agree line for line.
   */
  lens?: 'head' | 'ah'
  /** Ledger accounts that count as cash. Entries touching one of these are
   *  dropped whole — both legs — so the statement still balances. */
  excludeCashAccounts?: string[]
}

export interface StatementLine {
  accountId: string
  code: string
  name: string
  group: string // immediate parent group, for sectioning
  amount: string // signed on the account's normal side (always ≥ 0 in practice)
  /** Under the Accounting Head lens: some of this row's money is filed
   *  under a different Accounting Head — it appears in the section's
   *  re-pointed band as well. The row's own figure is untouched. */
  changed?: boolean
  /** What this account was brought forward at, on the same side as
   *  `amount` (Himal, 20 Aug: "balance sheet var disla pahije sglyacha
   *  opening balance"). Absent where nothing was entered. */
  opening?: string
}

/**
 * Money filed under an Accounting Head other than the one it posted to —
 * one line per (Accounting Head ← posting head). A memo: it is already
 * inside the posting head's row, so it is shown, not added.
 */
export interface RePointedLine {
  /** The Accounting Head it was filed under. */
  accountId: string
  code: string
  name: string
  /** The head it actually posted to — whose row still carries it. */
  fromAccountId: string
  fromCode: string
  fromName: string
  amount: string
}

export interface StatementSection {
  /** Sum of the section's opening balances, when any were entered. */
  openingTotal?: string
  title: string
  lines: StatementLine[]
  total: string
  /** Under the Accounting Head lens: what was filed elsewhere, shown first. */
  rePointed?: RePointedLine[]
}

interface RawRePointed {
  accountId: string
  code: string
  name: string
  fromAccountId: string
  fromCode: string
  fromName: string
  /** Kind of the head it posted to. */
  kind: string
  /** Kind of the Accounting Head it was filed under. */
  ahKind: string
  debit: string
  credit: string
}

interface RawBalance {
  accountId: string
  code: string
  name: string
  kind: string
  parentId: string | null
  debit: string
  credit: string
  changed?: boolean
}

/** Per-account movement in a range, with tree metadata. Leaf accounts only. */
async function accountMovements(entityId: string, range: DateRange): Promise<RawBalance[]> {
  const rows = await prisma.$queryRaw<
    { accountId: string; code: string; name: string; kind: string; parentId: string | null; debit: string | null; credit: string | null; changed: boolean | null }[]
  >`
    SELECT a.id as "accountId", a.code, a.name, a.kind::text as kind, a."parentId",
           SUM(l.debit)::text as debit, SUM(l.credit)::text as credit,
           -- Only under the Accounting Head lens: is any of this row's
           -- money filed under a different Accounting Head? On the
           -- ordinary statement the mark would only confuse.
           (${range.lens ?? 'head'} = 'ah'
            AND bool_or(COALESCE(l."accountingHeadId", mah.id, a.id) <> a.id)) as changed
    FROM "LedgerAccount" a
    JOIN "JournalLine" l ON l."accountId" = a.id
    JOIN "JournalEntry" e ON e.id = l."entryId"
    LEFT JOIN "HeadMode" hm ON lower(hm.category) = lower(a.name)
    LEFT JOIN LATERAL (
      SELECT x.id FROM "LedgerAccount" x
      WHERE hm."accountingHead" IS NOT NULL AND x."entityId" = a."entityId"
        AND lower(x.name) = lower(hm."accountingHead") AND x."isGroup" = false
      ORDER BY x.code LIMIT 1
    ) mah ON true
    WHERE a."entityId" = ${entityId} AND a."isGroup" = false
      AND (${range.excludeCashAccounts ?? []}::text[] = '{}'::text[] OR NOT EXISTS (
        SELECT 1 FROM "JournalLine" cl
        WHERE cl."entryId" = e.id AND cl."accountId" = ANY(${range.excludeCashAccounts ?? []})
      ))
      AND (${range.from ?? null}::date IS NULL OR e.date >= ${range.from ?? null}::date)
      AND (${range.to ?? null}::date IS NULL OR e.date <= ${range.to ?? null}::date)
      AND (${range.headAccountId ?? null}::text IS NULL OR a.id = ${range.headAccountId ?? null})
      AND (${range.accountingHeadId ?? null}::text IS NULL
           OR COALESCE(l."accountingHeadId", mah.id, a.id) = ${range.accountingHeadId ?? null})
    GROUP BY a.id, a.code, a.name, a.kind, a."parentId"
    ORDER BY a.code
  `
  return rows.map((r) => ({ ...r, debit: r.debit ?? '0', credit: r.credit ?? '0', changed: r.changed ?? false }))
}

/**
 * The lines whose effective Accounting Head differs from the head they
 * posted to, summed per (Accounting Head ← posting head). Same window, same
 * cash and narrowing rules as accountMovements, so the band and the rows
 * describe the same money.
 */
async function rePointedMovements(entityId: string, range: DateRange): Promise<RawRePointed[]> {
  const rows = await prisma.$queryRaw<
    (Omit<RawRePointed, 'debit' | 'credit'> & { debit: string | null; credit: string | null })[]
  >`
    SELECT ah.id as "accountId", ah.code, ah.name, ah.kind::text as "ahKind",
           a.id as "fromAccountId", a.code as "fromCode", a.name as "fromName", a.kind::text as kind,
           SUM(l.debit)::text as debit, SUM(l.credit)::text as credit
    FROM "LedgerAccount" a
    JOIN "JournalLine" l ON l."accountId" = a.id
    JOIN "JournalEntry" e ON e.id = l."entryId"
    LEFT JOIN "HeadMode" hm ON lower(hm.category) = lower(a.name)
    LEFT JOIN LATERAL (
      SELECT x.id FROM "LedgerAccount" x
      WHERE hm."accountingHead" IS NOT NULL AND x."entityId" = a."entityId"
        AND lower(x.name) = lower(hm."accountingHead") AND x."isGroup" = false
      ORDER BY x.code LIMIT 1
    ) mah ON true
    JOIN "LedgerAccount" ah ON ah.id = COALESCE(l."accountingHeadId", mah.id, a.id)
    WHERE a."entityId" = ${entityId} AND a."isGroup" = false
      AND ah.id <> a.id
      AND (${range.excludeCashAccounts ?? []}::text[] = '{}'::text[] OR NOT EXISTS (
        SELECT 1 FROM "JournalLine" cl
        WHERE cl."entryId" = e.id AND cl."accountId" = ANY(${range.excludeCashAccounts ?? []})
      ))
      AND (${range.from ?? null}::date IS NULL OR e.date >= ${range.from ?? null}::date)
      AND (${range.to ?? null}::date IS NULL OR e.date <= ${range.to ?? null}::date)
      AND (${range.headAccountId ?? null}::text IS NULL OR a.id = ${range.headAccountId ?? null})
      AND (${range.accountingHeadId ?? null}::text IS NULL OR ah.id = ${range.accountingHeadId ?? null})
    GROUP BY ah.id, ah.code, ah.name, ah.kind, a.id, a.code, a.name, a.kind
    ORDER BY ah.code, a.code
  `
  return rows.map((r) => ({ ...r, debit: r.debit ?? '0', credit: r.credit ?? '0' }))
}

/**
 * What each account was brought forward at: the opening_balance documents,
 * read as Dr − Cr per account. The control account is skipped — it is the
 * other side of every one of them, not a balance anyone opened with.
 */
async function openingBalancesByAccount(entityId: string): Promise<Map<string, number>> {
  const docs = await prisma.journalDoc.findMany({
    where: { entityId, sourceType: 'opening_balance', deletedAt: null },
    select: {
      currentEntry: {
        select: { lines: { select: { accountId: true, debit: true, credit: true, account: { select: { system: true, name: true } } } } },
      },
    },
  })
  const by = new Map<string, number>()
  for (const d of docs) {
    for (const l of d.currentEntry?.lines ?? []) {
      if (l.account.system && l.account.name.toLowerCase().includes('opening')) continue
      const v = Number(l.debit) - Number(l.credit)
      if (v !== 0) by.set(l.accountId, (by.get(l.accountId) ?? 0) + v)
    }
  }
  return by
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
  /** accountId → opening balance as Dr − Cr; normalised here like `amount`. */
  openingBy?: Map<string, number>,
  /** Under the Accounting Head lens: this section's re-pointed money. */
  rePointedRows?: RawRePointed[],
): StatementSection {
  const lines: StatementLine[] = []
  let total = new Prisma.Decimal(0)
  let openingTotal = new Prisma.Decimal(0)
  for (const row of rows) {
    const debit = new Prisma.Decimal(row.debit)
    const credit = new Prisma.Decimal(row.credit)
    const amount = normal === 'debit' ? debit.minus(credit) : credit.minus(debit)
    if (amount.isZero()) continue // fully reversed — not a real line
    total = total.plus(amount)
    // the brought-forward figure, on the same side the row is shown on
    const raw = openingBy?.get(row.accountId)
    const opening =
      raw === undefined
        ? null
        : new Prisma.Decimal(normal === 'debit' ? raw : -raw)
    if (opening) openingTotal = openingTotal.plus(opening)
    lines.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      group: (row.parentId && groups.get(row.parentId)) || title,
      amount: amount.toFixed(2),
      changed: row.changed ?? false,
      ...(opening !== null ? { opening: opening.toFixed(2) } : {}),
    })
  }
  // The re-pointed band: the same money on the same side, named by the
  // Accounting Head it was filed under. A memo — it is inside `total`
  // already through the row it came out of.
  const rePointed: RePointedLine[] = []
  for (const row of rePointedRows ?? []) {
    const amount =
      normal === 'debit'
        ? new Prisma.Decimal(row.debit).minus(row.credit)
        : new Prisma.Decimal(row.credit).minus(row.debit)
    if (amount.isZero()) continue
    rePointed.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      fromAccountId: row.fromAccountId,
      fromCode: row.fromCode,
      fromName: row.fromName,
      amount: amount.toFixed(2),
    })
  }
  return {
    title,
    lines,
    total: total.toFixed(2),
    ...(openingBy ? { openingTotal: openingTotal.toFixed(2) } : {}),
    ...(rePointedRows ? { rePointed } : {}),
  }
}

/**
 * Which section a re-pointed line is shown in: the one its posting head
 * belongs to (the row still carrying it sits there), and — when the
 * Accounting Head lives on the other statement — that section too, since a
 * reader of the Balance Sheet wants to know that Loan given has −62,000
 * filed under it from Poker just as much as a reader of the P&L does.
 */
function bandOf(moved: RawRePointed[] | undefined, kind: string) {
  return moved?.filter((r) => r.kind === kind || r.ahKind === kind)
}

export interface ProfitAndLoss {
  income: StatementSection
  expenses: StatementSection
  netProfit: string
}

/** P&L for a period (spec §10). Income − Expenses. */
export async function profitAndLoss(entityId: string, range: DateRange): Promise<ProfitAndLoss> {
  const [rows, groups, moved] = await Promise.all([
    accountMovements(entityId, range),
    groupNames(entityId),
    range.lens === 'ah' ? rePointedMovements(entityId, range) : Promise.resolve(undefined),
  ])
  const income = section('Income', rows.filter((r) => r.kind === 'INCOME'), groups, 'credit', undefined, bandOf(moved, 'INCOME'))
  const expenses = section('Expenses', rows.filter((r) => r.kind === 'EXPENSE'), groups, 'debit', undefined, bandOf(moved, 'EXPENSE'))
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
export async function balanceSheet(
  entityId: string,
  asOf?: Date,
  view: Pick<DateRange, 'lens' | 'headAccountId' | 'accountingHeadId' | 'excludeCashAccounts'> = {},
): Promise<BalanceSheet> {
  const range: DateRange = { to: asOf, ...view }
  const [rows, groups, openingBy, moved] = await Promise.all([
    accountMovements(entityId, range),
    groupNames(entityId),
    openingBalancesByAccount(entityId),
    range.lens === 'ah' ? rePointedMovements(entityId, range) : Promise.resolve(undefined),
  ])
  const assets = section('Assets', rows.filter((r) => r.kind === 'ASSET'), groups, 'debit', openingBy, bandOf(moved, 'ASSET'))
  const liabilities = section('Liabilities', rows.filter((r) => r.kind === 'LIABILITY'), groups, 'credit', openingBy, bandOf(moved, 'LIABILITY'))
  const equity = section('Equity', rows.filter((r) => r.kind === 'EQUITY'), groups, 'credit', openingBy, bandOf(moved, 'EQUITY'))

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
      -- narrow to one head (Himal, 20 Aug), same picker as the other reports
      AND (${range.headAccountId ?? null}::text IS NULL OR a.id = ${range.headAccountId ?? null})
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
