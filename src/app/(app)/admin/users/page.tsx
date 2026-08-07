import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { PERMISSION_FLAGS, PERMISSION_LABELS, ROLE_PRESETS } from '@/lib/permissions'
import {
  createMember,
  setPermission,
  setUserActive,
  resetMemberPassword,
  setEntityScoped,
  setEntityScope,
  applyRolePreset,
} from './actions'

export default async function UsersPage() {
  await requireAdmin()

  const [users, entities] = await Promise.all([
    prisma.user.findMany({
      where: { deletedAt: null },
      include: { permissions: true, entityScopes: { select: { entityId: true } } },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    }),
    prisma.entity.findMany({ where: { archivedAt: null }, orderBy: { code: 'asc' } }),
  ])
  const members = users.filter((u) => u.role === 'MEMBER')
  const admin = users.find((u) => u.role === 'ADMIN')

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Users & permissions</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Main Admin: <span className="font-medium text-zinc-800">{admin?.name}</span>{' '}
          (cannot be deleted or demoted). Members start with zero permissions.
          Changes take effect immediately and are audit-logged.
        </p>
      </div>

      {/* Permission matrix */}
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-3">Permission</th>
              {members.map((m) => (
                <th key={m.id} className="px-4 py-3 text-center">
                  {m.name}
                  {!m.isActive && (
                    <span className="ml-1 rounded bg-red-100 px-1 text-[10px] text-red-700">
                      inactive
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            <tr className="bg-zinc-50/60">
              <td className="px-4 py-2 text-xs font-medium uppercase text-zinc-400">Role preset</td>
              {members.map((m) => (
                <td key={m.id} className="px-4 py-2 text-center">
                  <form action={applyRolePreset} className="inline-flex items-center gap-1">
                    <input type="hidden" name="userId" value={m.id} />
                    <select name="preset" className="rounded-md border border-zinc-300 bg-white px-1.5 py-1 text-xs" defaultValue="">
                      <option value="" disabled>Apply…</option>
                      {Object.entries(ROLE_PRESETS).map(([key, p]) => (
                        <option key={key} value={key}>{p.label}</option>
                      ))}
                    </select>
                    <button type="submit" className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100">
                      Set
                    </button>
                  </form>
                </td>
              ))}
            </tr>
            {PERMISSION_FLAGS.map((flag) => (
              <tr key={flag}>
                <td className="px-4 py-2 text-zinc-700">{PERMISSION_LABELS[flag]}</td>
                {members.map((m) => {
                  const granted = m.permissions?.[flag] === true
                  return (
                    <td key={m.id} className="px-4 py-2 text-center">
                      <form action={setPermission} className="inline">
                        <input type="hidden" name="userId" value={m.id} />
                        <input type="hidden" name="flag" value={flag} />
                        <input type="hidden" name="value" value={granted ? 'false' : 'true'} />
                        <button
                          type="submit"
                          aria-label={`${granted ? 'Revoke' : 'Grant'} ${PERMISSION_LABELS[flag]} for ${m.name}`}
                          className={
                            granted
                              ? 'rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-200'
                              : 'rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-400 hover:bg-zinc-200'
                          }
                        >
                          {granted ? 'Yes' : 'No'}
                        </button>
                      </form>
                    </td>
                  )
                })}
              </tr>
            ))}
            {/* Admin-only rows shown for clarity — never grantable */}
            {['Reimbursement approve', 'Masters / entity / bank editing', 'User & permission management'].map(
              (label) => (
                <tr key={label} className="bg-zinc-50/50">
                  <td className="px-4 py-2 text-zinc-400">{label}</td>
                  {members.map((m) => (
                    <td key={m.id} className="px-4 py-2 text-center text-xs text-zinc-300">
                      Admin only
                    </td>
                  ))}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      {/* Entity scoping (spec §1.2) */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">Per-entity scoping</h2>
        <p className="mt-1 text-xs text-zinc-500">
          When scoping is on, the member sees only the entities ticked below —
          e.g. tag ACPL transactions but never see HG personal books.
        </p>
        <div className="mt-3 space-y-3">
          {members.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3">
              <span className="w-28 text-sm font-medium text-zinc-800">{m.name}</span>
              <form action={setEntityScoped}>
                <input type="hidden" name="userId" value={m.id} />
                <input type="hidden" name="scoped" value={m.entityScoped ? 'false' : 'true'} />
                <button
                  type="submit"
                  className={
                    m.entityScoped
                      ? 'rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700 hover:bg-amber-200'
                      : 'rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-200'
                  }
                >
                  {m.entityScoped ? 'Scoped' : 'All entities'}
                </button>
              </form>
              {m.entityScoped &&
                entities.map((e) => {
                  const granted = m.entityScopes.some((s) => s.entityId === e.id)
                  return (
                    <form key={e.id} action={setEntityScope} className="inline">
                      <input type="hidden" name="userId" value={m.id} />
                      <input type="hidden" name="entityId" value={e.id} />
                      <input type="hidden" name="grant" value={granted ? 'false' : 'true'} />
                      <button
                        type="submit"
                        className={
                          granted
                            ? 'rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700'
                            : 'rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-50'
                        }
                      >
                        {e.code}
                      </button>
                    </form>
                  )
                })}
            </div>
          ))}
        </div>
      </div>

      {/* Member management */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="font-medium text-zinc-900">Add member</h2>
          <form action={createMember} className="mt-3 space-y-3">
            <input
              name="name"
              placeholder="Name"
              required
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            />
            <input
              name="email"
              type="email"
              placeholder="Email"
              required
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            />
            <input
              name="password"
              type="password"
              placeholder="Initial password (min 8 chars)"
              required
              minLength={8}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
            >
              Create member
            </button>
          </form>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="font-medium text-zinc-900">Member status & password</h2>
          <div className="mt-3 space-y-3">
            {members.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3">
                <div className="w-40">
                  <p className="text-sm font-medium text-zinc-800">{m.name}</p>
                  <p className="text-xs text-zinc-400">{m.email}</p>
                </div>
                <form action={setUserActive}>
                  <input type="hidden" name="userId" value={m.id} />
                  <input type="hidden" name="active" value={m.isActive ? 'false' : 'true'} />
                  <button
                    type="submit"
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                  >
                    {m.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                </form>
                <form action={resetMemberPassword} className="flex items-center gap-1">
                  <input type="hidden" name="userId" value={m.id} />
                  <input
                    name="password"
                    type="password"
                    placeholder="New password"
                    minLength={8}
                    required
                    className="w-36 rounded-md border border-zinc-300 px-2 py-1 text-xs"
                  />
                  <button
                    type="submit"
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                  >
                    Reset
                  </button>
                </form>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
