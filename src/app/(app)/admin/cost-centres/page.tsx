import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { createCostCentre, archiveCostCentre, restoreCostCentre, renameCostCentre } from './actions'
import { PageHeader, buttonClass, controlClass } from '@/components/ui'

// Cost centre masters (Admin) — tier 3 of the tag, summing into cost centre
// reports. Since 20 Aug 2026 every books carries the SAME seven, Himal's
// spellings (Company Essentials, Company Growth, Compulsory, Growth,
// Invesment, Lifestyle, Optional) — no per-book variants; a new centre
// added via the master register is born with one name in every books.

export default async function CostCentresPage() {
  const admin = await requireAdmin()
  const entity = await getCurrentEntity(admin)
  if (!entity) {
    return <p className="text-sm text-ink-2">Create an entity first (Admin → Entities).</p>
  }

  const centres = await prisma.costCentre.findMany({
    where: { entityId: entity.id },
    include: { _count: { select: { lines: true } } },
    orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
  })
  const active = centres.filter((c) => c.archivedAt === null)
  const archived = centres.filter((c) => c.archivedAt !== null)

  return (
    <div className="max-w-2xl space-y-8">
      <PageHeader
        kicker="Setup"
        title={`Cost centres — ${entity.name} (${entity.code})`}
        subtitle="The third tier of every tag. Archiving hides a centre from tag forms; its history stays in the reports."
      />

      <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
        <form action={createCostCentre} className="flex gap-2">
          <input type="hidden" name="entityId" value={entity.id} />
          <input
            name="name"
            required
            placeholder="e.g. Optional-Investment"
            className={`${controlClass} flex-1`}
          />
          <button type="submit" className={buttonClass('primary')}>
            Add cost centre
          </button>
        </form>
      </div>

      <div className="space-y-2">
        {active.map((cc) => (
          <div
            key={cc.id}
            className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-sm shadow-card"
          >
            <form action={renameCostCentre} className="flex items-center gap-2">
              <input type="hidden" name="id" value={cc.id} />
              <input
                name="name"
                defaultValue={cc.name}
                required
                className="w-56 rounded-lg border border-transparent px-2 py-1 text-sm font-medium text-ink hover:border-line focus:border-primary focus:outline-none"
              />
              <button type="submit" className="rounded-lg border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-2">
                Rename
              </button>
            </form>
            <span className="text-xs text-ink-3">{cc._count.lines} journal lines</span>
            <form action={archiveCostCentre} className="ml-auto">
              <input type="hidden" name="id" value={cc.id} />
              <button
                type="submit"
                className="rounded-lg border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-2"
              >
                Archive
              </button>
            </form>
          </div>
        ))}
        {active.length === 0 && (
          <p className="text-sm text-ink-3">No cost centres yet for these books.</p>
        )}
      </div>

      {archived.length > 0 && (
        <div className="rounded-2xl border border-line-2 bg-surface-2/60 p-4">
          <h2 className="text-sm font-medium text-ink-2">Archived</h2>
          <div className="mt-2 space-y-2">
            {archived.map((cc) => (
              <div key={cc.id} className="flex items-center gap-3 text-sm text-ink-2">
                <span>{cc.name}</span>
                <form action={restoreCostCentre} className="ml-auto">
                  <input type="hidden" name="id" value={cc.id} />
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
    </div>
  )
}
