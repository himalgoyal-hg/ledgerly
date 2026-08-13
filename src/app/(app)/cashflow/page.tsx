import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { displayINR } from '@/lib/ledger/money'
import { projectPools, lineMonthly, POOLS, FREQUENCIES } from '@/lib/budget/plan'
import { saveBudgetLineAction, archiveBudgetLineAction } from './actions'

// Cash flow plan (the user's FY sheet, alive): every budget line per head ×
// pool, and the pools projected forward from LIVE ledger balances — the
// same rupees the Cash tab and dashboard show. Rows are Excel-style
// always-editable; a ONCE line with a month is how a known future value
// enters the plan.

const EXPENSE_TYPES = ['Compulsory', 'Optional-Lifestyle', 'Optional-growth', 'Optional-Investment']
const inputCls = 'w-full rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs'

const freqLabel: Record<string, string> = {
  DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly',
  HALF_YEARLY: 'Half yearly', ANNUAL: 'Annual', ONCE: 'One-off',
}

const monthLabel = (m: string) => {
  const L = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${L[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`
}
const k = (n: number) =>
  Math.abs(n) >= 100000
    ? `${(n / 100000).toFixed(1)}L`
    : `${Math.round(n / 1000)}k`

export default async function CashFlowPage() {
  const user = await requireUser()
  if (!isAdmin(user) && !hasPermission(user, 'viewFinancialReports')) {
    throw new Error('Forbidden: missing permission "viewFinancialReports"')
  }
  const admin = isAdmin(user)

  const [projection, lines, entities] = await Promise.all([
    projectPools(new Date(), 6),
    prisma.budgetLine.findMany({
      where: { archivedAt: null },
      orderBy: [{ source: 'asc' }, { label: 'asc' }],
    }),
    prisma.entity.findMany({ select: { id: true, code: true } }),
  ])
  const entityCode = new Map(entities.map((e) => [e.id, e.code]))
  const months = projection[0]?.months.map((m) => m.month) ?? []
  const totals = months.map((month, i) =>
    projection.reduce((t, p) => t + p.months[i].closing, 0),
  )
  const monthlyOut = lines.reduce((t, l) => t + Math.max(0, lineMonthly(l)), 0)
  const monthlyIn = lines.reduce((t, l) => t + Math.max(0, -lineMonthly(l)), 0)

  const lineRow = (line: (typeof lines)[number] | null) => {
    const formId = line ? `bl-${line.id}` : 'bl-new'
    return (
      <tr key={line?.id ?? 'new'} className={line ? 'align-top hover:bg-zinc-50/60' : 'bg-emerald-50/40 align-top'}>
        <td className="px-1.5 py-0.5">
          <input name="label" form={formId} required defaultValue={line?.label ?? ''} placeholder="Head / name" className={inputCls} />
        </td>
        <td className="px-1.5 py-1 text-center">
          {line?.headAccountId ? (
            <span className="rounded bg-zinc-100 px-1 text-[10px] font-medium text-zinc-500">
              {entityCode.get(line.entityId)}
            </span>
          ) : line ? (
            <span className="text-[10px] text-zinc-300" title="No matching head — projection only">—</span>
          ) : null}
        </td>
        <td className="px-1.5 py-0.5">
          <select name="source" form={formId} defaultValue={line?.source ?? 'HG'} className={inputCls}>
            {POOLS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </td>
        <td className="px-1.5 py-0.5">
          <select name="expenseType" form={formId} defaultValue={line?.expenseType ?? ''} className={inputCls}>
            <option value="">— type —</option>
            {EXPENSE_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </td>
        <td className="px-1.5 py-0.5">
          <select name="frequency" form={formId} defaultValue={line?.frequency ?? 'MONTHLY'} className={inputCls}>
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>{freqLabel[f]}</option>
            ))}
          </select>
        </td>
        <td className="px-1.5 py-0.5">
          <input
            name="amount"
            form={formId}
            required
            inputMode="decimal"
            defaultValue={line ? String(line.amount) : ''}
            placeholder="₹ +out / −in"
            title="Positive = money goes out, negative = comes in"
            className={`${inputCls} text-right`}
          />
        </td>
        <td className="whitespace-nowrap px-1.5 py-1 text-right text-xs tabular-nums text-zinc-500">
          {line && line.frequency !== 'ONCE' ? displayINR(lineMonthly(line).toFixed(2)) : line ? '—' : ''}
        </td>
        <td className="px-1.5 py-0.5">
          <input
            name="onMonth"
            form={formId}
            type="month"
            defaultValue={line?.onMonth ?? ''}
            title="One-off lines only: which month"
            className={inputCls}
          />
        </td>
        <td className="px-1.5 py-0.5">
          <input name="dayNote" form={formId} defaultValue={line?.dayNote ?? ''} placeholder="Day" className={`${inputCls} w-16`} />
        </td>
        <td className="px-1.5 py-0.5">
          <div className="flex items-center justify-end gap-1">
            <form id={formId} action={saveBudgetLineAction}>
              {line && <input type="hidden" name="id" value={line.id} />}
              {line?.taxTreatment && <input type="hidden" name="taxTreatment" value={line.taxTreatment} />}
              <button
                type="submit"
                className={`whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium ${
                  line ? 'border border-zinc-300 text-zinc-600 hover:bg-zinc-100' : 'bg-emerald-700 text-white hover:bg-emerald-600'
                }`}
              >
                {line ? 'Save' : 'Add'}
              </button>
            </form>
            {line && (
              <form action={archiveBudgetLineAction}>
                <input type="hidden" name="id" value={line.id} />
                <button
                  type="submit"
                  title="Remove from the plan (archived, not deleted)"
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
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Cash flow plan — all books, one sheet</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Openings are today&apos;s live balances; the budget rolls them forward. + = money out, − = money in
          (receipts negative, like the sheet). Plan runs {displayINR(monthlyIn.toFixed(0))} in / {displayINR(monthlyOut.toFixed(0))} out per month.
        </p>
      </div>

      {/* Projection: pools × months */}
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
              <th className="px-2 py-2">Pool</th>
              <th className="px-2 py-2 text-right">Today</th>
              {months.map((m) => (
                <th key={m} className="px-2 py-2 text-right">{monthLabel(m)}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {projection.map((p) => (
              <tr key={p.pool} className="hover:bg-zinc-50/60">
                <td className="px-2 py-1.5 font-medium text-zinc-800">{p.pool}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-zinc-900">
                  {displayINR(p.balanceNow.toFixed(2))}
                </td>
                {p.months.map((m) => (
                  <td
                    key={m.month}
                    className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums ${
                      m.closing < 0 ? 'font-semibold text-red-600' : 'text-zinc-900'
                    }`}
                    title={`${monthLabel(m.month)}: in ${displayINR(m.inflow.toFixed(0))} · out ${displayINR(m.outflow.toFixed(0))}`}
                  >
                    {displayINR(m.closing.toFixed(2))}
                    <span className="block text-[10px] font-normal text-zinc-400">
                      +{k(m.inflow)} −{k(m.outflow)}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {projection.length > 0 && (
            <tfoot className="border-t border-zinc-300 font-medium text-zinc-900">
              <tr>
                <td className="px-2 py-2">Total</td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {displayINR(projection.reduce((t, p) => t + p.balanceNow, 0).toFixed(2))}
                </td>
                {totals.map((t, i) => (
                  <td key={months[i]} className={`px-2 py-2 text-right tabular-nums ${t < 0 ? 'text-red-600' : ''}`}>
                    {displayINR(t.toFixed(2))}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* The plan itself — Excel-style always-editable register */}
      {admin && (
        <div className="space-y-2">
          <h2 className="font-medium text-zinc-900">
            Budget lines ({lines.length})
            <span className="ml-2 text-xs font-normal text-zinc-400">
              edit in place · one-off future values via frequency &quot;One-off&quot; + month
            </span>
          </h2>
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
            <table className="w-full min-w-[68rem] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
                  <th className="w-[22%] px-1.5 py-2">Head / name</th>
                  <th className="px-1.5 py-2">Books</th>
                  <th className="px-1.5 py-2">Pool</th>
                  <th className="px-1.5 py-2">Type</th>
                  <th className="px-1.5 py-2">Frequency</th>
                  <th className="px-1.5 py-2 text-right">Amount / period</th>
                  <th className="px-1.5 py-2 text-right">₹ / month</th>
                  <th className="px-1.5 py-2">Month (one-off)</th>
                  <th className="px-1.5 py-2">Day</th>
                  <th className="px-1.5 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {lineRow(null)}
                {lines.map((l) => lineRow(l))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-400">
            The <Link href="/cash" className="underline hover:text-zinc-700">Cash tab</Link> shows the CASH pool&apos;s
            projection from these same lines — one plan, both screens.
          </p>
        </div>
      )}
    </div>
  )
}
