import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { expenseMatrix } from '@/lib/reports/prototype'

const inr = (n: number) => (n ? '₹' + Math.round(n).toLocaleString('en-IN') : '—')

export default async function MonthlyMatrixPage() {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>
  const m = await expenseMatrix(entity.id, 12)
  const cellR = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap'
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-900">
        Expenses month by month — {entity.code}
      </h1>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-xs">
          <thead className="border-b border-zinc-200 text-left uppercase text-zinc-500">
            <tr>
              <th className="px-2 py-2">Expense account</th>
              {m.months.map((k) => <th key={k.key} className={cellR}>{k.label}</th>)}
              <th className={cellR}>Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 text-sm">
            {m.rows.map((r) => (
              <tr key={r.name} className="hover:bg-zinc-50">
                <td className="px-2 py-1.5 text-zinc-800">{r.name}</td>
                {r.cells.map((c, i) => <td key={i} className={`${cellR} text-zinc-600`}>{inr(c)}</td>)}
                <td className={`${cellR} font-semibold`}>{inr(r.total)}</td>
              </tr>
            ))}
            <tr className="bg-zinc-50 font-semibold">
              <td className="px-2 py-1.5">Total</td>
              {m.colTotals.map((c, i) => <td key={i} className={cellR}>{inr(c)}</td>)}
              <td className={cellR}>{inr(m.grand)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {m.rows.length === 0 && <p className="text-sm text-zinc-400">No expense postings in the last 12 months.</p>}
    </div>
  )
}
