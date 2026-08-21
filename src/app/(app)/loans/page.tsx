import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { accountBalances, accountLedger } from '@/lib/ledger/queries'
import { PageHeader, controlClass, tableWrapClass, theadClass } from '@/components/ui'
import { createLoanPartyAction, recordLoanMovementAction } from './actions'

// Loans & advances — parties, movements and running-balance ledgers, per
// the v2 prototype. Parties are ledger accounts under 1400 / 2300.

export default async function LoansPage({
  searchParams,
}: {
  searchParams: Promise<{ party?: string }>
}) {
  const user = await requireUser()
  const admin = isAdmin(user)
  if (!admin && !hasPermission(user, 'viewFinancialReports')) {
    return <p className="text-sm text-ink-2">You don&apos;t have access to this screen.</p>
  }
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>

  const groups = await prisma.ledgerAccount.findMany({
    where: { entityId: entity.id, code: { in: ['1400', '2300'] }, isGroup: true },
  })
  const givenGroup = groups.find((g) => g.code === '1400')
  const takenGroup = groups.find((g) => g.code === '2300')
  const allParties = await prisma.ledgerAccount.findMany({
    where: {
      entityId: entity.id,
      parentId: { in: groups.map((g) => g.id) },
      archivedAt: null,
    },
    orderBy: { name: 'asc' },
  })
  // Only the heads whose Nature on the master register is Liability or
  // Personal belong here (Himal, 21 Aug: "sirf nature mai ka Liability and
  // Personal dikhana chahiye"). A head filed under the loans groups but
  // marked Expense or Asset — or with no master row at all — stays out;
  // the footnote names it so nothing looks lost.
  const natureRows = await prisma.headMode.findMany({
    where: { category: { in: allParties.map((p) => p.name), mode: 'insensitive' } },
    select: { category: true, nature: true },
  })
  const natureOf = new Map(natureRows.map((m) => [m.category.toLowerCase(), m.nature]))
  const SHOWN_NATURES = ['liability', 'personal']
  const parties = allParties.filter((p) =>
    SHOWN_NATURES.includes((natureOf.get(p.name.toLowerCase()) ?? '').toLowerCase()),
  )
  const hidden = allParties
    .filter((p) => !parties.includes(p))
    .map((p) => ({ name: p.name, nature: natureOf.get(p.name.toLowerCase()) ?? null }))
  const balances = await accountBalances(parties.map((p) => p.id))
  const rows = parties.map((p) => {
    const bal = Number(balances.get(p.id) ?? '0') // Dr-positive
    const given = p.parentId === givenGroup?.id
    return { id: p.id, name: p.name, given, balance: given ? bal : -bal }
  })
  const recoverable = rows.filter((r) => r.given).reduce((s, r) => s + r.balance, 0)
  const payable = rows.filter((r) => !r.given).reduce((s, r) => s + r.balance, 0)

  // Pay-from options: bank accounts + cash locations with ledger accounts.
  const [banks, cashLocs] = await Promise.all([
    prisma.bankAccount.findMany({
      where: { entityId: entity.id, archivedAt: null, ledgerAccountId: { not: null } },
    }),
    prisma.cashLocation.findMany({
      where: { entityId: entity.id, archivedAt: null, ledgerAccountId: { not: null } },
    }),
  ])
  const sources = [
    ...banks.map((b) => ({ id: b.ledgerAccountId!, label: b.nickname })),
    ...cashLocs.map((c) => ({ id: c.ledgerAccountId!, label: `Cash — ${c.name}` })),
  ]

  const { party: partyId } = await searchParams
  const selected = rows.find((r) => r.id === partyId) ?? null
  const ledger = selected ? await accountLedger(selected.id, {}) : null

  const today = new Date().toISOString().slice(0, 10)
  const tile = (label: string, value: string, hint: string) => (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
      <p className="text-sm text-ink-2">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
      <p className="mt-1 text-xs text-ink-3">{hint}</p>
    </div>
  )

  return (
    <div className="space-y-6">
      <PageHeader kicker="Register" title={`Loans & advances — ${entity.name} (${entity.code})`} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {tile('Recoverable', displayINR(recoverable.toFixed(2)), 'advances & loans given out')}
        {tile('Payable', displayINR(payable.toFixed(2)), 'loans taken')}
        {tile(
          'Net position',
          displayINR(Math.abs(recoverable - payable).toFixed(2)),
          recoverable - payable >= 0 ? 'owed to you' : 'owed by you',
        )}
      </div>

      {/* Party balances */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
        <h2 className="font-medium text-ink">Parties</h2>
        <div className="mt-3 divide-y divide-line-2">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 py-2 text-sm">
              <Link href={`/loans?party=${r.id}`} className="font-medium text-ink hover:underline">
                {r.name}
              </Link>
              <span className="text-xs text-ink-3">{r.given ? 'owes me' : 'I owe'}</span>
              <span
                className={`ml-auto font-semibold tabular-nums ${r.balance < 0 ? 'text-danger' : 'text-ink'}`}
              >
                {displayINR(Math.abs(r.balance).toFixed(2))}
              </span>
            </div>
          ))}
          {rows.length === 0 && <p className="py-2 text-sm text-ink-3">No parties yet — add one below.</p>}
        </div>
        {hidden.length > 0 && (
          <p className="mt-3 border-t border-line-2 pt-2 text-[11px] text-ink-3">
            Only heads whose Nature on the master register is Liability or Personal are listed. Not shown:{' '}
            {hidden.map((h, i) => (
              <span key={h.name}>
                {i > 0 && ', '}
                {h.name}
                <span className="text-ink-3/70"> ({h.nature ?? 'no master row'})</span>
              </span>
            ))}
            . Change the Nature on{' '}
            <Link href="/admin/coa" className="underline hover:text-ink">
              Accounts — master register
            </Link>{' '}
            to bring one in.
          </p>
        )}
      </div>

      {admin && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
            <h2 className="font-medium text-ink">Add a person or party</h2>
            <form action={createLoanPartyAction} className="mt-3 flex flex-wrap items-end gap-2">
              <input type="hidden" name="entityId" value={entity.id} />
              <input name="name" required placeholder="e.g. Harshal Pahade" className={`${controlClass} w-52`} />
              <select name="kind" className={controlClass}>
                <option value="given">They owe me (advance given)</option>
                <option value="taken">I owe them (loan taken)</option>
              </select>
              <input name="opening" type="number" step="0.01" min="0" placeholder="Opening balance" className={`${controlClass} w-36`} />
              <input name="date" type="date" defaultValue={today} className={controlClass} />
              <button type="submit" className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-strong">
                Add party
              </button>
            </form>
          </div>

          <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
            <h2 className="font-medium text-ink">Record a movement</h2>
            <form action={recordLoanMovementAction} className="mt-3 flex flex-wrap items-end gap-2">
              <select name="accountId" required className={`${controlClass} w-44`}>
                <option value="">— party —</option>
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
              <select name="direction" className={controlClass}>
                <option value="out">Money out (given / repaid by me)</option>
                <option value="in">Money in (repayment / loan received)</option>
              </select>
              <input name="date" type="date" defaultValue={today} className={controlClass} />
              <input name="amount" type="number" step="0.01" min="0.01" required placeholder="Amount" className={`${controlClass} w-32`} />
              <select name="sourceAccountId" required className={controlClass}>
                <option value="">— pay from —</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
              <select name="payMode" className={controlClass}>
                {['Bank transfer', 'UPI', 'Cheque', 'Cash', 'Card'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <input name="narration" placeholder="Narration (optional)" className={`${controlClass} w-56`} />
              <button type="submit" className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-strong">
                Post movement
              </button>
            </form>
            <p className="mt-2 text-xs text-ink-3">
              Posts a balanced journal against the account you pick — cash movements hit the cash location&apos;s ledger.
            </p>
          </div>
        </div>
      )}

      {/* Party ledger with running balance */}
      {selected && ledger && (
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
          <div className="flex items-baseline gap-3">
            <h2 className="font-medium text-ink">Ledger — {selected.name}</h2>
            <span className="text-xs text-ink-3">
              opening {displayINR(ledger.opening)} · closing {displayINR(ledger.closing)}
            </span>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className={theadClass}>
                <tr>
                  <th className="px-2 py-2">Date</th>
                  <th className="px-2 py-2">Narration</th>
                  <th className="px-2 py-2 text-right">Debit</th>
                  <th className="px-2 py-2 text-right">Credit</th>
                  <th className="px-2 py-2 text-right">Running balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2">
                {ledger.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap px-2 py-2 text-ink-2">
                      {l.date.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-2 py-2 text-ink-2">{l.narration}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {Number(l.debit) ? displayINR(l.debit) : '—'}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {Number(l.credit) ? displayINR(l.credit) : '—'}
                    </td>
                    <td className="px-2 py-2 text-right font-medium tabular-nums">{displayINR(l.running)}</td>
                  </tr>
                ))}
                {ledger.lines.length === 0 && (
                  <tr><td colSpan={5} className="px-2 py-4 text-center text-ink-3">No movements yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
