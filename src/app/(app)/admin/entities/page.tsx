import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import {
  createEntity,
  archiveEntity,
  restoreEntity,
  hardDeleteEntity,
} from './actions'
import { PageHeader, buttonClass, controlClass, tableWrapClass, theadClass } from '@/components/ui'

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
      <PageHeader
        kicker="Setup"
        title="Entities"
        subtitle={
          <>
            Archiving hides an entity from every dropdown and the &ldquo;Books
            of&rdquo; switcher; data is preserved and restorable. Hard delete is
            only possible while an entity has no data under it.
          </>
        }
      />

      <div className={tableWrapClass}>
        <table className="w-full text-left text-sm">
          <thead className={theadClass}>
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
          <tbody className="divide-y divide-line-2">
            {active.map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-2 font-medium text-ink">
                  {e.name} <span className="text-ink-3">({e.code})</span>
                </td>
                <td className="px-4 py-2 text-ink-2">{TYPE_LABELS[e.type]}</td>
                <td className="px-4 py-2 font-mono text-xs text-ink-2">{e.pan}</td>
                <td className="px-4 py-2 font-mono text-xs text-ink-2">{e.gstin ?? '—'}</td>
                <td className="px-4 py-2 text-ink-2">{MONTHS[e.fyStartMonth - 1]}</td>
                <td className="px-4 py-2 text-ink-2">
                  {e._count.bankAccounts} bank · {e._count.cashLocations} cash
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <form action={archiveEntity}>
                      <input type="hidden" name="id" value={e.id} />
                      <button
                        type="submit"
                        className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-surface-2"
                      >
                        Archive
                      </button>
                    </form>
                    {e._count.bankAccounts === 0 && e._count.cashLocations === 0 && (
                      <form action={hardDeleteEntity}>
                        <input type="hidden" name="id" value={e.id} />
                        <button
                          type="submit"
                          className="rounded-lg border border-danger/30 px-2 py-1 text-xs text-danger hover:bg-danger-soft"
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
                <td colSpan={7} className="px-4 py-6 text-center text-sm text-ink-3">
                  No entities yet — create the first one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {archived.length > 0 && (
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
          <h2 className="font-medium text-ink">Archived</h2>
          <div className="mt-2 space-y-2">
            {archived.map((e) => (
              <div key={e.id} className="flex items-center gap-3 border-t border-line-2 pt-2">
                <span className="text-sm text-ink-2">
                  {e.name} ({e.code})
                </span>
                <form action={restoreEntity}>
                  <input type="hidden" name="id" value={e.id} />
                  <button
                    type="submit"
                    className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-surface-2"
                  >
                    Restore
                  </button>
                </form>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
        <h2 className="font-medium text-ink">Create entity</h2>
        <form action={createEntity} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <input
            name="name"
            placeholder="Name (e.g. Accurest Consulting Pvt Ltd)"
            required
            className={controlClass}
          />
          <input
            name="code"
            placeholder="Code (e.g. ACPL)"
            required
            maxLength={10}
            className={`${controlClass} uppercase`}
          />
          <select name="type" required className={controlClass}>
            <option value="INDIVIDUAL">Individual</option>
            <option value="PVT_LTD">Pvt Ltd</option>
            <option value="PARTNERSHIP">Partnership</option>
            <option value="LLP">LLP</option>
          </select>
          <input
            name="pan"
            placeholder="PAN (AAAAA9999A)"
            required
            className={`${controlClass} uppercase`}
          />
          <input
            name="gstin"
            placeholder="GSTIN (optional)"
            className={`${controlClass} uppercase`}
          />
          <select
            name="fyStartMonth"
            defaultValue="4"
            className={controlClass}
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                FY starts {m}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className={`${buttonClass('primary')} sm:col-span-2 lg:col-span-1`}
          >
            Create entity
          </button>
        </form>
      </div>
    </div>
  )
}
