import { prisma } from '@/lib/db'
import { audit, auditedTransaction } from '@/lib/audit'
import { generateRecurring } from './recurring'
import { queueNotification, deliverQueued, notificationRecipients } from './notify'
import { weeklySummary, dueReminders, isoWeekKey } from './weekly'
import { balanceAlerts } from '@/lib/reports/dashboard'

// The automation job (spec §6.5, §8.4, §10). One entry point runs every
// recurring piece of work; it is idempotent, so calling it twice in a day
// changes nothing the second time. Trigger it from cron (see /api/automation/run)
// or the "Run now" button on the admin screen.

export interface JobReport {
  ranAt: string
  entities: {
    entity: string
    billsCreated: number
    tasksCreated: number
    remindersQueued: number
    alertsQueued: number
    weeklyQueued: boolean
  }[]
  delivery: { sent: number; failed: number; stillQueued: number; reason?: string }
}

/**
 * @param force  queue the weekly summary regardless of the day — the admin's
 *               "Run now" uses it; cron leaves it off so Monday governs.
 */
export async function runAutomation(args: {
  actorId: string
  now?: Date
  force?: boolean
}): Promise<JobReport> {
  const now = args.now ?? new Date()
  const isMonday = now.getUTCDay() === 1
  const recipients = await notificationRecipients()
  const entities = await prisma.entity.findMany({ where: { archivedAt: null } })
  const report: JobReport['entities'] = []

  for (const entity of entities) {
    // 1. Materialize recurring bills and tasks coming due.
    const generated = await generateRecurring(entity.id, args.actorId, now)

    // 2. Queue reminders for what falls due shortly.
    let remindersQueued = 0
    for (const reminder of await dueReminders(entity.id, now)) {
      for (const recipient of recipients) {
        const queued = await queueNotification({
          entityId: entity.id,
          kind: 'due_reminder',
          channel: 'email',
          recipient,
          subject: reminder.subject,
          body: reminder.body,
          dedupeKey: `${reminder.dedupeKey}:${recipient}`,
        })
        if (queued) remindersQueued++
      }
    }

    // 3. Low-balance / funding alerts (spec §8.4) — one per alert per day.
    let alertsQueued = 0
    const day = now.toISOString().slice(0, 10)
    for (const alert of await balanceAlerts(entity.id)) {
      for (const recipient of recipients) {
        const queued = await queueNotification({
          entityId: entity.id,
          kind: 'low_balance',
          channel: 'email',
          recipient,
          subject: `Ledgerly alert — ${alert.label} (${entity.code})`,
          body: `${alert.label}: ${alert.message}\n\nBooks: ${entity.name} (${entity.code})`,
          dedupeKey: `alert:${entity.id}:${alert.label}:${day}:${recipient}`,
        })
        if (queued) alertsQueued++
      }
    }

    // 4. Weekly summary — Mondays (spec §10), once per ISO week.
    let weeklyQueued = false
    if (isMonday || args.force) {
      const summary = await weeklySummary(entity.id, now)
      for (const recipient of recipients) {
        const queued = await queueNotification({
          entityId: entity.id,
          kind: 'weekly_summary',
          channel: 'email',
          recipient,
          subject: summary.subject,
          body: summary.body,
          dedupeKey: `weekly:${entity.id}:${isoWeekKey(now)}:${recipient}`,
        })
        if (queued) weeklyQueued = true
      }
    }

    report.push({
      entity: entity.code,
      billsCreated: generated.bills.length,
      tasksCreated: generated.tasks.length,
      remindersQueued,
      alertsQueued,
      weeklyQueued,
    })
  }

  // 5. Deliver whatever is queued.
  const delivery = await deliverQueued()

  const totals = report.reduce(
    (t, r) => ({
      bills: t.bills + r.billsCreated,
      tasks: t.tasks + r.tasksCreated,
      messages: t.messages + r.remindersQueued + r.alertsQueued,
    }),
    { bills: 0, tasks: 0, messages: 0 },
  )
  if (totals.bills || totals.tasks || totals.messages || delivery.sent) {
    await auditedTransaction((tx) =>
      audit(tx, {
        actorId: args.actorId,
        action: 'automation.run',
        targetType: 'System',
        targetId: 'automation',
        summary: `Automation: ${totals.bills} bill(s), ${totals.tasks} task(s) generated; ${totals.messages} message(s) queued; ${delivery.sent} sent`,
        after: { entities: report, delivery },
      }),
    )
  }

  return { ranAt: now.toISOString(), entities: report, delivery }
}
