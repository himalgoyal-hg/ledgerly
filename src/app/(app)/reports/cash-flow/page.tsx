import { Fragment } from 'react'
import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireUser, isAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { cashFlow, type CashFlowLine } from '@/lib/reports/statements'
import { projectPools, lineMonthly, FREQUENCIES } from '@/lib/budget/plan'
import { saveCashPlanAction, archiveCashPlanAction, saveCategoryPlanAction, archiveCategoryPlanAction } from '../../cash/actions'
import { ReportHeader, DateRangeFilters, CashToggle } from '../report-chrome'
import { SmartCombobox } from '@/components/smart-combobox'
import { chipClass, tableWrapClass, theadClass } from '@/components/ui'

// Cash Flow (spec §10), direct method: every entry touching bank or cash
// contributes its counter-lines. Transfers between own accounts have no
// counter-line, so they self-eliminate.

export default async function CashFlowPage(props: {
  searchParams: Promise<{ from?: string; to?: string; view?: string; cash?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>

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
  const agg = (subset: typeof pools) =>
    subset.length > 0 && pools.length > 0
      ? pools[0].months.map((m, i) => ({
          month: m.month,
          opening: subset.reduce((t, p) => t + p.months[i].opening, 0),
          inflow: subset.reduce((t, p) => t + p.months[i].inflow, 0),
          outflow: subset.reduce((t, p) => t + p.months[i].outflow, 0),
          closing: subset.reduce((t, p) => t + p.months[i].closing, 0),
        }))
      : []
  // bank and cash ARE different pockets — each gets its own block, the
  // total ties them back together
  const bankMonths = agg(pools.filter((p) => p.pool !== 'CASH'))
  const showCash = params.cash === '1'
  const cashMonths = agg(pools.filter((p) => p.pool === 'CASH'))
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
  // One row per CATEGORY, bank and cash budgets in their OWN columns —
  // the sheet's shape. Same-label bank/cash lines fold into one row.
  const recurringCats = (() => {
    const map = new Map<string, {
      label: string; bank: number; cash: number; frequency: string
      dayNote: string | null; taxTreatment: string | null
    }>()
    for (const l of planLines.filter((x) => x.frequency !== 'ONCE')) {
      const key = l.label.toLowerCase()
      const row = map.get(key) ?? {
        label: l.label, bank: 0, cash: 0, frequency: l.frequency, dayNote: l.dayNote, taxTreatment: l.taxTreatment,
      }
      if (l.source === 'CASH') row.cash += Number(l.amount)
      else row.bank += Number(l.amount)
      row.frequency = l.frequency
      row.dayNote = row.dayNote ?? l.dayNote
      row.taxTreatment = row.taxTreatment ?? l.taxTreatment
      map.set(key, row)
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
  })()

  const POOL_OPTIONS = ['ACPL', 'HG', 'MG', 'PG', 'CASH']
  // same Day dropdown as the master register: dates, weekdays, period-ends
  const DAY_OPTIONS = [
    ...Array.from({ length: 31 }, (_, i) => String(i + 1)),
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'End of month', 'End of quarter',
  ]
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
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <table className="w-full text-left text-sm">
        <thead className={theadClass}>
          <tr>
            <th className="px-4 py-2">{title}</th>
            <th className="px-4 py-2 text-right">Cash in / (out)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-2">
          {data.lines.map((line) => (
            <tr key={line.accountId}>
              <td className="px-4 py-2">
                <Link
                  href={`/reports/ledger?accountId=${line.accountId}${rangeSuffix}`}
                  className="text-ink hover:underline"
                >
                  <span className="font-mono text-xs text-ink-3">{line.code}</span> {line.name}
                </Link>
              </td>
              <td
                className={`w-40 px-4 py-2 text-right ${
                  Number(line.amount) >= 0 ? 'text-success' : 'text-danger'
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
              <td colSpan={2} className="px-4 py-3 text-center text-sm text-ink-3">
                No movement.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot className="border-t border-line font-medium text-ink">
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
        filters={
          <>
            <CashToggle
              base="/reports/cash-flow"
              showing={showCash}
              keep={{ from: params.from, to: params.to, view: params.view }}
            />
            <DateRangeFilters from={params.from} to={params.to} />
          </>
        }
        exportHref={`/reports/export?report=cash-flow&${query}`}
      />

      {/* Two views, one screen: what happened, and what the plan says next */}
      <div className="flex gap-1 border-b border-line pb-2 print:hidden">
        <Link
          href={`/reports/cash-flow${query.toString() ? `?${query}` : ''}`}
          className={chipClass(view === 'history')}
        >
          History
        </Link>
        <Link
          href={`/reports/cash-flow?view=ahead${query.toString() ? `&${query}` : ''}`}
          className={chipClass(view === 'ahead')}
        >
          Cash ahead
        </Link>
      </div>

      {view === 'history' && (
      <div className="flex flex-wrap gap-3">
        <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-card">
          <div className="text-xs text-ink-2">Opening cash & bank</div>
          <div className="text-lg font-semibold text-ink">{displayINR(cf.opening)}</div>
        </div>
        <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-card">
          <div className="text-xs text-ink-2">Net movement</div>
          <div
            className={`text-lg font-semibold ${
              Number(cf.netMovement) >= 0 ? 'text-success' : 'text-danger'
            }`}
          >
            {displayINR(cf.netMovement)}
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-primary px-4 py-3 shadow-card">
          <div className="text-xs text-white/70">Closing cash & bank</div>
          <div className="text-lg font-semibold text-white">{displayINR(cf.closing)}</div>
        </div>
        {!cf.reconciles && (
          <div className="rounded-2xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
            Movements do not reconcile with the balances — check the audit log.
          </div>
        )}
      </div>
      )}

      {/* Cash ahead — same three tiles as the history below, but forward:
          today's cash, the plan's net movement, the projected closing. */}
      {view === 'ahead' && cashProjection && cashProjection.months.length > 0 && (
        <div className="flex flex-wrap gap-3 print:hidden">
          <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-card">
            <div className="text-xs text-ink-2">Bank today</div>
            <div className="text-lg font-semibold text-ink">
              {displayINR(
                pools
                  .filter((p) => p.pool !== 'CASH')
                  .reduce((t, p) => t + p.balanceNow, 0)
                  .toFixed(2),
              )}
            </div>
            <div className="mt-0.5 text-[10px] text-ink-3">
              {pools
                .filter((p) => p.pool !== 'CASH' && p.balanceNow !== 0)
                .map((p) => `${p.pool} ${displayINR(p.balanceNow.toFixed(0))}`)
                .join(' · ')}
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-card">
            <div className="text-xs text-ink-2">Cash today</div>
            <div className="text-lg font-semibold text-ink">
              {displayINR((pools.find((p) => p.pool === 'CASH')?.balanceNow ?? 0).toFixed(2))}
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-card">
            <div className="text-xs text-ink-2">Bank + cash today</div>
            <div className="text-lg font-semibold text-ink">
              {displayINR(cashProjection.balanceNow.toFixed(2))}
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-card">
            <div className="text-xs text-ink-2">
              Planned net movement (next {cashProjection.months.length} mo)
            </div>
            {(() => {
              const net =
                cashProjection.months[cashProjection.months.length - 1].closing -
                cashProjection.balanceNow
              return (
                <div className={`text-lg font-semibold ${net >= 0 ? 'text-success' : 'text-danger'}`}>
                  {displayINR(net.toFixed(2))}
                </div>
              )
            })()}
          </div>
          <div className="rounded-2xl border border-line bg-primary px-4 py-3 shadow-card">
            <div className="text-xs text-white/70">
              Projected closing ({shortMonth(cashProjection.months[cashProjection.months.length - 1].month)})
            </div>
            <div
              className={`text-lg font-semibold ${
                cashProjection.months[cashProjection.months.length - 1].closing < 0
                  ? 'text-danger'
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
        <div className={`${tableWrapClass} print:hidden`}>
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase tracking-wider text-ink-3">
                <th className="px-3 py-2">Cashflow</th>
                {cashProjection.months.map((m) => (
                  <th key={m.month} className="px-2 py-2 text-right">{shortMonth(m.month)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-2">
              {([
                ['Bank', bankMonths],
                // cash only when asked for (Himal, 20 Aug)
                ...(showCash ? ([['Cash', cashMonths]] as const) : []),
                [showCash ? 'Total' : 'Total (bank + cash)', cashProjection.months],
              ] as const).map(([label, months]) => (
                <Fragment key={label}>
                  <tr className={label === 'Total' ? 'border-t-2 border-line bg-surface-2/80' : 'bg-surface-2/60'}>
                    <td colSpan={months.length + 1} className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-2">
                      {label}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-1 text-xs text-ink-2">Opening Balance</td>
                    {months.map((m) => (
                      <td key={m.month} className="px-2 py-1 text-right text-xs tabular-nums text-ink-2">
                        {displayINR(m.opening.toFixed(0))}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="px-3 py-1 text-xs text-ink-2">Incoming</td>
                    {months.map((m) => (
                      <td key={m.month} className="px-2 py-1 text-right text-xs tabular-nums text-success">
                        {displayINR(m.inflow.toFixed(0))}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="px-3 py-1 text-xs text-ink-2">Outgoing</td>
                    {months.map((m) => (
                      <td key={m.month} className="px-2 py-1 text-right text-xs tabular-nums text-danger">
                        {m.outflow ? `-${displayINR(m.outflow.toFixed(0))}` : displayINR('0')}
                      </td>
                    ))}
                  </tr>
                  <tr className={label === 'Total' ? 'bg-surface-2 font-semibold' : 'font-medium'}>
                    <td className="px-3 py-1 text-xs text-ink">Closing</td>
                    {months.map((m) => (
                      <td key={m.month} className={`px-2 py-1 text-right text-xs tabular-nums ${m.closing < 0 ? 'text-danger' : 'text-ink'}`}>
                        {displayINR(m.closing.toFixed(0))}
                      </td>
                    ))}
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
          {/* pool-by-pool drill-down, tucked away */}
          <details className="border-t border-line-2">
            <summary className="cursor-pointer px-3 py-1.5 text-xs text-ink-3 hover:text-ink-2">
              Pool by pool (closings) ▾
            </summary>
            <div className="overflow-x-auto px-3 pb-2">
              <table className="w-full min-w-[40rem] text-left text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-ink-3">
                    <th className="px-2 py-1">Pool</th>
                    <th className="px-2 py-1 text-right">Today</th>
                    {pools[0]?.months.map((m) => (
                      <th key={m.month} className="px-2 py-1 text-right">{shortMonth(m.month)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-2">
                  {pools.map((p) => (
                    <tr key={p.pool}>
                      <td className="px-2 py-1 font-medium text-ink-2">{p.pool}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-ink-2">
                        {displayINR(p.balanceNow.toFixed(0))}
                      </td>
                      {p.months.map((m) => (
                        <td
                          key={m.month}
                          className={`px-2 py-1 text-right tabular-nums ${m.closing < 0 ? 'font-semibold text-danger' : 'text-ink-2'}`}
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

      {/* Recurring — one row per category, Bank budget and Cash budget in
          their OWN columns (the sheet's shape). Saving runs the same master
          propagation as the Accounts register. */}
      {view === 'ahead' && cashProjection && (
        <div className={`${tableWrapClass} print:hidden`}>
          <table className="w-full min-w-[64rem] text-left text-sm">
            <thead>
              <tr className="border-b border-line-2 text-[10px] uppercase tracking-wider text-ink-3">
                <th className="w-[22%] px-2 py-1.5">Recurring — expense head</th>
                <th className="px-2 py-1.5 text-right">Bank budget ₹</th>
                <th className="px-2 py-1.5 text-right">Cash budget ₹</th>
                <th className="px-2 py-1.5">Claimable as (Income tax)</th>
                <th className="px-2 py-1.5">Frequency</th>
                <th className="px-2 py-1.5">Day</th>
                <th className="px-2 py-1.5 text-right">₹ / month</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line-2">
              {[null, ...recurringCats].map((row) => {
                const formId = row ? `cp-${row.label.replace(/[^a-zA-Z0-9]/g, '_')}` : 'cp-new-rec'
                const monthly = row
                  ? lineMonthly({ amount: String(row.bank) as never, frequency: row.frequency }) +
                    lineMonthly({ amount: String(row.cash) as never, frequency: row.frequency })
                  : 0
                return (
                  <tr key={row?.label ?? 'new'} className={row ? 'hover:bg-surface-2/60' : 'bg-success-soft/40'}>
                    <td className="px-2 py-0.5">
                      <input
                        name="category"
                        form={formId}
                        required
                        list="head-options"
                        defaultValue={row?.label ?? ''}
                        placeholder="Type — tagging heads suggest themselves"
                        className="w-full rounded border border-line bg-surface px-1.5 py-1 text-xs"
                      />
                    </td>
                    <td className="px-2 py-0.5">
                      <input
                        name="bankBudget"
                        form={formId}
                        inputMode="decimal"
                        defaultValue={row?.bank ? String(Math.round(row.bank)) : ''}
                        title="Per frequency period; negative = receipt"
                        className="w-full rounded border border-line bg-surface px-1.5 py-1 text-right text-xs tabular-nums"
                      />
                    </td>
                    <td className="px-2 py-0.5">
                      <input
                        name="cashBudget"
                        form={formId}
                        inputMode="decimal"
                        defaultValue={row?.cash ? String(Math.round(row.cash)) : ''}
                        title="Paid from the cash pool"
                        className="w-full rounded border border-line bg-surface px-1.5 py-1 text-right text-xs tabular-nums"
                      />
                    </td>
                    <td className="px-2 py-0.5">
                      <input
                        name="taxTreatment"
                        form={formId}
                        list="claimable-options"
                        defaultValue={row?.taxTreatment ?? ''}
                        placeholder="Drawing / HG Business Expense…"
                        className="w-full rounded border border-line bg-surface px-1.5 py-1 text-xs"
                      />
                    </td>
                    <td className="px-2 py-0.5">
                      <select
                        name="frequency"
                        form={formId}
                        defaultValue={row?.frequency ?? 'MONTHLY'}
                        className="w-full rounded border border-line bg-surface px-1.5 py-1 text-xs"
                      >
                        {FREQUENCIES.filter((f) => f !== 'ONCE').map((f) => (
                          <option key={f} value={f}>{freqLabel[f]}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-0.5">
                      <SmartCombobox
                        options={[
                          ...(row?.dayNote && !DAY_OPTIONS.includes(row.dayNote) ? [{ id: row.dayNote, label: row.dayNote }] : []),
                          ...DAY_OPTIONS.map((d) => ({ id: d, label: d })),
                        ]}
                        name="dayNote"
                        defaultId={row?.dayNote ?? ''}
                        formId={formId}
                        placeholder="Day"
                        className="w-24 rounded border border-line bg-surface px-1.5 py-1 text-xs"
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right text-xs tabular-nums text-ink-2">
                      {row ? displayINR(monthly.toFixed(2)) : ''}
                    </td>
                    <td className="px-2 py-0.5">
                      <div className="flex items-center justify-end gap-1">
                        <form id={formId} action={saveCategoryPlanAction}>
                          <button
                            type="submit"
                            className={`whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium ${
                              row
                                ? 'border border-line text-ink-2 hover:bg-surface-2'
                                : 'bg-success text-white hover:opacity-90'
                            }`}
                          >
                            {row ? 'Save' : 'Add'}
                          </button>
                        </form>
                        {row && (
                          <form action={archiveCategoryPlanAction}>
                            <input type="hidden" name="category" value={row.label} />
                            <button
                              type="submit"
                              title="Remove from the plan (recycle bin)"
                              className="rounded border border-danger/30 px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger-soft"
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
        <div className={`${tableWrapClass} print:hidden`}>
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead>
              <tr className="border-b border-line-2 text-[10px] uppercase tracking-wider text-ink-3">
                <th className="w-[36%] px-2 py-1.5">One-time</th>
                <th className="px-2 py-1.5 text-right">₹ (+out / −in)</th>
                <th className="px-2 py-1.5">Date</th>
                <th className="px-2 py-1.5">Account</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line-2">
              {[null, ...planLines.filter((l) => l.frequency === 'ONCE')].map((line) => {
                const formId = line ? `cp-${line.id}` : 'cp-new-once'
                const dateValue = line?.onMonth
                  ? `${line.onMonth}-${/^\d{1,2}$/.test(line.dayNote ?? '') ? String(line.dayNote).padStart(2, '0') : '01'}`
                  : ''
                return (
                  <tr key={line?.id ?? 'new'} className={line ? 'hover:bg-surface-2/60' : 'bg-success-soft/40'}>
                    <td className="px-2 py-0.5">
                      <input
                        name="label"
                        form={formId}
                        required
                        list="head-options"
                        defaultValue={line?.label ?? ''}
                        placeholder="Type — tagging heads suggest themselves"
                        className="w-full rounded border border-line bg-surface px-1.5 py-1 text-xs"
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
                        className="w-full rounded border border-line bg-surface px-1.5 py-1 text-right text-xs"
                      />
                    </td>
                    <td className="px-2 py-0.5">
                      <input
                        name="onDate"
                        form={formId}
                        type="date"
                        required
                        defaultValue={dateValue}
                        className="rounded border border-line bg-surface px-1.5 py-1 text-xs"
                      />
                    </td>
                    <td className="px-2 py-0.5">
                      <select
                        name="source"
                        form={formId}
                        defaultValue={line?.source ?? 'CASH'}
                        className="w-full rounded border border-line bg-surface px-1.5 py-1 text-xs"
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
                                ? 'border border-line text-ink-2 hover:bg-surface-2'
                                : 'bg-success text-white hover:opacity-90'
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
                              className="rounded border border-danger/30 px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger-soft"
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
