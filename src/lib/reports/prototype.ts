import 'server-only'
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'

// Report queries for the v2-prototype tabs: month-by-month matrix, weekly
// summary, cash-vs-bank usage, bank balances, ITR summary, investments.
// Same conventions as series.ts — reversals net out, money leaves as floats
// for display only.

export function monthKeys(count: number, now = new Date()) {
  const keys: { key: string; label: string }[] = []
  const L = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    keys.push({ key: d.toISOString().slice(0, 7), label: L[d.getUTCMonth()] })
  }
  return keys
}

/** Expense accounts × months grid. */
export async function expenseMatrix(entityId: string, months = 12) {
  const keys = monthKeys(months)
  const from = new Date(`${keys[0].key}-01T00:00:00Z`)
  const rows = await prisma.$queryRaw<{ name: string; month: string; amt: string }[]>`
    SELECT a.name, to_char(date_trunc('month', e.date), 'YYYY-MM') AS month,
           SUM(l.debit - l.credit)::text AS amt
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN "LedgerAccount" a ON a.id = l."accountId"
    WHERE e."entityId" = ${entityId} AND a.kind = 'EXPENSE' AND e.date >= ${from}::date
    GROUP BY a.name, 2
  `
  const byName = new Map<string, Map<string, number>>()
  rows.forEach((r) => {
    const m = byName.get(r.name) ?? new Map()
    m.set(r.month, Number(r.amt))
    byName.set(r.name, m)
  })
  const out = [...byName.entries()]
    .map(([name, m]) => {
      const cells = keys.map((k) => m.get(k.key) ?? 0)
      return { name, cells, total: cells.reduce((s, v) => s + v, 0) }
    })
    .filter((r) => r.total !== 0)
    .sort((a, b) => b.total - a.total)
  const colTotals = keys.map((_, i) => out.reduce((s, r) => s + r.cells[i], 0))
  return { months: keys, rows: out, colTotals, grand: colTotals.reduce((s, v) => s + v, 0) }
}

/**
 * The sheet's "Expenses M/M" tab, computed: expense heads × FY months
 * (Apr..Mar) straight from tagged postings, with the Budget columns —
 * monthly budget (year ÷ 12), variance vs the recent month, total year
 * budget, and variance vs the FY's actual total. Rows appear if they have
 * either an actual or a budget.
 */
