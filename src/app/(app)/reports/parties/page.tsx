import Link from 'next/link'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { prisma } from '@/lib/db'
import { displayINR } from '@/lib/ledger/money'
import { partyLedgers, type PartyRow } from '@/lib/reports/analysis'
import { ReportHeader } from '../report-chrome'
import { settlePartyCashAction } from './actions'

// Party ledgers (spec §10): customers, vendors and member/employee payables,
// each drillable to its full account statement. Customer/vendor rows carry a
// "mark paid" cash-settlement form; bank settlements happen by tagging the
// statement row to the party's head, never from here.

export default async function PartiesPage(props: {
  searchParams: Promise<{ to?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

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
      <summary className="cursor-pointer text-right text-xs text-zinc-400 hover:text-zinc-700">
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
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs"
        />
        <input
          name="amount"
          required
          inputMode="decimal"
          defaultValue={row.balance}
          className="w-24 rounded-md border border-zinc-300 px-2 py-1 text-right text-xs"
        />
        <select
          name="locationId"
          required
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs"
        >
          {cashLocations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700"
        >
          {direction === 'receive' ? 'Received in cash' : 'Paid in cash'}
        </button>
        <p className="w-full text-right text-[10px] text-zinc-400">
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
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 px-4 py-2">
          <h2 className="text-sm font-medium text-zinc-900">{title}</h2>
          <p className="text-xs text-zinc-400">{caption}</p>
        </div>
        <table className="w-full text-left text-sm">
          <tbody className="divide-y divide-zinc-100">
            {rows.map((row) => (
              <tr key={row.accountId}>
                <td className="px-4 py-2 align-top">
                  <Link
                    href={`/reports/ledger?accountId=${row.accountId}${suffix}`}
                    className="text-zinc-800 hover:underline"
                  >
                    {row.name}
                  </Link>
                </td>
                <td className="w-56 px-4 py-2 text-right">
                  <span className="text-zinc-900">{displayINR(row.balance)}</span>
                  {settle && canSettle && settleForm(row, settle)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-4 text-center text-sm text-zinc-400">
                  Nothing outstanding.
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="border-t border-zinc-300 font-medium text-zinc-900">
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
            <span className="text-xs text-zinc-400">as at</span>
            <input
              type="date"
              name="to"
              defaultValue={params.to}
              className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
            />
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
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
