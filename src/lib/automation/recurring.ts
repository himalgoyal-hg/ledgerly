import { prisma } from '@/lib/db'
import { createBill, periodKeyOf } from '@/lib/ops/bills'
import { createTask } from '@/lib/ops/tasks'

// Recurring generators (spec §6.3 "recurring bills auto-generate in
// Pending", §6.5). Paying or completing an item already spawns its
// successor; this fills the other gap — items that come due while the
// previous one is still open. Generation is idempotent: the
// (seriesId, periodKey) unique index means re-running creates nothing new.

/** How far ahead an instance is materialized. */
export const LEAD_DAYS = 14

function addPeriod(date: Date, recurrence: string): Date {
  const next = new Date(date)
  if (recurrence === 'MONTHLY') next.setUTCMonth(next.getUTCMonth() + 1)
  else if (recurrence === 'QUARTERLY') next.setUTCMonth(next.getUTCMonth() + 3)
  else if (recurrence === 'HALF_YEARLY') next.setUTCMonth(next.getUTCMonth() + 6)
  else next.setUTCFullYear(next.getUTCFullYear() + 1)
  return next
}

export interface GenerationResult {
  bills: { id: string; vendor: string; dueDate: Date }[]
  tasks: { id: string; title: string; dueDate: Date }[]
}

/**
 * Materialize recurring bills and tasks whose next occurrence falls inside
 * the lead window. Walks each series forward from its latest instance.
 */
export async function generateRecurring(
  entityId: string,
  actorId: string,
  now = new Date(),
): Promise<GenerationResult> {
  const horizon = new Date(now.getTime() + LEAD_DAYS * 86_400_000)
  const result: GenerationResult = { bills: [], tasks: [] }

  // --- Bills ---
  const billSeries = await prisma.bill.findMany({
    where: { entityId, recurrence: { not: 'NONE' }, seriesId: { not: null } },
    orderBy: { dueDate: 'desc' },
  })
  const latestBill = new Map<string, (typeof billSeries)[number]>()
  for (const bill of billSeries) {
    if (!latestBill.has(bill.seriesId!)) latestBill.set(bill.seriesId!, bill)
  }
  for (const bill of latestBill.values()) {
    let cursor = bill
    // Walk forward until the next due date passes the horizon.
    for (let guard = 0; guard < 24; guard++) {
      const nextDue = addPeriod(cursor.dueDate, cursor.recurrence)
      if (nextDue > horizon) break
      const exists = await prisma.bill.findFirst({
        where: { seriesId: cursor.seriesId, periodKey: periodKeyOf(nextDue) },
      })
      if (exists) {
        cursor = exists
        continue
      }
      const created = await prisma.$transaction((tx) =>
        createBill(tx, {
          entityId,
          vendor: cursor.vendor,
          billType: cursor.billType,
          amount: String(cursor.amount),
          billDate: addPeriod(cursor.billDate, cursor.recurrence),
          dueDate: nextDue,
          renewalDate: cursor.renewalDate ? addPeriod(cursor.renewalDate, cursor.recurrence) : null,
          policyNumber: cursor.policyNumber,
          insuredValue: cursor.insuredValue === null ? null : String(cursor.insuredValue),
          insuredFor: cursor.insuredFor,
          link: cursor.link,
          remarks: cursor.remarks,
          recurrence: cursor.recurrence,
          expenseAccountId: cursor.expenseAccountId,
          costCentreId: cursor.costCentreId,
          gstType: cursor.gstType,
          gstRate: cursor.gstRate === null ? null : String(cursor.gstRate),
          hsn: cursor.hsn,
          vendorGstin: cursor.vendorGstin,
          tdsSection: cursor.tdsSection,
          tdsRate: cursor.tdsRate === null ? null : String(cursor.tdsRate),
          vendorPan: cursor.vendorPan,
          actorId,
          seriesId: cursor.seriesId,
        }),
      )
      result.bills.push({ id: created.id, vendor: created.vendor, dueDate: created.dueDate })
      cursor = created
    }
  }

  // --- Finance tasks ---
  const taskSeries = await prisma.financeTask.findMany({
    where: { entityId, recurrence: { not: 'NONE' }, seriesId: { not: null } },
    orderBy: { dueDate: 'desc' },
  })
  const latestTask = new Map<string, (typeof taskSeries)[number]>()
  for (const task of taskSeries) {
    if (!latestTask.has(task.seriesId!)) latestTask.set(task.seriesId!, task)
  }
  for (const task of latestTask.values()) {
    let cursor = task
    for (let guard = 0; guard < 24; guard++) {
      const nextDue = addPeriod(cursor.dueDate, cursor.recurrence)
      if (nextDue > horizon) break
      const exists = await prisma.financeTask.findFirst({
        where: { seriesId: cursor.seriesId, periodKey: periodKeyOf(nextDue) },
      })
      if (exists) {
        cursor = exists
        continue
      }
      const created = await prisma.$transaction((tx) =>
        createTask(tx, {
          entityId,
          title: cursor.title,
          kind: cursor.kind,
          amount: cursor.amount === null ? null : String(cursor.amount),
          dueDate: nextDue,
          recurrence: cursor.recurrence,
          notes: cursor.notes,
          actorId,
          seriesId: cursor.seriesId,
        }),
      )
      result.tasks.push({ id: created.id, title: created.title, dueDate: created.dueDate })
      cursor = created
    }
  }

  return result
}
