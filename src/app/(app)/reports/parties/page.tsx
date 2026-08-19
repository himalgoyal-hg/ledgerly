import Link from 'next/link'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { prisma } from '@/lib/db'
import { displayINR } from '@/lib/ledger/money'
import { partyLedgers, type PartyRow } from '@/lib/reports/analysis'
import { ReportHeader } from '../report-chrome'
import { settlePartyCashAction } from './actions'
import { controlClass } from '@/components/ui'

// Party ledgers (spec §10): customers, vendors and member/employee payables,
// each drillable to its full account statement. Customer/vendor rows carry a
// "mark paid" cash-settlement form; bank settlements happen by tagging the
// statement row to the party's head, never from here.

export default async function PartiesPage(props: {
  searchParams: Promise<{ to?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>

  const params = await props.searchParams
  const [parties, cashLocations] = await Promise.all([
    partyLedgers(entity.id, params.to ? new Date(params.to) : undefined),
    prisma.cashLocation.findMany({
      where: { entityId: entity.id, archivedAt: null, ledgerAccountId: { not: null } },
      orderBy: { name: 'asc' },
    }),
  ])
  const canSettle =
    (isAdmin(user) || hasPermission(user, 'cashEntries')) && cashLocations.length > 0
  const today = new Date().toISOString().slice(0, 10)
  const query = new URLSearchParams(params.to ? { to: params.to } : {})
  const suffix = query.toString() ? `&${query}` : ''

  const settleForm = (row: PartyRow, direction: 'receive' | 'pay') => (
    <details>
      <summary className="cursor-pointer text-right text-xs text-ink-3 hover:text-ink-2">
        Mark paid
      </summary>
      <form
        action={settlePartyCashAction}
        className="mt-2 flex flex-wrap items-center justify-end gap-2"
      >
        <input type="hidden" name="accountId" value={row.accountId} />
        <input type="hidden" name="direction" value={direction} />
        <input
          type="date"
          name="date"
          required
          defaultValue={today}
          className={controlClass}
        />
        <input
          name="amount"
          required
          inputMode="decimal"
          defaultValue={row.balance}
          className={`${controlClass} w-24 text-right`}
        />
        <select
          name="locationId"
          required
          className={controlClass}
        >
          {cashLocations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-white hover:bg-primary-strong"
        >
          {direction === 'receive' ? 'Received in cash' : 'Paid in cash'}
        </button>
        <p className="w-full text-right text-[10px] text-ink-3">
          Came by bank instead? Tag the statement row to this party — that settles it.
        </p>
      </form>
    </details>
  )

  const table = (
    title: string,
    caption: string,
    rows: PartyRow[],
    settle?: 'receive' | 'pay',
  ) => {
    const total = rows.reduce((sum, r) => sum + Number(r.balance), 0)
    return (
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="border-b border-line px-4 py-2">
          <h2 className="text-sm font-medium text-ink">{title}</h2>
          <p className="text-xs text-ink-3">{caption}</p>
        </div>
        <table className="w-full text-left text-sm">
          <tbody className="divide-y divide-line-2">
            {rows.map((row) => (
              <tr key={row.accountId}>
                <td className="px-4 py-2 align-top">
                  <Link
                    href={`/reports/ledger?accountId=${row.accountId}${suffix}`}
                    className="text-ink hover:underline"
                  >
                    {row.name}
                  </Link>
                </td>
                <td className="w-56 px-4 py-2 text-right">
                  <span className="text-ink">{displayINR(row.balance)}</span>
                  {settle && canSettle && settleForm(row, settle)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-4 text-center text-sm text-ink-3">
                  Nothing outstanding.
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="border-t border-line font-medium text-ink">
              <tr>
                <td className="px-4 py-2">Total</td>
                <td className="px-4 py-2 text-right">{displayINR(total)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Party ledgers"
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={`Outstanding as at ${params.to ?? 'today'}`}
        filters={
          <>
            <span className="text-xs text-ink-3">as at</span>
            <input
              type="date"
              name="to"
              defaultValue={params.to}
              className={controlClass}
            />
            <button
              type="submit"
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              Apply
            </button>
          </>
        }
        exportHref={`/reports/export?report=parties&${query}`}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {table('Customers', 'Receivable — they owe us', parties.customers, 'receive')}
        {table('Vendors', 'Payable — we owe them', parties.vendors, 'pay')}
        {table('Members & employees', 'Payable — reimbursements and salary', parties.payables)}
      </div>
    </div>
  )
}
