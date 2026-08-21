import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { prisma } from '@/lib/db'
import { balanceSheet } from '@/lib/reports/statements'
import { controlClass } from '@/components/ui'
import { ReportHeader, SectionTable, CashToggle, ResetFilters, HeadLensFilters } from '../report-chrome'
import { cashAccountIds, readCashToggle } from '@/lib/reports/cash-filter'

// Balance Sheet (spec §10) as at a date. The books are never closed into
// reserves, so cumulative profit appears as its own equity line — which is
// what makes Assets = Liabilities + Equity hold exactly.
//
// The same two lenses as the P&L (Himal, 21 Aug: "balance sheet made pan
// add kar Expense Head / Accounting Head filter"). Both read the same
// sheet; the Accounting Head one leads each side with the money filed
// under a different head — e.g. Loan given carrying −62,000 from Poker.

export default async function BalanceSheetPage(props: {
  searchParams: Promise<{ to?: string; head?: string; ah?: string; by?: string; cash?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>

  const params = await props.searchParams
  const asOf = params.to ? new Date(params.to) : undefined
  const showCash = readCashToggle(params)
  const excludeCashAccounts = showCash ? [] : await cashAccountIds(entity.id)
  const lens = params.by === 'ah' ? 'ah' : 'head'
  const headAccountId = lens === 'head' ? params.head || undefined : undefined
  const accountingHeadId = lens === 'ah' ? params.ah || undefined : undefined
  const [bs, allHeads] = await Promise.all([
    balanceSheet(entity.id, asOf, { lens, headAccountId, accountingHeadId, excludeCashAccounts }),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, kind: true },
    }),
  ])
  // The posting-head picker offers ONLY the accounts a balance sheet can
  // hold — an expense head here just blanked the sheet (Himal, 20 Aug:
  // "balance sheet madech chalt nahi"). The Accounting Head picker lists
  // every head, since money on the sheet can be filed under any of them.
  const sheetHeads = allHeads.filter((h) => h.kind === 'ASSET' || h.kind === 'LIABILITY' || h.kind === 'EQUITY')
  // a narrowed sheet with no rows AND nothing in the re-pointed bands
  const sides = [bs.assets, bs.liabilities, bs.equity]
  const emptied =
    Boolean(headAccountId || accountingHeadId) &&
    sides.reduce((n, x) => n + x.lines.length + (x.rePointed?.length ?? 0), 0) === 0
  // both are already on their own normal side, so they simply add
  const openingLiabEquity =
    bs.liabilities.openingTotal !== undefined && bs.equity.openingTotal !== undefined
      ? (Number(bs.liabilities.openingTotal) + Number(bs.equity.openingTotal)).toFixed(2)
      : undefined
  const nameOf = (id?: string) => allHeads.find((h) => h.id === id)?.name
  const query = new URLSearchParams({
    ...(params.to ? { to: params.to } : {}),
    ...(headAccountId ? { head: headAccountId } : {}),
    ...(accountingHeadId ? { ah: accountingHeadId } : {}),
    ...(lens === 'ah' ? { by: 'ah' } : {}),
    ...(showCash ? {} : { cash: '0' }),
  })
  const rangeSuffix = query.toString() ? `&${query}` : ''

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Balance Sheet"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={[
          lens === 'ah'
            ? 'By Accounting Head — the same sheet, with the money filed under a different head shown first'
            : 'By Expense Head',
          `as at ${params.to ?? 'today'}`,
          showCash ? '' : 'cash hidden',
          headAccountId ? `only ${nameOf(headAccountId) ?? '—'}` : '',
          accountingHeadId ? `only ${nameOf(accountingHeadId) ?? '—'}` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
        filters={
          <>
            {/* read left to right: the lens and its picker, as at when,
                what to leave out, and the way back */}
            <HeadLensFilters
              base="/reports/balance-sheet"
              lens={lens}
              keep={{ to: params.to, cash: params.cash }}
              headOptions={sheetHeads}
              ahOptions={allHeads}
              pickedHead={params.head}
              pickedAh={params.ah}
              headPlaceholder="All accounts — type to search"
            />
            <span className="text-xs text-ink-3">as at</span>
            <input type="date" name="to" defaultValue={params.to} className={controlClass} />
            {!showCash && <input type="hidden" name="cash" value="0" />}
            <button
              type="submit"
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2"
            >
              Apply
            </button>
            <CashToggle
              base="/reports/balance-sheet"
              showing={showCash}
              keep={{ to: params.to, by: params.by, head: params.head, ah: params.ah }}
            />
            <ResetFilters
              base="/reports/balance-sheet"
              active={Boolean(params.head || params.ah || params.by || params.to || params.cash)}
            />
          </>
        }
        exportHref={`/reports/export?report=balance-sheet&${query}`}
      />

      {emptied && (
        <p className="rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">
          Nothing on the balance sheet for that account — it has no balance as at this date.
        </p>
      )}

      {/* The headline first: both sides, what they opened at and what they
          are now. The detail follows below. */}
      <div className="rounded-2xl border border-line bg-surface shadow-card">
        <div className="grid divide-y divide-line-2 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          {(
            [
              ['Total assets', bs.assets.openingTotal, bs.assetsTotal],
              [
                'Total liabilities + equity',
                openingLiabEquity,
                bs.liabilitiesEquityTotal,
              ],
            ] as const
          ).map(([label, opening, now]) => (
            <div key={label} className="px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</div>
              <div className="mt-0.5 text-xl font-semibold tabular-nums text-ink">{displayINR(now)}</div>
              {opening !== undefined && (
                <div className="text-[11px] tabular-nums text-ink-3">
                  opened at {displayINR(opening)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

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

      {/* A narrowed sheet is a deliberate slice and is not meant to balance
          — this warning is for a genuine integrity problem only. */}
      {!bs.balances && !headAccountId && !accountingHeadId && (
        <p className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
          The sheet does not balance. This should be impossible — the journal
          enforces Dr = Cr at the database level. Check the Trial Balance and
          the audit log.
        </p>
      )}
    </div>
  )
}
