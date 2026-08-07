import 'server-only'
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { COA } from '@/lib/ledger/coa'

// Time-series and snapshot data behind the Overview analytics (spec §9).
// Same conventions as the report queries: no entry-state filter — reversals
// net out by construction — and money stays Decimal until the edge.

export interface MonthPoint {
  month: string // "2025-04" — first day of month, ISO-prefixed
  label: string // "Apr"
  income: number // paise-safe rupee floats for charting only, never re-posted
  expense: number
  cashNet: number // movement across bank + cash ledger accounts
}

function monthKeys(count: number, now = new Date()): string[] {
  const keys: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    keys.push(d.toISOString().slice(0, 7))
  }
  return keys
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const labelOf = (key: string) => MONTH_LABELS[Number(key.slice(5, 7)) - 1]

/**
 * Income, expense and bank+cash movement per month for the trailing window.
 * One pass over the ledger; missing months come back as zeros so charts get
 * a continuous axis.
 */
export async function monthlyFlows(entityId: string, months = 12): Promise<MonthPoint[]> {
  const keys = monthKeys(months)
  const from = new Date(`${keys[0]}-01T00:00:00Z`)

  const rows = await prisma.$queryRaw<
    { month: string; income: string | null; expense: string | null; cashnet: string | null }[]
  >`
    SELECT to_char(date_trunc('month', e.date), 'YYYY-MM') AS month,
           SUM(l.credit - l.debit) FILTER (WHERE a.kind = 'INCOME')::text  AS income,
           SUM(l.debit - l.credit) FILTER (WHERE a.kind = 'EXPENSE')::text AS expense,
           SUM(l.debit - l.credit) FILTER (WHERE a.id IN (
             SELECT "ledgerAccountId" FROM "BankAccount"
              WHERE "entityId" = ${entityId} AND "ledgerAccountId" IS NOT NULL
             UNION
             SELECT "ledgerAccountId" FROM "CashLocation"
              WHERE "entityId" = ${entityId} AND "ledgerAccountId" IS NOT NULL
           ))::text AS cashnet
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN "LedgerAccount" a ON a.id = l."accountId"
    WHERE e."entityId" = ${entityId} AND e.date >= ${from}::date
    GROUP BY 1
  `
  const byMonth = new Map(rows.map((r) => [r.month, r]))
  return keys.map((k) => {
    const r = byMonth.get(k)
    return {
      month: k,
      label: labelOf(k),
      income: Number(r?.income ?? 0),
      expense: Number(r?.expense ?? 0),
      cashNet: Number(r?.cashnet ?? 0),
    }
  })
}

export interface CategorySlice {
  name: string
  amount: number
}

/** Top expense accounts for a window, tail folded into "Other". */
export async function expenseCategories(
  entityId: string,
  months = 12,
  top = 6,
): Promise<CategorySlice[]> {
  const from = new Date(`${monthKeys(months)[0]}-01T00:00:00Z`)
  const rows = await prisma.$queryRaw<{ name: string; amount: string }[]>`
    SELECT a.name, SUM(l.debit - l.credit)::text AS amount
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN "LedgerAccount" a ON a.id = l."accountId"
    WHERE e."entityId" = ${entityId} AND a.kind = 'EXPENSE' AND e.date >= ${from}::date
    GROUP BY a.name
    HAVING SUM(l.debit - l.credit) > 0
    ORDER BY SUM(l.debit - l.credit) DESC
  `
  const slices = rows.map((r) => ({ name: r.name, amount: Number(r.amount) }))
  if (slices.length <= top) return slices
  const head = slices.slice(0, top)
  const other = slices.slice(top).reduce((t, s) => t + s.amount, 0)
  return [...head, { name: 'Other', amount: other }]
}

export interface GstMonthPoint {
  month: string
  label: string
  output: number // GST on outward supplies (liability)
  input: number // ITC on purchases
}

/** GST output vs input credit per month, straight off the tax register. */
export async function gstMonthly(entityId: string, months = 6): Promise<GstMonthPoint[]> {
  const keys = monthKeys(months)
  const from = new Date(`${keys[0]}-01T00:00:00Z`)
  const rows = await prisma.$queryRaw<
    { month: string; output: string | null; input: string | null }[]
  >`
    SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month,
           SUM("gstAmount") FILTER (WHERE direction = 'output')::text AS output,
           SUM("gstAmount") FILTER (WHERE direction = 'input')::text  AS input
    FROM "TaxLine"
    WHERE "entityId" = ${entityId} AND date >= ${from}::date
    GROUP BY 1
  `
  const byMonth = new Map(rows.map((r) => [r.month, r]))
  return keys.map((k) => ({
    month: k,
    label: labelOf(k),
    output: Number(byMonth.get(k)?.output ?? 0),
    input: Number(byMonth.get(k)?.input ?? 0),
  }))
}

export interface StatSnapshot {
  current: string // Decimal.toFixed(2)
  prior: string // same figure 30 days ago
  deltaPct: number | null // null when prior is zero — no honest percentage exists
}

