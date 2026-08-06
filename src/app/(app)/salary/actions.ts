'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { upsertPerson, createRun, updateRunLine, approveRun, payRun } from '@/lib/ops/salary'

// Salary register (spec §6.4) — Admin-only.

export async function upsertPersonAction(formData: FormData) {
  const admin = await requireAdmin()

  await auditedTransaction(async (tx) => {
    const person = await upsertPerson(tx, {
      id: String(formData.get('id') ?? '') || null,
      entityId: String(formData.get('entityId') ?? ''),
      name: String(formData.get('name') ?? ''),
      type: String(formData.get('type') ?? 'SALARY') === 'CONSULTANT' ? 'CONSULTANT' : 'SALARY',
      team: String(formData.get('team') ?? '') || null,
      costCentreId: String(formData.get('costCentreId') ?? '') || null,
      monthlyGross: String(formData.get('monthlyGross') ?? ''),
      tdsRate: String(formData.get('tdsRate') ?? '0'),
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'salary.person_upsert',
      targetType: 'SalaryPerson',
      targetId: person.id,
      summary: `${person.name}: ${person.type.toLowerCase()}, gross ₹${person.monthlyGross}, TDS ${person.tdsRate}% (${person.tdsSection})`,
    })
  })
  revalidatePath('/salary')
}

export async function createRunAction(formData: FormData) {
  const admin = await requireAdmin()
  const [year, month] = String(formData.get('month') ?? '').split('-').map(Number)
  if (!year || !month) throw new Error('Pick a month')

  await auditedTransaction(async (tx) => {
    const run = await createRun(tx, {
      entityId: String(formData.get('entityId') ?? ''),
      year,
      month,
      actorId: admin.id,
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'salary.run_create',
      targetType: 'SalaryRun',
      targetId: run.id,
      summary: `Drafted salary run ${year}-${String(month).padStart(2, '0')} (${run.lines.length} people)`,
    })
  })
  revalidatePath('/salary')
}

export async function updateRunLineAction(formData: FormData) {
  await requireAdmin()
  await auditedTransaction((tx) =>
    updateRunLine(tx, {
      lineId: String(formData.get('lineId') ?? ''),
      gross: String(formData.get('gross') ?? ''),
      tds: String(formData.get('tds') ?? ''),
    }),
  )
  revalidatePath('/salary')
}

export async function approveRunAction(formData: FormData) {
  const admin = await requireAdmin()
  const runId = String(formData.get('runId') ?? '')

  await auditedTransaction(async (tx) => {
    const run = await approveRun(tx, { runId, actorId: admin.id })
    await audit(tx, {
      actorId: admin.id,
      action: 'salary.run_approve',
      targetType: 'SalaryRun',
      targetId: run.id,
      summary: `Approved salary run ${run.year}-${String(run.month).padStart(2, '0')} — consolidated posting + TDS task`,
    })
  })
  revalidatePath('/salary')
  revalidatePath('/tasks')
}

export async function payRunAction(formData: FormData) {
  const admin = await requireAdmin()
  const runId = String(formData.get('runId') ?? '')
  const sourceAccountId = String(formData.get('sourceAccountId') ?? '')
  const date = new Date(String(formData.get('date') ?? ''))
  if (!sourceAccountId) throw new Error('Pick the paying account')
  if (isNaN(date.getTime())) throw new Error('Pick a date')

  await auditedTransaction(async (tx) => {
    const run = await payRun(tx, { runId, date, sourceAccountId, actorId: admin.id })
    await audit(tx, {
      actorId: admin.id,
      action: 'salary.run_pay',
      targetType: 'SalaryRun',
      targetId: run.id,
      summary: `Marked salary run ${run.year}-${String(run.month).padStart(2, '0')} paid`,
    })
  })
  revalidatePath('/salary')
}
