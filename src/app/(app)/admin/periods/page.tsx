import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { lockPeriod, unlockPeriod } from './actions'
import { PageHeader } from '@/components/ui'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export default async function PeriodsPage() {
  const user = await requireAdmin()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>

  const locks = await prisma.periodLock.findMany({ where: { entityId: entity.id } })
  const isLocked = (y: number, m: number) =>
    locks.some((l) => l.year === y && l.month === m)

  // Show the current FY and the previous one, laid out FY-wise.
  const now = new Date()
  const fyStart = entity.fyStartMonth
  const currentFyStartYear =
    now.getMonth() + 1 >= fyStart ? now.getFullYear() : now.getFullYear() - 1
  const fys = [currentFyStartYear - 1, currentFyStartYear]

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Admin"
        title={`Period locks — ${entity.name} (${entity.code})`}
        subtitle="Lock a month after filing (GST). Locked months reject posting, edit, delete and undo — enforced in the database. Unlocks are audit-logged."
      />

      {fys.map((startYear) => (
        <div key={startYear} className="rounded-2xl border border-line bg-surface p-4 shadow-card">
          <h2 className="font-medium text-ink">
            FY {startYear}–{String((startYear + 1) % 100).padStart(2, '0')}
          </h2>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-12">
            {Array.from({ length: 12 }, (_, i) => {
              const month = ((fyStart - 1 + i) % 12) + 1
              const year = month >= fyStart ? startYear : startYear + 1
              const locked = isLocked(year, month)
              return (
                <form key={`${year}-${month}`} action={locked ? unlockPeriod : lockPeriod}>
                  <input type="hidden" name="entityId" value={entity.id} />
                  <input type="hidden" name="year" value={year} />
                  <input type="hidden" name="month" value={month} />
                  <button
                    type="submit"
                    className={
                      locked
                        ? 'w-full rounded-lg bg-primary px-2 py-2 text-xs font-medium text-white hover:bg-primary-strong'
                        : 'w-full rounded-lg border border-line px-2 py-2 text-xs text-ink-2 hover:bg-surface-2'
                    }
                    title={locked ? 'Click to unlock (audit-logged)' : 'Click to lock'}
                  >
                    {MONTH_NAMES[month - 1]} {String(year % 100).padStart(2, '0')}
                    <span className="block text-[10px] opacity-70">
                      {locked ? '🔒 locked' : 'open'}
                    </span>
                  </button>
                </form>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