export interface StatTrends {
  bank: StatSnapshot
  cash: StatSnapshot
  receivables: StatSnapshot
  payables: StatSnapshot
  /** Month-end bank+cash total for the trailing year — the stat-card sparkline. */
  liquiditySpark: number[]
}

function snapshot(current: Prisma.Decimal, prior: Prisma.Decimal): StatSnapshot {
  return {
    current: current.toFixed(2),
    prior: prior.toFixed(2),
    deltaPct: prior.isZero()
      ? null
      : Number(current.minus(prior).div(prior.abs()).times(100).toFixed(1)),
  }
}

/**
 * The four monetary headline figures now and 30 days ago, plus a 12-month
 * liquidity sparkline. Balance-sheet figures are cumulative, so "as at" sums
 * run from the beginning of the books, not the window.
 */
export async function statTrends(entityId: string): Promise<StatTrends> {
  const prior = new Date(Date.now() - 30 * 86_400_000)

  // Every group's balance now and then, one ledger pass. Debit-positive;
  // liability-side figures flip below.
  const rows = await prisma.$queryRaw<
    { bucket: string; now: string | null; prior: string | null }[]
  >`
    WITH buckets AS (
      SELECT a.id,
             CASE
               WHEN a.id IN (SELECT "ledgerAccountId" FROM "BankAccount"
                              WHERE "entityId" = ${entityId} AND "ledgerAccountId" IS NOT NULL) THEN 'bank'
               WHEN a.id IN (SELECT "ledgerAccountId" FROM "CashLocation"
                              WHERE "entityId" = ${entityId} AND "ledgerAccountId" IS NOT NULL) THEN 'cash'
               WHEN g.code = ${COA.DEBTORS_GROUP} THEN 'receivables'
               WHEN g.code IN (${COA.CREDITORS_GROUP}, ${COA.PAYABLES_GROUP}) THEN 'payables'
             END AS bucket
      FROM "LedgerAccount" a
      LEFT JOIN "LedgerAccount" g ON g.id = a."parentId"
      WHERE a."entityId" = ${entityId}
    )
    SELECT b.bucket,
           SUM(l.debit - l.credit)::text AS now,
           SUM(l.debit - l.credit) FILTER (WHERE e.date <= ${prior}::date)::text AS prior
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN buckets b ON b.id = l."accountId"
    WHERE e."entityId" = ${entityId} AND b.bucket IS NOT NULL
    GROUP BY b.bucket
  `
  const get = (bucket: string) => {
    const r = rows.find((x) => x.bucket === bucket)
    return {
      now: new Prisma.Decimal(r?.now ?? 0),
      prior: new Prisma.Decimal(r?.prior ?? 0),
    }
  }
  const bank = get('bank')
  const cash = get('cash')
  const recv = get('receivables')
  const pay = get('payables')

  // Liquidity sparkline: cumulative bank+cash close per month. Movements
  // before the window fold into an opening offset so the curve is a balance,
  // not a rate.
  const keys = monthKeys(12)
  const from = new Date(`${keys[0]}-01T00:00:00Z`)
  const moves = await prisma.$queryRaw<{ month: string | null; net: string }[]>`
    SELECT CASE WHEN e.date >= ${from}::date
                THEN to_char(date_trunc('month', e.date), 'YYYY-MM') END AS month,
           SUM(l.debit - l.credit)::text AS net
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE e."entityId" = ${entityId} AND l."accountId" IN (
      SELECT "ledgerAccountId" FROM "BankAccount"
       WHERE "entityId" = ${entityId} AND "ledgerAccountId" IS NOT NULL
      UNION
      SELECT "ledgerAccountId" FROM "CashLocation"
       WHERE "entityId" = ${entityId} AND "ledgerAccountId" IS NOT NULL
    )
    GROUP BY 1
  `
  let running = Number(moves.find((m) => m.month === null)?.net ?? 0)
  const byMonth = new Map(moves.map((m) => [m.month, Number(m.net)]))
  const liquiditySpark = keys.map((k) => (running += byMonth.get(k) ?? 0))

  return {
    bank: snapshot(bank.now, bank.prior),
    cash: snapshot(cash.now, cash.prior),
    receivables: snapshot(recv.now, recv.prior),
    // Creditors carry credit balances; flip so "payables ₹X" reads positive.
    payables: snapshot(pay.now.neg(), pay.prior.neg()),
    liquiditySpark,
  }
}

/** Pending bills: the count and money the Overview "Pending bills" card shows. */
export async function pendingBills(entityId: string) {
  const agg = await prisma.bill.aggregate({
    where: { entityId, status: 'PENDING' },
    _count: true,
    _sum: { amount: true, gstAmount: true, tdsAmount: true },
  })
  const total = new Prisma.Decimal(String(agg._sum.amount ?? 0))
    .plus(String(agg._sum.gstAmount ?? 0))
    .minus(String(agg._sum.tdsAmount ?? 0))
  return { count: agg._count, total: total.toFixed(2) }
}
