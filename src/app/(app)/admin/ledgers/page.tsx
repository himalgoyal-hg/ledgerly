import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { accountLedger } from '@/lib/ledger/queries'
import { displayINR } from '@/lib/ledger/money'
import { PageHeader, controlClass, tableWrapClass, theadClass } from '@/components/ui'

// Account ledgers (spec §4) — derived statement view for any account,
// with running balance. Drill-down target from the Trial Balance.

export default async function LedgersPage(props: {
  searchParams: Promise<{ accountId?: string; from?: string; to?: string }>
}) {
  const user = await requireAdmin()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>

  const params = await props.searchParams
  const accounts = await prisma.ledgerAccount.findMany({
    where: { entityId: entity.id, isGroup: false },
    orderBy: { code: 'asc' },
  })
  const account = accounts.find((a) => a.id === params.accountId) ?? null

  const ledger = account
    ? await accountLedger(account.id, {
        from: params.from ? new Date(params.from) : undefined,
        to: params.to ? new Date(params.to) : undefined,
      })
    : null

  return (
    <div className="space-y-6">
      <PageHeader kicker="Admin" title={`Ledgers — ${entity.name} (${entity.code})`} />

      <form className="flex flex-wrap items-center gap-2">
        <select
          name="accountId"
          defaultValue={account?.id ?? ''}
          className={controlClass}
        >
          <option value="">— choose account —</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.name}
            </option>
          ))}
        </select>
        <input type="date" name="from" defaultValue={params.from} className={controlClass} />
        <span className="text-xs text-ink-3">to</span>
        <input type="date" name="to" defaultValue={params.to} className={controlClass} />
        <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2">
          View
        </button>
      </form>

      {account && ledger && (
        <div className={tableWrapClass}>
          <table className="w-full text-left text-sm">
            <thead className={theadClass}>
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Narration</th>
                <th className="px-4 py-3 text-right">Debit</th>
                <th className="px-4 py-3 text-right">Credit</th>
                <th className="px-4 py-3 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-2">
              {params.from && (
                <tr className="bg-surface-2/60">
                  <td className="px-4 py-2 text-xs text-ink-3" colSpan={4}>
                    Opening balance
                  </td>
                  <td className="px-4 py-2 text-right font-medium text-ink-2">
                    {displayINR(ledger.opening)}
                  </td>
                </tr>
              )}
              {ledger.lines.map((l, i) => (
                <tr key={`${l.entryId}-${i}`} className={l.kind === 'REVERSAL' ? 'text-ink-3' : undefined}>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-2">
                    {l.date.toISOString().slice(0, 10)}
                  </td>
                  <td className="px-4 py-2 text-ink-2">
                    {l.narration}
                    {l.reference && <span className="ml-2 text-xs text-ink-3">ref {l.reference}</span>}
                  </td>
                  <td className="px-4 py-2 text-right">{Number(l.debit) > 0 ? displayINR(l.debit) : ''}</td>
                  <td className="px-4 py-2 text-right">{Number(l.credit) > 0 ? displayINR(l.credit) : ''}</td>
                  <td className="px-4 py-2 text-right font-medium text-ink">{displayINR(l.running)}</td>
                </tr>
              ))}
              {ledger.lines.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-ink-3">
                    No postings on this account in this range.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="border-t border-line">
              <tr className="font-medium text-ink">
                <td className="px-4 py-3" colSpan={4}>
                  Closing balance — {account.code} · {account.name}
                </td>
                <td className="px-4 py-3 text-right">{displayINR(ledger.closing)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
