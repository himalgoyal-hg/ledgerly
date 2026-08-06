import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { salaryReport } from '@/lib/reports/analysis'
import { ReportHeader } from '../report-chrome'

// Salary report (spec §10): approved and paid runs for a year, per person,
// with the TDS section each deduction sits under.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export default async function SalaryReportPage(props: {
  searchParams: Promise<{ year?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const params = await props.searchParams
  const year = Number(params.year) || new Date().getUTCFullYear()
  const report = await salaryReport(entity.id, year)

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Salary report"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={`${year} — gross ${displayINR(report.gross)} · TDS ${displayINR(
          report.tds,
        )} · net ${displayINR(report.net)}`}
        filters={
          <>
            <input
              type="number"
              name="year"
              defaultValue={year}
              className="w-24 rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
            />
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
            >
              Apply
            </button>
          </>
        }
        exportHref={`/reports/export?report=salary&year=${year}`}
      />

      <div className="space-y-4">
        {report.months.map((month) => (
          <div key={month.runId} className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-2">
              <h2 className="text-sm font-medium text-zinc-900">
                {MONTHS[month.month - 1]} {year}
              </h2>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  month.status === 'PAID'
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-sky-100 text-sky-700'
                }`}
              >
                {month.status.toLowerCase()}
              </span>
              <span className="ml-auto text-xs text-zinc-500">
                gross {displayINR(month.gross)} · TDS {displayINR(month.tds)} · net{' '}
                {displayINR(month.net)}
              </span>
            </div>
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-zinc-400">
                <tr>
                  <th className="px-4 py-1 font-medium">Person</th>
                  <th className="px-4 py-1 font-medium">Type</th>
                  <th className="px-4 py-1 font-medium">Cost centre</th>
                  <th className="px-4 py-1 text-right font-medium">Gross</th>
                  <th className="px-4 py-1 text-right font-medium">TDS</th>
                  <th className="px-4 py-1 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {month.lines.map((line) => (
                  <tr key={`${month.runId}-${line.name}`}>
                    <td className="px-4 py-1.5 text-zinc-800">{line.name}</td>
                    <td className="px-4 py-1.5 text-xs text-zinc-500">
                      {line.type === 'SALARY' ? 'Salary' : 'Consultant'}
                      <span className="ml-1 text-zinc-400">u/s {line.section}</span>
                    </td>
                    <td className="px-4 py-1.5 text-xs text-zinc-500">{line.costCentre}</td>
                    <td className="px-4 py-1.5 text-right text-zinc-700">{displayINR(line.gross)}</td>
                    <td className="px-4 py-1.5 text-right text-zinc-500">− {displayINR(line.tds)}</td>
                    <td className="px-4 py-1.5 text-right font-medium text-zinc-900">
                      {displayINR(line.net)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {report.months.length === 0 && (
          <p className="text-sm text-zinc-400">No approved salary runs in {year}.</p>
        )}
      </div>
    </div>
  )
}
