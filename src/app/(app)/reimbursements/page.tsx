import Link from 'next/link'
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { accountBalances, accountLedger } from '@/lib/ledger/queries'
import { memberAdvanceName, ensureMemberAccounts } from '@/lib/ops/reimburse'
import { suggestPaymentSource, rankForAmount } from '@/lib/automation/suggest'
import { HeadCostCentrePicker } from '@/components/head-cost-centre-picker'
import { SourceSelect } from '../source-select'
import { PageHeader, chipClass, controlClass, tableWrapClass, theadClass } from '@/components/ui'
import {
  submitClaimAction,
  approveClaimAction,
  rejectClaimAction,
  memberMoneyAction,
} from './actions'

// Reimbursements & advances (spec §6.1, extended): one tab per member, the
// LIVE balance of their "Advance — <name>" ledger in the header, the money
// movements underneath. Positive = the member holds the books' money;
// negative = the books owe the member. Read from the ledger, so it always
// matches reports.

const SOURCE_LABEL: Record<string, string> = {
  member_advance: 'Advance / settlement',
  reimbursement_settlement: 'Settlement',
  reimbursement: 'Claim approved',
  statement_txn: 'Bank statement',
  cash_entry: 'Cash entry',
  manual: 'Manual journal',
  opening_balance: 'Opening balance',
}

