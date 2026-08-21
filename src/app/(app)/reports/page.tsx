import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { profitAndLoss } from '@/lib/reports/statements'
import { controlClass } from '@/components/ui'
import { HeadCombobox } from '@/components/head-combobox'
import { ReportHeader, DateRangeFilters, SectionTable, CashToggle, ResetFilters } from './report-chrome'
import { cashAccountIds, readCashToggle } from '@/lib/reports/cash-filter'

// Profit & Loss (spec §10) — live over the journal, drillable to source.
// Two narrowing pickers sit beside the dates (Himal, 20 Aug): one Expense
// Head, and one Accounting Head — the latter reading the same effective
// ladder as Reports → By (the entry's own pick, else the master's mapping,
// else the head itself), so "show me everything filed under Loan given"
// answers the same way in both places.

export default async function ProfitAndLossPage(props: {
  searchParams: Promise<{ from?: string; to?: string; head?: string; ah?: string; by?: string; cash?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>

  const params = await props.searchParams
  const from = params.from ? new Date(params.from) : undefined
  const to = params.to ? new Date(params.to) : undefined
  // Which head each row IS — the lens, not a filter. Default: the account
  // that was posted to, the ordinary statement.
  const lens = params.by === 'ah' ? 'ah' : 'head'
  const headAccountId = lens === 'head' ? params.head || undefined : undefined
  const accountingHeadId = lens === 'ah' ? params.ah || undefined : undefined
  const showCash = readCashToggle(params)
  const excludeCashAccounts = showCash ? [] : await cashAccountIds(entity.id)
  const [pnl, allHeads] = await Promise.all([
    profitAndLoss(entity.id, { from, to, headAccountId, accountingHeadId, lens, excludeCashAccounts }),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, kind: true },
    }),
  ])
  // Expense Head picker lists what a P&L can hold; the Accounting Head one
  // lists every head, since an entry can be filed under any of them.
  const pnlHeads = allHeads.filter((h) => h.kind === 'EXPENSE' || h.kind === 'INCOME')
  const nameOf = (id?: string) => allHeads.find((h) => h.id === id)?.name

  const query = new URLSearchParams({
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
    ...(headAccountId ? { head: headAccountId } : {}),
    ...(accountingHeadId ? { ah: accountingHeadId } : {}),
    ...(lens === 'ah' ? { by: 'ah' } : {}),
  })
  // switching lens keeps the dates and drops the other lens's narrowing
  const lensHref = (key: 'head' | 'ah') => {
    const s = new URLSearchParams()
    if (params.from) s.set('from', params.from)
    if (params.to) s.set('to', params.to)
    if (key === 'ah') s.set('by', 'ah')
    const str = s.toString()
    return str ? `/reports?${str}` : '/reports'
  }
  const chip = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 text-sm font-medium ${
      active
        ? 'border-primary/40 bg-primary-soft text-primary'
        : 'border-line bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink'
    }`
  const rangeSuffix = query.toString() ? `&${query}` : ''
  const profit = Number(pnl.netProfit)

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Profit & Loss"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={[
          lens === 'ah'
            ? 'By Accounting Head — everything, with the re-pointed rows highlighted'
            : 'By Expense Head',
          showCash ? '' : 'cash hidden',
          params.from || params.to ? `${params.from ?? 'start'} to ${params.to ?? 'today'}` : 'All time',
          headAccountId ? `only ${nameOf(headAccountId) ?? '—'}` : '',
          accountingHeadId ? `only ${nameOf(accountingHeadId) ?? '—'}` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
        filters={
          <>
            {/* the lens — what each row IS. Clicking one shows that view
                alone, the way Reports → By's chips do. */}
            <Link href={lensHref('head')} className={chip(lens === 'head')}>
              Expense Head
            </Link>
            <Link href={lensHref('ah')} className={chip(lens === 'ah')}>
              Accounting Head
            </Link>
            {/* and one narrowing picker, the one that fits the lens */}
            {/* type-ahead rather than a long list: first letters filter, and
                text matching nothing simply means "all" */}
            {lens === 'head' ? (
              <HeadCombobox
                heads={pnlHeads}
                name="head"
                defaultHeadId={params.head}
                placeholder="All Expense Heads — type to search"
                className={`${controlClass} w-56`}
              />
            ) : (
              <>
                <input type="hidden" name="by" value="ah" />
                <HeadCombobox
                  heads={allHeads}
                  name="ah"
                  defaultHeadId={params.ah}
                  placeholder="All Accounting Heads — type to search"
                  className={`${controlClass} w-56`}
                />
              </>
            )}
            <CashToggle base="/reports" showing={showCash} keep={{ from: params.from, to: params.to, by: params.by, head: params.head, ah: params.ah }} />
            <ResetFilters base="/reports" active={Boolean(params.head || params.ah || params.by || params.from || params.to || params.cash)} />
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
