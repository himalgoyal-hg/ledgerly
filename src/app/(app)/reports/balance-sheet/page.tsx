import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { balanceSheet } from '@/lib/reports/statements'
import { ReportHeader, SectionTable } from '../report-chrome'

// Balance Sheet (spec §10) as at a date. The books are never closed into
// reserves, so cumulative profit appears as its own equity line — which is
// what makes Assets = Liabilities + Equity hold exactly.

export default async function BalanceSheetPage(props: {
  searchParams: Promise<{ to?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const params = await props.searchParams
  const asOf = params.to ? new Date(params.to) : undefined
  const bs = await balanceSheet(entity.id, asOf)
  const query = new URLSearchParams(params.to ? { to: params.to } : {})
  const rangeSuffix = query.toString() ? `&${query}` : ''

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Balance Sheet"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={`As at ${params.to ?? 'today'} · ${
          bs.balances ? '✓ balances' : '✗ DOES NOT BALANCE'
        }`}
        filters={
          <>
            <span className="text-xs text-zinc-400">as at</span>
            <input
              type="date"
              name="to"
              defaultValue={params.to}
              className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
            />
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
            >
              Apply
            </button>
          </>
        }
        exportHref={`/reports/export?report=balance-sheet&${query}`}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <SectionTable section={bs.assets} range={rangeSuffix} />
          <div className="rounded-xl border border-zinc-300 bg-zinc-50 px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-zinc-700">Total assets</span>
              <span className="text-lg font-semibold text-zinc-900">
                {displayINR(bs.assetsTotal)}
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <SectionTable section={bs.liabilities} range={rangeSuffix} />
          <SectionTable section={bs.equity} range={rangeSuffix} />
          <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-zinc-700">
                Profit to date
                <span className="ml-2 text-xs text-zinc-400">(books not closed to reserves)</span>
              </span>
              <span className="font-medium text-zinc-900">{displayINR(bs.retainedEarnings)}</span>
            </div>
          </div>
          <div className="rounded-xl border border-zinc-300 bg-zinc-50 px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-zinc-700">
                Total liabilities + equity
              </span>
              <span className="text-lg font-semibold text-zinc-900">
                {displayINR(bs.liabilitiesEquityTotal)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {!bs.balances && (
        <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          The sheet does not balance. This should be impossible — the journal
          enforces Dr = Cr at the database level. Check the Trial Balance and
          the audit log.
        </p>
      )}
    </div>
  )
}
