import { Fragment } from 'react'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { ConfirmButton } from '@/components/confirm-button'
import { LiveFilter } from '@/components/live-filter'
import { CellInput, DateCell } from './cell-input'
import { Badge, PageHeader, tableWrapClass, theadClass } from '@/components/ui'
import {
  saveFinanceCellAction,
  createFinanceTaskAction,
  updateFinanceTaskAction,
  archiveFinanceTaskAction,
  addFinanceMonthAction,
} from './actions'

// Finance tasks — Himal's sheet, as a screen: a Bills register sits above
// the checklist. The register is built exactly like Accounts — master
// register (Himal, 19 Aug): one row per bill, real always-visible columns
// (name / bank mode / due day), ✓ saves the row, a dashed first row adds a
// new one. Below it, the checklist grid keeps its own shape — columns are
// the bills, rows are months, and each cell IS an input (amount / date /
// remark). Nothing posts; the checklist just tracks that payment happened.

const ord = (d: number) => {
  const s = ['th', 'st', 'nd', 'rd'][d % 100 > 10 && d % 100 < 14 ? 0 : Math.min(d % 10, 4) % 4] ?? 'th'
  return `${d}${s}`
}

// Same inline-cell style as the master register — border only shows on
// hover/focus, so a row reads as data until you touch a field.
const cellCls =
  'w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-xs hover:border-line focus:border-primary focus:bg-surface focus:outline-none'

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

      {/* Bills register — same pattern as Accounts — master register: one
          row per bill, real editable columns, ✓ saves, ✕ removes. The
          first row is the add-row (dashed border), exactly like master's. */}
      <div>
        <h2 className="mb-1.5 text-sm font-semibold text-ink">Bills</h2>
        <div className={tableWrapClass}>
          <table className="w-full table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[38%]" />
              <col className="w-[28%]" />
              <col className="w-[10%]" />
              <col className="w-[24%]" />
            </colgroup>
            <thead className={theadClass}>
              <tr>
                <th className="px-4 py-2.5">Bill / task</th>
                <th className="px-2 py-2.5">Bank mode</th>
                <th className="px-2 py-2.5">Due day</th>
                <th className="px-2 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line-2">
              <tr className="border-l-2 border-success bg-surface-2/60">
                <td className="px-4 py-1">
                  <input
                    name="name"
                    form="task-new"
                    required
                    placeholder="＋ New EMI Rs. 12,000 / Netflix…"
                    className={`${cellCls} border-dashed border-success/40`}
                  />
                </td>
                <td className="px-1 py-0.5">
                  <input name="account" form="task-new" list="task-bank-modes" placeholder="HDFC 2762 / Cash" className={cellCls} />
                </td>
                <td className="px-1 py-0.5">
                  <input name="dueDay" form="task-new" inputMode="numeric" placeholder="7" className={`${cellCls} text-right tabular-nums`} />
                </td>
                <td className="px-2 py-1 text-right">
                  <form id="task-new" action={createFinanceTaskAction} className="flex flex-wrap items-center justify-end gap-1">
                    {/* fill-what-you-know: the new bill's first month can be
                        born already filled, same as adding it on the sheet */}
                    <input name="firstMonth" type="month" defaultValue={nowKey} title="First month (optional)" className={`${cellCls} w-28`} />
                    <input name="firstValue" placeholder="₹ / Yes" title="First value (optional)" className={`${cellCls} w-16`} />
                    <button type="submit" className="rounded bg-success px-2 py-0.5 text-[11px] font-medium text-white hover:opacity-90">
                      Add
                    </button>
                  </form>
                </td>
              </tr>
              {tasks.map((t) => {
                const fid = `task-${t.id}`
                return (
                  <tr key={t.id} className="even:bg-surface-2/40 hover:bg-primary-soft/40">
                    <td className="px-4 py-1 text-xs font-medium text-ink">
                      <input type="hidden" name="taskId" form={fid} value={t.id} />
                      <input name="name" form={fid} defaultValue={t.name} required className={cellCls} />
                    </td>
                    <td className="px-1 py-0.5">
                      <input name="account" form={fid} list="task-bank-modes" defaultValue={t.account ?? ''} placeholder="HDFC 2762 / Cash" className={cellCls} />
                    </td>
                    <td className="px-1 py-0.5">
                      <input name="dueDay" form={fid} defaultValue={t.dueDay ?? ''} inputMode="numeric" placeholder="7" className={`${cellCls} text-right tabular-nums`} />
                    </td>
                    <td className="whitespace-nowrap px-2 py-0.5 text-right">
                      <form id={fid} action={updateFinanceTaskAction} className="inline">
                        <button
                          type="submit"
                          title="Save — updates the register and this bill's column below"
                          className="rounded border border-line px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:bg-surface-2"
                        >
                          ✓
                        </button>
                      </form>
                      <form action={archiveFinanceTaskAction} className="ml-1 inline">
                        <input type="hidden" name="taskId" value={t.id} />
                        <ConfirmButton
                          message={`Remove "${t.name}" from the register? History stays in the database.`}
                          className="rounded border border-danger/30 px-1.5 py-0.5 text-[11px] text-danger/70 hover:bg-danger-soft hover:text-danger"
                        >
                          ✕
                        </ConfirmButton>
                      </form>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* The register — the sheet itself: months × tasks, every cell an
          input. Each bill is an Amount + Date column pair (Himal, 19 Aug).
          Fixed colgroup grid: Month 9rem, Amount 14rem for note-style
          columns (no due day) else 9rem, Date 7rem. */}
      <div className={tableWrapClass}>
        <table
          data-live-filter="tasks"
          className="w-full table-fixed text-left text-sm"
          style={{ minWidth: `${9 + tasks.reduce((s, t) => s + (t.dueDay === null ? 14 : 9) + 7, 0)}rem` }}
        >
          <colgroup>
            <col style={{ width: '9rem' }} />
            {tasks.map((t) => (
              <Fragment key={t.id}>
                <col style={{ width: t.dueDay === null ? '14rem' : '9rem' }} />
                <col style={{ width: '7rem' }} />
              </Fragment>
            ))}
          </colgroup>
          <thead className={theadClass}>
            <tr className="align-bottom">
              <th rowSpan={2} className="sticky left-0 z-10 bg-surface px-2 py-2">Month</th>
              {tasks.map((t) => (
                <th key={t.id} colSpan={2} className="border-l border-line-2 px-1.5 pb-0 pt-2 font-medium">
                  <div className="normal-case tracking-normal">
                    <div className="truncate text-[10px] text-ink-3" title={t.account ?? undefined}>
                      {t.account ?? ' '}
                      {t.dueDay ? ` · due ${ord(t.dueDay)}` : ''}
                    </div>
                    <div className="mt-0.5 truncate text-xs font-semibold text-ink" title={t.name}>
                      {t.name}
                    </div>
                  </div>
                </th>
              ))}
            </tr>
            {/* the pair's sub-labels — every bill reads Amount | Date */}
            <tr>
              {tasks.map((t) => (
                <Fragment key={t.id}>
                  <th className="border-l border-line-2 px-1.5 pb-1.5 pt-0.5 text-[9px] font-medium tracking-wider text-ink-3">Amount</th>
                  <th className="px-1.5 pb-1.5 pt-0.5 text-[9px] font-medium tracking-wider text-ink-3">Date</th>
                </Fragment>
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
                    const remark = cell?.remark ?? ''
                    const formId = `cell-${t.id}-${mk}`
                    return (
                      <Fragment key={t.id}>
                        <td className={`border-l border-line-2 px-0.5 py-0.5 ${overdue ? 'bg-warning-soft/60' : ''}`}>
                          {/* Excel-style: the cell IS the input — type, Enter,
                              saved; blank clears the whole cell. The Date cell
                              next door and the Remark below post through this
                              same form. */}
                          <form id={formId} action={saveFinanceCellAction}>
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
                                title={remark || 'Remark'}
                              >
                                {remark || '⋯'}
                              </summary>
                              <div className="mt-1 space-y-1 px-1 pb-1">
                                <input
                                  name="remark"
                                  defaultValue={remark}
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
                        <td className={`px-0.5 py-0.5 ${overdue ? 'bg-warning-soft/60' : ''}`}>
                          <DateCell
                            formId={formId}
                            defaultValue={cell?.paidOn?.toISOString().slice(0, 10) ?? ''}
                            title={value ? 'Paid on — pick a date and it saves' : 'Fill the amount first — the date rides with it'}
                          />
                        </td>
                      </Fragment>
                    )
                  })}
                </tr>
              )
            })}
            {/* the next row of the sheet — one click away */}
            <tr data-filter-keep="1">
              <td colSpan={tasks.length * 2 + 1} className="px-2 py-2">
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
        Every bill has an Amount and a Date column — type or pick, Enter or click away saves. Clearing the amount removes the whole cell, date and remark included. ⋯ under an amount holds its Remark. Add, rename or remove a bill in the Bills register above — ✓ saves, ✕ removes.
      </p>
      <datalist id="task-bank-modes">
        {bankModes.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  )
}