export async function expenseMatrixFy(
  entityId: string,
  fyStart: number,
  view: {
    lens?: 'head' | 'ah'
    headAccountId?: string
    accountingHeadId?: string
    /** Entries touching one of these accounts are dropped whole. */
    excludeCashAccounts?: string[]
  } = {},
) {
  const L = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const keys = Array.from({ length: 12 }, (_, i) => {
    const year = i < 9 ? fyStart : fyStart + 1
    const month = i < 9 ? i + 4 : i - 8
    return { key: `${year}-${String(month).padStart(2, '0')}`, label: L[month - 1], year, month }
  })
  const from = new Date(Date.UTC(fyStart, 3, 1))
  const to = new Date(Date.UTC(fyStart + 1, 3, 1))

  // The register covers every head that has a PURPOSE, not just the ones
  // filed under Expenses (Himal, 20 Aug: "Synergy EMI dist nahi"). That EMI
  // is a Liability head, so a kind='EXPENSE' filter hid ₹2,07,160 of real
  // payments and its ₹2.7L/month target. Two things stay out: the money
  // accounts themselves (bank + cash — they are the SOURCE of every entry,
  // never its purpose) and the system control accounts (GST/TDS, Opening
  // Balances), which would only double-count the tax already split out.
  const [bankAccts, cashLocs] = await Promise.all([
    prisma.bankAccount.findMany({ where: { entityId }, select: { ledgerAccountId: true } }),
    prisma.cashLocation.findMany({ where: { entityId }, select: { ledgerAccountId: true } }),
  ])
  const moneyIds = [...bankAccts, ...cashLocs]
    .map((x) => x.ledgerAccountId)
    .filter((x): x is string => !!x)

  const [actuals, budgets] = await Promise.all([
    prisma.$queryRaw<{ name: string; kind: string; month: string; amt: string }[]>`
      SELECT eff.name, a.kind::text AS kind,
             to_char(date_trunc('month', e.date), 'YYYY-MM') AS month,
             SUM(l.debit - l.credit)::text AS amt
      FROM "JournalLine" l
      JOIN "JournalEntry" e ON e.id = l."entryId"
      JOIN "LedgerAccount" a ON a.id = l."accountId"
      LEFT JOIN "HeadMode" hm ON lower(hm.category) = lower(a.name)
      LEFT JOIN LATERAL (
        SELECT x.id FROM "LedgerAccount" x
        WHERE hm."accountingHead" IS NOT NULL AND x."entityId" = a."entityId"
          AND lower(x.name) = lower(hm."accountingHead") AND x."isGroup" = false
        ORDER BY x.code LIMIT 1
      ) mah ON true
      -- the head each row IS: posted account, or its effective Accounting
      -- Head under the 'ah' lens. Kind stays the posting account's, so the
      -- sections and the "Spent" headline keep their meaning.
      JOIN "LedgerAccount" eff ON eff.id = CASE
        WHEN ${view.lens ?? 'head'} = 'ah' THEN COALESCE(l."accountingHeadId", mah.id, a.id)
        ELSE a.id END
      WHERE e."entityId" = ${entityId}
        AND a.system = false
        AND NOT (l."accountId" = ANY(${moneyIds}))
        -- the Accounting Head lens shows only what was re-pointed
        AND (${view.lens ?? 'head'} <> 'ah'
             OR COALESCE(l."accountingHeadId", mah.id, a.id) <> a.id)
        AND (${view.excludeCashAccounts ?? []}::text[] = '{}'::text[] OR NOT EXISTS (
          SELECT 1 FROM "JournalLine" cl
          WHERE cl."entryId" = e.id AND cl."accountId" = ANY(${view.excludeCashAccounts ?? []})
        ))
        AND (${view.headAccountId ?? null}::text IS NULL OR a.id = ${view.headAccountId ?? null})
        AND (${view.accountingHeadId ?? null}::text IS NULL
             OR COALESCE(l."accountingHeadId", mah.id, a.id) = ${view.accountingHeadId ?? null})
        AND e.date >= ${from}::date AND e.date < ${to}::date
      GROUP BY eff.name, a.kind, 3
    `,
    prisma.budget.findMany({
      where: {
        entityId,
        OR: [
          { year: fyStart, month: { gte: 4 } },
          { year: fyStart + 1, month: { lte: 3 } },
        ],
        // a narrowed view shows that head's target, not everyone's
        ...(view.headAccountId ? { accountId: view.headAccountId } : {}),
      },
    }),
  ])

  const actualBy = new Map<string, Map<string, number>>()
  const kindByName = new Map<string, string>()
  for (const r of actuals) {
    const m = actualBy.get(r.name) ?? new Map<string, number>()
    m.set(r.month, Number(r.amt))
    actualBy.set(r.name, m)
    kindByName.set(r.name, r.kind)
  }
  const accounts = await prisma.ledgerAccount.findMany({
    where: { id: { in: [...new Set(budgets.map((b) => b.accountId))] } },
    select: { id: true, name: true, kind: true },
  })
  const accountName = new Map(accounts.map((a) => [a.id, a.name]))
  for (const a of accounts) if (!kindByName.has(a.name)) kindByName.set(a.name, a.kind)
  const budgetBy = new Map<string, number>()
  for (const b of budgets) {
    const name = accountName.get(b.accountId) ?? b.accountId
    budgetBy.set(name, (budgetBy.get(name) ?? 0) + Number(b.amount))
  }

  // "recent month" = today's month when inside this FY, else the FY's last
  const nowKey = new Date().toISOString().slice(0, 7)
  const recentIdx = Math.max(0, keys.findIndex((k) => k.key === nowKey))
  const recentIdxFinal = keys.some((k) => k.key === nowKey) ? recentIdx : keys.length - 1

  // Budgets belong to the head that POSTED, so whenever the view narrows or
  // regroups by Accounting Head, only keep the ones whose money survived —
  // otherwise every budgeted head still draws a row and the lens looks like
  // it did nothing (Himal, 20 Aug).
  if (view.accountingHeadId || view.lens === 'ah') {
    for (const name of [...budgetBy.keys()]) if (!actualBy.has(name)) budgetBy.delete(name)
  }
  const names = new Set<string>([...actualBy.keys(), ...budgetBy.keys()])
  // accountId per head name, so the budget cells can edit in place
  const headAccounts = await prisma.ledgerAccount.findMany({
    where: { entityId, isGroup: false, name: { in: [...names] } },
    select: { id: true, name: true },
  })
  const idByName = new Map(headAccounts.map((a) => [a.name, a.id]))
  // Sections keep the register readable now that four natures share it —
  // each block totals on its own, so "what did I spend" stays answerable
  // even while EMIs, investments and income sit in the same view.
  const SECTION: Record<string, { label: string; order: number }> = {
    EXPENSE: { label: 'Expenses', order: 0 },
    LIABILITY: { label: 'EMIs & liabilities', order: 1 },
    ASSET: { label: 'Assets, investments & transfers', order: 2 },
    INCOME: { label: 'Income', order: 3 },
    EQUITY: { label: 'Capital', order: 4 },
  }
  const rows = [...names]
    .map((name) => {
      const m = actualBy.get(name)
      const cells = keys.map((k) => m?.get(k.key) ?? 0)
      const total = cells.reduce((s, v) => s + v, 0)
      const yearBudget = budgetBy.get(name) ?? 0
      const monthlyBudget = yearBudget / 12
      const kind = kindByName.get(name) ?? 'EXPENSE'
      return {
        name,
        kind,
        section: (SECTION[kind] ?? SECTION.EXPENSE).label,
        sectionOrder: (SECTION[kind] ?? SECTION.EXPENSE).order,
        accountId: idByName.get(name) ?? null,
        cells,
        total,
        monthlyBudget,
        recentVariance: monthlyBudget - cells[recentIdxFinal],
        yearBudget,
        yearVariance: yearBudget - total,
      }
    })
    .filter((r) => r.total !== 0 || r.yearBudget !== 0)
    .sort(
      (a, b) =>
        a.sectionOrder - b.sectionOrder ||
        Math.abs(b.total) - Math.abs(a.total) ||
        b.yearBudget - a.yearBudget,
    )

  // per-section subtotals, in the order the rows already carry
  const sections = [...new Set(rows.map((r) => r.section))].map((label) => {
    const mine = rows.filter((r) => r.section === label)
    return {
      label,
      cells: keys.map((_, i) => mine.reduce((s, r) => s + r.cells[i], 0)),
      total: mine.reduce((s, r) => s + r.total, 0),
      yearBudget: mine.reduce((s, r) => s + r.yearBudget, 0),
      count: mine.length,
    }
  })

  const colTotals = keys.map((_, i) => rows.reduce((s, r) => s + r.cells[i], 0))
  const grand = colTotals.reduce((s, v) => s + v, 0)
  const budgetGrand = rows.reduce((s, r) => s + r.yearBudget, 0)
  // "Spent" = the Expenses block alone, so the headline number still means
  // what it always did even though the register now shows everything.
  const spent = rows.filter((r) => r.kind === 'EXPENSE').reduce((s, r) => s + r.total, 0)
  return { months: keys, rows, sections, colTotals, grand, spent, budgetGrand, recentIdx: recentIdxFinal }
}

