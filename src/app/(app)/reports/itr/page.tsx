import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { profitAndLoss, type RePointedLine } from '@/lib/reports/statements'
import { taxesPaid } from '@/lib/reports/prototype'
import { PageHeader } from '@/components/ui'
import { HeadLensFilters, readHeadLens, ResetFilters } from '../report-chrome'

const inr = (n: number) => '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN')

export default async function ItrPage(props: {
  searchParams: Promise<{ by?: string; head?: string; ah?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>
  const params = await props.searchParams
  // the two lenses every head report carries (Himal, 21 Aug): the same
  // figures either way, the Accounting Head one leading each block with
  // what is filed under a different head
  const lens = readHeadLens(params)
  const [pl, taxes, allHeads] = await Promise.all([
    profitAndLoss(entity.id, lens),
    taxesPaid(entity.id),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, kind: true },
    }),
  ])
  const pnlHeads = allHeads.filter((h) => h.kind === 'EXPENSE' || h.kind === 'INCOME')
  const nameOf = (id?: string) => allHeads.find((h) => h.id === id)?.name
  const taxTotal = taxes.reduce((s, t) => s + t.amount, 0)
  const sec = (
    title: string,
    note: string,
    rows: { name: string; amount: number }[],
    total: number,
    band?: RePointedLine[],
  ) => (
    <div className="rounded-2xl border border-line bg-surface shadow-card">
      <div className="border-b border-line-2 px-4 py-3">
        <h2 className="font-medium text-ink">{title}</h2>
        <p className="text-xs text-ink-3">{note}</p>
      </div>
      <div className="divide-y divide-line-2 px-4 text-sm">
        {/* the re-pointed band first — a memo, already inside the rows */}
        {band && band.length > 0 && (
          <div className="-mx-4 bg-primary-soft/40 px-4">
            <p className="py-1 text-[10px] font-bold uppercase tracking-widest text-primary">
              Filed under a different Accounting Head
              <span className="ml-2 font-normal normal-case tracking-normal text-primary/80">shown, not added</span>
            </p>
            {band.map((m) => (
              <p key={`${m.accountId}-${m.fromAccountId}`} className="flex justify-between py-1.5">
                <span className="font-medium text-primary">
                  {m.name}
                  <span className="ml-1.5 rounded bg-primary/15 px-1 text-[9px] font-semibold uppercase tracking-wide text-primary">changed</span>
                  <span className="ml-2 text-xs font-normal text-ink-3">from {m.fromName}</span>
                </span>
                <span className="tabular-nums text-primary">{inr(Number(m.amount))}</span>
              </p>
            ))}
          </div>
        )}
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
        subtitle={[
          'A working figure only — not a computation of tax payable.',
          lens.lens === 'ah'
            ? 'By Accounting Head — the same figures, with what is filed under a different head shown first'
            : 'By Expense Head',
          lens.headAccountId ? `only ${nameOf(lens.headAccountId) ?? '—'}` : '',
          lens.accountingHeadId ? `only ${nameOf(lens.accountingHeadId) ?? '—'}` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <form className="flex flex-wrap items-center gap-1">
            <HeadLensFilters
              base="/reports/itr"
              lens={lens.lens}
              headOptions={pnlHeads}
              ahOptions={allHeads}
              pickedHead={params.head}
              pickedAh={params.ah}
            />
            <ResetFilters base="/reports/itr" active={Boolean(params.head || params.ah || params.by)} />
            <button type="submit" className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink">
              Apply
            </button>
          </form>
        }
      />
      {sec('Heads of income', 'income ledgers, all time', pl.income.lines.map((l) => ({ name: l.name, amount: Number(l.amount) })), Number(pl.income.total), pl.income.rePointed)}
      {sec('Expenditure', 'expense ledgers, all time', pl.expenses.lines.map((l) => ({ name: l.name, amount: Number(l.amount) })), Number(pl.expenses.total), pl.expenses.rePointed)}
      {sec('Taxes & statutory payments', 'income tax, TDS, professional tax, GST paid', taxes, taxTotal)}
    </div>
  )
}
