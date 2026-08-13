import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { cashBalances } from '@/lib/ops/cash'

// The cash-flow plan: budget lines (per head × pool) rolled into monthly
// equivalents and projected forward from LIVE ledger balances — the same
// numbers the Cash tab and dashboard show, so plan and books stay linked.

export const POOLS = ['AC', 'ACPL', 'HG', 'MG', 'PG', 'CASH'] as const
export type Pool = (typeof POOLS)[number]

export const FREQUENCIES = [
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'HALF_YEARLY',
  'ANNUAL',
  'ONCE',
] as const

/** Per-frequency amount → per-month equivalent (the sheet's own arithmetic). */
export function monthlyEquivalent(amount: number, frequency: string): number {
  switch (frequency) {
    case 'DAILY':
      return (amount * 365) / 12
    case 'WEEKLY':
      return (amount * 52) / 12
    case 'MONTHLY':
      return amount
    case 'QUARTERLY':
      return amount / 3
    case 'HALF_YEARLY':
      return amount / 6
    case 'ANNUAL':
      return amount / 12
    default:
      return 0 // ONCE handled per-month
  }
}

export interface PoolMonth {
  month: string // YYYY-MM
  opening: number
  inflow: number
  outflow: number
  closing: number
}

export interface PoolProjection {
  pool: Pool
  balanceNow: number
  months: PoolMonth[]
}

function monthKeysFrom(start: Date, count: number): string[] {
  const keys: string[] = []
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))
    keys.push(d.toISOString().slice(0, 7))
  }
  return keys
}

/** Live balance per pool: bank ledgers per books, plus the one cash pool. */
export async function poolBalances(): Promise<Map<Pool, number>> {
  const entities = await prisma.entity.findMany({ where: { archivedAt: null } })
  const balances = new Map<Pool, number>()
  for (const e of entities) {
    if (!POOLS.includes(e.code as Pool)) continue
    const rows = await prisma.$queryRaw<{ total: string | null }[]>`
      SELECT SUM(l.debit - l.credit)::text AS total
      FROM "JournalLine" l
      WHERE l."accountId" IN (
        SELECT "ledgerAccountId" FROM "BankAccount"
        WHERE "entityId" = ${e.id} AND "ledgerAccountId" IS NOT NULL
      )
    `
    balances.set(e.code as Pool, Number(rows[0]?.total ?? 0))
  }
  let cash = 0
  for (const e of entities) cash += Number((await cashBalances(e.id)).total)
  balances.set('CASH', cash)
  return balances
}

/** A line's planned amount for one month (monthly equivalent, or the ONCE hit). */
function planForMonth(
  line: { amount: Prisma.Decimal; frequency: string; onMonth: string | null },
  month: string,
): number {
  return line.frequency === 'ONCE'
    ? line.onMonth === month
      ? Number(line.amount)
      : 0
    : monthlyEquivalent(Number(line.amount), line.frequency)
}

/**
 * Project each pool `count` months ahead, starting this month: opening is
 * the live balance today, then budgeted monthly equivalents (+ ONCE lines
 * in their month) roll it forward.
 *
 * The CURRENT month is interlinked with the books: what already moved on a
 * line's head (bank rows, cash payments — anything posted) nets off its
 * plan, so only the REMAINING expected money rolls forward. Heads shared
 * by several pool-split lines share the actual in proportion to their plan.
 */
export async function projectPools(today: Date, count = 6): Promise<PoolProjection[]> {
  const [lines, balances] = await Promise.all([
    prisma.budgetLine.findMany({ where: { archivedAt: null } }),
    poolBalances(),
  ])
  const months = monthKeysFrom(today, count)
  const currentMonth = months[0]

  // Per-head: total plan this month vs actual, → remaining fraction each
  // split line keeps for the current month.
  const actuals = await actualByHead(
    [...new Set(lines.map((l) => l.headAccountId).filter((x): x is string => x !== null))],
    currentMonth,
  )
  const planByHead = new Map<string, number>()
  for (const l of lines) {
    if (!l.headAccountId) continue
    planByHead.set(
      l.headAccountId,
      (planByHead.get(l.headAccountId) ?? 0) + planForMonth(l, currentMonth),
    )
  }
  const remainingFraction = (headId: string | null): number => {
    if (!headId) return 1
    const plan = planByHead.get(headId) ?? 0
    if (plan === 0) return 1
    const actual = actuals.get(headId) ?? 0
    if (plan > 0) {
      const remaining = Math.max(0, plan - Math.max(0, actual))
      return remaining / plan
    }
    const remaining = Math.min(0, plan - Math.min(0, actual))
    return remaining / plan
  }

  return POOLS.map((pool) => {
    const mine = lines.filter((l) => l.source === pool)
    const balanceNow = balances.get(pool) ?? 0
    let running = balanceNow
    const rows: PoolMonth[] = months.map((month) => {
      let inflow = 0
      let outflow = 0
      for (const line of mine) {
        let amount = planForMonth(line, month)
        if (month === currentMonth) amount *= remainingFraction(line.headAccountId)
        if (amount > 0) outflow += amount
        if (amount < 0) inflow -= amount
      }
      const opening = running
      const closing = opening + inflow - outflow
      running = closing
      return { month, opening, inflow, outflow, closing }
    })
    return { pool, balanceNow, months: rows }
  }).filter((p) => p.balanceNow !== 0 || lines.some((l) => l.source === p.pool))
}

/** For display: a line's ₹/month share. */
export function lineMonthly(line: { amount: Prisma.Decimal; frequency: string }): number {
  return line.frequency === 'ONCE' ? 0 : monthlyEquivalent(Number(line.amount), line.frequency)
}

/**
 * Actual movement per head for one month, signed like the plan: expense
 * heads spend positive (Dr − Cr), income heads receive negative — so a
 * line's actual compares straight against its planned amount.
 */
export async function actualByHead(
  headIds: string[],
  monthKey: string, // YYYY-MM
): Promise<Map<string, number>> {
  if (headIds.length === 0) return new Map()
  const from = new Date(`${monthKey}-01T00:00:00Z`)
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1))
  const rows = await prisma.$queryRaw<{ accountId: string; net: string }[]>`
    SELECT l."accountId", SUM(l.debit - l.credit)::text AS net
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE l."accountId" IN (${Prisma.join(headIds)})
      AND e.date >= ${from}::date AND e.date < ${to}::date
    GROUP BY l."accountId"
  `
  return new Map(rows.map((r) => [r.accountId, Number(r.net)]))
}
