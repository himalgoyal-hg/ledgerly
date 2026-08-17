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
            opening: pools.reduce((t, p) => t + p.months[i].opening, 0),
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
  // Every tagging head, offered as type-ahead for the category fields —
  // a matching name links the line to its head, so tagged entries net
  // against the plan and the cashflow stays in step with the books.
  const headNames = admin
    ? [
        ...new Set(
          (
            await prisma.ledgerAccount.findMany({
              where: { isGroup: false, archivedAt: null, kind: { in: ['EXPENSE', 'INCOME'] } },
              select: { name: true },
              orderBy: { name: 'asc' },
            })
          ).map((h) => h.name),
        ),
      ]
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

      {/* The sheet's Cashflow block: Op / Incoming / Outgoing / Closing × months */}
      {view === 'ahead' && cashProjection && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm print:hidden">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
                <th className="px-3 py-2">Cashflow</th>
                {cashProjection.months.map((m) => (
                  <th key={m.month} className="px-2 py-2 text-right">{shortMonth(m.month)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              <tr>
                <td className="px-3 py-1.5 text-xs font-medium text-zinc-500">Opening Balance</td>
                {cashProjection.months.map((m) => (
                  <td key={m.month} className="px-2 py-1.5 text-right tabular-nums text-zinc-600">
                    {displayINR(m.opening.toFixed(0))}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="px-3 py-1.5 text-xs font-medium text-zinc-500">Incoming</td>
                {cashProjection.months.map((m) => (
                  <td key={m.month} className="px-2 py-1.5 text-right tabular-nums text-emerald-700">
                    {displayINR(m.inflow.toFixed(0))}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="px-3 py-1.5 text-xs font-medium text-zinc-500">Outgoing</td>
                {cashProjection.months.map((m) => (
                  <td key={m.month} className="px-2 py-1.5 text-right tabular-nums text-red-600">
                    {m.outflow ? `-${displayINR(m.outflow.toFixed(0))}` : displayINR('0')}
                  </td>
                ))}
              </tr>
              <tr className="bg-zinc-50 font-semibold">
                <td className="px-3 py-1.5 text-xs text-zinc-800">Closing</td>
                {cashProjection.months.map((m) => (
                  <td
                    key={m.month}
                    className={`px-2 py-1.5 text-right tabular-nums ${m.closing < 0 ? 'text-red-600' : 'text-zinc-900'}`}
                  >
                    {displayINR(m.closing.toFixed(0))}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          {/* pool-by-pool drill-down, tucked away */}
          <details className="border-t border-zinc-100">
            <summary className="cursor-pointer px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-700">
              Pool by pool (closings) ▾
            </summary>
            <div className="overflow-x-auto px-3 pb-2">
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
          </details>
        </div>
      )}

      {/* Recurring — the sheet's left block: category, budget, claimable-as,
          frequency, day, account. Rows edit in place; the green row adds. */}
      {view === 'ahead' && cashProjection && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm print:hidden">
          <table className="w-full min-w-[62rem] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-[10px] uppercase tracking-wider text-zinc-400">
                <th className="w-[22%] px-2 py-1.5">Recurring — account tagging category</th>
                <th className="px-2 py-1.5 text-right">Budget ₹ (+out / −in)</th>
                <th className="px-2 py-1.5">Claimable as (Income tax)</th>
                <th className="px-2 py-1.5">Frequency</th>
                <th className="px-2 py-1.5">Day</th>
                <th className="px-2 py-1.5">Account</th>
                <th className="px-2 py-1.5 text-right">₹ / month</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              {[null, ...planLines.filter((l) => l.frequency !== 'ONCE')].map((line) => {
                const formId = line ? `cp-${line.id}` : 'cp-new-rec'
                return (
                  <tr key={line?.id ?? 'new'} className={line ? 'hover:bg-zinc-50/60' : 'bg-emerald-50/40'}>
                    <td className="px-2 py-0.5">
                      <input
                        name="label"
                        form={formId}
                        required
                        list="head-options"
                        defaultValue={line?.label ?? ''}
                        placeholder="Type — tagging heads suggest themselves"
                        className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs"
                      />
                    </td>
                    <td className="px-2 py-0.5">
                      <input
                        name="amount"
                        form={formId}
                        required
                        inputMode="decimal"
                        defaultValue={line ? String(line.amount) : ''}
                        placeholder="₹"
                        title="Positive = goes out, negative = comes in (e.g. Receipt from company)"
                        className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-right text-xs"
                      />
                    </td>
                    <td className="px-2 py-0.5">
                      <input
                        name="taxTreatment"
                        form={formId}
                        list="claimable-options"
                        defaultValue={line?.taxTreatment ?? ''}
                        placeholder="Drawing / HG Business Expense…"
                        className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs"
                      />
                    </td>
                    <td className="px-2 py-0.5">
                      <select
                        name="frequency"
                        form={formId}
                        defaultValue={line?.frequency ?? 'MONTHLY'}
                        className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs"
                      >
                        {FREQUENCIES.filter((f) => f !== 'ONCE').map((f) => (
                          <option key={f} value={f}>{freqLabel[f]}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-0.5">
                      <input
                        name="dayNote"
                        form={formId}
                        defaultValue={line?.dayNote ?? ''}
                        placeholder="27 / Fri"
                        className="w-16 rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs"
                      />
                    </td>
                    <td className="px-2 py-0.5">
                      <select
                        name="source"
                        form={formId}
                        defaultValue={line?.source ?? 'HG'}
                        className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs"
                      >
                        {POOL_OPTIONS.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right text-xs tabular-nums text-zinc-500">
                      {line ? displayINR(lineMonthly(line).toFixed(2)) : ''}
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
          <datalist id="claimable-options">
            <option value="Drawing" />
            <option value="HG Business Expense" />
            <option value="Investment" />
            <option value="ACPL expense" />
          </datalist>
          <datalist id="head-options">
            {headNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>
      )}

      {/* One-time — the sheet's right block: name, amount, the actual date */}
      {view === 'ahead' && cashProjection && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm print:hidden">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-[10px] uppercase tracking-wider text-zinc-400">
                <th className="w-[36%] px-2 py-1.5">One-time</th>
                <th className="px-2 py-1.5 text-right">₹ (+out / −in)</th>
                <th className="px-2 py-1.5">Date</th>
                <th className="px-2 py-1.5">Account</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              {[null, ...planLines.filter((l) => l.frequency === 'ONCE')].map((line) => {
                const formId = line ? `cp-${line.id}` : 'cp-new-once'
                const dateValue = line?.onMonth
                  ? `${line.onMonth}-${/^\d{1,2}$/.test(line.dayNote ?? '') ? String(line.dayNote).padStart(2, '0') : '01'}`
                  : ''
                return (
                  <tr key={line?.id ?? 'new'} className={line ? 'hover:bg-zinc-50/60' : 'bg-emerald-50/40'}>
                    <td className="px-2 py-0.5">
                      <input
                        name="label"
                        form={formId}
                        required
                        list="head-options"
                        defaultValue={line?.label ?? ''}
                        placeholder="Type — tagging heads suggest themselves"
                        className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs"
                      />
                    </td>
                    <td className="px-2 py-0.5">
                      <input
                        name="amount"
                        form={formId}
                        required
                        inputMode="decimal"
                        defaultValue={line ? String(line.amount) : ''}
                        placeholder="₹"
                        title="Positive = goes out, negative = comes in"
                        className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-right text-xs"
                      />
                    </td>
                    <td className="px-2 py-0.5">
                      <input
                        name="onDate"
                        form={formId}
                        type="date"
                        required
                        defaultValue={dateValue}
                        className="rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs"
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
                      <div className="flex items-center justify-end gap-1">
                        <form id={formId} action={saveCashPlanAction}>
                          {line && <input type="hidden" name="id" value={line.id} />}
                          <input type="hidden" name="frequency" value="ONCE" />
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
