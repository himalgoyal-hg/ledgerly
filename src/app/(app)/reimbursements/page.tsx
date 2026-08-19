import Link from 'next/link'
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { memberPayableName } from '@/lib/ops/reimburse'
import { suggestPaymentSource, rankForAmount } from '@/lib/automation/suggest'
import { HeadCostCentrePicker } from '@/components/head-cost-centre-picker'
import { SourceSelect } from '../source-select'
import { PageHeader, chipClass, controlClass } from '@/components/ui'
import {
  submitClaimAction,
  approveClaimAction,
  rejectClaimAction,
  settleMemberAction,
} from './actions'

// Reimbursements (spec §6.1): sub-tabs per member with the LIVE payable
// balance in the header — read from the ledger, so it always matches reports.

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

  // Tabs: admin sees every active user; a member sees only their own.
  const tabUsers = admin
    ? await prisma.user.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
      })
    : [user]

  // Live balances: each member's payable ledger account (Cr balance = owed).
  const payables = await prisma.ledgerAccount.findMany({
    where: {
      entityId: entity.id,
      name: { in: tabUsers.map((u) => memberPayableName(u.name)) },
    },
  })
  const balances = payables.length
    ? await prisma.$queryRaw<{ accountId: string; balance: string }[]>`
        SELECT l."accountId", (COALESCE(SUM(l.credit), 0) - COALESCE(SUM(l.debit), 0))::text as balance
        FROM "JournalLine" l WHERE l."accountId" IN (${Prisma.join(payables.map((p) => p.id))})
        GROUP BY l."accountId"
      `
    : []
  const owedTo = (name: string) => {
    const account = payables.find((p) => p.name === memberPayableName(name))
    const row = account && balances.find((b) => b.accountId === account.id)
    return new Prisma.Decimal(row?.balance ?? 0).toFixed(2)
  }

  // Claims still waiting for approval — the payable ledger only knows a
  // member once something IS approved, but the tab must show their money
  // from the moment they submit.
  const pendingSums = await prisma.reimbursement.groupBy({
    by: ['memberId'],
    where: { entityId: entity.id, status: 'PENDING' },
    _sum: { amount: true },
  })
  const pendingOf = (memberId: string) =>
    new Prisma.Decimal(
      String(pendingSums.find((p) => p.memberId === memberId)?._sum.amount ?? 0),
    ).toFixed(2)
  const tabAmount = (u: { id: string; name: string }) => {
    const owed = owedTo(u.name)
    const pending = pendingOf(u.id)
    const parts: string[] = []
    if (Number(owed) !== 0) parts.push(displayINR(owed))
    if (Number(pending) > 0) parts.push(`${displayINR(pending)} pending`)
    return parts.join(' · ') || displayINR('0.00')
  }

  const { member: memberParam } = await props.searchParams
  const selected = tabUsers.find((u) => u.id === memberParam) ?? (admin ? tabUsers[0] : user)

  const [claims, heads, costCentres, baseSuggestion] = await Promise.all([
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
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Operations"
        title={`Reimbursements — ${entity.name} (${entity.code})`}
        subtitle="Approving posts the expense immediately; the balance in each tab is that member's live payable ledger."
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

      {/* Admin settle */}
      {admin && baseSuggestion.options.length > 0 && (
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
          <h2 className="font-medium text-ink">
            Settle {selected.name} — owed {displayINR(owedTo(selected.name))}
          </h2>
          <form action={settleMemberAction} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="entityId" value={entity.id} />
            <input type="hidden" name="memberId" value={selected.id} />
            <input name="date" type="date" required className={controlClass} />
            <input name="amount" required inputMode="decimal" defaultValue={owedTo(selected.name)} className={`${controlClass} w-28`} />
            <SourceSelect
              suggestion={rankForAmount(baseSuggestion.options, owedTo(selected.name))}
            />
            <button type="submit" className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white hover:bg-primary-strong">
              Settle (Dr payable / Cr source)
            </button>
          </form>
        </div>
      )}

      {/* Claims */}
      <div className="space-y-2">
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
    </div>
  )
}
