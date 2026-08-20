import Link from 'next/link'
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { requireUser, hasPermission, isAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { LiveFilter } from '@/components/live-filter'
import { PageHeader, chipClass, controlClass, tableWrapClass, theadClass } from '@/components/ui'

// One report, three lenses (Himal, 19 Aug): the same FY months grid seen
// by Cost centre, by Expense Head, or by Accounting head (the chart's top
// groups). Every figure is a live ledger query — tagging fills it, nothing
// is typed. Rows link to the ledger where they can.
//
// Second tagging dimension (Himal, 19/20 Aug — the "Accounting Head"):
// every tag carries a 2nd head that mirrors the Expense Head unless changed
// while tagging. The Accounting Head scope shows exactly the entries whose
// 2nd head was changed, grouped under that head's name, in EVERY nature so
// asset buys (laptop, car) count alongside expenses. No master flag — the
// tag itself decides. The books view (All heads scope) never moves.

const L = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar']
const inr = (n: number) => (Math.round(n) ? (n < 0 ? '-₹' : '₹') + Math.abs(Math.round(n)).toLocaleString('en-IN') : '—')

const LENSES = [
  { key: 'cc', label: 'Cost centre' },
  { key: 'head', label: 'Expense Head' },
  { key: 'group', label: 'Account group' },
] as const

export default async function ByDimensionPage({
  searchParams,
}: {
  searchParams: Promise<{ by?: string; fy?: string; scope?: string }>
}) {
  const user = await requireUser()
  if (!isAdmin(user) && !hasPermission(user, 'viewFinancialReports')) {
    throw new Error('Forbidden: missing permission "viewFinancialReports"')
  }
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>

  const params = await searchParams
  const by = LENSES.some((l) => l.key === params.by) ? (params.by as string) : 'cc'
  const sep = params.scope === 'sep'
  const now = new Date()
  const currentFy = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
  const fy = Number(params.fy) || currentFy
  const from = new Date(Date.UTC(fy, 3, 1))
  const to = new Date(Date.UTC(fy + 1, 3, 1))
  const keys = Array.from({ length: 12 }, (_, i) => {
    const year = i < 9 ? fy : fy + 1
    const month = i < 9 ? i + 4 : i - 8
    return `${year}-${String(month).padStart(2, '0')}`
  })

  // one query shape per lens: name × month × net movement (Dr − Cr).
  // Normal scope = expense + income heads, grouped by the head that POSTED.
  // Accounting Head scope: exactly the lines whose tag was given its own
  // Accounting Head (accountingHeadId set — mirror lines stay out), in
  // EVERY nature (asset buys count too), grouped under the Accounting
  // Head's name, not the Expense Head's. No master flag — the tag decides.
  const eff = Prisma.sql`COALESCE(ah.name, a.name)`
  const scopeFilter = sep
    ? Prisma.sql`AND l."accountingHeadId" IS NOT NULL`
    : Prisma.sql`AND a.kind IN ('EXPENSE', 'INCOME')`
  let rows: { name: string; id: string | null; month: string; amt: string }[] = []
  if (by === 'cc') {
    rows = await prisma.$queryRaw`
      SELECT COALESCE(cc.name, '(no cost centre)') AS name, cc.id AS id,
             to_char(date_trunc('month', e.date), 'YYYY-MM') AS month,
             SUM(l.debit - l.credit)::text AS amt
      FROM "JournalLine" l
      JOIN "JournalEntry" e ON e.id = l."entryId"
      JOIN "LedgerAccount" a ON a.id = l."accountId"
      LEFT JOIN "LedgerAccount" ah ON ah.id = l."accountingHeadId"
      LEFT JOIN "CostCentre" cc ON cc.id = l."costCentreId"
      WHERE e."entityId" = ${entity.id} ${scopeFilter}
        AND e.date >= ${from}::date AND e.date < ${to}::date
      GROUP BY 1, 2, 3`
  } else if (by === 'head') {
    rows = await prisma.$queryRaw`
      SELECT ${sep ? eff : Prisma.sql`a.name`} AS name,
             ${sep ? Prisma.sql`COALESCE(ah.id, a.id)` : Prisma.sql`a.id`} AS id,
             to_char(date_trunc('month', e.date), 'YYYY-MM') AS month,
             SUM(l.debit - l.credit)::text AS amt
      FROM "JournalLine" l
      JOIN "JournalEntry" e ON e.id = l."entryId"
      JOIN "LedgerAccount" a ON a.id = l."accountId"
      LEFT JOIN "LedgerAccount" ah ON ah.id = l."accountingHeadId"
      WHERE e."entityId" = ${entity.id} ${scopeFilter}
        AND e.date >= ${from}::date AND e.date < ${to}::date
      GROUP BY 1, 2, 3`
  } else {
    rows = await prisma.$queryRaw`
      SELECT root.name AS name, NULL AS id,
             to_char(date_trunc('month', e.date), 'YYYY-MM') AS month,
             SUM(l.debit - l.credit)::text AS amt
      FROM "JournalLine" l
      JOIN "JournalEntry" e ON e.id = l."entryId"
      JOIN "LedgerAccount" a ON a.id = l."accountId"
      LEFT JOIN "LedgerAccount" ah ON ah.id = l."accountingHeadId"
      JOIN "LedgerAccount" root
        ON root."entityId" = a."entityId"
        AND root.code = left(${sep ? Prisma.sql`COALESCE(ah.code, a.code)` : Prisma.sql`a.code`}, 1) || '000'
      WHERE e."entityId" = ${entity.id} ${sep ? scopeFilter : Prisma.empty}
        AND e.date >= ${from}::date AND e.date < ${to}::date
      GROUP BY 1, 2, 3`
  }

  const byName = new Map<string, { id: string | null; cells: Map<string, number> }>()
  for (const r of rows) {
    const entry = byName.get(r.name) ?? { id: r.id, cells: new Map<string, number>() }
    entry.cells.set(r.month, (entry.cells.get(r.month) ?? 0) + Number(r.amt))
    byName.set(r.name, entry)
  }
  const table = [...byName.entries()]
    .map(([name, e]) => {
      const cells = keys.map((k) => e.cells.get(k) ?? 0)
      return { name, id: e.id, cells, total: cells.reduce((s, v) => s + v, 0) }
    })
    .filter((r) => r.total !== 0 || r.cells.some((c) => c !== 0))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
  const colTotals = keys.map((_, i) => table.reduce((s, r) => s + r.cells[i], 0))
  const grand = colTotals.reduce((s, v) => s + v, 0)
  const cellR = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap'

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Report"
        title={`By ${LENSES.find((l) => l.key === by)?.label}${sep ? ' · Accounting Head' : ''} — ${entity.code}`}
        subtitle={
          sep
            ? `Entries given their own Accounting Head while tagging — grouped under it, every nature, asset buys included. FY ${fy}-${String(fy + 1).slice(2)}.`
            : `Live from tagged entries, FY ${fy}-${String(fy + 1).slice(2)}. Positive = money out, negative = money in.`
        }
        actions={
          <>
            {LENSES.map((l) => (
              <Link key={l.key} href={`/reports/by?by=${l.key}&fy=${fy}${sep ? '&scope=sep' : ''}`} className={chipClass(by === l.key)}>
                {l.label}
              </Link>
            ))}
            {[currentFy - 1, currentFy].map((y) => (
              <Link key={y} href={`/reports/by?by=${by}&fy=${y}${sep ? '&scope=sep' : ''}`} className={chipClass(fy === y)}>
                FY {y}-{String(y + 1).slice(2)}
              </Link>
            ))}
            {/* the second tagging dimension — all heads vs the Yes-flagged ones */}
            <span className="mx-1 h-4 w-px bg-line" aria-hidden />
            <Link href={`/reports/by?by=${by}&fy=${fy}`} className={chipClass(!sep)}>
              All heads
            </Link>
            <Link href={`/reports/by?by=${by}&fy=${fy}&scope=sep`} className={chipClass(sep)}>
              Accounting Head
            </Link>
            <LiveFilter selector="[data-live-filter='by']" placeholder="Type to search…" className={`${controlClass} w-40`} />
          </>
        }
      />

      <div className={tableWrapClass}>
        <table data-live-filter="by" className="w-full min-w-[1000px] text-xs">
          <thead className={theadClass}>
            <tr>
              <th className="px-3 py-2">{LENSES.find((l) => l.key === by)?.label}</th>
              {keys.map((k, i) => (
                <th key={k} className={cellR}>{L[i]}</th>
              ))}
              <th className={cellR}>Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2 text-sm">
            {table.map((r) => (
              <tr key={r.name} className="hover:bg-surface-2/60">
                <td className="px-3 py-1.5 text-ink">
                  {by === 'head' && r.id ? (
                    <Link href={`/admin/ledgers?accountId=${r.id}`} className="hover:underline">{r.name}</Link>
                  ) : (
                    r.name
                  )}
                </td>
                {r.cells.map((c, i) => (
                  <td key={i} className={`${cellR} ${c < 0 ? 'text-success' : 'text-ink-2'}`}>{inr(c)}</td>
                ))}
                <td className={`${cellR} font-semibold ${r.total < 0 ? 'text-success' : ''}`}>{inr(r.total)}</td>
              </tr>
            ))}
            <tr data-filter-keep="1" className="bg-surface-2/60 font-semibold">
              <td className="px-3 py-1.5">Total</td>
              {colTotals.map((c, i) => (
                <td key={i} className={cellR}>{inr(c)}</td>
              ))}
              <td className={cellR}>{inr(grand)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {table.length === 0 && (
        <p className="text-sm text-ink-3">
          {sep ? (
            <>
              Nothing here for FY {fy}-{String(fy + 1).slice(2)} yet — while{' '}
              <Link href="/tagging" className="text-primary hover:underline">
                tagging
              </Link>
              , change an entry&apos;s Accounting Head (it mirrors the Expense Head until you do); those entries
              show here, grouped under the head you picked.
            </>
          ) : (
            <>Nothing tagged in FY {fy}-{String(fy + 1).slice(2)} for this lens yet.</>
          )}
        </p>
      )}
    </div>
  )
}
