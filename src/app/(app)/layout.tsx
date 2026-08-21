import { prisma } from '@/lib/db'
import { requireUser, isAdmin, visibleEntityFilter } from '@/lib/auth'
import { getSession } from '@/lib/session'
import { logoutAction } from '@/app/login/actions'
import { duesTiles } from '@/lib/reports/dashboard'
import { displayINR } from '@/lib/ledger/money'
import { buildNav } from '@/components/shell/nav'
import { Shell, type ShellNotification } from '@/components/shell/shell'
import { DirtyFormWatcher } from '@/components/dirty-forms'
import { setBooksOf } from './actions'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
  const admin = isAdmin(user)

  // Active entities visible to this user (admin: all; scoped member: granted only).
  const entities = await prisma.entity.findMany({
    where: { archivedAt: null, ...visibleEntityFilter(user) },
    orderBy: { code: 'asc' },
  })
  const session = await getSession()
  const currentEntity = entities.find((e) => e.id === session.booksEntityId) ?? entities[0] ?? null

  // Header bell: dues inside 7 days. Admin-only, like the dues tile itself.
  let notifications: ShellNotification[] = []
  if (admin && currentEntity) {
    const dues = await duesTiles(currentEntity.id, 7)
    const today = new Date().toISOString().slice(0, 10)
    notifications = dues.items.slice(0, 6).map((item) => ({
      title: item.title,
      hint: `due ${item.dueDate.toISOString().slice(0, 10)}${item.amount ? ` · ${displayINR(item.amount)}` : ''}`,
      href: '/bills',
      overdue: item.dueDate.toISOString().slice(0, 10) < today,
    }))
  }

  // buildNav filters server-side; hidden destinations never reach the client.
  return (
    <Shell
      nav={buildNav(user)}
      user={{ name: user.name, admin }}
      entities={entities.map((e) => ({ id: e.id, name: e.name, code: e.code }))}
      currentEntityId={currentEntity?.id ?? null}
      notifications={notifications}
      switchAction={setBooksOf}
      logoutAction={logoutAction}
    >
      {children}
      {/* every form's Save turns green while it holds unsaved changes */}
      <DirtyFormWatcher />
    </Shell>
  )
}
