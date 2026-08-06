import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { costCentreReport } from '@/lib/reports/analysis'
import { ReportHeader, DateRangeFilters } from '../report-chrome'

// Expense by cost centre (spec §10). Untagged spend is shown, not hidden —
// it is the queue of work for whoever tags.

export default async function CostCentreReportPage(props: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const params = await props.searchParams
  const report = await costCentreReport(entity.id, {
    from: params.from ? new Date(params.from) : undefined,
    to: params.to ? new Date(params.to) : undefined,
  })
  const query = new URLSearchParams({
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
  })
  const max = Math.max(1, ...report.rows.map((r) => Math.abs(Number(r.net))))

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Expense by cost centre"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={
          params.from || params.to
            ? `${params.from ?? 'start'} to ${params.to ?? 'today'}`
            : 'All time'
        }
        filters={<DateRangeFilters from={params.from} to={params.to} />}
        exportHref={`/reports/export?report=cost-centres&${query}`}
      />

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-2">Cost centre</th>
              <th className="px-4 py-2 text-right">Expense</th>
              <th className="px-4 py-2 text-right">Income</th>
              <th className="px-4 py-2 text-right">Net spend</th>
              <th className="w-40 px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {report.rows.map((row) => (
              <tr key={row.costCentreId ?? 'untagged'}>
                <td className="px-4 py-2 text-zinc-800">
                  {row.name}
                  {row.costCentreId === null && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      untagged
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right text-zinc-700">{displayINR(row.expense)}</td>
                <td className="px-4 py-2 text-right text-zinc-500">{displayINR(row.income)}</td>
                <td className="px-4 py-2 text-right font-medium text-zinc-900">
                  {displayINR(row.net)}
                </td>
                <td className="px-4 py-2">
                  <div className="h-2 w-full rounded bg-zinc-100">
                    <div
                      className="h-2 rounded bg-zinc-400"
                      style={{ width: `${Math.round((Math.abs(Number(row.net)) / max) * 100)}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-zinc-400">
                  No income or expense postings in this range.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="border-t border-zinc-300 font-medium text-zinc-900">
            <tr>
              <td className="px-4 py-2" colSpan={3}>
                Total net spend
              </td>
              <td className="px-4 py-2 text-right">{displayINR(report.total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
