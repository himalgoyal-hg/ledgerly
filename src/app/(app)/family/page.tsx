import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { displayINR } from '@/lib/ledger/money'
import { balanceSheet } from '@/lib/reports/statements'
import { balanceTiles } from '@/lib/reports/dashboard'
import { profitAndLoss } from '@/lib/reports/statements'
import { PageHeader, tableWrapClass, theadClass } from '@/components/ui'

// "All entities (family)" view from the v2 prototype: every set of books
// stands alone; the total is the family position.

export default async function FamilyPage() {
  await requireAdmin()
  const entities = await prisma.entity.findMany({
    where: { archivedAt: null },
    orderBy: { code: 'asc' },
  })
  const per = await Promise.all(
    entities.map(async (e) => {
      const [bs, tiles, pl] = await Promise.all([
        balanceSheet(e.id),
        balanceTiles(e.id),
        profitAndLoss(e.id, {}),
      ])
      const cash = Number(tiles.bankTotal) + Number(tiles.cashTotal)
      const assets = Number(bs.assetsTotal)
      const liab = Number(bs.liabilities.total)
      return {
        id: e.id,
        name: e.name,
        code: e.code,
        cash,
        assets,
        liab,
        capital: assets - liab,
        profit: Number(bs.retainedEarnings),
        income: Number(pl.income.total),
        expense: Number(pl.expenses.total),
      }
    }),
  )
  const T = (f: (r: (typeof per)[number]) => number) => per.reduce((s, r) => s + f(r), 0)
  const cellR = 'px-3 py-2 text-right tabular-nums'

  return (
    <div className="space-y-6">
      <PageHeader kicker="Family" title="Family view — all entities" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Family net capital', T((r) => r.capital), `${per.length} entities combined`],
          ['Cash & bank', T((r) => r.cash), 'across every account'],
          ['Total assets', T((r) => r.assets), 'including bank balances'],
          ['Total liabilities', T((r) => r.liab), 'loans & dues'],
        ].map(([label, v, hint]) => (
          <div key={String(label)} className="rounded-2xl border border-line bg-surface p-4 shadow-card">
            <p className="text-sm text-ink-2">{label}</p>
            <p className="mt-1 text-2xl font-semibold text-ink">{displayINR(Number(v).toFixed(2))}</p>
            <p className="mt-1 text-xs text-ink-3">{hint}</p>
          </div>
        ))}
      </div>

      <div className={tableWrapClass}>
        <table className="w-full min-w-[760px] text-sm">
          <thead className={theadClass}>
            <tr>
              <th className="px-3 py-2.5">Entity</th>
              <th className={cellR}>Cash &amp; bank</th>
              <th className={cellR}>Total assets</th>
              <th className={cellR}>Liabilities</th>
              <th className={cellR}>Net capital</th>
              <th className={cellR}>Income (all time)</th>
              <th className={cellR}>Expenses</th>
              <th className={cellR}>Surplus</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            {per.map((r) => (
              <tr key={r.id} className="hover:bg-surface-2/60">
                <td className="px-3 py-2 font-medium text-ink">
                  {r.name} <span className="text-xs text-ink-3">({r.code})</span>
                </td>
                <td className={cellR}>{displayINR(r.cash.toFixed(2))}</td>
                <td className={cellR}>{displayINR(r.assets.toFixed(2))}</td>
                <td className={cellR}>{displayINR(r.liab.toFixed(2))}</td>
                <td className={`${cellR} font-semibold`}>{displayINR(r.capital.toFixed(2))}</td>
                <td className={cellR}>{displayINR(r.income.toFixed(2))}</td>
                <td className={cellR}>{displayINR(r.expense.toFixed(2))}</td>
                <td className={`${cellR} ${r.profit < 0 ? 'text-danger' : 'text-success'}`}>
                  {displayINR(r.profit.toFixed(2))}
                </td>
              </tr>
            ))}
            <tr className="bg-surface-2/60 font-semibold">
              <td className="px-3 py-2">Family total</td>
              <td className={cellR}>{displayINR(T((r) => r.cash).toFixed(2))}</td>
              <td className={cellR}>{displayINR(T((r) => r.assets).toFixed(2))}</td>
              <td className={cellR}>{displayINR(T((r) => r.liab).toFixed(2))}</td>
              <td className={cellR}>{displayINR(T((r) => r.capital).toFixed(2))}</td>
              <td className={cellR}>{displayINR(T((r) => r.income).toFixed(2))}</td>
              <td className={cellR}>{displayINR(T((r) => r.expense).toFixed(2))}</td>
              <td className={cellR}>{displayINR(T((r) => r.profit).toFixed(2))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-3">
        Inter-entity loans appear on both sides and net off in the family total.
      </p>
    </div>
  )
}
