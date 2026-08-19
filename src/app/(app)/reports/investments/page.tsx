import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { investmentReport } from '@/lib/reports/prototype'
import { PageHeader, tableWrapClass, theadClass } from '@/components/ui'

const inr = (n: number) => (n ? '₹' + Math.round(n).toLocaleString('en-IN') : '—')

export default async function InvestmentsPage() {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>
  const r = await investmentReport(entity.id, 12)
  const cellR = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap'
  const grid = (title: string, note: string, rows: typeof r.income) => (
    <div className={tableWrapClass}>
      <div className="border-b border-line-2 px-4 py-3">
        <h2 className="font-medium text-ink">{title}</h2>
        <p className="text-xs text-ink-3">{note}</p>
      </div>
      <table className="w-full min-w-[860px] text-xs">
        <thead className={theadClass}>
          <tr><th className="px-2 py-2">Account</th>{r.months.map((k) => <th key={k.key} className={cellR}>{k.label}</th>)}<th className={cellR}>Total</th></tr>
        </thead>
        <tbody className="divide-y divide-line-2 text-sm">
          {rows.map((x) => (
            <tr key={x.name} className="hover:bg-surface-2/60">
              <td className="px-2 py-1.5 text-ink">{x.name}</td>
              {x.cells.map((c, i) => <td key={i} className={`${cellR} text-ink-2`}>{inr(c)}</td>)}
              <td className={`${cellR} font-semibold`}>{inr(x.total)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={14} className="px-4 py-4 text-ink-3">Nothing matching yet — accounts named interest / dividend / capital gain / investment appear here.</td></tr>}
        </tbody>
      </table>
    </div>
  )
  return (
    <div className="space-y-4">
      <PageHeader kicker="Report" title={<>Capital gains, dividend &amp; interest — {entity.code}</>} />
      {grid('Investment & other income received', 'interest, dividend and other receipts by month', r.income)}
      {grid('Amounts invested', 'SIPs, shares, deposits — money moved into investment accounts', r.invested)}
    </div>
  )
}
