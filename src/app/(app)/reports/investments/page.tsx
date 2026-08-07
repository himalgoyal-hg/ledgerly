import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { investmentReport } from '@/lib/reports/prototype'

const inr = (n: number) => (n ? '₹' + Math.round(n).toLocaleString('en-IN') : '—')

export default async function InvestmentsPage() {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>
  const r = await investmentReport(entity.id, 12)
  const cellR = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap'
  const grid = (title: string, note: string, rows: typeof r.income) => (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-100 px-4 py-3">
        <h2 className="font-medium text-zinc-900">{title}</h2>
        <p className="text-xs text-zinc-400">{note}</p>
      </div>
      <table className="w-full min-w-[860px] text-xs">
        <thead className="border-b border-zinc-200 text-left uppercase text-zinc-500">
          <tr><th className="px-2 py-2">Account</th>{r.months.map((k) => <th key={k.key} className={cellR}>{k.label}</th>)}<th className={cellR}>Total</th></tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 text-sm">
          {rows.map((x) => (
            <tr key={x.name} className="hover:bg-zinc-50">
              <td className="px-2 py-1.5 text-zinc-800">{x.name}</td>
              {x.cells.map((c, i) => <td key={i} className={`${cellR} text-zinc-600`}>{inr(c)}</td>)}
              <td className={`${cellR} font-semibold`}>{inr(x.total)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={14} className="px-4 py-4 text-zinc-400">Nothing matching yet — accounts named interest / dividend / capital gain / investment appear here.</td></tr>}
        </tbody>
      </table>
    </div>
  )
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-900">Capital gains, dividend &amp; interest — {entity.code}</h1>
      {grid('Investment & other income received', 'interest, dividend and other receipts by month', r.income)}
      {grid('Amounts invested', 'SIPs, shares, deposits — money moved into investment accounts', r.invested)}
    </div>
  )
}
