import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { COA } from '@/lib/ledger/coa'
import type { DateRange } from './statements'

// Analytical reports (spec §10): expense by cost centre, party ledgers,
// budget vs actual, salary report. All derived from the journal.

export interface CostCentreRow {
  costCentreId: string | null
  name: string
  expense: string
  income: string
  net: string // expense − income (spend on the centre)
}

/** Expense by cost centre (spec §10), including untagged spend. */
export async function costCentreReport(entityId: string, range: DateRange) {
  const rows = await prisma.$queryRaw<
    { costCentreId: string | null; name: string | null; expense: string | null; income: string | null }[]
  >`
    SELECT l."costCentreId", c.name,
           SUM(CASE WHEN a.kind = 'EXPENSE' THEN l.debit - l.credit ELSE 0 END)::text as expense,
           SUM(CASE WHEN a.kind = 'INCOME'  THEN l.credit - l.debit ELSE 0 END)::text as income
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN "LedgerAccount" a ON a.id = l."accountId"
    LEFT JOIN "CostCentre" c ON c.id = l."costCentreId"
    WHERE e."entityId" = ${entityId}
      AND a.kind IN ('EXPENSE', 'INCOME')
      AND (${range.from ?? null}::date IS NULL OR e.date >= ${range.from ?? null}::date)
      AND (${range.to ?? null}::date IS NULL OR e.date <= ${range.to ?? null}::date)
    GROUP BY l."costCentreId", c.name
    ORDER BY c.name NULLS LAST
  `
  const list: CostCentreRow[] = rows.map((r) => {
    const expense = new Prisma.Decimal(r.expense ?? 0)
    const income = new Prisma.Decimal(r.income ?? 0)
    return {
      costCentreId: r.costCentreId,
      name: r.name ?? 'Untagged',
      expense: expense.toFixed(2),
      income: income.toFixed(2),
      net: expense.minus(income).toFixed(2),
    }
  })
  const total = list.reduce((sum, r) => sum.plus(r.net), new Prisma.Decimal(0))
  return { rows: list.filter((r) => r.expense !== '0.00' || r.income !== '0.00'), total: total.toFixed(2) }
}

export interface PartyRow {
  accountId: string
  code: string
  name: string
  balance: string // positive = they owe us (debtors) / we owe them (creditors)
}

/**
 * Party ledgers (spec §10): customers (Sundry Debtors), vendors (Sundry
 * Creditors) and members/employees (Payables), as at a date.
 */
export async function partyLedgers(entityId: string, asOf?: Date) {
  const groups = await prisma.ledgerAccount.findMany({
    where: {
      entityId,
      code: { in: [COA.DEBTORS_GROUP, COA.CREDITORS_GROUP, COA.PAYABLES_GROUP] },
    },
    select: { id: true, code: true, name: true },
  })
  const groupById = new Map(groups.map((g) => [g.id, g]))
  if (groups.length === 0) return { customers: [], vendors: [], payables: [] }

  const rows = await prisma.$queryRaw<
    { accountId: string; code: string; name: string; parentId: string; balance: string | null }[]
  >`
    SELECT a.id as "accountId", a.code, a.name, a."parentId",
           (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0))::text as balance
    FROM "LedgerAccount" a
    JOIN "JournalLine" l ON l."accountId" = a.id
    JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE a."entityId" = ${entityId}
      AND a."parentId" IN (${Prisma.join(groups.map((g) => g.id))})
      AND (${asOf ?? null}::date IS NULL OR e.date <= ${asOf ?? null}::date)
    GROUP BY a.id, a.code, a.name, a."parentId"
    ORDER BY a.code
  `

  const pick = (groupCode: string, normal: 'debit' | 'credit'): PartyRow[] =>
    rows
      .filter((r) => groupById.get(r.parentId)?.code === groupCode)
      .map((r) => {
        const raw = new Prisma.Decimal(r.balance ?? 0)
        const balance = normal === 'debit' ? raw : raw.negated()
        return { accountId: r.accountId, code: r.code, name: r.name, balance: balance.toFixed(2) }
      })
      .filter((r) => r.balance !== '0.00')

  return {
    customers: pick(COA.DEBTORS_GROUP, 'debit'),
    vendors: pick(COA.CREDITORS_GROUP, 'credit'),
    payables: pick(COA.PAYABLES_GROUP, 'credit'),
  }
}

export interface BudgetRow {
  accountId: string
  code: string
  name: string
  budget: string
  actual: string
  variance: string // budget − actual (positive = under budget)
  usedPct: number | null
}

/**
 * Budget vs Actual (spec §10) for a period. Budgets are per account-month;
 * actuals come from the ledger on the account's normal side.
 */
/**
 * Budget vs Actual over an explicit list of (year, month) periods.
 *
 * It takes periods rather than a calendar year because budgets are stored
 * on the FINANCIAL year, Apr–Mar (Himal, 20 Aug): asking for "2026" used to
 * match only Apr–Dec, so a ₹30,000/month head reported ₹270,000 for the
 * year instead of ₹360,000 — the Jan–Mar quarter sits under year 2027.
 */
