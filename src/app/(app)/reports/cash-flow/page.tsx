import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireUser, isAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { cashFlow, type CashFlowLine } from '@/lib/reports/statements'
import { projectPools, lineMonthly, FREQUENCIES } from '@/lib/budget/plan'
import { saveCashPlanAction, archiveCashPlanAction } from '../../cash/actions'
import { ReportHeader, DateRangeFilters } from '../report-chrome'

// Cash Flow (spec §10), direct method: every entry touching bank or cash
// contributes its counter-lines. Transfers between own accounts have no
// counter-line, so they self-eliminate.

export default async function CashFlowPage(props: {
  searchParams: Promise<{ from?: string; to?: string; view?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const params = await props.searchParams
  const view = params.view === 'ahead' ? 'ahead' : 'history'
  const from = params.from ? new Date(params.from) : undefined
  const to = params.to ? new Date(params.to) : undefined
  const cf = await cashFlow(entity.id, { from, to })

  // Looking AHEAD: the CASH pool projected from the live balance, with the
  // planned future payments editable right here (admin only). Lines live in
  // BudgetLine (source CASH); the current month nets what already posted.
  const admin = isAdmin(user)
  const pools = admin ? await projectPools(new Date(), 6) : []
  // Bank + cash TOGETHER: every pool (each books' banks, plus the cash
  // pool) summed per month — the same live rupees the dashboard totals.
  const cashProjection =
    pools.length > 0
      ? {
          balanceNow: pools.reduce((t, p) => t + p.balanceNow, 0),
          months: pools[0].months.map((m, i) => ({
            month: m.month,
            inflow: pools.reduce((t, p) => t + p.months[i].inflow, 0),
            outflow: pools.reduce((t, p) => t + p.months[i].outflow, 0),
            closing: pools.reduce((t, p) => t + p.months[i].closing, 0),
          })),
        }
      : null
  const planLines = admin
    ? await prisma.budgetLine.findMany({
        where: { archivedAt: null },
        orderBy: [{ source: 'asc' }, { label: 'asc' }],
      })
    : []
  const POOL_OPTIONS = ['ACPL', 'HG', 'MG', 'PG', 'CASH']
  const shortMonth = (m: string) =>
    `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`
  const freqLabel: Record<string, string> = {
    DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly',
    HALF_YEARLY: 'Half yearly', ANNUAL: 'Annual', ONCE: 'One-off',
  }
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

      {/* Two views, one screen: what happened, and what the plan says next */}
      <div className="flex gap-1 border-b border-zinc-200 pb-2 print:hidden">
        <Link
          href={`/reports/cash-flow${query.toString() ? `?${query}` : ''}`}
          className={`rounded-md px-3 py-1.5 text-sm ${
            view === 'history' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
          }`}
        >
          History
        </Link>
        <Link
          href={`/reports/cash-flow?view=ahead${query.toString() ? `&${query}` : ''}`}
          className={`rounded-md px-3 py-1.5 text-sm ${
            view === 'ahead' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
          }`}
        >
          Cash ahead
        </Link>
      </div>

      {view === 'history' && (
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
      )}

      {/* Cash ahead — same three tiles as the history below, but forward:
          today's cash, the plan's net movement, the projected closing. */}
      {view === 'ahead' && cashProjection && cashProjection.months.length > 0 && (
        <div className="flex flex-wrap gap-3 print:hidden">
          <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
            <div className="text-xs text-zinc-500">Bank today</div>
            <div className="text-lg font-semibold text-zinc-900">
              {displayINR(
                pools
                  .filter((p) => p.pool !== 'CASH')
                  .reduce((t, p) => t + p.balanceNow, 0)
                  .toFixed(2),
              )}
            </div>
            <div className="mt-0.5 text-[10px] text-zinc-400">
              {pools
                .filter((p) => p.pool !== 'CASH' && p.balanceNow !== 0)
                .map((p) => `${p.pool} ${displayINR(p.balanceNow.toFixed(0))}`)
                .join(' · ')}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
            <div className="text-xs text-zinc-500">Cash today</div>
            <div className="text-lg font-semibold text-zinc-900">
              {displayINR((pools.find((p) => p.pool === 'CASH')?.balanceNow ?? 0).toFixed(2))}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
            <div className="text-xs text-zinc-500">Bank + cash today</div>
            <div className="text-lg font-semibold text-zinc-900">
              {displayINR(cashProjection.balanceNow.toFixed(2))}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
            <div className="text-xs text-zinc-500">
              Planned net movement (next {cashProjection.months.length} mo)
            </div>
            {(() => {
              const net =
                cashProjection.months[cashProjection.months.length - 1].closing -
                cashProjection.balanceNow
              return (
                <div className={`text-lg font-semibold ${net >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                  {displayINR(net.toFixed(2))}
                </div>
              )
            })()}
          </div>
          <div className="rounded-xl border border-zinc-300 bg-zinc-900 px-4 py-3 shadow-sm">
            <div className="text-xs text-zinc-400">
              Projected closing ({shortMonth(cashProjection.months[cashProjection.months.length - 1].month)})
            </div>
            <div
              className={`text-lg font-semibold ${
                cashProjection.months[cashProjection.months.length - 1].closing < 0
                  ? 'text-red-400'
                  : 'text-white'
              }`}
            >
              {displayINR(cashProjection.months[cashProjection.months.length - 1].closing.toFixed(2))}
            </div>
          </div>
        </div>
      )}

      {/* Cash-only flow — the physical pool month by month */}
      {view === 'ahead' && (() => {
        const cashPool = pools.find((p) => p.pool === 'CASH')
        if (!cashPool) return null
        const upcoming = planLines
          .filter((l) => l.source === 'CASH' && l.frequency === 'ONCE' && l.onMonth)
          .sort((a, b) => (a.onMonth! < b.onMonth! ? -1 : 1))
        return (
          <div className="rounded-xl border border-zinc-200 bg-white shadow-sm print:hidden">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-1.5 text-xs">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              Cash only
            </span>
            <span className="flex items-baseline gap-1">
              <span className="text-zinc-400">today</span>
              <span className="font-semibold tabular-nums text-zinc-800">
                {displayINR(cashPool.balanceNow.toFixed(2))}
              </span>
            </span>
            {cashPool.months.map((m) => (
              <span
                key={m.month}
                className="flex items-baseline gap-1"
                title={`in ${displayINR(m.inflow.toFixed(0))} · out ${displayINR(m.outflow.toFixed(0))}`}
              >
                <span className="text-zinc-400">{shortMonth(m.month)}</span>
                <span className={`font-semibold tabular-nums ${m.closing < 0 ? 'text-red-600' : 'text-zinc-800'}`}>
                  {displayINR(m.closing.toFixed(2))}
                </span>
              </span>
            ))}
            {/* Quick-add a future cash need right here: name, ₹, month →
                a one-off CASH line (− amount = cash coming in). */}
            {admin && (
              <form action={saveCashPlanAction} className="ml-auto flex items-center gap-1">
                <input type="hidden" name="frequency" value="ONCE" />
                <input type="hidden" name="source" value="CASH" />
                <input
                  name="label"
                  required
                  placeholder="Cash needed — what for"
                  className="w-40 rounded border border-zinc-300 px-1.5 py-1 text-xs"
                />
                <input
                  name="amount"
                  required
                  inputMode="decimal"
                  placeholder="₹"
                  title="Positive = cash needed (out), negative = coming in"
                  className="w-20 rounded border border-zinc-300 px-1.5 py-1 text-right text-xs"
                />
                <input
                  name="onMonth"
                  type="month"
                  required
                  className="rounded border border-zinc-300 px-1.5 py-1 text-xs"
                />
                <button
                  type="submit"
                  className="whitespace-nowrap rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600"
                >
                  + Add
                </button>
              </form>
            )}
          </div>
          {/* The added future needs, visible — not just baked into the numbers */}
          {upcoming.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-3 py-1.5 text-xs">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                Upcoming
              </span>
              {upcoming.map((l) => (
                <span
                  key={l.id}
                  className={`flex items-center gap-1 rounded-full px-2 py-0.5 ${
                    Number(l.amount) < 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'
                  }`}
                >
                  <span className="font-medium">{l.label}</span>
                  <span className="tabular-nums">
                    {Number(l.amount) < 0 ? '+' : ''}{displayINR(Math.abs(Number(l.amount)).toFixed(0))}
                  </span>
                  <span className="text-[10px] opacity-70">({shortMonth(l.onMonth!)})</span>
                  {admin && (
                    <form action={archiveCashPlanAction} className="flex">
                      <input type="hidden" name="id" value={l.id} />
                      <button type="submit" title="Remove" className="ml-0.5 text-[10px] opacity-50 hover:opacity-100">
                        ✕
                      </button>
                    </form>
                  )}
                </span>
              ))}
            </div>
          )}
          </div>
        )
      })()}

      {view === 'ahead' && cashProjection && (
        <details className="rounded-xl border border-zinc-200 bg-white shadow-sm print:hidden" open>
          <summary className="flex cursor-pointer flex-wrap items-center gap-x-5 gap-y-1 px-3 py-1.5 text-xs hover:bg-zinc-50">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              Cash ahead
            </span>
            {cashProjection.months.map((m) => (
              <span
                key={m.month}
                className="flex items-baseline gap-1"
                title={`in ${displayINR(m.inflow.toFixed(0))} · out ${displayINR(m.outflow.toFixed(0))}`}
              >
                <span className="text-zinc-400">{shortMonth(m.month)}</span>
                <span className={`font-semibold tabular-nums ${m.closing < 0 ? 'text-red-600' : 'text-zinc-800'}`}>
                  {displayINR(m.closing.toFixed(2))}
                </span>
              </span>
            ))}
            <span className="ml-auto text-zinc-400">planned lines ({planLines.length}) ▾</span>
          </summary>
          <div className="overflow-x-auto border-t border-zinc-100 px-3 py-2">
            {/* Where the money sits, pool by pool */}
            <table className="w-full min-w-[40rem] text-left text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-zinc-400">
                  <th className="px-2 py-1">Pool</th>
                  <th className="px-2 py-1 text-right">Today</th>
                  {pools[0]?.months.map((m) => (
                    <th key={m.month} className="px-2 py-1 text-right">{shortMonth(m.month)}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {pools.map((p) => (
                  <tr key={p.pool}>
                    <td className="px-2 py-1 font-medium text-zinc-700">{p.pool}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-zinc-600">
                      {displayINR(p.balanceNow.toFixed(0))}
                    </td>
                    {p.months.map((m) => (
                      <td
                        key={m.month}
                        className={`px-2 py-1 text-right tabular-nums ${m.closing < 0 ? 'font-semibold text-red-600' : 'text-zinc-600'}`}
                        title={`in ${displayINR(m.inflow.toFixed(0))} · out ${displayINR(m.outflow.toFixed(0))}`}
                      >
                        {displayINR(m.closing.toFixed(0))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto border-t border-zinc-100">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-[10px] uppercase tracking-wider text-zinc-400">
                  <th className="w-[26%] px-2 py-1.5">Payment / receipt</th>
                  <th className="px-2 py-1.5">Source</th>
                  <th className="px-2 py-1.5">Frequency</th>
                  <th className="px-2 py-1.5 text-right">₹ +out / −in</th>
                  <th className="px-2 py-1.5">Month (one-off)</th>
                  <th className="px-2 py-1.5 text-right">₹ / month</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {[null, ...planLines].map((line) => {
                  const formId = line ? `cp-${line.id}` : 'cp-new'
                  return (
                    <tr key={line?.id ?? 'new'} className={line ? 'hover:bg-zinc-50/60' : 'bg-emerald-50/40'}>
                      <td className="px-2 py-0.5">
                        <input
                          name="label"
                          form={formId}
                          required
                          defaultValue={line?.label ?? ''}
                          placeholder="e.g. Diwali gifts / Maid salary"
                          className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs"
                        />
                      </td>
                      <td className="px-2 py-0.5">
                        <select
                          name="source"
                          form={formId}
                          defaultValue={line?.source ?? 'CASH'}
                          className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs"
                        >
                          {POOL_OPTIONS.map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-0.5">
                        <select
                          name="frequency"
                          form={formId}
                          defaultValue={line?.frequency ?? 'ONCE'}
                          className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs"
                        >
                          {FREQUENCIES.map((f) => (
                            <option key={f} value={f}>{freqLabel[f]}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-0.5">
                        <input
                          name="amount"
                          form={formId}
                          required
                          inputMode="decimal"
                          defaultValue={line ? String(line.amount) : ''}
                          placeholder="₹"
                          title="Positive = cash goes out, negative = comes in"
                          className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-right text-xs"
                        />
                      </td>
                      <td className="px-2 py-0.5">
                        <input
                          name="onMonth"
                          form={formId}
                          type="month"
                          defaultValue={line?.onMonth ?? ''}
                          className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs"
                        />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right text-xs tabular-nums text-zinc-500">
                        {line && line.frequency !== 'ONCE' ? displayINR(lineMonthly(line).toFixed(2)) : line ? '—' : ''}
                      </td>
                      <td className="px-2 py-0.5">
                        <div className="flex items-center justify-end gap-1">
                          <form id={formId} action={saveCashPlanAction}>
                            {line && <input type="hidden" name="id" value={line.id} />}
                            <button
                              type="submit"
                              className={`whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium ${
                                line
                                  ? 'border border-zinc-300 text-zinc-600 hover:bg-zinc-100'
                                  : 'bg-emerald-700 text-white hover:bg-emerald-600'
                              }`}
                            >
                              {line ? 'Save' : 'Add'}
                            </button>
                          </form>
                          {line && (
                            <form action={archiveCashPlanAction}>
                              <input type="hidden" name="id" value={line.id} />
                              <button
                                type="submit"
                                title="Remove from the plan"
                                className="rounded border border-red-200 px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-50"
                              >
                                ✕
                              </button>
                            </form>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {view === 'history' && (
      <div className="space-y-4">
        {bucket('Operating', cf.operating)}
        {bucket('Investing', cf.investing)}
        {bucket('Financing', cf.financing)}
      </div>
      )}
    </div>
  )
}