/** Weekly expense totals with the top accounts of each week. */
export async function weeklyExpenses(
  entityId: string,
  weeks = 16,
  view: {
    lens?: 'head' | 'ah'
    headAccountId?: string
    accountingHeadId?: string
    excludeCashAccounts?: string[]
  } = {},
) {
  const from = new Date(Date.now() - weeks * 7 * 86_400_000)
  const rows = await prisma.$queryRaw<{ wk: string; name: string; amt: string }[]>`
    SELECT to_char(date_trunc('week', e.date), 'YYYY-MM-DD') AS wk, eff.name,
           SUM(l.debit - l.credit)::text AS amt
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN "LedgerAccount" a ON a.id = l."accountId"
    LEFT JOIN "HeadMode" hm ON lower(hm.category) = lower(a.name)
    LEFT JOIN LATERAL (
      SELECT x.id FROM "LedgerAccount" x
      WHERE hm."accountingHead" IS NOT NULL AND x."entityId" = a."entityId"
        AND lower(x.name) = lower(hm."accountingHead") AND x."isGroup" = false
      ORDER BY x.code LIMIT 1
    ) mah ON true
    JOIN "LedgerAccount" eff ON eff.id = CASE
      WHEN ${view.lens ?? 'head'} = 'ah' THEN COALESCE(l."accountingHeadId", mah.id, a.id)
      ELSE a.id END
    WHERE e."entityId" = ${entityId} AND a.kind = 'EXPENSE' AND e.date >= ${from}::date
      AND (${view.lens ?? 'head'} <> 'ah'
           OR COALESCE(l."accountingHeadId", mah.id, a.id) <> a.id)
      AND (${view.excludeCashAccounts ?? []}::text[] = '{}'::text[] OR NOT EXISTS (
        SELECT 1 FROM "JournalLine" cl
        WHERE cl."entryId" = e.id AND cl."accountId" = ANY(${view.excludeCashAccounts ?? []})
      ))
      AND (${view.headAccountId ?? null}::text IS NULL OR a.id = ${view.headAccountId ?? null})
      AND (${view.accountingHeadId ?? null}::text IS NULL
           OR COALESCE(l."accountingHeadId", mah.id, a.id) = ${view.accountingHeadId ?? null})
    GROUP BY 1, eff.name HAVING SUM(l.debit - l.credit) > 0
  `
  const byWeek = new Map<string, { total: number; accts: { name: string; amt: number }[] }>()
  rows.forEach((r) => {
    const w = byWeek.get(r.wk) ?? { total: 0, accts: [] }
    w.total += Number(r.amt)
    w.accts.push({ name: r.name, amt: Number(r.amt) })
    byWeek.set(r.wk, w)
  })
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([wk, w]) => ({
      week: wk,
      total: w.total,
      top: w.accts.sort((a, b) => b.amt - a.amt).slice(0, 3),
    }))
}