export async function budgetVsActual(
  entityId: string,
  periods: { year: number; month: number }[],
) {
  const budgets = await prisma.budget.findMany({
    where: { entityId, OR: periods.map((p) => ({ year: p.year, month: p.month })) },
  })
  const accountIds = [...new Set(budgets.map((b) => b.accountId))]
  const first = periods[0]
  const last = periods[periods.length - 1]
  const from = new Date(Date.UTC(first.year, first.month - 1, 1))
  const to = new Date(Date.UTC(last.year, last.month, 0))

  const accounts = await prisma.ledgerAccount.findMany({
    where: { entityId, ...(accountIds.length ? { id: { in: accountIds } } : {}) },
    select: { id: true, code: true, name: true, kind: true },
  })
  const actualRows = accountIds.length
    ? await prisma.$queryRaw<{ accountId: string; debit: string | null; credit: string | null }[]>`
        SELECT l."accountId", SUM(l.debit)::text as debit, SUM(l.credit)::text as credit
        FROM "JournalLine" l
        JOIN "JournalEntry" e ON e.id = l."entryId"
        WHERE l."accountId" IN (${Prisma.join(accountIds)})
          AND e.date >= ${from}::date AND e.date <= ${to}::date
        GROUP BY l."accountId"
      `
    : []

  const rows: BudgetRow[] = []
  let budgetTotal = new Prisma.Decimal(0)
  let actualTotal = new Prisma.Decimal(0)
  for (const accountId of accountIds) {
    const account = accounts.find((a) => a.id === accountId)
    if (!account) continue
    const budget = budgets
      .filter((b) => b.accountId === accountId)
      .reduce((sum, b) => sum.plus(String(b.amount)), new Prisma.Decimal(0))
    const raw = actualRows.find((r) => r.accountId === accountId)
    const debit = new Prisma.Decimal(raw?.debit ?? 0)
    const credit = new Prisma.Decimal(raw?.credit ?? 0)
    const actual = account.kind === 'INCOME' ? credit.minus(debit) : debit.minus(credit)
    budgetTotal = budgetTotal.plus(budget)
    actualTotal = actualTotal.plus(actual)
    rows.push({
      accountId,
      code: account.code,
      name: account.name,
      budget: budget.toFixed(2),
      actual: actual.toFixed(2),
      variance: budget.minus(actual).toFixed(2),
      usedPct: budget.isZero() ? null : Number(actual.dividedBy(budget).times(100).toFixed(1)),
    })
  }
  rows.sort((a, b) => a.code.localeCompare(b.code))
  return {
    rows,
    budgetTotal: budgetTotal.toFixed(2),
    actualTotal: actualTotal.toFixed(2),
    varianceTotal: budgetTotal.minus(actualTotal).toFixed(2),
  }
}

/** Salary report (spec §10): approved/paid runs with per-person detail. */
export async function salaryReport(entityId: string, year: number) {
  const runs = await prisma.salaryRun.findMany({
    where: { entityId, year, status: { in: ['APPROVED', 'PAID'] } },
    include: { lines: true },
    orderBy: { month: 'asc' },
  })
  const personIds = [...new Set(runs.flatMap((r) => r.lines.map((l) => l.personId)))]
  const [people, costCentres] = await Promise.all([
    prisma.salaryPerson.findMany({ where: { id: { in: personIds } } }),
    prisma.costCentre.findMany({ where: { entityId } }),
  ])
  const personById = new Map(people.map((p) => [p.id, p]))
  const ccById = new Map(costCentres.map((c) => [c.id, c.name]))

  const months = runs.map((run) => {
    const totals = run.lines.reduce(
      (t, l) => ({
        gross: t.gross.plus(String(l.gross)),
        tds: t.tds.plus(String(l.tds)),
        net: t.net.plus(String(l.net)),
      }),
      { gross: new Prisma.Decimal(0), tds: new Prisma.Decimal(0), net: new Prisma.Decimal(0) },
    )
    return {
      runId: run.id,
      month: run.month,
      status: run.status,
      gross: totals.gross.toFixed(2),
      tds: totals.tds.toFixed(2),
      net: totals.net.toFixed(2),
      lines: run.lines.map((l) => {
        const person = personById.get(l.personId)
        return {
          name: person?.name ?? '(removed)',
          type: person?.type ?? 'SALARY',
          section: person?.tdsSection ?? '—',
          costCentre: l.costCentreId ? (ccById.get(l.costCentreId) ?? '—') : '—',
          gross: new Prisma.Decimal(String(l.gross)).toFixed(2),
          tds: new Prisma.Decimal(String(l.tds)).toFixed(2),
          net: new Prisma.Decimal(String(l.net)).toFixed(2),
        }
      }),
    }
  })

  const yearTotals = months.reduce(
    (t, m) => ({
      gross: t.gross.plus(m.gross),
      tds: t.tds.plus(m.tds),
      net: t.net.plus(m.net),
    }),
    { gross: new Prisma.Decimal(0), tds: new Prisma.Decimal(0), net: new Prisma.Decimal(0) },
  )
  return {
    months,
    gross: yearTotals.gross.toFixed(2),
    tds: yearTotals.tds.toFixed(2),
    net: yearTotals.net.toFixed(2),
  }
}
