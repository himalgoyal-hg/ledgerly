import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { prisma } from '@/lib/db'
import { balanceSheet } from '@/lib/reports/statements'
import { controlClass } from '@/components/ui'
import { ReportHeader, SectionTable, CashToggle } from '../report-chrome'
import { HeadCombobox } from '@/components/head-combobox'
import { cashAccountIds, readCashToggle } from '@/lib/reports/cash-filter'

// Balance Sheet (spec §10) as at a date. The books are never closed into
// reserves, so cumulative profit appears as its own equity line — which is
// what makes Assets = Liabilities + Equity hold exactly.

export default async function BalanceSheetPage(props: {
  searchParams: Promise<{ to?: string; head?: string; cash?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>

  const params = await props.searchParams
  const asOf = params.to ? new Date(params.to) : undefined
  const showCash = readCashToggle(params)
  const excludeCashAccounts = showCash ? [] : await cashAccountIds(entity.id)
  const headAccountId = params.head || undefined
  const [bs, sheetHeads] = await Promise.all([
    balanceSheet(entity.id, asOf, { headAccountId, excludeCashAccounts }),
    // ONLY the accounts a balance sheet can hold. Offering expense heads
    // here (Himal, 20 Aug: "balance sheet madech chalt nahi") just blanked
    // the whole sheet, since none of them ever appears on it.
    prisma.ledgerAccount.findMany({
      where: {
        entityId: entity.id,
        isGroup: false,
        archivedAt: null,
        kind: { in: ['ASSET', 'LIABILITY', 'EQUITY'] },
      },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, kind: true },
    }),
  ])
  const emptied = Boolean(headAccountId) && bs.assets.lines.length + bs.liabilities.lines.length + bs.equity.lines.length === 0
  const nameOf = (id?: string) => sheetHeads.find((h) => h.id === id)?.name
  const query = new URLSearchParams({
    ...(params.to ? { to: params.to } : {}),
    ...(headAccountId ? { head: headAccountId } : {}),
    ...(showCash ? {} : { cash: '0' }),
  })
  const rangeSuffix = query.toString() ? `&${query}` : ''

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Balance Sheet"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={[
          `as at ${params.to ?? 'today'}`,
          showCash ? '' : 'cash hidden',
          headAccountId ? `only ${nameOf(headAccountId) ?? '—'}` : '',
          // a narrowed sheet is one account's balance, not a statement
          headAccountId
            ? 'one account — totals are not meant to balance'
            : bs.balances
              ? '✓ balances'
              : '✗ DOES NOT BALANCE',
        ]
          .filter(Boolean)
          .join(' · ')}
        filters={
          <>
            {/* only balance-sheet accounts — an expense head would empty
                the sheet, which is what made this look broken */}
            <HeadCombobox
              heads={sheetHeads}
              name="head"
              defaultHeadId={params.head}
              placeholder="All accounts — type to search"
              className={`${controlClass} w-56`}
            />
            <CashToggle base="/reports/balance-sheet" showing={showCash} keep={{ to: params.to, head: params.head }} />
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

      {emptied && (
        <p className="rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">
          Nothing on the balance sheet for that account — it has no balance as at this date.
        </p>
      )}

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
