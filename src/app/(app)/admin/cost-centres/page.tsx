import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { createCostCentre, archiveCostCentre, restoreCostCentre, renameCostCentre } from './actions'

// Cost centre masters (Admin): Hyrox Project, Office Operations, Personal,
// Consultant… — tier 3 of the tag, summing into cost centre reports.

export default async function CostCentresPage() {
  const admin = await requireAdmin()
  const entity = await getCurrentEntity(admin)
  if (!entity) {
    return <p className="text-sm text-zinc-500">Create an entity first (Admin → Entities).</p>
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
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">
          Cost centres — {entity.name} ({entity.code})
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          The third tier of every tag. Archiving hides a centre from tag forms;
          its history stays in the reports.
        </p>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <form action={createCostCentre} className="flex gap-2">
          <input type="hidden" name="entityId" value={entity.id} />
          <input
            name="name"
            required
            placeholder="e.g. Hyrox Project"
            className="flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Add cost centre
          </button>
        </form>
      </div>

      <div className="space-y-2">
        {active.map((cc) => (
          <div
            key={cc.id}
            className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 text-sm shadow-sm"
          >
            <form action={renameCostCentre} className="flex items-center gap-2">
              <input type="hidden" name="id" value={cc.id} />
              <input
                name="name"
                defaultValue={cc.name}
                required
                className="w-56 rounded-md border border-transparent px-2 py-1 text-sm font-medium text-zinc-800 hover:border-zinc-300 focus:border-zinc-300 focus:outline-none"
              />
              <button type="submit" className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100">
                Rename
              </button>
            </form>
            <span className="text-xs text-zinc-400">{cc._count.lines} journal lines</span>
            <form action={archiveCostCentre} className="ml-auto">
              <input type="hidden" name="id" value={cc.id} />
              <button
                type="submit"
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
              >
                Archive
              </button>
            </form>
          </div>
        ))}
        {active.length === 0 && (
          <p className="text-sm text-zinc-400">No cost centres yet for these books.</p>
        )}
      </div>

      {archived.length > 0 && (
        <div className="rounded-xl border border-zinc-100 bg-zinc-50 p-4">
          <h2 className="text-sm font-medium text-zinc-700">Archived</h2>
          <div className="mt-2 space-y-2">
            {archived.map((cc) => (
              <div key={cc.id} className="flex items-center gap-3 text-sm text-zinc-500">
                <span>{cc.name}</span>
                <form action={restoreCostCentre} className="ml-auto">
                  <input type="hidden" name="id" value={cc.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
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
