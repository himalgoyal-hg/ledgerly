'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { createTask, completeTask } from '@/lib/ops/tasks'

// Finance tasks (spec §6.5) — Admin-only.

export async function createTaskAction(formData: FormData) {
  const admin = await requireAdmin()
  const dueDate = new Date(String(formData.get('dueDate') ?? ''))
  if (isNaN(dueDate.getTime())) throw new Error('Pick a due date')

  await auditedTransaction(async (tx) => {
    const task = await createTask(tx, {
      entityId: String(formData.get('entityId') ?? ''),
      title: String(formData.get('title') ?? ''),
      kind: String(formData.get('kind') ?? 'other'),
      amount: String(formData.get('amount') ?? '') || null,
      dueDate,
      recurrence: String(formData.get('recurrence') ?? 'NONE') as
        | 'NONE' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY',
      notes: String(formData.get('notes') ?? '') || null,
      actorId: admin.id,
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'task.create',
      targetType: 'FinanceTask',
      targetId: task.id,
      summary: `Task "${task.title}" due ${dueDate.toISOString().slice(0, 10)}`,
    })
  })
  revalidatePath('/tasks')
}

export async function completeTaskAction(formData: FormData) {
  const admin = await requireAdmin()
  const taskId = String(formData.get('taskId') ?? '')

  await auditedTransaction(async (tx) => {
    const { task, nextTask } = await completeTask(tx, { taskId, actorId: admin.id })
    await audit(tx, {
      actorId: admin.id,
      action: 'task.complete',
      targetType: 'FinanceTask',
      targetId: task.id,
      summary: `Completed "${task.title}"${nextTask ? ` — next due ${nextTask.dueDate.toISOString().slice(0, 10)}` : ''}`,
    })
  })
  revalidatePath('/tasks')
}

/** Edit an open task's title, due date or amount. */
export async function editTaskAction(formData: FormData) {
  const admin = await requireAdmin()
  const taskId = String(formData.get('taskId') ?? '')
  const title = String(formData.get('title') ?? '').trim()
  const dueDate = new Date(String(formData.get('dueDate') ?? ''))
  const amountRaw = String(formData.get('amount') ?? '').trim()
  if (!title) throw new Error('Title is required')
  if (isNaN(dueDate.getTime())) throw new Error('Pick a due date')

  await auditedTransaction(async (tx) => {
    const task = await tx.financeTask.findUniqueOrThrow({ where: { id: taskId } })
    if (task.status !== 'OPEN') throw new Error('Only open tasks can be edited')
    await tx.financeTask.update({
      where: { id: taskId },
      data: { title, dueDate, amount: amountRaw ? amountRaw : null },
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'task.edit',
      targetType: 'FinanceTask',
      targetId: taskId,
      summary: `Edited task "${task.title}"`,
      before: { title: task.title, dueDate: task.dueDate, amount: task.amount ? String(task.amount) : null },
      after: { title, dueDate, amount: amountRaw || null },
    })
  })
  revalidatePath('/tasks')
  revalidatePath('/')
}

/** Delete a task. Tasks never post to the ledger, so this is a plain removal. */
export async function deleteTaskAction(formData: FormData) {
  const admin = await requireAdmin()
  const taskId = String(formData.get('taskId') ?? '')

  await auditedTransaction(async (tx) => {
    const task = await tx.financeTask.findUniqueOrThrow({ where: { id: taskId } })
    await tx.financeTask.delete({ where: { id: taskId } })
    await audit(tx, {
      actorId: admin.id,
      action: 'task.delete',
      targetType: 'FinanceTask',
      targetId: taskId,
      summary: `Deleted task "${task.title}"`,
      before: { title: task.title, kind: task.kind, dueDate: task.dueDate, status: task.status },
    })
  })
  revalidatePath('/tasks')
  revalidatePath('/')
}
