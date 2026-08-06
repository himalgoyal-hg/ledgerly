import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { partyLedgers, type PartyRow } from '@/lib/reports/analysis'
import { ReportHeader } from '../report-chrome'

// Party ledgers (spec §10): customers, vendors and member/employee payables,
// each drillable to its full account statement.

export default async function PartiesPage(props: {
  searchParams: Promise<{ to?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const params = await props.searchParams
  const parties = await partyLedgers(entity.id, params.to ? new Date(params.to) : undefined)
  const query = new URLSearchParams(params.to ? { to: params.to } : {})
  const suffix = query.toString() ? `&${query}` : ''

  const table = (title: string, caption: string, rows: PartyRow[]) => {
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
                <td className="px-4 py-2">
                  <Link
                    href={`/reports/ledger?accountId=${row.accountId}${suffix}`}
                    className="text-zinc-800 hover:underline"
                  >
                    {row.name}
                  </Link>
                </td>
                <td className="w-36 px-4 py-2 text-right text-zinc-900">
                  {displayINR(row.balance)}
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
        {table('Customers', 'Receivable — they owe us', parties.customers)}
        {table('Vendors', 'Payable — we owe them', parties.vendors)}
        {table('Members & employees', 'Payable — reimbursements and salary', parties.payables)}
      </div>
    </div>
  )
}
