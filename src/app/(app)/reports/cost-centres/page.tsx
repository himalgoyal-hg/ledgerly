import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { costCentreReport } from '@/lib/reports/analysis'
import { tableWrapClass, theadClass } from '@/components/ui'
import { prisma } from '@/lib/db'
import { ReportHeader, DateRangeFilters, HeadLensFilters, readHeadLens, CashToggle, ResetFilters } from '../report-chrome'
import { cashAccountIds, readCashToggle } from '@/lib/reports/cash-filter'

// Expense by cost centre (spec §10). Untagged spend is shown, not hidden —
// it is the queue of work for whoever tags.

export default async function CostCentreReportPage(props: {
  searchParams: Promise<{ from?: string; to?: string; by?: string; head?: string; ah?: string; cash?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>

  const params = await props.searchParams
  const view = readHeadLens(params)
  const [report, lensHeads] = await Promise.all([
    costCentreReport(entity.id, {
      from: params.from ? new Date(params.from) : undefined,
      to: params.to ? new Date(params.to) : undefined,
      ...view,
      excludeCashAccounts: readCashToggle(params) ? [] : await cashAccountIds(entity.id),
    }),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, kind: true },
    }),
  ])
  const nameOf = (id?: string) => lensHeads.find((h) => h.id === id)?.name
  const query = new URLSearchParams({
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
    ...(view.headAccountId ? { head: view.headAccountId } : {}),
    ...(view.accountingHeadId ? { ah: view.accountingHeadId } : {}),
    ...(view.lens === 'ah' ? { by: 'ah' } : {}),
  })
  const max = Math.max(1, ...report.rows.map((r) => Math.abs(Number(r.net))))

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Expense by cost centre"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={[
          params.from || params.to ? `${params.from ?? 'start'} to ${params.to ?? 'today'}` : 'All time',
          view.headAccountId ? `only ${nameOf(view.headAccountId) ?? '—'}` : '',
          view.accountingHeadId ? `only entries under ${nameOf(view.accountingHeadId) ?? '—'}` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
        filters={
          <>
            {/* rows here are cost centres, so the lens narrows rather than
                regroups — pick a head and see its centres alone */}
            <HeadLensFilters
              base="/reports/cost-centres"
              lens={view.lens}
              keep={{ from: params.from, to: params.to }}
              headOptions={lensHeads}
              ahOptions={lensHeads}
              pickedHead={params.head}
              pickedAh={params.ah}
            />
            <CashToggle base="/reports/cost-centres" showing={readCashToggle(params)} keep={{ from: params.from, to: params.to, by: params.by, head: params.head, ah: params.ah }} />
            <ResetFilters base="/reports/cost-centres" active={Boolean(params.head || params.ah || params.by || params.from || params.to || params.cash)} />
            <DateRangeFilters from={params.from} to={params.to} />
          </>
        }
        exportHref={`/reports/export?report=cost-centres&${query}`}
      />

      <div className={tableWrapClass}>
        <table className="w-full text-left text-sm">
          <thead className={theadClass}>
            <tr>
              <th className="px-4 py-2">Cost centre</th>
              <th className="px-4 py-2 text-right">Expense</th>
              <th className="px-4 py-2 text-right">Income</th>
              <th className="px-4 py-2 text-right">Net spend</th>
              <th className="w-40 px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            {report.rows.map((row) => (
              <tr key={row.costCentreId ?? 'untagged'}>
                <td className="px-4 py-2 text-ink">
                  {row.name}
                  {row.costCentreId === null && (
                    <span className="ml-2 rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">
                      untagged
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right text-ink-2">{displayINR(row.expense)}</td>
                <td className="px-4 py-2 text-right text-ink-2">{displayINR(row.income)}</td>
                <td className="px-4 py-2 text-right font-medium text-ink">
                  {displayINR(row.net)}
                </td>
                <td className="px-4 py-2">
                  <div className="h-2 w-full rounded bg-surface-2">
                    <div
                      className="h-2 rounded bg-ink-3"
                      style={{ width: `${Math.round((Math.abs(Number(row.net)) / max) * 100)}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-ink-3">
                  No income or expense postings in this range.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="border-t border-line font-medium text-ink">
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
