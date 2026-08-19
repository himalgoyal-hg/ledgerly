import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { salaryReport } from '@/lib/reports/analysis'
import { ReportHeader } from '../report-chrome'
import { controlClass, theadClass } from '@/components/ui'

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
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>

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
              className={`${controlClass} w-24`}
            />
            <button
              type="submit"
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              Apply
            </button>
          </>
        }
        exportHref={`/reports/export?report=salary&year=${year}`}
      />

      <div className="space-y-4">
        {report.months.map((month) => (
          <div key={month.runId} className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
              <h2 className="text-sm font-medium text-ink">
                {MONTHS[month.month - 1]} {year}
              </h2>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  month.status === 'PAID'
                    ? 'bg-success-soft text-success'
                    : 'bg-primary-soft text-primary'
                }`}
              >
                {month.status.toLowerCase()}
              </span>
              <span className="ml-auto text-xs text-ink-2">
                gross {displayINR(month.gross)} · TDS {displayINR(month.tds)} · net{' '}
                {displayINR(month.net)}
              </span>
            </div>
            <table className="w-full text-left text-sm">
              <thead className={theadClass}>
                <tr>
                  <th className="px-4 py-1 font-medium">Person</th>
                  <th className="px-4 py-1 font-medium">Type</th>
                  <th className="px-4 py-1 font-medium">Cost centre</th>
                  <th className="px-4 py-1 text-right font-medium">Gross</th>
                  <th className="px-4 py-1 text-right font-medium">TDS</th>
                  <th className="px-4 py-1 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2">
                {month.lines.map((line) => (
                  <tr key={`${month.runId}-${line.name}`}>
                    <td className="px-4 py-1.5 text-ink">{line.name}</td>
                    <td className="px-4 py-1.5 text-xs text-ink-2">
                      {line.type === 'SALARY' ? 'Salary' : 'Consultant'}
                      <span className="ml-1 text-ink-3">u/s {line.section}</span>
                    </td>
                    <td className="px-4 py-1.5 text-xs text-ink-2">{line.costCentre}</td>
                    <td className="px-4 py-1.5 text-right text-ink-2">{displayINR(line.gross)}</td>
                    <td className="px-4 py-1.5 text-right text-ink-2">− {displayINR(line.tds)}</td>
                    <td className="px-4 py-1.5 text-right font-medium text-ink">
                      {displayINR(line.net)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {report.months.length === 0 && (
          <p className="text-sm text-ink-3">No approved salary runs in {year}.</p>
        )}
      </div>
    </div>
  )
}
