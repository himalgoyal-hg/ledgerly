import { prisma } from '@/lib/db'
import { displayINR } from '@/lib/ledger/money'
import { profitAndLoss } from '@/lib/reports/statements'
import {
  balanceTiles,
  queueTiles,
  duesTiles,
  receivableTiles,
  balanceAlerts,
} from '@/lib/reports/dashboard'

// Weekly summary (spec §10, auto-emailed Monday) and due reminders
// (spec §6.5). Both render plain text — readable in any mail client and in
// the outbox screen without a renderer.

/** ISO week key, e.g. "2026-W32" — the weekly summary's dedupe key. */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  // ISO: week 1 is the week containing the first Thursday.
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function line(label: string, value: string): string {
  return `  ${label.padEnd(28)}${value}`
}

/** The Monday email: last week's activity and the week ahead. */
export async function weeklySummary(entityId: string, now = new Date()) {
  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } })
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)

  const [pnl, balances, queues, dues, receivables, alerts] = await Promise.all([
    profitAndLoss(entityId, { from: weekAgo, to: now }),
    balanceTiles(entityId),
    queueTiles(entityId),
    duesTiles(entityId, 7),
    receivableTiles(entityId),
    balanceAlerts(entityId),
  ])

  const sections: string[] = []
  sections.push(`Ledgerly weekly summary — ${entity.name} (${entity.code})`)
  sections.push(`Week ending ${now.toISOString().slice(0, 10)}`)

  sections.push('\nLAST 7 DAYS')
  sections.push(line('Income', displayINR(pnl.income.total)))
  sections.push(line('Expenses', displayINR(pnl.expenses.total)))
  sections.push(line(Number(pnl.netProfit) >= 0 ? 'Net profit' : 'Net loss', displayINR(pnl.netProfit)))

  sections.push('\nBALANCES')
  for (const bank of balances.banks) sections.push(line(bank.label, displayINR(bank.balance)))
  if (balances.cash.length > 0) sections.push(line('Cash on hand', displayINR(balances.cashTotal)))
  sections.push(
    line('Total bank + cash', displayINR((Number(balances.bankTotal) + Number(balances.cashTotal)).toFixed(2))),
  )

  sections.push('\nNEEDS ATTENTION')
  sections.push(line('Pending tagging', `${queues.pendingTags} transaction(s)`))
  if (queues.taggedUnposted > 0) {
    sections.push(line('Tagged, not posted', `${queues.taggedUnposted} transaction(s)`))
  }
  if (queues.unconfirmedImports > 0) {
    sections.push(line('Statements to confirm', String(queues.unconfirmedImports)))
  }
  sections.push(
    line('Pending reimbursements', `${queues.pendingClaims} (${displayINR(queues.pendingClaimsAmount)})`),
  )
  if (Number(receivables.overdueTotal) > 0) {
    sections.push(
      line('Overdue receivables', `${displayINR(receivables.overdueTotal)} across ${receivables.overdue.length}`),
    )
  }

  sections.push('\nDUE IN THE NEXT 7 DAYS')
  if (dues.items.length === 0) {
    sections.push('  Nothing due.')
  } else {
    for (const item of dues.items) {
      sections.push(
        line(
          `${item.dueDate.toISOString().slice(0, 10)}  ${item.title}`.slice(0, 46),
          item.amount ? displayINR(item.amount) : '',
        ),
      )
    }
    sections.push(line('Total committed', displayINR(dues.total)))
  }

  if (alerts.length > 0) {
    sections.push('\nALERTS')
    for (const alert of alerts) sections.push(`  ${alert.label}: ${alert.message}`)
  }

  return {
    subject: `Ledgerly weekly — ${entity.code} — week ending ${now.toISOString().slice(0, 10)}`,
    body: sections.join('\n'),
    dedupeKeySuffix: isoWeekKey(now),
  }
}

/** Reminder for one due item (spec §6.5). One message per item per due date. */
export async function dueReminders(entityId: string, now = new Date(), withinDays = 3) {
  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } })
  const dues = await duesTiles(entityId, withinDays)
  return dues.items.map((item) => {
    const due = item.dueDate.toISOString().slice(0, 10)
    const overdue = due < now.toISOString().slice(0, 10)
    return {
      dedupeKey: `due:${item.source}:${item.id}:${due}`,
      subject: `${overdue ? 'OVERDUE' : 'Due'} ${due} — ${item.title} (${entity.code})`,
      body: [
        `${overdue ? 'This is overdue.' : 'This falls due shortly.'}`,
        '',
        line('Item', item.title),
        line('Type', item.kind),
        line('Due date', due),
        ...(item.amount ? [line('Amount', displayINR(item.amount))] : []),
        line('Books', `${entity.name} (${entity.code})`),
        '',
        item.source === 'bill'
          ? 'Open Ledgerly → Bills to record the payment.'
          : 'Open Ledgerly → Tasks to complete it.',
      ].join('\n'),
    }
  })
}
