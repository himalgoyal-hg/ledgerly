import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { usageByMonth } from '@/lib/reports/prototype'

const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN')

export default async function UsagePage() {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>
  const rows = await usageByMonth(entity.id, 12)
  const tb = rows.reduce((s, r) => s + r.bank, 0)
  const tc = rows.reduce((s, r) => s + r.cash, 0)
  const pct = (c: number, b: number) => Math.round((c / Math.max(1, c + b)) * 100) + '%'
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-900">Usage — cash versus bank — {entity.code}</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[['Paid through banks', tb, pct(tb, tc) + ' of spend'], ['Paid in cash', tc, pct(tc, tb) + ' of spend'], ['Total outflow', tb + tc, 'last 12 months']].map(([l, v, h]) => (
          <div key={String(l)} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <p className="text-sm text-zinc-500">{l}</p>
            <p className="mt-1 text-2xl font-semibold text-zinc-900">{inr(Number(v))}</p>
            <p className="mt-1 text-xs text-zinc-400">{h}</p>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs uppercase text-zinc-500">
            <tr><th className="px-3 py-2">Month</th><th className="px-3 py-2 text-right">Through bank</th><th className="px-3 py-2 text-right">In cash</th><th className="px-3 py-2 text-right">Cash share</th></tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-zinc-50">
                <td className="px-3 py-2 text-zinc-600">{r.label}</td>
                <td className="px-3 py-2 text-right tabular-nums">{inr(r.bank)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{inr(r.cash)}</td>
                <td className="px-3 py-2 text-right text-zinc-500">{pct(r.cash, r.bank)}</td>
              </tr>
            ))}
            <tr className="bg-zinc-50 font-semibold">
              <td className="px-3 py-2">Total</td>
              <td className="px-3 py-2 text-right tabular-nums">{inr(tb)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{inr(tc)}</td>
              <td className="px-3 py-2 text-right">{pct(tc, tb)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
