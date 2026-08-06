import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission, visibleEntityFilter } from '@/lib/auth'

// Overview dashboard (spec §9). Members see only tiles their permissions
// allow. Phase 1 shows the core/admin tiles; ledger-derived tiles (balances,
// queues, dues) arrive with Phases 2–3 and slot in here.

export default async function OverviewPage() {
  const user = await requireUser()

  const [entityCount, bankAccountCount, cashLocationCount, memberCount] =
    await Promise.all([
      prisma.entity.count({ where: { archivedAt: null, ...visibleEntityFilter(user) } }),
      prisma.bankAccount.count({
        where: { archivedAt: null, entity: { archivedAt: null, ...visibleEntityFilter(user) } },
      }),
      prisma.cashLocation.count({
        where: { archivedAt: null, entity: { archivedAt: null, ...visibleEntityFilter(user) } },
      }),
      isAdmin(user)
        ? prisma.user.count({ where: { role: 'MEMBER', deletedAt: null } })
        : Promise.resolve(0),
    ])

  const tiles: { label: string; value: string; sub?: string; show: boolean }[] = [
    { label: 'Entities', value: String(entityCount), sub: 'active', show: true },
    { label: 'Bank accounts', value: String(bankAccountCount), sub: 'active', show: true },
    { label: 'Cash locations', value: String(cashLocationCount), sub: 'active', show: true },
    { label: 'Members', value: String(memberCount), sub: 'logins', show: isAdmin(user) },
    {
      label: 'Pending tagging queue',
      value: '—',
      sub: 'arrives with Phase 3 (statement pipeline)',
      show: hasPermission(user, 'transactionTagging'),
    },
    {
      label: 'Cash & bank balances',
      value: '—',
      sub: 'arrives with Phase 2 (accounting engine)',
      show: isAdmin(user) || hasPermission(user, 'viewFinancialReports'),
    },
    {
      label: 'Pending reimbursements',
      value: '—',
      sub: 'arrives with Phase 4 (operations)',
      show: isAdmin(user) || hasPermission(user, 'reimbursementSubmit'),
    },
  ]

  const visible = tiles.filter((t) => t.show)

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-900">Overview</h1>
      {visible.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500">
          You don&apos;t have access to anything yet. Ask the admin to grant you
          permissions.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((t) => (
            <div
              key={t.label}
              className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm"
            >
              <p className="text-sm text-zinc-500">{t.label}</p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900">{t.value}</p>
              {t.sub && <p className="mt-1 text-xs text-zinc-400">{t.sub}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
