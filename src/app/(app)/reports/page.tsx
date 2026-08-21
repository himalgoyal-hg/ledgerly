import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { profitAndLoss } from '@/lib/reports/statements'
import { controlClass } from '@/components/ui'
import { ReportHeader, DateRangeFilters, SectionTable } from './report-chrome'

// Profit & Loss (spec §10) — live over the journal, drillable to source.
// Two narrowing pickers sit beside the dates (Himal, 20 Aug): one Expense
// Head, and one Accounting Head — the latter reading the same effective
// ladder as Reports → By (the entry's own pick, else the master's mapping,
// else the head itself), so "show me everything filed under Loan given"
// answers the same way in both places.

export default async function ProfitAndLossPage(props: {
  searchParams: Promise<{ from?: string; to?: string; head?: string; ah?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>

  const params = await props.searchParams
  const from = params.from ? new Date(params.from) : undefined
  const to = params.to ? new Date(params.to) : undefined
  const headAccountId = params.head || undefined
  const accountingHeadId = params.ah || undefined
  const [pnl, allHeads] = await Promise.all([
    profitAndLoss(entity.id, { from, to, headAccountId, accountingHeadId }),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, kind: true },
    }),
  ])
  // Expense Head picker lists what a P&L can hold; the Accounting Head one
  // lists every head, since an entry can be filed under any of them.
  const pnlHeads = allHeads.filter((h) => h.kind === 'EXPENSE' || h.kind === 'INCOME')
  const nameOf = (id?: string) => allHeads.find((h) => h.id === id)?.name

  const query = new URLSearchParams({
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
    ...(params.head ? { head: params.head } : {}),
    ...(params.ah ? { ah: params.ah } : {}),
  })
  const rangeSuffix = query.toString() ? `&${query}` : ''
  const profit = Number(pnl.netProfit)

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Profit & Loss"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={[
          params.from || params.to
            ? `${params.from ?? 'start'} to ${params.to ?? 'today'}`
            : 'All time',
          headAccountId ? `Expense Head: ${nameOf(headAccountId) ?? '—'}` : '',
          accountingHeadId ? `Accounting Head: ${nameOf(accountingHeadId) ?? '—'}` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
        filters={
          <>
            {/* the two head pickers sit first, right after the title */}
            <select name="head" defaultValue={params.head ?? ''} title="Show only this Expense Head" className={controlClass}>
              <option value="">All Expense Heads</option>
              {pnlHeads.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
            <select name="ah" defaultValue={params.ah ?? ''} title="Show only entries filed under this Accounting Head" className={controlClass}>
              <option value="">All Accounting Heads</option>
              {allHeads.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
            {(params.head || params.ah) && (
              <Link
                href={`/reports${params.from || params.to ? `?${new URLSearchParams({ ...(params.from ? { from: params.from } : {}), ...(params.to ? { to: params.to } : {}) })}` : ''}`}
                title="Show every head again"
                className="rounded-lg border border-primary/30 bg-primary-soft px-2 py-1.5 text-xs font-medium text-primary hover:bg-primary/15"
              >
                ✕ Clear heads
              </Link>
            )}
            <DateRangeFilters from={params.from} to={params.to} />
          </>
        }
        exportHref={`/reports/export?report=pnl&${query}`}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionTable section={pnl.income} range={rangeSuffix} />
        <SectionTable section={pnl.expenses} range={rangeSuffix} />
      </div>

      <div
        className={`rounded-2xl border p-4 shadow-card ${
          profit >= 0 ? 'border-success/30 bg-success-soft' : 'border-danger/30 bg-danger-soft'
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-sm font-medium text-ink-2">
            {profit >= 0 ? 'Net profit' : 'Net loss'}
          </span>
          <span className="text-2xl font-semibold text-ink">
            {displayINR(profit >= 0 ? pnl.netProfit : String(-profit))}
          </span>
          <span className="ml-auto text-xs text-ink-2">
            income {displayINR(pnl.income.total)} − expenses {displayINR(pnl.expenses.total)}
          </span>
        </div>
      </div>
    </div>
  )
}
