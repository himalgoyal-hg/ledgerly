import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission, visibleEntityFilter } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { logoutAction } from '@/app/login/actions'
import { setBooksOf } from './actions'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
  const session = await getSession()

  // Active entities visible to this user (admin: all; scoped member: granted only).
  const entities = await prisma.entity.findMany({
    where: { archivedAt: null, ...visibleEntityFilter(user) },
    orderBy: { code: 'asc' },
  })
  const currentEntity =
    entities.find((e) => e.id === session.booksEntityId) ?? entities[0] ?? null

  // Nav is permission-filtered — but this is cosmetic; every page and every
  // server action re-checks permissions server-side (never trust the UI).
  const nav: { href: string; label: string; show: boolean }[] = [
    { href: '/', label: 'Overview', show: true },
    { href: '/statements', label: 'Statements', show: hasPermission(user, 'statementUpload') },
    { href: '/tagging', label: 'Tagging queue', show: hasPermission(user, 'transactionTagging') },
    { href: '/reports', label: 'Reports', show: hasPermission(user, 'viewFinancialReports') },
    { href: '/tax', label: 'GST / TDS', show: hasPermission(user, 'viewTaxRegisters') },
    { href: '/cash', label: 'Cash', show: hasPermission(user, 'cashEntries') || hasPermission(user, 'viewCashReports') },
    { href: '/reimbursements', label: 'Reimbursements', show: hasPermission(user, 'reimbursementSubmit') || isAdmin(user) },
  ]
  const adminNav: { href: string; label: string }[] = [
    { href: '/journal', label: 'Journal' },
    { href: '/admin/trial-balance', label: 'Trial balance' },
    { href: '/admin/ledgers', label: 'Ledgers' },
    { href: '/admin/coa', label: 'Accounts' },
    { href: '/admin/periods', label: 'Periods' },
    { href: '/admin/users', label: 'Users & permissions' },
    { href: '/admin/entities', label: 'Entities' },
    { href: '/admin/banking', label: 'Banking & cash' },
    { href: '/admin/audit', label: 'Audit log' },
  ]

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link href="/" className="text-lg font-semibold tracking-tight text-zinc-900">
            Ledgerly
          </Link>

          {/* Books of switcher */}
          {entities.length > 0 && (
            <form action={setBooksOf} className="flex items-center gap-2">
              <label htmlFor="booksOf" className="text-xs text-zinc-500">
                Books of
              </label>
              <select
                id="booksOf"
                name="entityId"
                defaultValue={currentEntity?.id}
                className="rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-900"
              >
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.code})
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
              >
                Switch
              </button>
            </form>
          )}

          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-zinc-600">
              {user.name}
              {isAdmin(user) && (
                <span className="ml-1 rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] font-medium uppercase text-white">
                  Admin
                </span>
              )}
            </span>
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-md border border-zinc-300 px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-100"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-4 pb-2">
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
              >
                {n.label}
              </Link>
            ))}
          {isAdmin(user) && (
            <>
              <span className="mx-2 h-4 w-px bg-zinc-200" aria-hidden />
              {adminNav.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="rounded-md px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                >
                  {n.label}
                </Link>
              ))}
            </>
          )}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}
