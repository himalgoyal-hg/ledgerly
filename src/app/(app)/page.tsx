import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission, visibleEntityFilter } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { accountBalances } from '@/lib/ledger/queries'
import { displayINR } from '@/lib/ledger/money'

// Overview dashboard (spec §9). Members see only tiles their permissions
// allow. Balances are live queries over the ledger — nothing stored.

export default async function OverviewPage() {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)

  const [entityCount, memberCount] = await Promise.all([
    prisma.entity.count({ where: { archivedAt: null, ...visibleEntityFilter(user) } }),
    isAdmin(user)
      ? prisma.user.count({ where: { role: 'MEMBER', deletedAt: null } })
      : Promise.resolve(0),
  ])

  // Live bank & cash balances for the current "Books of" entity.
  const canSeeBalances = isAdmin(user) || hasPermission(user, 'viewFinancialReports')
  const canSeeCash = isAdmin(user) || hasPermission(user, 'viewCashReports')
  let bankRows: { label: string; balance: string }[] = []
  let cashRows: { label: string; balance: string }[] = []
  if (entity && (canSeeBalances || canSeeCash)) {
    const [bankAccounts, cashLocations] = await Promise.all([
      prisma.bankAccount.findMany({
        where: { entityId: entity.id, archivedAt: null, ledgerAccountId: { not: null } },
        orderBy: { nickname: 'asc' },
      }),
      prisma.cashLocation.findMany({
        where: { entityId: entity.id, archivedAt: null, ledgerAccountId: { not: null } },
        orderBy: { name: 'asc' },
      }),
    ])
    const balances = await accountBalances([
      ...bankAccounts.map((a) => a.ledgerAccountId!),
      ...cashLocations.map((l) => l.ledgerAccountId!),
    ])
    if (canSeeBalances) {
      bankRows = bankAccounts.map((a) => ({
        label: a.nickname,
        balance: balances.get(a.ledgerAccountId!) ?? '0.00',
      }))
    }
    if (canSeeCash) {
      cashRows = cashLocations.map((l) => ({
        label: l.name,
        balance: balances.get(l.ledgerAccountId!) ?? '0.00',
      }))
    }
  }
  const bankTotal = bankRows.reduce((s, r) => s + Number(r.balance), 0)
  const cashTotal = cashRows.reduce((s, r) => s + Number(r.balance), 0)

  const anythingVisible =
    canSeeBalances || canSeeCash || isAdmin(user) ||
    hasPermission(user, 'transactionTagging') || hasPermission(user, 'reimbursementSubmit')

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-900">
        Overview{entity ? ` — ${entity.name} (${entity.code})` : ''}
      </h1>
      {!anythingVisible ? (
        <p className="mt-4 text-sm text-zinc-500">
          You don&apos;t have access to anything yet. Ask the admin to grant you
          permissions.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {canSeeBalances && (
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm sm:col-span-2 lg:col-span-1">
              <p className="text-sm text-zinc-500">Bank balances</p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900">{displayINR(bankTotal)}</p>
              <div className="mt-2 space-y-1">
                {bankRows.map((r) => (
                  <div key={r.label} className="flex justify-between text-xs text-zinc-500">
                    <span>{r.label}</span>
                    <span>{displayINR(r.balance)}</span>
                  </div>
                ))}
                {bankRows.length === 0 && (
                  <p className="text-xs text-zinc-400">No bank accounts yet.</p>
                )}
              </div>
            </div>
          )}
          {canSeeCash && (
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-zinc-500">Where is cash</p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900">{displayINR(cashTotal)}</p>
              <div className="mt-2 space-y-1">
                {cashRows.map((r) => (
                  <div key={r.label} className="flex justify-between text-xs text-zinc-500">
                    <span>{r.label}</span>
                    <span>{displayINR(r.balance)}</span>
                  </div>
                ))}
                {cashRows.length === 0 && (
                  <p className="text-xs text-zinc-400">No cash locations yet.</p>
                )}
              </div>
            </div>
          )}
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <p className="text-sm text-zinc-500">Entities</p>
            <p className="mt-1 text-2xl font-semibold text-zinc-900">{entityCount}</p>
            <p className="mt-1 text-xs text-zinc-400">active</p>
          </div>
          {isAdmin(user) && (
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-zinc-500">Members</p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900">{memberCount}</p>
              <p className="mt-1 text-xs text-zinc-400">logins</p>
            </div>
          )}
          {hasPermission(user, 'transactionTagging') && (
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-zinc-500">Pending tagging queue</p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900">—</p>
              <p className="mt-1 text-xs text-zinc-400">arrives with Phase 3 (statement pipeline)</p>
            </div>
          )}
          {(isAdmin(user) || hasPermission(user, 'reimbursementSubmit')) && (
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-zinc-500">Pending reimbursements</p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900">—</p>
              <p className="mt-1 text-xs text-zinc-400">arrives with Phase 4 (operations)</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
