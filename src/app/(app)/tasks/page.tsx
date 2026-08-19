import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { ConfirmButton } from '@/components/confirm-button'
import { CellInput } from './cell-input'
import { PageHeader, buttonClass, controlClass, tableWrapClass, theadClass } from '@/components/ui'
import {
  saveFinanceCellAction,
  createFinanceTaskAction,
  updateFinanceTaskAction,
  archiveFinanceTaskAction,
  addFinanceMonthAction,
} from './actions'

// Finance tasks — Himal's sheet, as a screen: columns are the recurring
// payments (with paying account + due day), rows are months, and each cell
// IS an input — type the amount/"Yes"/note, Enter, saved. Nothing posts;
// the checklist just tracks that the payment happened.

const inputCls = controlClass

const ord = (d: number) => {
  const s = ['th', 'st', 'nd', 'rd'][d % 100 > 10 && d % 100 < 14 ? 0 : Math.min(d % 10, 4) % 4] ?? 'th'
  return `${d}${s}`
}

export default async function FinanceTasksPage() {
  await requireAdmin()

  const [tasks, monthRows] = await Promise.all([
    prisma.financeTask.findMany({
      where: { archivedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: { cells: true },
    }),
    prisma.financeMonth.findMany({ orderBy: { month: 'asc' } }),
  ])

  // cell lookup: taskId → month key (yyyy-mm) → value
  const cellMap = new Map<string, Map<string, string>>()
  const monthSet = new Set<string>(monthRows.map((r) => r.month.toISOString().slice(0, 7)))
  for (const t of tasks) {
    const m = new Map<string, string>()
    for (const c of t.cells) {
      const key = c.month.toISOString().slice(0, 7)
      m.set(key, c.value)
      monthSet.add(key) // a cell's month always shows, row or no row
    }
    cellMap.set(t.id, m)
  }

  // month rows come from the DB (＋ Add month appends); today's month always shows
  const now = new Date()
  const nowKey = now.toISOString().slice(0, 7)
  monthSet.add(nowKey)
  const months = [...monthSet].sort()
  const lastMonth = months[months.length - 1]
  const nextMonthKey = (() => {
    const d = new Date(`${lastMonth}-01T00:00:00Z`)
    d.setUTCMonth(d.getUTCMonth() + 1)
    return d.toISOString().slice(0, 7)
  })()

  const monthLabel = (key: string) =>
    new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: '2-digit', timeZone: 'UTC' })

  // this month's checklist: every task with a due day, done or waiting
  const dueTasks = tasks
    .filter((t) => t.dueDay !== null)
    .map((t) => ({ task: t, value: cellMap.get(t.id)?.get(nowKey) ?? null }))
  const pendingCount = dueTasks.filter((d) => !d.value).length

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Operations"
        title="Finance tasks"
        subtitle="Monthly payment checklist — fill the cell (amount / Yes / note) when a payment is done. Nothing posts from here."
      />

      {/* This month at a glance — the reason the sheet exists */}
      <div className="rounded-2xl border border-line bg-surface p-3 shadow-card">
        <h2 className="text-sm font-medium text-ink">
          {monthLabel(nowKey)} — {pendingCount ? `${pendingCount} payment${pendingCount > 1 ? 's' : ''} pending` : 'all done ✓'}
        </h2>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {dueTasks
            .sort((a, b) => (a.task.dueDay ?? 0) - (b.task.dueDay ?? 0))
            .map(({ task, value }) => (
              <span
                key={task.id}
                title={task.account ?? undefined}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  value
                    ? 'border-success/30 bg-success-soft text-success'
                    : (task.dueDay ?? 32) <= now.getDate()
                      ? 'border-warning/30 bg-warning-soft text-warning'
                      : 'border-line bg-surface-2/60 text-ink-2'
                }`}
              >
                {ord(task.dueDay!)} · {task.name}
                {value ? ` — ${value.length > 18 ? `${value.slice(0, 18)}…` : value}` : ''}
              </span>
            ))}
        </div>
      </div>

      {/* New bill / task — the sheet's column format: name, paying account,
          due day, and (fill-what-you-know) the first month's value */}
      <details className="rounded-2xl border border-line bg-surface shadow-card">
        <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-ink hover:bg-surface-2/60">
          ＋ New bill / task (a new column in the register)
        </summary>
        <form action={createFinanceTaskAction} className="border-t border-line-2 p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Bill / task *</span>
              <input name="name" required placeholder="New EMI Rs. 12,000 / Netflix…" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Paid from</span>
              <input name="account" placeholder="7838 account / MG Axis bank / cash" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Due day</span>
              <input name="dueDay" inputMode="numeric" placeholder="7" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Month (optional)</span>
              <input name="firstMonth" type="month" defaultValue={nowKey} className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Amount / note (optional)</span>
              <input name="firstValue" placeholder="₹12,000 / Yes" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <div className="flex items-end">
              <button type="submit" className={buttonClass('primary')}>
                Add
              </button>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            Fill what you have — name is enough; the amount and other cells can be filled later, right in the grid.
          </p>
        </form>
      </details>

      {/* The register — the sheet itself: months × tasks, every cell an input */}
      <div className={tableWrapClass}>
        <table className="w-full text-left text-sm" style={{ minWidth: `${10 + tasks.length * 9}rem` }}>
          <thead className={theadClass}>
            <tr className="align-bottom">
              <th className="sticky left-0 z-10 bg-surface px-2 py-2">Month</th>
              {tasks.map((t) => (
                <th key={t.id} className={`px-1.5 py-2 font-medium ${t.dueDay === null ? 'min-w-[16rem]' : 'min-w-[7rem]'}`}>
                  <div className="normal-case tracking-normal">
                    <div className="text-[10px] text-ink-3">
                      {t.account ?? ' '}
                      {t.dueDay ? ` · due ${ord(t.dueDay)}` : ''}
                    </div>
                    <div className="mt-0.5 flex items-start gap-1 text-xs font-semibold text-ink-2">
                      <span>{t.name}</span>
                      {/* header ✎ — edit the column in place */}
                      <details className="relative">
                        <summary className="cursor-pointer list-none text-ink-3 hover:text-ink-2">✎</summary>
                        <div className="absolute left-0 top-5 z-20 w-56 rounded-lg border border-line bg-surface p-2 shadow-lg">
                          <form action={updateFinanceTaskAction} className="space-y-1.5">
                            <input type="hidden" name="taskId" value={t.id} />
                            <input name="name" defaultValue={t.name} required className={`w-full ${inputCls}`} />
                            <input name="account" defaultValue={t.account ?? ''} placeholder="Paid from" className={`w-full ${inputCls}`} />
                            <input name="dueDay" defaultValue={t.dueDay ?? ''} inputMode="numeric" placeholder="Due day" className={`w-full ${inputCls}`} />
                            <button type="submit" className="w-full rounded-lg bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary-strong">
                              Save
                            </button>
                          </form>
                          <form action={archiveFinanceTaskAction} className="mt-1">
                            <input type="hidden" name="taskId" value={t.id} />
                            <ConfirmButton
                              message={`Remove "${t.name}" from the register? History stays in the database.`}
                              className="w-full rounded-lg border border-danger/30 px-2 py-1 text-xs text-danger hover:bg-danger-soft"
                            >
                              Remove column
                            </ConfirmButton>
                          </form>
                        </div>
                      </details>
                    </div>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {months.map((mk) => {
              const isNow = mk === nowKey
              return (
                <tr
                  key={mk}
                  className={`border-b border-line-2 align-top ${isNow ? 'bg-warning-soft/40' : mk > nowKey ? 'text-ink-3' : ''}`}
                >
                  <td className={`sticky left-0 z-10 whitespace-nowrap px-2 py-1 text-xs font-medium ${isNow ? 'bg-warning-soft text-warning' : 'bg-surface text-ink-2'}`}>
                    {monthLabel(mk)}
                    {isNow && <span className="ml-1 text-[9px] uppercase text-warning">now</span>}
                  </td>
                  {tasks.map((t) => {
                    const value = cellMap.get(t.id)?.get(mk) ?? ''
                    const overdue = isNow && !value && t.dueDay !== null && t.dueDay <= now.getDate()
                    return (
                      <td key={t.id} className={`px-0.5 py-0.5 ${overdue ? 'bg-warning-soft/60' : ''}`}>
                        {/* Excel-style: the cell IS the input — type, Enter, saved; blank clears */}
                        <form action={saveFinanceCellAction}>
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="hidden" name="month" value={mk} />
                          <CellInput
                            defaultValue={value}
                            title={value || (overdue ? `Due ${ord(t.dueDay!)} — pending` : 'Type and press Enter to save')}
                            placeholder={overdue ? `due ${ord(t.dueDay!)}` : ''}
                            emphasis={overdue}
                          />
                        </form>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {/* the next row of the sheet — one click away */}
            <tr>
              <td colSpan={tasks.length + 1} className="px-2 py-1.5">
                <form action={addFinanceMonthAction} className="flex items-center gap-2">
                  <button
                    type="submit"
                    className="rounded-lg border border-dashed border-line px-3 py-1 text-xs text-ink-2 hover:border-ink-3 hover:bg-surface-2/60 hover:text-ink"
                  >
                    ＋ Add {monthLabel(nextMonthKey)}
                  </button>
                  <input
                    name="month"
                    type="month"
                    title="Or pick a different month to add"
                    className="rounded-lg border border-line px-2 py-0.5 text-xs text-ink-2"
                  />
                </form>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-ink-3">
        Type in a cell and press Enter to save; clear it to remove. ✎ edits a column, ＋ adds a new one.
      </p>
    </div>
  )
}
