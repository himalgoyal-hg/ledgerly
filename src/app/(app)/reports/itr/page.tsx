import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { profitAndLoss } from '@/lib/reports/statements'
import { taxesPaid } from '@/lib/reports/prototype'

const inr = (n: number) => '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN')

export default async function ItrPage() {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>
  const [pl, taxes] = await Promise.all([profitAndLoss(entity.id, {}), taxesPaid(entity.id)])
  const taxTotal = taxes.reduce((s, t) => s + t.amount, 0)
  const sec = (title: string, note: string, rows: { name: string; amount: number }[], total: number) => (
    <div className="rounded-xl border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-100 px-4 py-3">
        <h2 className="font-medium text-zinc-900">{title}</h2>
        <p className="text-xs text-zinc-400">{note}</p>
      </div>
      <div className="divide-y divide-zinc-100 px-4 text-sm">
        {rows.map((r) => (
          <p key={r.name} className="flex justify-between py-2"><span className="text-zinc-700">{r.name}</span><span className="tabular-nums">{inr(r.amount)}</span></p>
        ))}
        {rows.length === 0 && <p className="py-2 text-zinc-400">Nothing recorded.</p>}
        <p className="flex justify-between py-2 font-semibold"><span>Total</span><span className="tabular-nums">{inr(total)}</span></p>
      </div>
    </div>
  )
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-900">ITR summary — {entity.code}</h1>
      <p className="text-xs text-zinc-400">A working figure only — not a computation of tax payable.</p>
      {sec('Heads of income', 'income ledgers, all time', pl.income.lines.map((l) => ({ name: l.name, amount: Number(l.amount) })), Number(pl.income.total))}
      {sec('Expenditure', 'expense ledgers, all time', pl.expenses.lines.map((l) => ({ name: l.name, amount: Number(l.amount) })), Number(pl.expenses.total))}
      {sec('Taxes & statutory payments', 'income tax, TDS, professional tax, GST paid', taxes, taxTotal)}
    </div>
  )
}