/** Outflow through banks vs cash locations, per month. */
export async function usageByMonth(entityId: string, months = 12) {
  const keys = monthKeys(months)
  const from = new Date(`${keys[0].key}-01T00:00:00Z`)
  const rows = await prisma.$queryRaw<{ month: string; bank: string | null; cash: string | null }[]>`
    SELECT to_char(date_trunc('month', e.date), 'YYYY-MM') AS month,
           SUM(l.credit) FILTER (WHERE l."accountId" IN (
             SELECT "ledgerAccountId" FROM "BankAccount" WHERE "entityId" = ${entityId} AND "ledgerAccountId" IS NOT NULL
           ))::text AS bank,
           SUM(l.credit) FILTER (WHERE l."accountId" IN (
             SELECT "ledgerAccountId" FROM "CashLocation" WHERE "entityId" = ${entityId} AND "ledgerAccountId" IS NOT NULL
           ))::text AS cash
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE e."entityId" = ${entityId} AND e.date >= ${from}::date
    GROUP BY 1
  `
  const byMonth = new Map(rows.map((r) => [r.month, r]))
  return keys.map((k) => ({
    label: k.label,
    bank: Number(byMonth.get(k.key)?.bank ?? 0),
    cash: Number(byMonth.get(k.key)?.cash ?? 0),
  }))
}

