import { prisma } from '@/lib/db'
import { Prisma } from '@/generated/prisma/client'

// Ledger-derived views (spec §4): trial balance, account ledgers, balances.
// Everything sums the append-only journal — nothing is stored separately,
// so reversal pairs cancel and the books tally by construction.

export interface TrialBalanceRow {
  accountId: string
  code: string
  name: string
  kind: string
  isGroup: boolean
  debit: string // total Dr in the range
  credit: string // total Cr in the range
  balance: string // Dr − Cr (positive = debit balance)
}

export async function trialBalance(
  entityId: string,
  opts: { from?: Date; to?: Date } = {},
): Promise<TrialBalanceRow[]> {
  const rows = await prisma.$queryRaw<
    {
      accountId: string
      code: string
      name: string
      kind: string
      isGroup: boolean
      debit: string | null
      credit: string | null
    }[]
  >`
    SELECT a.id as "accountId", a.code, a.name, a.kind::text as kind, a."isGroup",
           SUM(l.debit)::text  as debit,
           SUM(l.credit)::text as credit
    FROM "LedgerAccount" a
    JOIN "JournalLine" l ON l."accountId" = a.id
    JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE a."entityId" = ${entityId}
      AND (${opts.from ?? null}::date IS NULL OR e.date >= ${opts.from ?? null}::date)
      AND (${opts.to ?? null}::date IS NULL OR e.date <= ${opts.to ?? null}::date)
    GROUP BY a.id, a.code, a.name, a.kind, a."isGroup"
    ORDER BY a.code
  `
  return rows.map((r) => {
    const debit = new Prisma.Decimal(r.debit ?? 0)
    const credit = new Prisma.Decimal(r.credit ?? 0)
    return {
      ...r,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      balance: debit.minus(credit).toFixed(2),
    }
  })
}

export interface LedgerLine {
  entryId: string
  docId: string
  date: Date
  narration: string
  reference: string | null
  kind: string
  debit: string
  credit: string
  running: string
}

/** Account statement with running balance (Dr-positive). */
export async function accountLedger(
  accountId: string,
  opts: { from?: Date; to?: Date } = {},
): Promise<{ opening: string; lines: LedgerLine[]; closing: string }> {
  const openingRow = await prisma.$queryRaw<{ balance: string | null }[]>`
    SELECT (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0))::text as balance
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE l."accountId" = ${accountId}
      AND ${opts.from ?? null}::date IS NOT NULL
      AND e.date < ${opts.from ?? null}::date
  `
  const opening = new Prisma.Decimal(openingRow[0]?.balance ?? 0)

  const rows = await prisma.$queryRaw<
    {
      entryId: string
      docId: string
      date: Date
      narration: string
      reference: string | null
      kind: string
      debit: string
      credit: string
      createdAt: Date
    }[]
  >`
    SELECT e.id as "entryId", e."docId", e.date, e.narration, e.reference,
           e.kind::text as kind, l.debit::text, l.credit::text, e."createdAt"
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE l."accountId" = ${accountId}
      AND (${opts.from ?? null}::date IS NULL OR e.date >= ${opts.from ?? null}::date)
      AND (${opts.to ?? null}::date IS NULL OR e.date <= ${opts.to ?? null}::date)
    ORDER BY e.date, e."createdAt", l.id
  `
  let running = opening
  const lines = rows.map((r) => {
    running = running.plus(r.debit).minus(r.credit)
    return {
      entryId: r.entryId,
      docId: r.docId,
      date: r.date,
      narration: r.narration,
      reference: r.reference,
      kind: r.kind,
      debit: new Prisma.Decimal(r.debit).toFixed(2),
      credit: new Prisma.Decimal(r.credit).toFixed(2),
      running: running.toFixed(2),
    }
  })
  return { opening: opening.toFixed(2), lines, closing: running.toFixed(2) }
}

/** Dr−Cr balance per ledger account id (for dashboard tiles etc.). */
export async function accountBalances(
  accountIds: string[],
): Promise<Map<string, string>> {
  if (accountIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<{ accountId: string; balance: string }[]>`
    SELECT l."accountId",
           (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0))::text as balance
    FROM "JournalLine" l
    WHERE l."accountId" IN (${Prisma.join(accountIds)})
    GROUP BY l."accountId"
  `
  const map = new Map<string, string>()
  for (const id of accountIds) map.set(id, '0.00')
  for (const r of rows) map.set(r.accountId, new Prisma.Decimal(r.balance).toFixed(2))
  return map
}

/** Whole-books check (spec §11.1): total Dr = total Cr for an entity. */
export async function booksTally(entityId: string) {
  const rows = await prisma.$queryRaw<{ debit: string | null; credit: string | null }[]>`
    SELECT SUM(l.debit)::text as debit, SUM(l.credit)::text as credit
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE e."entityId" = ${entityId}
  `
  const debit = new Prisma.Decimal(rows[0]?.debit ?? 0)
  const credit = new Prisma.Decimal(rows[0]?.credit ?? 0)
  return { debit: debit.toFixed(2), credit: credit.toFixed(2), tallies: debit.equals(credit) }
}
