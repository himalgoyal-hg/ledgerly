import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import {
  createEntity,
  archiveEntity,
  restoreEntity,
  hardDeleteEntity,
} from './actions'

const TYPE_LABELS: Record<string, string> = {
  INDIVIDUAL: 'Individual',
  PVT_LTD: 'Pvt Ltd',
  PARTNERSHIP: 'Partnership',
  LLP: 'LLP',
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export default async function EntitiesPage() {
  await requireAdmin()

  const entities = await prisma.entity.findMany({
    include: { _count: { select: { bankAccounts: true, cashLocations: true } } },
    orderBy: [{ archivedAt: 'asc' }, { code: 'asc' }],
  })
  const active = entities.filter((e) => !e.archivedAt)
  const archived = entities.filter((e) => e.archivedAt)

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Entities</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Archiving hides an entity from every dropdown and the &ldquo;Books
          of&rdquo; switcher; data is preserved and restorable. Hard delete is
          only possible while an entity has no data under it.
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-3">Entity</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">PAN</th>
              <th className="px-4 py-3">GSTIN</th>
              <th className="px-4 py-3">FY starts</th>
              <th className="px-4 py-3">Accounts</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {active.map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-2 font-medium text-zinc-800">
                  {e.name} <span className="text-zinc-400">({e.code})</span>
                </td>
                <td className="px-4 py-2 text-zinc-600">{TYPE_LABELS[e.type]}</td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-600">{e.pan}</td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-600">{e.gstin ?? '—'}</td>
                <td className="px-4 py-2 text-zinc-600">{MONTHS[e.fyStartMonth - 1]}</td>
                <td className="px-4 py-2 text-zinc-600">
                  {e._count.bankAccounts} bank · {e._count.cashLocations} cash
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <form action={archiveEntity}>
                      <input type="hidden" name="id" value={e.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                      >
                        Archive
                      </button>
                    </form>
                    {e._count.bankAccounts === 0 && e._count.cashLocations === 0 && (
                      <form action={hardDeleteEntity}>
                        <input type="hidden" name="id" value={e.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {active.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-sm text-zinc-400">
                  No entities yet — create the first one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {archived.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="font-medium text-zinc-900">Archived</h2>
          <div className="mt-2 space-y-2">
            {archived.map((e) => (
              <div key={e.id} className="flex items-center gap-3 border-t border-zinc-100 pt-2">
                <span className="text-sm text-zinc-500">
                  {e.name} ({e.code})
                </span>
                <form action={restoreEntity}>
                  <input type="hidden" name="id" value={e.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                  >
                    Restore
                  </button>
                </form>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">Create entity</h2>
        <form action={createEntity} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <input
            name="name"
            placeholder="Name (e.g. Accurest Consulting Pvt Ltd)"
            required
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <input
            name="code"
            placeholder="Code (e.g. ACPL)"
            required
            maxLength={10}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm uppercase"
          />
          <select name="type" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm">
            <option value="INDIVIDUAL">Individual</option>
            <option value="PVT_LTD">Pvt Ltd</option>
            <option value="PARTNERSHIP">Partnership</option>
            <option value="LLP">LLP</option>
          </select>
          <input
            name="pan"
            placeholder="PAN (AAAAA9999A)"
            required
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm uppercase"
          />
          <input
            name="gstin"
            placeholder="GSTIN (optional)"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm uppercase"
          />
          <select
            name="fyStartMonth"
            defaultValue="4"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                FY starts {m}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 sm:col-span-2 lg:col-span-1"
          >
            Create entity
          </button>
        </form>
      </div>
    </div>
  )
}
