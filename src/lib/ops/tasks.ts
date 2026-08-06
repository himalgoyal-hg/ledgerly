import type { Prisma, FinanceTask } from '@/generated/prisma/client'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { periodKeyOf } from './bills'
import { OpsError } from './reimburse'

// Finance tasks (spec §6.5): EMI, subscriptions, payroll, GST/TDS payments,
// renewals — due dates + recurrence. Completing a recurring task spawns the
// next instance; reminder delivery (email/WhatsApp) arrives with Phase 7.

function addPeriod(date: Date, recurrence: string): Date {
  const next = new Date(date)
  if (recurrence === 'MONTHLY') next.setUTCMonth(next.getUTCMonth() + 1)
  else if (recurrence === 'QUARTERLY') next.setUTCMonth(next.getUTCMonth() + 3)
  else next.setUTCFullYear(next.getUTCFullYear() + 1)
  return next
}

export const TASK_KINDS = ['emi', 'subscription', 'payroll', 'gst', 'tds', 'renewal', 'other'] as const

export async function createTask(
  tx: Prisma.TransactionClient,
  args: {
    entityId: string
    title: string
    kind: string
    amount?: string | null
    dueDate: Date
    recurrence?: 'NONE' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY'
    notes?: string | null
    actorId: string
    seriesId?: string | null
  },
) {
  const title = args.title.trim()
  if (!title) throw new OpsError('Title is required')
  if (!(TASK_KINDS as readonly string[]).includes(args.kind)) throw new OpsError('Unknown task kind')
  const amount =
    args.amount?.trim() ? formatPaise(parsePaise(args.amount.trim())) : null
  const task = await tx.financeTask.create({
    data: {
      entityId: args.entityId,
      title,
      kind: args.kind,
      amount,
      dueDate: args.dueDate,
      recurrence: args.recurrence ?? 'NONE',
      notes: args.notes ?? null,
      seriesId: args.seriesId,
      periodKey: args.seriesId ? periodKeyOf(args.dueDate) : null,
      createdById: args.actorId,
    },
  })
  if ((args.recurrence ?? 'NONE') !== 'NONE' && !args.seriesId) {
    return tx.financeTask.update({
      where: { id: task.id },
      data: { seriesId: task.id, periodKey: periodKeyOf(args.dueDate) },
    })
  }
  return task
}

/** Complete a task; a recurring one spawns its next OPEN instance. */
export async function completeTask(
  tx: Prisma.TransactionClient,
  args: { taskId: string; actorId: string },
): Promise<{ task: FinanceTask; nextTask: FinanceTask | null }> {
  const task = await tx.financeTask.findUniqueOrThrow({ where: { id: args.taskId } })
  if (task.status !== 'OPEN') throw new OpsError('Task is already done')
  const done = await tx.financeTask.update({
    where: { id: task.id },
    data: { status: 'DONE', completedAt: new Date(), completedById: args.actorId },
  })
  let nextTask: FinanceTask | null = null
  if (task.recurrence !== 'NONE') {
    const nextDue = addPeriod(task.dueDate, task.recurrence)
    const exists = await tx.financeTask.findFirst({
      where: { seriesId: task.seriesId, periodKey: periodKeyOf(nextDue) },
    })
    if (!exists) {
      nextTask = await createTask(tx, {
        entityId: task.entityId,
        title: task.title,
        kind: task.kind,
        amount: task.amount === null ? null : String(task.amount),
        dueDate: nextDue,
        recurrence: task.recurrence,
        notes: task.notes,
        actorId: args.actorId,
        seriesId: task.seriesId,
      })
    }
  }
  return { task: done, nextTask }
}
