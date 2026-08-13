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

/**
 * Project each pool `count` months ahead, starting this month: opening is
 * the live balance today, then budgeted monthly equivalents (+ ONCE lines
 * in their month) roll it forward.
 */
export async function projectPools(today: Date, count = 6): Promise<PoolProjection[]> {
  const [lines, balances] = await Promise.all([
    prisma.budgetLine.findMany({ where: { archivedAt: null } }),
    poolBalances(),
  ])
  const months = monthKeysFrom(today, count)

  return POOLS.map((pool) => {
    const mine = lines.filter((l) => l.source === pool)
    const balanceNow = balances.get(pool) ?? 0
    let running = balanceNow
    const rows: PoolMonth[] = months.map((month) => {
      let inflow = 0
      let outflow = 0
      for (const line of mine) {
        const amount =
          line.frequency === 'ONCE'
            ? line.onMonth === month
              ? Number(line.amount)
              : 0
            : monthlyEquivalent(Number(line.amount), line.frequency)
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
