import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { bankBalancesReport } from '@/lib/reports/prototype'
import { profitAndLoss } from '@/lib/reports/statements'
import { PageHeader, tableWrapClass, theadClass } from '@/components/ui'

const inr = (n: number) => (n < 0 ? '−' : '') + '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN')

export default async function BankBalancesPage() {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>
  const [rows, pl] = await Promise.all([bankBalancesReport(entity.id), profitAndLoss(entity.id, {})])
  const T = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0)
  const profit = Number(pl.netProfit)
  const cellR = 'px-3 py-2 text-right tabular-nums'
  return (
    <div className="space-y-4">
      <PageHeader kicker="Report" title={<>Bank &amp; profit balances — {entity.code}</>} />
      <div className={tableWrapClass}>
        <table className="w-full min-w-[560px] text-sm">
          <thead className={theadClass}>
            <tr><th className="px-3 py-2">Account</th><th className="px-3 py-2">Type</th><th className={cellR}>Receipts</th><th className={cellR}>Payments</th><th className={cellR}>Closing</th></tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-surface-2/60">
                <td className="px-3 py-2 text-ink">{r.label}</td>
                <td className="px-3 py-2 text-ink-2">{r.type}</td>
                <td className={cellR}>{inr(r.receipts)}</td>
                <td className={cellR}>{inr(r.payments)}</td>
                <td className={`${cellR} font-semibold ${r.closing < 0 ? 'text-danger' : ''}`}>{inr(r.closing)}</td>
              </tr>
            ))}
            <tr className="bg-surface-2/60 font-semibold">
              <td className="px-3 py-2">Total</td><td />
              <td className={cellR}>{inr(T((r) => r.receipts))}</td>
              <td className={cellR}>{inr(T((r) => r.payments))}</td>
              <td className={cellR}>{inr(T((r) => r.closing))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-card text-sm">
        <h2 className="font-medium text-ink">Reconciliation to profit</h2>
        <div className="mt-2 space-y-1 text-ink-2">
          <p className="flex justify-between"><span>Net cash movement</span><span className="tabular-nums">{inr(T((r) => r.closing))}</span></p>
          <p className="flex justify-between"><span>Surplus / (deficit) per profit &amp; loss</span><span className="tabular-nums">{inr(profit)}</span></p>
          <p className="flex justify-between font-medium text-ink"><span>Difference — balance-sheet items (loans, capital, drawings)</span><span className="tabular-nums">{inr(T((r) => r.closing) - profit)}</span></p>
        </div>
      </div>
    </div>
  )
}