export default async function ReimbursementsPage(props: {
  searchParams: Promise<{ member?: string }>
}) {
  const user = await requireUser()
  const admin = isAdmin(user)
  if (!admin && !hasPermission(user, 'reimbursementSubmit')) {
    throw new Error('Forbidden: missing permission "reimbursementSubmit"')
  }
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>
  await ensureMemberAccounts(entity.id)

  // Tabs: admin sees every active user; a member sees only their own.
  const tabUsers = admin
    ? await prisma.user.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
      })
    : [user]

  // Live balances: each member's advance ledger (Dr − Cr).
  const accounts = await prisma.ledgerAccount.findMany({
    where: {
      entityId: entity.id,
      name: { in: tabUsers.map((u) => memberAdvanceName(u.name)) },
    },
  })
  const balances = await accountBalances(accounts.map((a) => a.id))
  const accountOf = (name: string) => accounts.find((a) => a.name === memberAdvanceName(name))
  const balanceOf = (name: string) => {
    const account = accountOf(name)
    return new Prisma.Decimal(account ? (balances.get(account.id) ?? 0) : 0).toFixed(2)
  }

  // Claims still waiting for approval — they have not touched the ledger
  // yet, but the tab must show them from the moment they are submitted.
  const pendingSums = await prisma.reimbursement.groupBy({
    by: ['memberId'],
    where: { entityId: entity.id, status: 'PENDING' },
    _sum: { amount: true },
  })
  const pendingOf = (memberId: string) =>
    new Prisma.Decimal(
      String(pendingSums.find((p) => p.memberId === memberId)?._sum.amount ?? 0),
    ).toFixed(2)

  const describe = (balance: string) => {
    const n = Number(balance)
    if (n > 0) return { label: 'advance with member', short: 'advance', amount: balance, tone: 'text-primary' }
    if (n < 0) return { label: 'owed to member', short: 'owed', amount: new Prisma.Decimal(balance).neg().toFixed(2), tone: 'text-warning' }
    return { label: 'settled', short: '', amount: '0.00', tone: 'text-ink-3' }
  }
  const tabAmount = (u: { id: string; name: string }) => {
    const bal = describe(balanceOf(u.name))
    const pending = pendingOf(u.id)
    const parts: string[] = []
    if (bal.short) parts.push(`${displayINR(bal.amount)} ${bal.short}`)
    if (Number(pending) > 0) parts.push(`${displayINR(pending)} pending`)
    return parts.join(' · ') || displayINR('0.00')
  }

  const { member: memberParam } = await props.searchParams
  const selected = tabUsers.find((u) => u.id === memberParam) ?? (admin ? tabUsers[0] : user)
  const selectedBalance = describe(balanceOf(selected.name))
  const selectedAccount = accountOf(selected.name)

  const [claims, heads, costCentres, baseSuggestion, ledger] = await Promise.all([
    prisma.reimbursement.findMany({
      where: { entityId: entity.id, memberId: selected.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null, kind: 'EXPENSE' },
      orderBy: { code: 'asc' },
    }),
    prisma.costCentre.findMany({
      where: { entityId: entity.id, archivedAt: null },
      orderBy: { name: 'asc' },
    }),
    suggestPaymentSource({ entityId: entity.id, module: 'reimbursement' }),
    selectedAccount ? accountLedger(selectedAccount.id) : Promise.resolve(null),
  ])
  const ledgerDocs = ledger
    ? await prisma.journalDoc.findMany({
        where: { id: { in: [...new Set(ledger.lines.map((l) => l.docId))] } },
        select: { id: true, sourceType: true, deletedAt: true },
      })
    : []
  const docById = new Map(ledgerDocs.map((d) => [d.id, d]))
  // Newest first, so the latest movement sits under the balance.
  const ledgerRows = ledger ? [...ledger.lines].reverse() : []

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Operations"
        title={`Reimbursements & advances — ${entity.name} (${entity.code})`}
        subtitle="Advances paid go to the member's ledger; approved claims come off it. The balance in each tab is that ledger, live."
      />

      {/* Member sub-tabs with live running balance (spec §6.1) */}
      <div className="flex flex-wrap gap-1 border-b border-line pb-2">
        {tabUsers.map((u) => (
          <Link
            key={u.id}
            href={`/reimbursements?member=${u.id}`}
            className={chipClass(u.id === selected.id)}
          >
            {u.name}
            <span className={`ml-2 text-xs ${u.id === selected.id ? 'text-white/70' : 'text-ink-3'}`}>
              {tabAmount(u)}
            </span>
          </Link>
        ))}
      </div>

      {/* Position of the selected member */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{selected.name}</div>
        <div className={`mt-1 text-2xl font-semibold ${selectedBalance.tone}`}>
          {displayINR(selectedBalance.amount)}
          <span className="ml-2 text-sm font-normal text-ink-2">{selectedBalance.label}</span>
        </div>
        <p className="mt-1 text-xs text-ink-3">
          {Number(selectedBalance.amount) === 0
            ? 'Nothing outstanding either way.'
            : selectedBalance.short === 'advance'
              ? `${selected.name} still holds this much of the books' money — claims will use it up.`
              : `The books owe ${selected.name} this much — pay it below to settle.`}
          {Number(pendingOf(selected.id)) > 0 && ` ${displayINR(pendingOf(selected.id))} in claims awaiting approval.`}
        </p>
      </div>

      {/* Submit own claim */}
      {selected.id === user.id && (
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
          <h2 className="font-medium text-ink">Submit a claim</h2>
          <form action={submitClaimAction} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="entityId" value={entity.id} />
            <input name="date" type="date" required className={controlClass} />
            <input name="category" required placeholder="Category (Travel, Food…)" className={controlClass} />
            <input name="amount" required inputMode="decimal" placeholder="Amount ₹" className={`${controlClass} w-28`} />
            <label className="flex cursor-pointer items-center gap-1 rounded-lg border border-dashed border-line px-2 py-1.5 text-xs text-ink-2 hover:border-ink-3">
              📎 receipt
              <input type="file" name="file" accept="application/pdf,image/*" className="w-40 text-xs" />
            </label>
            <input name="link" placeholder="…or Drive link" className={`${controlClass} w-44`} />
            <input name="remarks" placeholder="Remarks" className={`${controlClass} flex-1 min-w-40`} />
            <button type="submit" className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white hover:bg-primary-strong">
              Submit
            </button>
          </form>
        </div>
      )}

      {/* Admin: advance out, settlement out, or advance back in */}
      {admin && baseSuggestion.options.length > 0 && (
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
          <h2 className="font-medium text-ink">Advance / settle — {selected.name}</h2>
          <p className="mt-1 text-xs text-ink-3">
            Money handed to {selected.name} (an advance, or settling what is owed) or received back from them.
            Bank transfers can instead be tagged to the head &ldquo;{memberAdvanceName(selected.name)}&rdquo; on the Tagging page.
          </p>
          <form action={memberMoneyAction} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="entityId" value={entity.id} />
            <input type="hidden" name="memberId" value={selected.id} />
            <select name="direction" className={controlClass} defaultValue="paid">
              <option value="paid">Paid to {selected.name}</option>
              <option value="received">Received back from {selected.name}</option>
            </select>
            <input name="date" type="date" required className={controlClass} />
            <input
              name="amount"
              required
              inputMode="decimal"
              placeholder="Amount ₹"
              defaultValue={selectedBalance.short === 'owed' ? selectedBalance.amount : ''}
              className={`${controlClass} w-28`}
            />
            <SourceSelect
              suggestion={rankForAmount(
                baseSuggestion.options,
                selectedBalance.short === 'owed' ? selectedBalance.amount : '0.00',
              )}
            />
            <input name="note" placeholder="Note (optional)" className={`${controlClass} w-44`} />
            <button type="submit" className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white hover:bg-primary-strong">
              Record
            </button>
          </form>
        </div>
      )}

      {/* Claims */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-ink">Claims</h2>
        {claims.map((claim) => (
          <div key={claim.id} className="rounded-2xl border border-line bg-surface p-4 shadow-card">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-xs text-ink-3">{claim.date.toISOString().slice(0, 10)}</span>
              <span className="font-medium text-ink">{claim.category}</span>
              {claim.link && (
                <a href={claim.link} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                  bill
                </a>
              )}
              {claim.remarks && <span className="text-xs text-ink-3">{claim.remarks}</span>}
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  claim.status === 'PENDING'
                    ? 'bg-warning-soft text-warning'
                    : claim.status === 'APPROVED'
                      ? 'bg-success-soft text-success'
                      : 'bg-danger-soft text-danger'
                }`}
              >
                {claim.status.toLowerCase()}
              </span>
              {claim.status === 'REJECTED' && claim.rejectReason && (
                <span className="text-xs text-danger">{claim.rejectReason}</span>
              )}
              <span className="ml-auto font-semibold text-ink">
                {displayINR(String(claim.amount))}
              </span>
            </div>
            {admin && claim.status === 'PENDING' && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <form action={approveClaimAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="claimId" value={claim.id} />
                  <HeadCostCentrePicker
                    heads={heads.map((h) => ({
                      id: h.id,
                      code: h.code,
                      name: h.name,
                      kind: h.kind,
                      defaultCostCentreId: h.defaultCostCentreId,
                    }))}
                    costCentres={costCentres}
                    headName="expenseAccountId"
                    required
                    className={`${controlClass} w-56`}
                  />
                  <button type="submit" className="rounded-lg bg-success px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
                    Approve & post
                  </button>
                </form>
                <form action={rejectClaimAction} className="flex items-center gap-2">
                  <input type="hidden" name="claimId" value={claim.id} />
                  <input name="reason" required placeholder="Rejection remarks" className={controlClass} />
                  <button type="submit" className="rounded-lg border border-danger/30 px-3 py-1.5 text-xs text-danger hover:bg-danger-soft">
                    Reject
                  </button>
                </form>
              </div>
            )}
          </div>
        ))}
        {claims.length === 0 && (
          <p className="text-sm text-ink-3">No claims yet for {selected.name} in these books.</p>
        )}
      </div>

      {/* The member's advance ledger — every movement, newest first */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-ink">Advance ledger — {selected.name}</h2>
        {ledgerRows.length === 0 ? (
          <p className="text-sm text-ink-3">No advances or settlements recorded yet.</p>
        ) : (
          <div className={tableWrapClass}>
            <table className="w-full text-left text-sm">
              <thead className={theadClass}>
                <tr>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Narration</th>
                  <th className="px-4 py-2">Source</th>
                  <th className="px-4 py-2 text-right">Paid to member</th>
                  <th className="px-4 py-2 text-right">Spent / returned</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2">
                {ledgerRows.map((line, index) => {
                  const doc = docById.get(line.docId)
                  const running = Number(line.running)
                  return (
                    <tr key={`${line.entryId}-${index}`} className={line.kind === 'REVERSAL' ? 'text-ink-3' : ''}>
                      <td className="px-4 py-2 text-xs text-ink-3">{line.date.toISOString().slice(0, 10)}</td>
                      <td className="px-4 py-2 text-ink">
                        {line.narration}
                        {doc?.deletedAt && (
                          <span className="ml-2 rounded bg-danger-soft px-1.5 py-0.5 text-[10px] font-medium text-danger">deleted</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-ink-2">
                        {doc ? (SOURCE_LABEL[doc.sourceType] ?? doc.sourceType) : '—'}
                        {line.kind === 'REVERSAL' && (
                          <span className="ml-1 rounded bg-surface-2 px-1 py-0.5 text-[10px]">reversal</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-ink-2">{Number(line.debit) > 0 ? displayINR(line.debit) : ''}</td>
                      <td className="px-4 py-2 text-right text-ink-2">{Number(line.credit) > 0 ? displayINR(line.credit) : ''}</td>
                      <td className={`px-4 py-2 text-right font-medium ${running > 0 ? 'text-primary' : running < 0 ? 'text-warning' : 'text-ink-3'}`}>
                        {displayINR(running < 0 ? new Prisma.Decimal(line.running).neg().toFixed(2) : line.running)}
                        {running < 0 && <span className="ml-1 text-[10px] font-normal text-ink-3">owed</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {selectedAccount && admin && (
          <p className="text-xs text-ink-3">
            Full statement:{' '}
            <Link href={`/reports/ledger?accountId=${selectedAccount.id}`} className="text-primary hover:underline">
              {selectedAccount.code} · {selectedAccount.name}
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}
