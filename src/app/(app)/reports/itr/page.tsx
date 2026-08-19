import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { profitAndLoss } from '@/lib/reports/statements'
import { taxesPaid } from '@/lib/reports/prototype'
import { PageHeader } from '@/components/ui'

const inr = (n: number) => '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN')

export default async function ItrPage() {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>
  const [pl, taxes] = await Promise.all([profitAndLoss(entity.id, {}), taxesPaid(entity.id)])
  const taxTotal = taxes.reduce((s, t) => s + t.amount, 0)
  const sec = (title: string, note: string, rows: { name: string; amount: number }[], total: number) => (
    <div className="rounded-2xl border border-line bg-surface shadow-card">
      <div className="border-b border-line-2 px-4 py-3">
        <h2 className="font-medium text-ink">{title}</h2>
        <p className="text-xs text-ink-3">{note}</p>
      </div>
      <div className="divide-y divide-line-2 px-4 text-sm">
        {rows.map((r) => (
          <p key={r.name} className="flex justify-between py-2"><span className="text-ink-2">{r.name}</span><span className="tabular-nums">{inr(r.amount)}</span></p>
        ))}
        {rows.length === 0 && <p className="py-2 text-ink-3">Nothing recorded.</p>}
        <p className="flex justify-between py-2 font-semibold"><span>Total</span><span className="tabular-nums">{inr(total)}</span></p>
      </div>
    </div>
  )
  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Report"
        title={<>ITR summary — {entity.code}</>}
        subtitle="A working figure only — not a computation of tax payable."
      />
      {sec('Heads of income', 'income ledgers, all time', pl.income.lines.map((l) => ({ name: l.name, amount: Number(l.amount) })), Number(pl.income.total))}
      {sec('Expenditure', 'expense ledgers, all time', pl.expenses.lines.map((l) => ({ name: l.name, amount: Number(l.amount) })), Number(pl.expenses.total))}
      {sec('Taxes & statutory payments', 'income tax, TDS, professional tax, GST paid', taxes, taxTotal)}
    </div>
  )
}
