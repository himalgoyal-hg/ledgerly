import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { createAccount, archiveAccount, restoreAccount } from './actions'

export default async function CoaPage() {
  const user = await requireAdmin()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>

  const accounts = await prisma.ledgerAccount.findMany({
    where: { entityId: entity.id },
    include: { _count: { select: { lines: true } } },
    orderBy: { code: 'asc' },
  })
  const groups = accounts.filter((a) => a.isGroup)
  const depth = (code: string) => (code.endsWith('000') ? 0 : code.endsWith('00') ? 1 : code.endsWith('0') ? 2 : 2)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">
          Chart of Accounts — {entity.name} ({entity.code})
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Seeded automatically on entity creation. Group heads structure the
          tree; postings go to leaf accounts only.
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Account</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3 text-right">Postings</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {accounts.map((a) => (
              <tr key={a.id} className={a.archivedAt ? 'opacity-40' : undefined}>
                <td className="px-4 py-1.5 font-mono text-xs text-zinc-500">{a.code}</td>
                <td className="px-4 py-1.5">
                  <span style={{ paddingLeft: `${depth(a.code) * 1.25}rem` }}>
                    {a.isGroup ? (
                      <span className="font-medium text-zinc-800">{a.name}</span>
                    ) : (
                      <Link href={`/admin/ledgers?accountId=${a.id}`} className="text-zinc-700 hover:underline">
                        {a.name}
                      </Link>
                    )}
                    {a.system && <span className="ml-2 text-[10px] uppercase text-zinc-300">system</span>}
                    {a.archivedAt && <span className="ml-2 text-[10px] text-zinc-400">archived</span>}
                  </span>
                </td>
                <td className="px-4 py-1.5 text-xs text-zinc-500">{a.kind}</td>
                <td className="px-4 py-1.5 text-right text-xs text-zinc-500">
                  {a.isGroup ? '—' : a._count.lines}
                </td>
                <td className="px-4 py-1.5 text-right">
                  {!a.isGroup && !a.system && (
                    <form action={a.archivedAt ? restoreAccount : archiveAccount} className="inline">
                      <input type="hidden" name="id" value={a.id} />
                      <button type="submit" className="text-xs text-zinc-400 hover:text-zinc-700">
                        {a.archivedAt ? 'restore' : 'archive'}
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">Add account head</h2>
        <form action={createAccount} className="mt-3 flex flex-wrap gap-2">
          <input type="hidden" name="entityId" value={entity.id} />
          <select name="parentId" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm">
            <option value="">Under group…</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.code} · {g.name}
              </option>
            ))}
          </select>
          <input
            name="name"
            placeholder="Account name (e.g. ACPL Hyrox)"
            required
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700">
            Add account
          </button>
        </form>
      </div>
    </div>
  )
}
