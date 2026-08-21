import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { weeklyExpenses } from '@/lib/reports/prototype'
import { PageHeader, tableWrapClass, theadClass } from '@/components/ui'
import { HeadLensFilters, readHeadLens } from '../report-chrome'

const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN')

export default async function WeeklyPage(props: {
  searchParams: Promise<{ by?: string; head?: string; ah?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>
  const params = await props.searchParams
  const view = readHeadLens(params)
  const [weeks, lensHeads] = await Promise.all([
    weeklyExpenses(entity.id, 16, view),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, kind: true },
    }),
  ])
  const max = Math.max(...weeks.map((w) => w.total), 1)
  return (
    <div className="space-y-4">
      <PageHeader
        title={`Expenses by week — ${entity.code}`}
        subtitle={view.lens === 'ah' ? 'By Accounting Head' : 'By Expense Head'}
        actions={
          <form className="flex flex-wrap items-center gap-1">
            <HeadLensFilters
              base="/reports/weekly"
              lens={view.lens}
              headOptions={lensHeads}
              ahOptions={lensHeads}
              pickedHead={params.head}
              pickedAh={params.ah}
            />
            <button type="submit" className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink">
              Apply
            </button>
          </form>
        }
      />
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
        <div className="flex h-44 items-end gap-2 overflow-x-auto">
          {weeks.map((w) => (
            <div key={w.week} className="flex min-w-[44px] flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[10px] tabular-nums text-ink-2">{inr(w.total)}</span>
              <div
                className="w-full rounded-t bg-[var(--chart-1)]"
                style={{ height: `${Math.max(3, Math.round((w.total / max) * 120))}px` }}
              />
              <span className="text-[10px] text-ink-2">{w.week.slice(5)}</span>
            </div>
          ))}
          {weeks.length === 0 && <p className="text-sm text-ink-3">No expenses in the last 16 weeks.</p>}
        </div>
      </div>
      <div className={tableWrapClass}>
        <table className="w-full text-sm">
          <thead className={theadClass}>
            <tr><th className="px-3 py-2">Week from</th><th className="px-3 py-2">Top accounts</th><th className="px-3 py-2 text-right">Total spend</th></tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            {weeks.slice().reverse().map((w) => (
              <tr key={w.week} className="hover:bg-surface-2/60">
                <td className="whitespace-nowrap px-3 py-2 text-ink-2">{w.week}</td>
                <td className="px-3 py-2 text-xs text-ink-2">
                  {w.top.map((t) => `${t.name} ${inr(t.amt)}`).join(' · ')}
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">{inr(w.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
