import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { prisma } from '@/lib/db'
import { balanceSheet } from '@/lib/reports/statements'
import { controlClass } from '@/components/ui'
import { ReportHeader, SectionTable, HeadLensFilters, readHeadLens, CashToggle } from '../report-chrome'
import { cashAccountIds, readCashToggle } from '@/lib/reports/cash-filter'

// Balance Sheet (spec §10) as at a date. The books are never closed into
// reserves, so cumulative profit appears as its own equity line — which is
// what makes Assets = Liabilities + Equity hold exactly.

export default async function BalanceSheetPage(props: {
  searchParams: Promise<{ to?: string; by?: string; head?: string; ah?: string; cash?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>

  const params = await props.searchParams
  const asOf = params.to ? new Date(params.to) : undefined
  const view = readHeadLens(params)
  const showCash = readCashToggle(params)
  const excludeCashAccounts = showCash ? [] : await cashAccountIds(entity.id)
  const [bs, allHeads] = await Promise.all([
    balanceSheet(entity.id, asOf, { ...view, excludeCashAccounts }),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, kind: true },
    }),
  ])
  const nameOf = (id?: string) => allHeads.find((h) => h.id === id)?.name
  const query = new URLSearchParams({
    ...(params.to ? { to: params.to } : {}),
    ...(view.headAccountId ? { head: view.headAccountId } : {}),
    ...(view.accountingHeadId ? { ah: view.accountingHeadId } : {}),
    ...(view.lens === 'ah' ? { by: 'ah' } : {}),
  })
  const rangeSuffix = query.toString() ? `&${query}` : ''

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Balance Sheet"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={[
          view.lens === 'ah' ? 'By Accounting Head' : 'By Expense Head',
          `as at ${params.to ?? 'today'}`,
          showCash ? '' : 'cash hidden',
          view.headAccountId ? `only ${nameOf(view.headAccountId) ?? '—'}` : '',
          view.accountingHeadId ? `only ${nameOf(view.accountingHeadId) ?? '—'}` : '',
          // a narrowed sheet is a slice, so it is not meant to balance
          view.headAccountId || view.accountingHeadId
            ? 'a slice — totals will not balance'
            : bs.balances
              ? '✓ balances'
              : '✗ DOES NOT BALANCE',
        ]
          .filter(Boolean)
          .join(' · ')}
        filters={
          <>
            <HeadLensFilters
              base="/reports/balance-sheet"
              lens={view.lens}
              keep={{ to: params.to }}
              headOptions={allHeads}
              ahOptions={allHeads}
              pickedHead={params.head}
              pickedAh={params.ah}
            />
            <CashToggle base="/reports/balance-sheet" showing={showCash} keep={{ to: params.to, by: params.by, head: params.head, ah: params.ah }} />
            <span className="text-xs text-ink-3">as at</span>
            <input
              type="date"
              name="to"
              defaultValue={params.to}
              className={controlClass}
            />
            <button
              type="submit"
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2"
            >
              Apply
            </button>
          </>
        }
        exportHref={`/reports/export?report=balance-sheet&${query}`}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <SectionTable section={bs.assets} range={rangeSuffix} />
          <div className="rounded-xl border border-line bg-surface-2/60 px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-ink-2">Total assets</span>
              <span className="text-lg font-semibold text-ink">
                {displayINR(bs.assetsTotal)}
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <SectionTable section={bs.liabilities} range={rangeSuffix} />
          <SectionTable section={bs.equity} range={rangeSuffix} />
          <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-card">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-ink-2">
                Profit to date
                <span className="ml-2 text-xs text-ink-3">(books not closed to reserves)</span>
              </span>
              <span className="font-medium text-ink">{displayINR(bs.retainedEarnings)}</span>
            </div>
          </div>
          <div className="rounded-xl border border-line bg-surface-2/60 px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-ink-2">
                Total liabilities + equity
              </span>
              <span className="text-lg font-semibold text-ink">
                {displayINR(bs.liabilitiesEquityTotal)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {!bs.balances && (
        <p className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
          The sheet does not balance. This should be impossible — the journal
          enforces Dr = Cr at the database level. Check the Trial Balance and
          the audit log.
        </p>
      )}
    </div>
  )
}
