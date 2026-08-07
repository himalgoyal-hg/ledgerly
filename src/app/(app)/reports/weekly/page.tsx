import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { weeklyExpenses } from '@/lib/reports/prototype'

const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN')

export default async function WeeklyPage() {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>
  const weeks = await weeklyExpenses(entity.id, 16)
  const max = Math.max(...weeks.map((w) => w.total), 1)
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-900">Expenses by week — {entity.code}</h1>
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex h-44 items-end gap-2 overflow-x-auto">
          {weeks.map((w) => (
            <div key={w.week} className="flex min-w-[44px] flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[10px] tabular-nums text-zinc-500">{inr(w.total)}</span>
              <div
                className="w-full rounded-t bg-blue-600"
                style={{ height: `${Math.max(3, Math.round((w.total / max) * 120))}px` }}
              />
              <span className="text-[10px] text-zinc-500">{w.week.slice(5)}</span>
            </div>
          ))}
          {weeks.length === 0 && <p className="text-sm text-zinc-400">No expenses in the last 16 weeks.</p>}
        </div>
      </div>
      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-500">
            <tr><th className="px-3 py-2">Week from</th><th className="px-3 py-2">Top accounts</th><th className="px-3 py-2 text-right">Total spend</th></tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {weeks.slice().reverse().map((w) => (
              <tr key={w.week} className="hover:bg-zinc-50">
                <td className="whitespace-nowrap px-3 py-2 text-zinc-600">{w.week}</td>
                <td className="px-3 py-2 text-xs text-zinc-500">
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
