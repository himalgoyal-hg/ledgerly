import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { cashFlow, type CashFlowLine } from '@/lib/reports/statements'
import { ReportHeader, DateRangeFilters } from '../report-chrome'

// Cash Flow (spec §10), direct method: every entry touching bank or cash
// contributes its counter-lines. Transfers between own accounts have no
// counter-line, so they self-eliminate.

export default async function CashFlowPage(props: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const params = await props.searchParams
  const from = params.from ? new Date(params.from) : undefined
  const to = params.to ? new Date(params.to) : undefined
  const cf = await cashFlow(entity.id, { from, to })
  const query = new URLSearchParams({
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
  })
  const rangeSuffix = query.toString() ? `&${query}` : ''

  const bucket = (title: string, data: { lines: CashFlowLine[]; total: string }) => (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
          <tr>
            <th className="px-4 py-2">{title}</th>
            <th className="px-4 py-2 text-right">Cash in / (out)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {data.lines.map((line) => (
            <tr key={line.accountId}>
              <td className="px-4 py-2">
                <Link
                  href={`/reports/ledger?accountId=${line.accountId}${rangeSuffix}`}
                  className="text-zinc-800 hover:underline"
                >
                  <span className="font-mono text-xs text-zinc-400">{line.code}</span> {line.name}
                </Link>
              </td>
              <td
                className={`w-40 px-4 py-2 text-right ${
                  Number(line.amount) >= 0 ? 'text-emerald-700' : 'text-red-600'
                }`}
              >
                {Number(line.amount) >= 0
                  ? displayINR(line.amount)
                  : `(${displayINR(String(-Number(line.amount)))})`}
              </td>
            </tr>
          ))}
          {data.lines.length === 0 && (
            <tr>
              <td colSpan={2} className="px-4 py-3 text-center text-sm text-zinc-400">
                No movement.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot className="border-t border-zinc-300 font-medium text-zinc-900">
          <tr>
            <td className="px-4 py-2">Net {title.toLowerCase()}</td>
            <td className="px-4 py-2 text-right">{displayINR(data.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Cash Flow"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={
          params.from || params.to
            ? `${params.from ?? 'start'} to ${params.to ?? 'today'}`
            : 'All time — set a range to narrow it down'
        }
        filters={<DateRangeFilters from={params.from} to={params.to} />}
        exportHref={`/reports/export?report=cash-flow&${query}`}
      />

      <div className="flex flex-wrap gap-3">
        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
          <div className="text-xs text-zinc-500">Opening cash & bank</div>
          <div className="text-lg font-semibold text-zinc-900">{displayINR(cf.opening)}</div>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
          <div className="text-xs text-zinc-500">Net movement</div>
          <div
            className={`text-lg font-semibold ${
              Number(cf.netMovement) >= 0 ? 'text-emerald-700' : 'text-red-600'
            }`}
          >
            {displayINR(cf.netMovement)}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-300 bg-zinc-900 px-4 py-3 shadow-sm">
          <div className="text-xs text-zinc-400">Closing cash & bank</div>
          <div className="text-lg font-semibold text-white">{displayINR(cf.closing)}</div>
        </div>
        {!cf.reconciles && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Movements do not reconcile with the balances — check the audit log.
          </div>
        )}
      </div>

      <div className="space-y-4">
        {bucket('Operating', cf.operating)}
        {bucket('Investing', cf.investing)}
        {bucket('Financing', cf.financing)}
      </div>
    </div>
  )
}
