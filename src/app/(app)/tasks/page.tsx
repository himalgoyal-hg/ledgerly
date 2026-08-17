import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { ConfirmButton } from '@/components/confirm-button'
import {
  saveFinanceCellAction,
  createFinanceTaskAction,
  updateFinanceTaskAction,
  archiveFinanceTaskAction,
} from './actions'

// Finance tasks — Himal's sheet, as a screen: columns are the recurring
// payments (with paying account + due day), rows are months, and each cell
// IS an input — type the amount/"Yes"/note, Enter, saved. Nothing posts;
// the checklist just tracks that the payment happened.

const inputCls = 'rounded-md border border-zinc-300 px-2 py-1.5 text-sm'

const ord = (d: number) => {
  const s = ['th', 'st', 'nd', 'rd'][d % 100 > 10 && d % 100 < 14 ? 0 : Math.min(d % 10, 4) % 4] ?? 'th'
  return `${d}${s}`
}

export default async function FinanceTasksPage() {
  await requireAdmin()

  const tasks = await prisma.financeTask.findMany({
    where: { archivedAt: null },
    orderBy: { sortOrder: 'asc' },
    include: { cells: true },
  })

  // cell lookup: taskId → month key (yyyy-mm) → value
  const cellMap = new Map<string, Map<string, string>>()
  let minKey = '2025-12'
  for (const t of tasks) {
    const m = new Map<string, string>()
    for (const c of t.cells) {
      const key = c.month.toISOString().slice(0, 7)
      m.set(key, c.value)
      if (key < minKey) minKey = key
    }
    cellMap.set(t.id, m)
  }

  // months: earliest cell → 2 months past today (the sheet's rolling year)
  const now = new Date()
  const nowKey = now.toISOString().slice(0, 7)
  const months: string[] = []
  const cursor = new Date(`${minKey}-01T00:00:00Z`)
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1))
  while (cursor <= end) {
    months.push(cursor.toISOString().slice(0, 7))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }

  const monthLabel = (key: string) =>
    new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: '2-digit', timeZone: 'UTC' })

  // this month's checklist: every task with a due day, done or waiting
  const dueTasks = tasks
    .filter((t) => t.dueDay !== null)
    .map((t) => ({ task: t, value: cellMap.get(t.id)?.get(nowKey) ?? null }))
  const pendingCount = dueTasks.filter((d) => !d.value).length

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Finance tasks</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Monthly payment checklist — fill the cell (amount / Yes / note) when a payment is done. Nothing posts from here.
        </p>
      </div>

      {/* This month at a glance — the reason the sheet exists */}
      <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
        <h2 className="text-sm font-medium text-zinc-900">
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
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : (task.dueDay ?? 32) <= now.getDate()
                      ? 'border-amber-300 bg-amber-50 text-amber-800'
                      : 'border-zinc-200 bg-zinc-50 text-zinc-600'
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
      <details className="rounded-xl border border-zinc-200 bg-white shadow-sm">
        <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50">
          ＋ New bill / task (a new column in the register)
        </summary>
        <form action={createFinanceTaskAction} className="border-t border-zinc-100 p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Bill / task *</span>
              <input name="name" required placeholder="New EMI Rs. 12,000 / Netflix…" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Paid from</span>
              <input name="account" placeholder="7838 account / MG Axis bank / cash" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Due day</span>
              <input name="dueDay" inputMode="numeric" placeholder="7" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Month (optional)</span>
              <input name="firstMonth" type="month" defaultValue={nowKey} className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Amount / note (optional)</span>
              <input name="firstValue" placeholder="₹12,000 / Yes" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <div className="flex items-end">
              <button type="submit" className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700">
                Add
              </button>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-zinc-400">
            Fill what you have — name is enough; amount आणि बाकी cells नंतर grid मध्येच भरता येतात.
          </p>
        </form>
      </details>

      {/* The register — the sheet itself: months × tasks, every cell an input */}
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm" style={{ minWidth: `${10 + tasks.length * 9}rem` }}>
          <thead>
            <tr className="border-b border-zinc-200 align-bottom text-[10px] uppercase tracking-wider text-zinc-400">
              <th className="sticky left-0 z-10 bg-white px-2 py-2">Month</th>
              {tasks.map((t) => (
                <th key={t.id} className="px-1.5 py-2 font-medium">
                  <div className="normal-case tracking-normal">
                    <div className="text-[10px] text-zinc-400">
                      {t.account ?? ' '}
                      {t.dueDay ? ` · due ${ord(t.dueDay)}` : ''}
                    </div>
                    <div className="mt-0.5 flex items-start gap-1 text-xs font-semibold text-zinc-700">
                      <span>{t.name}</span>
                      {/* header ✎ — edit the column in place */}
                      <details className="relative">
                        <summary className="cursor-pointer list-none text-zinc-300 hover:text-zinc-600">✎</summary>
                        <div className="absolute left-0 top-5 z-20 w-56 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg">
                          <form action={updateFinanceTaskAction} className="space-y-1.5">
                            <input type="hidden" name="taskId" value={t.id} />
                            <input name="name" defaultValue={t.name} required className={`w-full ${inputCls}`} />
                            <input name="account" defaultValue={t.account ?? ''} placeholder="Paid from" className={`w-full ${inputCls}`} />
                            <input name="dueDay" defaultValue={t.dueDay ?? ''} inputMode="numeric" placeholder="Due day" className={`w-full ${inputCls}`} />
                            <button type="submit" className="w-full rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-700">
                              Save
                            </button>
                          </form>
                          <form action={archiveFinanceTaskAction} className="mt-1">
                            <input type="hidden" name="taskId" value={t.id} />
                            <ConfirmButton
                              message={`Remove "${t.name}" from the register? History stays in the database.`}
                              className="w-full rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
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
                  className={`border-b border-zinc-100 align-top ${isNow ? 'bg-amber-50/40' : mk > nowKey ? 'text-zinc-400' : ''}`}
                >
                  <td className={`sticky left-0 z-10 whitespace-nowrap px-2 py-1 text-xs font-medium ${isNow ? 'bg-amber-50 text-amber-900' : 'bg-white text-zinc-700'}`}>
                    {monthLabel(mk)}
                    {isNow && <span className="ml-1 text-[9px] uppercase text-amber-600">now</span>}
                  </td>
                  {tasks.map((t) => {
                    const value = cellMap.get(t.id)?.get(mk) ?? ''
                    const overdue = isNow && !value && t.dueDay !== null && t.dueDay <= now.getDate()
                    return (
                      <td key={t.id} className={`px-0.5 py-0.5 ${overdue ? 'bg-amber-100/60' : ''}`}>
                        {/* Excel-style: the cell IS the input — type, Enter, saved; blank clears */}
                        <form action={saveFinanceCellAction}>
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="hidden" name="month" value={mk} />
                          <input
                            name="value"
                            defaultValue={value}
                            title={value || (overdue ? `Due ${ord(t.dueDay!)} — pending` : 'Type and press Enter to save')}
                            placeholder={overdue ? `due ${ord(t.dueDay!)}` : ''}
                            className={`w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-xs tabular-nums hover:border-zinc-300 focus:border-zinc-400 focus:bg-white focus:outline-none ${overdue ? 'placeholder:text-amber-600' : ''}`}
                          />
                        </form>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-zinc-400">
        Cell मध्ये type करून Enter — save. रिकामं केलं की clear. ✎ ने column edit, ＋ ने नवीन task.
      </p>
    </div>
  )
}
