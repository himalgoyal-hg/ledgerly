import { prisma } from '@/lib/db'
import { requireUser, isAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { budgetVsActual } from '@/lib/reports/analysis'
import { buttonClass, controlClass, tableWrapClass, theadClass } from '@/components/ui'
import { ReportHeader } from '../report-chrome'
import { setBudget } from './actions'

// Budget vs Actual (spec §10). Budgets are per account-month; actuals come
// from the ledger. Setting targets is Admin-only; viewing follows the
// financial-reports permission.

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

export default async function BudgetPage(props: {
  searchParams: Promise<{ year?: string; month?: string }>
}) {
  const user = await requireUser()
  const admin = isAdmin(user)
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>

  const params = await props.searchParams
  const year = Number(params.year) || new Date().getUTCFullYear()
  const monthFilter = Number(params.month) || 0 // 0 = whole year
  const months = monthFilter ? [monthFilter] : Array.from({ length: 12 }, (_, i) => i + 1)

  const [report, accounts] = await Promise.all([
    budgetVsActual(entity.id, year, months),
    prisma.ledgerAccount.findMany({
      where: {
        entityId: entity.id,
        isGroup: false,
        archivedAt: null,
        kind: { in: ['EXPENSE', 'INCOME'] },
      },
      orderBy: { code: 'asc' },
    }),
    prisma.budget.findMany({
      where: { entityId: entity.id, year },
      select: { accountId: true, frequency: true },
      distinct: ['accountId'],
    }),
  ])
  // "set weekly" / "set quarterly" chip — how each target was entered.
  const query = new URLSearchParams({
    year: String(year),
    ...(monthFilter ? { month: String(monthFilter) } : {}),
  })

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Budget vs Actual"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={monthFilter ? `${MONTHS[monthFilter - 1]} ${year}` : `Full year ${year}`}
        filters={
          <>
            <input
              type="number"
              name="year"
              defaultValue={year}
              className={`${controlClass} w-24`}
            />
            <select
              name="month"
              defaultValue={String(monthFilter)}
              className={controlClass}
            >
              <option value="0">Full year</option>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2"
            >
              Apply
            </button>
          </>
        }
        exportHref={`/reports/export?report=budget&${query}`}
      />

      {admin && (
        <details className="rounded-2xl border border-line bg-surface shadow-card print:hidden">
          <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-ink hover:bg-surface-2/60">
            ＋ Set a budget target
          </summary>
          <div className="border-t border-line-2 p-4">
          <form action={setBudget} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="entityId" value={entity.id} />
            <input type="hidden" name="year" value={year} />
            <select
              name="accountId"
              required
              className={`${controlClass} min-w-56`}
            >
              <option value="">— account —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </select>
            <select name="month" className={controlClass}>
              <option value="">Whole year</option>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m} {year}</option>
              ))}
            </select>
            <input
              name="amount"
              inputMode="decimal"
              placeholder="Amount ₹ (blank clears)"
              className={`${controlClass} w-44`}
            />
            <select name="frequency" className={controlClass}>
              <option value="ANNUAL">per year</option>
              <option value="MONTHLY">per month</option>
              <option value="WEEKLY">per week</option>
              <option value="QUARTERLY">per quarter</option>
              <option value="HALF_YEARLY">per half-year</option>
            </select>
            <button
              type="submit"
              className={buttonClass('primary')}
            >
              Save target
            </button>
          </form>
          <p className="mt-2 text-xs text-ink-3">
            Whole-year targets are annualised from the frequency (₹1,000/week → ₹52,000/yr) and
            spread over the twelve months. Picking a specific month takes the amount as-is.
          </p>
          </div>
        </details>
      )}

      <div className={tableWrapClass}>
        <table className="w-full text-left text-sm">
          <thead className={theadClass}>
            <tr>
              <th className="px-4 py-2">Account</th>
              <th className="px-4 py-2 text-right">Budget</th>
              <th className="px-4 py-2 text-right">Actual</th>
              <th className="px-4 py-2 text-right">Variance</th>
              <th className="w-44 px-4 py-2">Used</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            {report.rows.map((row) => {
              const over = Number(row.variance) < 0
              const pct = row.usedPct ?? 0
              return (
                <tr key={row.accountId}>
                  <td className="px-4 py-2">
                    <span className="font-mono text-xs text-ink-3">{row.code}</span> {row.name}
                  </td>
                  <td className="px-4 py-2 text-right text-ink-2">
                    {admin ? (
                      // Excel-style: the number IS the input — type, Enter,
                      // saved (blank clears). Year view spreads the annual
                      // figure over twelve months; month view sets that month.
                      <form action={setBudget} className="flex items-center justify-end gap-1">
                        <input type="hidden" name="entityId" value={entity.id} />
                        <input type="hidden" name="accountId" value={row.accountId} />
                        <input type="hidden" name="year" value={year} />
                        <input type="hidden" name="month" value={monthFilter ? String(monthFilter) : ''} />
                        <input type="hidden" name="frequency" value="ANNUAL" />
                        <input
                          name="amount"
                          inputMode="decimal"
                          defaultValue={Number(row.budget) ? String(Math.round(Number(row.budget))) : ''}
                          title={
                            monthFilter
                              ? 'Target for this month — Enter to save, blank clears'
                              : 'Whole-year target, spread over 12 months — Enter to save, blank clears'
                          }
                          className="w-28 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-right tabular-nums text-ink-2 hover:border-line focus:border-primary focus:bg-surface focus:outline-none"
                        />
                        <button
                          type="submit"
                          title="Save"
                          className="rounded border border-line px-1 text-[10px] text-ink-3 hover:bg-surface-2 hover:text-ink-2"
                        >
                          ✓
                        </button>
                      </form>
                    ) : (
                      displayINR(row.budget)
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-ink">{displayINR(row.actual)}</td>
                  <td
                    className={`px-4 py-2 text-right font-medium ${
                      over ? 'text-danger' : 'text-success'
                    }`}
                  >
                    {over
                      ? `(${displayINR(String(-Number(row.variance)))})`
                      : displayINR(row.variance)}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 rounded bg-surface-2">
                        <div
                          className={`h-2 rounded ${over ? 'bg-danger' : 'bg-success'}`}
                          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                        />
                      </div>
                      <span className="w-12 text-right text-xs text-ink-2">
                        {row.usedPct === null ? '—' : `${row.usedPct}%`}
                      </span>
                    </div>
                  </td>
                </tr>
              )
            })}
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-ink-3">
                  No budgets set for {year}.
                  {admin && ' Set targets below.'}
                </td>
              </tr>
            )}
          </tbody>
          {report.rows.length > 0 && (
            <tfoot className="border-t border-line font-medium text-ink">
              <tr>
                <td className="px-4 py-2">Totals</td>
                <td className="px-4 py-2 text-right">{displayINR(report.budgetTotal)}</td>
                <td className="px-4 py-2 text-right">{displayINR(report.actualTotal)}</td>
                <td className="px-4 py-2 text-right">{displayINR(report.varianceTotal)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

    </div>
  )
}
