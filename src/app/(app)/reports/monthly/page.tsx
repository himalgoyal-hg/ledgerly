import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { expenseMatrixFy } from '@/lib/reports/prototype'

// Expenses M/M — the sheet's tab, computed instead of typed: heads × FY
// months straight from tagged entries, budget columns from Budget vs
// Actual. Tag a statement row and it lands here on refresh; nothing is
// entered by hand.

const inr = (n: number) => (Math.round(n) ? '₹' + Math.round(n).toLocaleString('en-IN') : '—')
const signed = (n: number) => {
  const v = Math.round(n)
  if (!v) return '—'
  return v < 0 ? `-₹${(-v).toLocaleString('en-IN')}` : `₹${v.toLocaleString('en-IN')}`
}

export default async function MonthlyMatrixPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>

  // FY starts April: Aug 2026 sits in FY 2026-27
  const now = new Date()
  const currentFy = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
  const params = await searchParams
  const fy = Number(params.fy) || currentFy

  const m = await expenseMatrixFy(entity.id, fy)
  const cellR = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Expenses M/M — {entity.code}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Straight from tagged entries — tag a statement row and it shows up here. Budget columns come from Budget vs Actual.
          </p>
        </div>
        <form className="flex items-center gap-1 text-sm">
          <label className="text-xs text-zinc-400">FY</label>
          <select
            name="fy"
            defaultValue={fy}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm"
          >
            {[currentFy - 2, currentFy - 1, currentFy].map((y) => (
              <option key={y} value={y}>
                {y}-{String(y + 1).slice(2)}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100">
            Go
          </button>
        </form>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full min-w-[1100px] text-xs">
          <thead className="border-b border-zinc-200 text-left uppercase text-zinc-500">
            <tr className="text-[9px] text-zinc-400">
              <th colSpan={2}></th>
              <th colSpan={12}></th>
              <th colSpan={2} className="px-2 pt-1.5 text-center font-medium normal-case">
                Recent month vs Budget
              </th>
              <th colSpan={2} className="px-2 pt-1.5 text-center font-medium normal-case">
                Full year
              </th>
            </tr>
            <tr>
              <th className={cellR}>Total</th>
              <th className="px-2 py-2">Expenses</th>
              {m.months.map((k, i) => (
                <th key={k.key} className={`${cellR} ${i === m.recentIdx ? 'text-zinc-800' : ''}`}>
                  {k.label}
                </th>
              ))}
              <th className={cellR}>Monthly budget</th>
              <th className={cellR}>Variance</th>
              <th className={cellR}>Year budget</th>
              <th className={cellR}>Variance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 text-sm">
            {m.rows.map((r) => (
              <tr key={r.name} className="hover:bg-zinc-50">
                <td className={`${cellR} font-semibold`}>{inr(r.total)}</td>
                <td className="px-2 py-1.5 text-zinc-800">{r.name}</td>
                {r.cells.map((c, i) => (
                  <td key={i} className={`${cellR} ${i === m.recentIdx ? 'bg-amber-50/60 text-zinc-700' : 'text-zinc-600'}`}>
                    {inr(c)}
                  </td>
                ))}
                <td className={`${cellR} text-zinc-500`}>{inr(r.monthlyBudget)}</td>
                <td className={`${cellR} ${r.recentVariance < 0 ? 'text-red-600' : 'text-zinc-500'}`}>{signed(r.recentVariance)}</td>
                <td className={`${cellR} text-zinc-500`}>{inr(r.yearBudget)}</td>
                <td className={`${cellR} ${r.yearVariance < 0 ? 'text-red-600' : 'text-zinc-500'}`}>{signed(r.yearVariance)}</td>
              </tr>
            ))}
            <tr className="bg-zinc-50 font-semibold">
              <td className={cellR}>{inr(m.grand)}</td>
              <td className="px-2 py-1.5">Total</td>
              {m.colTotals.map((c, i) => (
                <td key={i} className={cellR}>{inr(c)}</td>
              ))}
              <td className={cellR}>{inr(m.budgetGrand / 12)}</td>
              <td className={cellR}></td>
              <td className={cellR}>{inr(m.budgetGrand)}</td>
              <td className={`${cellR} ${m.budgetGrand - m.grand < 0 ? 'text-red-600' : ''}`}>{signed(m.budgetGrand - m.grand)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {m.rows.length === 0 && (
        <p className="text-sm text-zinc-400">No tagged expenses or budgets in FY {fy}-{String(fy + 1).slice(2)} yet.</p>
      )}
    </div>
  )
}
