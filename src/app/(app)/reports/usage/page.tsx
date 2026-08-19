import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { usageByMonth } from '@/lib/reports/prototype'
import { PageHeader, tableWrapClass, theadClass } from '@/components/ui'

const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN')

export default async function UsagePage() {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>
  const rows = await usageByMonth(entity.id, 12)
  const tb = rows.reduce((s, r) => s + r.bank, 0)
  const tc = rows.reduce((s, r) => s + r.cash, 0)
  const pct = (c: number, b: number) => Math.round((c / Math.max(1, c + b)) * 100) + '%'
  return (
    <div className="space-y-4">
      <PageHeader title={`Usage — cash versus bank — ${entity.code}`} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[['Paid through banks', tb, pct(tb, tc) + ' of spend'], ['Paid in cash', tc, pct(tc, tb) + ' of spend'], ['Total outflow', tb + tc, 'last 12 months']].map(([l, v, h]) => (
          <div key={String(l)} className="rounded-2xl border border-line bg-surface p-4 shadow-card">
            <p className="text-sm text-ink-2">{l}</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{inr(Number(v))}</p>
            <p className="mt-1 text-xs text-ink-3">{h}</p>
          </div>
        ))}
      </div>
      <div className={tableWrapClass}>
        <table className="w-full text-sm">
          <thead className={theadClass}>
            <tr><th className="px-3 py-2">Month</th><th className="px-3 py-2 text-right">Through bank</th><th className="px-3 py-2 text-right">In cash</th><th className="px-3 py-2 text-right">Cash share</th></tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-surface-2/60">
                <td className="px-3 py-2 text-ink-2">{r.label}</td>
                <td className="px-3 py-2 text-right tabular-nums">{inr(r.bank)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{inr(r.cash)}</td>
                <td className="px-3 py-2 text-right text-ink-2">{pct(r.cash, r.bank)}</td>
              </tr>
            ))}
            <tr className="bg-surface-2/60 font-semibold">
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
