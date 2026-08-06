import Link from 'next/link'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { trialBalance, booksTally } from '@/lib/ledger/queries'
import { displayINR } from '@/lib/ledger/money'

// Trial Balance (spec §4) — Admin health check. Always tallies by
// construction: it is a straight aggregation of the balanced journal.

export default async function TrialBalancePage(props: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const user = await requireAdmin()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>

  const params = await props.searchParams
  const from = params.from ? new Date(params.from) : undefined
  const to = params.to ? new Date(params.to) : undefined

  const [rows, tally] = await Promise.all([
    trialBalance(entity.id, { from, to }),
    booksTally(entity.id),
  ])
  const totals = rows.reduce(
    (acc, r) => ({ debit: acc.debit + Number(r.debit), credit: acc.credit + Number(r.credit) }),
    { debit: 0, credit: 0 },
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">
            Trial Balance — {entity.name} ({entity.code})
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Whole books: Dr {displayINR(tally.debit)} = Cr {displayINR(tally.credit)}{' '}
            {tally.tallies ? '✓ tallies' : '✗ MISMATCH'}
          </p>
        </div>
        <form className="flex items-center gap-2">
          <input type="date" name="from" defaultValue={params.from} className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <span className="text-xs text-zinc-400">to</span>
          <input type="date" name="to" defaultValue={params.to} className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">
            Apply
          </button>
        </form>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-3">Account</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3 text-right">Debits</th>
              <th className="px-4 py-3 text-right">Credits</th>
              <th className="px-4 py-3 text-right">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.map((r) => (
              <tr key={r.accountId}>
                <td className="px-4 py-2">
                  <Link
                    href={`/admin/ledgers?accountId=${r.accountId}`}
                    className="text-zinc-800 hover:underline"
                  >
                    <span className="font-mono text-xs text-zinc-400">{r.code}</span>{' '}
                    {r.name}
                  </Link>
                </td>
                <td className="px-4 py-2 text-xs text-zinc-500">{r.kind}</td>
                <td className="px-4 py-2 text-right text-zinc-700">{displayINR(r.debit)}</td>
                <td className="px-4 py-2 text-right text-zinc-700">{displayINR(r.credit)}</td>
                <td className="px-4 py-2 text-right font-medium text-zinc-900">
                  {Number(r.balance) >= 0
                    ? `${displayINR(r.balance)} Dr`
                    : `${displayINR(String(-Number(r.balance)))} Cr`}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-zinc-400">
                  No postings in this range.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="border-t border-zinc-300 font-medium text-zinc-900">
            <tr>
              <td className="px-4 py-3" colSpan={2}>
                Totals {Math.abs(totals.debit - totals.credit) < 0.005 ? '✓ tallies' : '✗ MISMATCH'}
              </td>
              <td className="px-4 py-3 text-right">{displayINR(totals.debit)}</td>
              <td className="px-4 py-3 text-right">{displayINR(totals.credit)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
