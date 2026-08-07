import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { TASK_KINDS } from '@/lib/ops/tasks'
import { createTaskAction, completeTaskAction, editTaskAction, deleteTaskAction } from './actions'
import { ConfirmButton } from '@/components/confirm-button'

// Finance tasks & reminders (spec §6.5): EMI, subscriptions, payroll,
// GST/TDS payments, renewals — due dates + recurrence. A recurring task
// spawns its next instance on completion.

export default async function TasksPage() {
  const admin = await requireAdmin()
  const entity = await getCurrentEntity(admin)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const today = new Date().toISOString().slice(0, 10)
  const [open, done] = await Promise.all([
    prisma.financeTask.findMany({
      where: { entityId: entity.id, status: 'OPEN' },
      orderBy: { dueDate: 'asc' },
    }),
    prisma.financeTask.findMany({
      where: { entityId: entity.id, status: 'DONE' },
      orderBy: { completedAt: 'desc' },
      take: 15,
    }),
  ])

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900">
        Finance tasks — {entity.name} ({entity.code})
      </h1>

      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">New task</h2>
        <form action={createTaskAction} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="entityId" value={entity.id} />
          <input name="title" required placeholder="Title (Car EMI, GST payment…)" className="flex-1 min-w-48 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <select name="kind" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
            {TASK_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <input name="amount" inputMode="decimal" placeholder="Amount ₹ (optional)" className="w-36 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <input name="dueDate" type="date" required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <select name="recurrence" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
            <option value="NONE">One-time</option>
            <option value="MONTHLY">Monthly</option>
            <option value="QUARTERLY">Quarterly</option>
            <option value="YEARLY">Yearly</option>
          </select>
          <input name="notes" placeholder="Notes" className="w-40 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <button type="submit" className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700">
            Add task
          </button>
        </form>
      </div>

      <div className="space-y-2">
        <h2 className="font-medium text-zinc-900">Open ({open.length})</h2>
        {open.map((task) => {
          const overdue = task.dueDate.toISOString().slice(0, 10) < today
          return (
            <div key={task.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 text-sm shadow-sm">
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-500">
                {task.kind}
              </span>
              <span className="font-medium text-zinc-800">{task.title}</span>
              <span className={`text-xs ${overdue ? 'font-medium text-red-600' : 'text-zinc-400'}`}>
                due {task.dueDate.toISOString().slice(0, 10)}{overdue ? ' — OVERDUE' : ''}
              </span>
              {task.recurrence !== 'NONE' && (
                <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                  {task.recurrence.toLowerCase()}
                </span>
              )}
              {task.notes && <span className="text-xs text-zinc-400">{task.notes}</span>}
              {task.amount !== null && (
                <span className="ml-auto font-semibold text-zinc-900">{displayINR(String(task.amount))}</span>
              )}
              <form action={completeTaskAction} className={task.amount === null ? 'ml-auto' : ''}>
                <input type="hidden" name="taskId" value={task.id} />
                <button type="submit" className="rounded-md bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600">
                  Done
                </button>
              </form>
              <form action={deleteTaskAction}>
                <input type="hidden" name="taskId" value={task.id} />
                <ConfirmButton
                  message={`Delete task "${task.title}"?`}
                  className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  Delete
                </ConfirmButton>
              </form>
              <details className="w-full">
                <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-600">Edit</summary>
                <form action={editTaskAction} className="mt-2 flex flex-wrap items-center gap-2">
                  <input type="hidden" name="taskId" value={task.id} />
                  <input name="title" defaultValue={task.title} required className="w-56 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                  <input name="dueDate" type="date" defaultValue={task.dueDate.toISOString().slice(0, 10)} required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                  <input name="amount" type="number" step="0.01" min="0" defaultValue={task.amount === null ? '' : String(task.amount)} placeholder="Amount (optional)" className="w-36 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                  <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700">
                    Save
                  </button>
                </form>
              </details>
            </div>
          )
        })}
        {open.length === 0 && <p className="text-sm text-zinc-400">No open tasks.</p>}
      </div>

      {done.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-medium text-zinc-900">Recently completed</h2>
          {done.map((task) => (
            <div key={task.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-100 bg-zinc-50 p-3 text-sm text-zinc-500">
              <span>{task.title}</span>
              <span className="text-xs">done {task.completedAt?.toISOString().slice(0, 10)}</span>
              {task.amount !== null && <span className="ml-auto">{displayINR(String(task.amount))}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
