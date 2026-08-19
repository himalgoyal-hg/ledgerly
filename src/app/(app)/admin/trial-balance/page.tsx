import Link from 'next/link'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { trialBalance, booksTally } from '@/lib/ledger/queries'
import { displayINR } from '@/lib/ledger/money'
import { PageHeader, controlClass, tableWrapClass, theadClass } from '@/components/ui'

// Trial Balance (spec §4) — Admin health check. Always tallies by
// construction: it is a straight aggregation of the balanced journal.

export default async function TrialBalancePage(props: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const user = await requireAdmin()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>

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
      <PageHeader
        kicker="Admin"
        title={`Trial Balance — ${entity.name} (${entity.code})`}
        subtitle={
          <>
            Whole books: Dr {displayINR(tally.debit)} = Cr {displayINR(tally.credit)}{' '}
            {tally.tallies ? '✓ tallies' : '✗ MISMATCH'}
          </>
        }
        actions={
          <form className="flex items-center gap-2">
            <input type="date" name="from" defaultValue={params.from} className={controlClass} />
            <span className="text-xs text-ink-3">to</span>
            <input type="date" name="to" defaultValue={params.to} className={controlClass} />
            <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2">
              Apply
            </button>
          </form>
        }
      />

      <div className={tableWrapClass}>
        <table className="w-full text-left text-sm">
          <thead className={theadClass}>
            <tr>
              <th className="px-4 py-3">Account</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3 text-right">Debits</th>
              <th className="px-4 py-3 text-right">Credits</th>
              <th className="px-4 py-3 text-right">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            {rows.map((r) => (
              <tr key={r.accountId}>
                <td className="px-4 py-2">
                  <Link
                    href={`/admin/ledgers?accountId=${r.accountId}`}
                    className="text-ink hover:underline"
                  >
                    <span className="font-mono text-xs text-ink-3">{r.code}</span>{' '}
                    {r.name}
                  </Link>
                </td>
                <td className="px-4 py-2 text-xs text-ink-2">{r.kind}</td>
                <td className="px-4 py-2 text-right text-ink-2">{displayINR(r.debit)}</td>
                <td className="px-4 py-2 text-right text-ink-2">{displayINR(r.credit)}</td>
                <td className="px-4 py-2 text-right font-medium text-ink">
                  {Number(r.balance) >= 0
                    ? `${displayINR(r.balance)} Dr`
                    : `${displayINR(String(-Number(r.balance)))} Cr`}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-ink-3">
                  No postings in this range.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="border-t border-line font-medium text-ink">
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
