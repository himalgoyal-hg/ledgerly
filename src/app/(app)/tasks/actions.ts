'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

// Finance tasks: the sheet's monthly payment checklist. Cells are freeform
// text exactly like the sheet (amount, "Yes", a note) and nothing posts —
// the actual expense reaches the books via statement tagging / cash entries.

const field = (fd: FormData, name: string) => String(fd.get(name) ?? '').trim()

function parseMonth(raw: string): Date {
  const m = /^(\d{4})-(\d{2})$/.exec(raw)
  if (!m) throw new Error('Bad month')
  return new Date(`${raw}-01`)
}

/** Excel-style: the cell is the input. Blank clears, anything else is saved verbatim. */
export async function saveFinanceCellAction(formData: FormData) {
  await requireAdmin()
  const taskId = field(formData, 'taskId')
  const month = parseMonth(field(formData, 'month'))
  const value = field(formData, 'value')
  if (!value) {
    await prisma.financeTaskCell.deleteMany({ where: { taskId, month } })
  } else {
    await prisma.financeTaskCell.upsert({
      where: { taskId_month: { taskId, month } },
      create: { taskId, month, value },
      update: { value },
    })
  }
  revalidatePath('/tasks')
}

/** Add a month row — the picked one, or the next after the latest row. */
export async function addFinanceMonthAction(formData: FormData) {
  await requireAdmin()
  const raw = field(formData, 'month')
  let month: Date
  if (raw) {
    month = parseMonth(raw)
  } else {
    const last = await prisma.financeMonth.findFirst({ orderBy: { month: 'desc' } })
    const base = last?.month ?? new Date()
    month = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1))
  }
  await prisma.financeMonth.upsert({ where: { month }, create: { month }, update: {} })
  revalidatePath('/tasks')
}

export async function createFinanceTaskAction(formData: FormData) {
  await requireAdmin()
  const name = field(formData, 'name')
  if (!name) throw new Error('Task name is required')
  const dueDayRaw = field(formData, 'dueDay')
  const dueDay = dueDayRaw ? Number(dueDayRaw) : null
  if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31))
    throw new Error('Due day must be 1–31')
  const last = await prisma.financeTask.findFirst({ orderBy: { sortOrder: 'desc' } })
  const task = await prisma.financeTask.create({
    data: {
      name,
      account: field(formData, 'account') || null,
      dueDay,
      sortOrder: (last?.sortOrder ?? 0) + 1,
    },
  })
  // Fill-what-you-know: if the first month's value came along, the column
  // is born with its cell filled — same as adding it on the sheet.
  const firstValue = field(formData, 'firstValue')
  const firstMonth = field(formData, 'firstMonth')
  if (firstValue && firstMonth) {
    await prisma.financeTaskCell.create({
      data: { taskId: task.id, month: parseMonth(firstMonth), value: firstValue },
    })
  }
  revalidatePath('/tasks')
}

export async function updateFinanceTaskAction(formData: FormData) {
  await requireAdmin()
  const id = field(formData, 'taskId')
  const name = field(formData, 'name')
  if (!name) throw new Error('Task name is required')
  const dueDayRaw = field(formData, 'dueDay')
  const dueDay = dueDayRaw ? Number(dueDayRaw) : null
  if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31))
    throw new Error('Due day must be 1–31')
  await prisma.financeTask.update({
    where: { id },
    data: { name, account: field(formData, 'account') || null, dueDay },
  })
  revalidatePath('/tasks')
}

/** Archive = the column disappears; its history stays in the DB. */
export async function archiveFinanceTaskAction(formData: FormData) {
  await requireAdmin()
  await prisma.financeTask.update({
    where: { id: field(formData, 'taskId') },
    data: { archivedAt: new Date() },
  })
  revalidatePath('/tasks')
}
