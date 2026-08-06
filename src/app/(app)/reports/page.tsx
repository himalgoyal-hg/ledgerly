import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { profitAndLoss } from '@/lib/reports/statements'
import { ReportHeader, DateRangeFilters, SectionTable } from './report-chrome'

// Profit & Loss (spec §10) — live over the journal, drillable to source.

export default async function ProfitAndLossPage(props: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const params = await props.searchParams
  const from = params.from ? new Date(params.from) : undefined
  const to = params.to ? new Date(params.to) : undefined
  const pnl = await profitAndLoss(entity.id, { from, to })

  const query = new URLSearchParams({
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
  })
  const rangeSuffix = query.toString() ? `&${query}` : ''
  const profit = Number(pnl.netProfit)

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Profit & Loss"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={
          params.from || params.to
            ? `${params.from ?? 'start'} to ${params.to ?? 'today'}`
            : 'All time — set a range to narrow it down'
        }
        filters={<DateRangeFilters from={params.from} to={params.to} />}
        exportHref={`/reports/export?report=pnl&${query}`}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionTable section={pnl.income} range={rangeSuffix} />
        <SectionTable section={pnl.expenses} range={rangeSuffix} />
      </div>

      <div
        className={`rounded-xl border p-4 shadow-sm ${
          profit >= 0 ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-sm font-medium text-zinc-700">
            {profit >= 0 ? 'Net profit' : 'Net loss'}
          </span>
          <span className="text-2xl font-semibold text-zinc-900">
            {displayINR(profit >= 0 ? pnl.netProfit : String(-profit))}
          </span>
          <span className="ml-auto text-xs text-zinc-500">
            income {displayINR(pnl.income.total)} − expenses {displayINR(pnl.expenses.total)}
          </span>
        </div>
      </div>
    </div>
  )
}
