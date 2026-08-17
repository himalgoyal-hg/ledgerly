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

export async function createFinanceTaskAction(formData: FormData) {
  await requireAdmin()
  const name = field(formData, 'name')
  if (!name) throw new Error('Task name is required')
  const dueDayRaw = field(formData, 'dueDay')
  const dueDay = dueDayRaw ? Number(dueDayRaw) : null
  if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31))
    throw new Error('Due day must be 1–31')
  const last = await prisma.financeTask.findFirst({ orderBy: { sortOrder: 'desc' } })
  await prisma.financeTask.create({
    data: {
      name,
      account: field(formData, 'account') || null,
      dueDay,
      sortOrder: (last?.sortOrder ?? 0) + 1,
    },
  })
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
