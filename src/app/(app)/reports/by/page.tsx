import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireUser, hasPermission, isAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { LiveFilter } from '@/components/live-filter'

// One report, three lenses (Himal, 19 Aug): the same FY months grid seen
// by Cost centre, by Expense Head, or by Accounting head (the chart's top
// groups). Every figure is a live ledger query — tagging fills it, nothing
// is typed. Rows link to the ledger where they can.

const L = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar']
const inr = (n: number) => (Math.round(n) ? (n < 0 ? '-₹' : '₹') + Math.abs(Math.round(n)).toLocaleString('en-IN') : '—')

const LENSES = [
  { key: 'cc', label: 'Cost centre' },
  { key: 'head', label: 'Expense Head' },
  { key: 'group', label: 'Accounting head' },
] as const

export default async function ByDimensionPage({
  searchParams,
}: {
  searchParams: Promise<{ by?: string; fy?: string }>
}) {
  const user = await requireUser()
  if (!isAdmin(user) && !hasPermission(user, 'viewFinancialReports')) {
    throw new Error('Forbidden: missing permission "viewFinancialReports"')
  }
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>

  const params = await searchParams
  const by = LENSES.some((l) => l.key === params.by) ? (params.by as string) : 'cc'
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

  // one query shape per lens: name × month × net movement (Dr − Cr)
  let rows: { name: string; id: string | null; month: string; amt: string }[] = []
  if (by === 'cc') {
    rows = await prisma.$queryRaw`
      SELECT COALESCE(cc.name, '(no cost centre)') AS name, cc.id AS id,
             to_char(date_trunc('month', e.date), 'YYYY-MM') AS month,
             SUM(l.debit - l.credit)::text AS amt
      FROM "JournalLine" l
      JOIN "JournalEntry" e ON e.id = l."entryId"
      JOIN "LedgerAccount" a ON a.id = l."accountId"
      LEFT JOIN "CostCentre" cc ON cc.id = l."costCentreId"
      WHERE e."entityId" = ${entity.id} AND a.kind IN ('EXPENSE', 'INCOME')
        AND e.date >= ${from}::date AND e.date < ${to}::date
      GROUP BY 1, 2, 3`
  } else if (by === 'head') {
    rows = await prisma.$queryRaw`
      SELECT a.name AS name, a.id AS id,
             to_char(date_trunc('month', e.date), 'YYYY-MM') AS month,
             SUM(l.debit - l.credit)::text AS amt
      FROM "JournalLine" l
      JOIN "JournalEntry" e ON e.id = l."entryId"
      JOIN "LedgerAccount" a ON a.id = l."accountId"
      WHERE e."entityId" = ${entity.id} AND a.kind IN ('EXPENSE', 'INCOME')
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
      JOIN "LedgerAccount" root
        ON root."entityId" = a."entityId" AND root.code = left(a.code, 1) || '000'
      WHERE e."entityId" = ${entity.id}
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
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">
            By {LENSES.find((l) => l.key === by)?.label} — {entity.code}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Live from tagged entries, FY {fy}-{String(fy + 1).slice(2)}. Positive = money out, negative = money in.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {LENSES.map((l) => (
            <Link
              key={l.key}
              href={`/reports/by?by=${l.key}&fy=${fy}`}
              className={`rounded-full border px-3 py-1 text-xs ${
                by === l.key
                  ? 'border-zinc-900 bg-zinc-900 text-white'
                  : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              {l.label}
            </Link>
          ))}
          {[currentFy - 1, currentFy].map((y) => (
            <Link
              key={y}
              href={`/reports/by?by=${by}&fy=${y}`}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                fy === y ? 'border-sky-600 bg-sky-600 text-white' : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              FY {y}-{String(y + 1).slice(2)}
            </Link>
          ))}
          <LiveFilter selector="[data-live-filter='by']" placeholder="Type to search…" className="w-40 rounded-md border border-zinc-300 px-2.5 py-1 text-sm focus:border-zinc-500 focus:outline-none" />
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table data-live-filter="by" className="w-full min-w-[1000px] text-xs">
          <thead className="border-b border-zinc-200 text-left uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2">{LENSES.find((l) => l.key === by)?.label}</th>
              {keys.map((k, i) => (
                <th key={k} className={cellR}>{L[i]}</th>
              ))}
              <th className={cellR}>Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 text-sm">
            {table.map((r) => (
              <tr key={r.name} className="hover:bg-zinc-50">
                <td className="px-3 py-1.5 text-zinc-800">
                  {by === 'head' && r.id ? (
                    <Link href={`/admin/ledgers?accountId=${r.id}`} className="hover:underline">{r.name}</Link>
                  ) : (
                    r.name
                  )}
                </td>
                {r.cells.map((c, i) => (
                  <td key={i} className={`${cellR} ${c < 0 ? 'text-emerald-700' : 'text-zinc-600'}`}>{inr(c)}</td>
                ))}
                <td className={`${cellR} font-semibold ${r.total < 0 ? 'text-emerald-700' : ''}`}>{inr(r.total)}</td>
              </tr>
            ))}
            <tr data-filter-keep="1" className="bg-zinc-50 font-semibold">
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
        <p className="text-sm text-zinc-400">Nothing tagged in FY {fy}-{String(fy + 1).slice(2)} for this lens yet.</p>
      )}
    </div>
  )
}
