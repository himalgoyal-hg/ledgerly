import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { ConfirmButton } from '@/components/confirm-button'
import { LiveFilter } from '@/components/live-filter'
import { CellInput } from './cell-input'
import { Badge, PageHeader, buttonClass, controlClass, tableWrapClass, theadClass } from '@/components/ui'
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
//
// Professional-register structure (Himal, 19 Aug): fixed colgroup grid like
// the master register, a summary strip with the month's progress, labeled
// column editor, count chip in the header.

const inputCls = controlClass

const ord = (d: number) => {
  const s = ['th', 'st', 'nd', 'rd'][d % 100 > 10 && d % 100 < 14 ? 0 : Math.min(d % 10, 4) % 4] ?? 'th'
  return `${d}${s}`
}

const field = (label: string) => (
  <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</span>
)

export default async function FinanceTasksPage() {
  await requireAdmin()

  const [tasks, monthRows, banks] = await Promise.all([
    prisma.financeTask.findMany({
      where: { archivedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: { cells: true },
    }),
    prisma.financeMonth.findMany({ orderBy: { month: 'asc' } }),
    prisma.bankAccount.findMany({ where: { archivedAt: null }, select: { nickname: true }, orderBy: { nickname: 'asc' } }),
  ])
  // Bank mode options — the master register's vocabulary: real accounts + Cash
  const bankModes = [...new Set([...banks.map((b) => b.nickname), 'Cash'])]

  // cell lookup: taskId → month key (yyyy-mm) → cell (value + date + remark)
  type Cell = { value: string; paidOn: Date | null; remark: string | null }
  const cellMap = new Map<string, Map<string, Cell>>()
  const monthSet = new Set<string>(monthRows.map((r) => r.month.toISOString().slice(0, 7)))
  for (const t of tasks) {
    const m = new Map<string, Cell>()
    for (const c of t.cells) {
      const key = c.month.toISOString().slice(0, 7)
      m.set(key, { value: c.value, paidOn: c.paidOn, remark: c.remark })
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
    .sort((a, b) => (a.dueDay ?? 0) - (b.dueDay ?? 0))
    .map((t) => ({ task: t, value: cellMap.get(t.id)?.get(nowKey)?.value ?? null }))
  const doneTasks = dueTasks.filter((d) => d.value)
  const pendingTasks = dueTasks.filter((d) => !d.value)
  const pct = dueTasks.length ? Math.round((doneTasks.length / dueTasks.length) * 100) : 0

  const chip = (t: (typeof dueTasks)[number]) => {
    const overdue = !t.value && (t.task.dueDay ?? 32) <= now.getDate()
    return (
      <span
        key={t.task.id}
        title={t.task.account ?? undefined}
        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
          t.value
            ? 'border-success/30 bg-success-soft text-success'
            : overdue
              ? 'border-warning/30 bg-warning-soft text-warning'
              : 'border-line bg-surface text-ink-2'
        }`}
      >
        <span className="font-semibold tabular-nums">{ord(t.task.dueDay!)}</span>
        {t.task.name}
        {t.value ? <span className="font-medium">· {t.value.length > 16 ? `${t.value.slice(0, 16)}…` : t.value}</span> : null}
      </span>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Operations"
        title="Finance tasks"
        subtitle="Monthly payment checklist — fill the cell (amount / Yes / note) when a payment is done. Nothing posts from here."
        actions={
          <>
            <Badge tone="neutral">
              {tasks.length} bills · {months.length} months
            </Badge>
            <LiveFilter selector="[data-live-filter='tasks']" placeholder="Type to search months…" />
          </>
        }
      />

      {/* This month at a glance — the reason the sheet exists */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-ink">{monthLabel(nowKey)}</h2>
          {pendingTasks.length ? (
            <Badge tone="warning">{pendingTasks.length} pending</Badge>
          ) : (
            <Badge tone="success">all done ✓</Badge>
          )}
          <span className="text-xs tabular-nums text-ink-3">
            {doneTasks.length}/{dueTasks.length} paid
          </span>
          {/* progress track */}
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <div className="h-full rounded-full bg-success transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
        {dueTasks.length > 0 && (
          <div className="mt-3 space-y-2">
            {pendingTasks.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-14 text-[10px] font-semibold uppercase tracking-wider text-ink-3">Waiting</span>
                {pendingTasks.map(chip)}
              </div>
            )}
            {doneTasks.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-14 text-[10px] font-semibold uppercase tracking-wider text-ink-3">Paid</span>
                {doneTasks.map(chip)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* New bill / task — the sheet's column format: name, paying account,
          due day, and (fill-what-you-know) the first month's value */}
      <details className="rounded-2xl border border-line bg-surface shadow-card">
        <summary className="cursor-pointer rounded-2xl px-4 py-2.5 text-sm font-medium text-ink hover:bg-surface-2/60">
          ＋ New bill / task (a new column in the register)
        </summary>
        <form action={createFinanceTaskAction} className="border-t border-line-2 p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <label className="block">
              {field('Bill / task *')}
              <input name="name" required placeholder="New EMI Rs. 12,000 / Netflix…" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              {field('Bank mode')}
              <input name="account" list="task-bank-modes" placeholder="HDFC 2762 / MG Axis bank / Cash" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              {field('Due day')}
              <input name="dueDay" inputMode="numeric" placeholder="7" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              {field('Month (optional)')}
              <input name="firstMonth" type="month" defaultValue={nowKey} className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              {field('Amount / note (optional)')}
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

      {/* The register — the sheet itself: months × tasks, every cell an
          input. Fixed colgroup grid: Month 9rem, wide 16rem for note-style
          columns (no due day), 9rem for regular payment columns. */}
      <div className={tableWrapClass}>
        <table
          data-live-filter="tasks"
          className="w-full table-fixed text-left text-sm"
          style={{ minWidth: `${9 + tasks.reduce((s, t) => s + (t.dueDay === null ? 16 : 9), 0)}rem` }}
        >
          <colgroup>
            <col style={{ width: '9rem' }} />
            {tasks.map((t) => (
              <col key={t.id} style={{ width: t.dueDay === null ? '16rem' : '9rem' }} />
            ))}
          </colgroup>
          <thead className={theadClass}>
            <tr className="align-bottom">
              <th className="sticky left-0 z-10 bg-surface px-2 py-2">Month</th>
              {tasks.map((t) => (
                <th key={t.id} className="px-1.5 py-2 font-medium">
                  <div className="normal-case tracking-normal">
                    <div className="truncate text-[10px] text-ink-3" title={t.account ?? undefined}>
                      {t.account ?? ' '}
                      {t.dueDay ? ` · due ${ord(t.dueDay)}` : ''}
                    </div>
                    <div className="mt-0.5 flex items-start gap-1 text-xs font-semibold text-ink">
                      <span className="truncate" title={t.name}>{t.name}</span>
                      {/* header ✎ — edit the column in place */}
                      <details className="relative shrink-0">
                        <summary className="cursor-pointer list-none rounded px-1 text-ink-3 hover:bg-surface-2 hover:text-ink-2">✎</summary>
                        <div className="absolute left-0 top-6 z-20 w-60 rounded-xl border border-line bg-surface p-3 shadow-pop">
                          <form action={updateFinanceTaskAction} className="space-y-2">
                            <input type="hidden" name="taskId" value={t.id} />
                            <label className="block">
                              {field('Bill / task')}
                              <input name="name" defaultValue={t.name} required className={`mt-1 w-full ${inputCls}`} />
                            </label>
                            <label className="block">
                              {field('Bank mode')}
                              <input name="account" list="task-bank-modes" defaultValue={t.account ?? ''} placeholder="HDFC 2762 / Cash" className={`mt-1 w-full ${inputCls}`} />
                            </label>
                            <label className="block">
                              {field('Due day')}
                              <input name="dueDay" defaultValue={t.dueDay ?? ''} inputMode="numeric" placeholder="7" className={`mt-1 w-full ${inputCls}`} />
                            </label>
                            <button type="submit" className="w-full rounded-lg bg-primary px-2 py-1.5 text-xs font-medium text-white hover:bg-primary-strong">
                              Save
                            </button>
                          </form>
                          <form action={archiveFinanceTaskAction} className="mt-1.5">
                            <input type="hidden" name="taskId" value={t.id} />
                            <ConfirmButton
                              message={`Remove "${t.name}" from the register? History stays in the database.`}
                              className="w-full rounded-lg border border-danger/30 px-2 py-1.5 text-xs text-danger hover:bg-danger-soft"
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
          <tbody className="divide-y divide-line-2">
            {months.map((mk) => {
              const isNow = mk === nowKey
              return (
                <tr
                  key={mk}
                  data-filter-keep={isNow ? '1' : undefined}
                  className={`align-top ${isNow ? 'bg-warning-soft/40' : mk > nowKey ? 'text-ink-3' : 'even:bg-surface-2/40 hover:bg-primary-soft/40'}`}
                >
                  <td className={`sticky left-0 z-10 whitespace-nowrap px-2 py-1.5 text-xs font-medium ${isNow ? 'bg-warning-soft text-warning' : 'bg-surface text-ink-2'}`}>
                    {monthLabel(mk)}
                    {isNow && <span className="ml-1 text-[9px] uppercase text-warning">now</span>}
                  </td>
                  {tasks.map((t) => {
                    const cell = cellMap.get(t.id)?.get(mk)
                    const value = cell?.value ?? ''
                    const overdue = isNow && !value && t.dueDay !== null && t.dueDay <= now.getDate()
                    const paidLabel = cell?.paidOn
                      ? cell.paidOn.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
                      : ''
                    const meta = [paidLabel, cell?.remark ?? ''].filter(Boolean).join(' · ')
                    return (
                      <td key={t.id} className={`px-0.5 py-0.5 ${overdue ? 'bg-warning-soft/60' : ''}`}>
                        {/* Excel-style: the cell IS the input — type, Enter, saved;
                            blank clears. Date + Remark ride in the same form,
                            expanding inline (an absolute popover would clip in
                            the scroll box). */}
                        <form action={saveFinanceCellAction}>
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="hidden" name="month" value={mk} />
                          <CellInput
                            defaultValue={value}
                            title={value || (overdue ? `Due ${ord(t.dueDay!)} — pending` : 'Type and press Enter to save')}
                            placeholder={overdue ? `due ${ord(t.dueDay!)}` : ''}
                            emphasis={overdue}
                          />
                          <details>
                            <summary
                              className="cursor-pointer list-none truncate px-1.5 text-[9px] leading-tight text-ink-3 hover:text-ink-2"
                              title={meta || 'Date · Remark'}
                            >
                              {meta || '⋯'}
                            </summary>
                            <div className="mt-1 space-y-1 px-1 pb-1">
                              <input
                                name="paidOn"
                                type="date"
                                defaultValue={cell?.paidOn?.toISOString().slice(0, 10) ?? ''}
                                className="w-full rounded border border-line bg-surface px-1 py-0.5 text-[10px] text-ink"
                              />
                              <input
                                name="remark"
                                defaultValue={cell?.remark ?? ''}
                                placeholder="Remark"
                                className="w-full rounded border border-line bg-surface px-1 py-0.5 text-[10px] text-ink"
                              />
                              <button type="submit" className="w-full rounded bg-primary px-1 py-0.5 text-[10px] font-medium text-white hover:bg-primary-strong">
                                Save
                              </button>
                            </div>
                          </details>
                        </form>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {/* the next row of the sheet — one click away */}
            <tr data-filter-keep="1">
              <td colSpan={tasks.length + 1} className="px-2 py-2">
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
                    className="rounded-lg border border-line bg-surface px-2 py-0.5 text-xs text-ink-2"
                  />
                </form>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-ink-3">
        Type in a cell and press Enter to save; clear it to remove. ⋯ under a cell holds its Date and Remark. ✎ edits a column, ＋ adds a new one.
      </p>
      <datalist id="task-bank-modes">
        {bankModes.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  )
}