/** Every bank account and cash location: receipts, payments, closing. */
export async function bankBalancesReport(entityId: string) {
  const [banks, cashLocs] = await Promise.all([
    prisma.bankAccount.findMany({ where: { entityId, ledgerAccountId: { not: null } } }),
    prisma.cashLocation.findMany({ where: { entityId, ledgerAccountId: { not: null } } }),
  ])
  const accounts = [
    ...banks.map((b) => ({ id: b.ledgerAccountId!, label: b.nickname, type: b.bankName })),
    ...cashLocs.map((c) => ({ id: c.ledgerAccountId!, label: c.name, type: 'Cash' })),
  ]
  if (accounts.length === 0) return []
  const sums = await prisma.$queryRaw<{ id: string; dr: string; cr: string }[]>`
    SELECT l."accountId" AS id, SUM(l.debit)::text AS dr, SUM(l.credit)::text AS cr
    FROM "JournalLine" l
    WHERE l."accountId" IN (${Prisma.join(accounts.map((a) => a.id))})
    GROUP BY 1
  `
  const byId = new Map(sums.map((s) => [s.id, s]))
  return accounts.map((a) => {
    const s = byId.get(a.id)
    const dr = Number(s?.dr ?? 0)
    const cr = Number(s?.cr ?? 0)
    return { ...a, receipts: dr, payments: cr, closing: dr - cr }
  })
}

/** Taxes & statutory payments — expense accounts that look like tax heads. */
export async function taxesPaid(entityId: string) {
  const rows = await prisma.$queryRaw<{ name: string; amt: string }[]>`
    SELECT a.name, SUM(l.debit - l.credit)::text AS amt
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN "LedgerAccount" a ON a.id = l."accountId"
    WHERE e."entityId" = ${entityId} AND a.kind = 'EXPENSE'
      AND a.name ~* 'income tax|tds|professional tax|advance tax|gst'
    GROUP BY a.name HAVING SUM(l.debit - l.credit) <> 0
    ORDER BY 2 DESC
  `
  return rows.map((r) => ({ name: r.name, amount: Number(r.amt) }))
}

/** Investment & other income by month + amounts moved into investments. */
export async function investmentReport(entityId: string, months = 12) {
  const keys = monthKeys(months)
  const from = new Date(`${keys[0].key}-01T00:00:00Z`)
  const income = await prisma.$queryRaw<{ name: string; month: string; amt: string }[]>`
    SELECT a.name, to_char(date_trunc('month', e.date), 'YYYY-MM') AS month,
           SUM(l.credit - l.debit)::text AS amt
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN "LedgerAccount" a ON a.id = l."accountId"
    WHERE e."entityId" = ${entityId} AND a.kind = 'INCOME'
      AND a.name ~* 'interest|dividend|capital gain|investment'
      AND e.date >= ${from}::date
    GROUP BY a.name, 2
  `
  const invested = await prisma.$queryRaw<{ name: string; month: string; amt: string }[]>`
    SELECT a.name, to_char(date_trunc('month', e.date), 'YYYY-MM') AS month,
           SUM(l.debit - l.credit)::text AS amt
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN "LedgerAccount" a ON a.id = l."accountId"
    WHERE e."entityId" = ${entityId} AND a.kind = 'ASSET'
      AND a.name ~* 'invest|shares|mutual|sip|fixed deposit'
      AND e.date >= ${from}::date
    GROUP BY a.name, 2
  `
  const fold = (rows: { name: string; month: string; amt: string }[]) => {
    const byName = new Map<string, Map<string, number>>()
    rows.forEach((r) => {
      const m = byName.get(r.name) ?? new Map()
      m.set(r.month, Number(r.amt))
      byName.set(r.name, m)
    })
    return [...byName.entries()]
      .map(([name, m]) => {
        const cells = keys.map((k) => m.get(k.key) ?? 0)
        return { name, cells, total: cells.reduce((s, v) => s + v, 0) }
      })
      .filter((r) => r.total !== 0)
      .sort((a, b) => b.total - a.total)
  }
  return { months: keys, income: fold(income), invested: fold(invested) }
}
