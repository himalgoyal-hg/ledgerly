import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { accountBalances } from '@/lib/ledger/queries'
import { agingBucket } from '@/lib/ops/invoices'

// Overview dashboard data (spec §9). Every figure is a live query; each
// loader is independent so a screen can fetch only what the viewer may see.

/** Bank + cash balances for an entity, per account and total. */
export async function balanceTiles(entityId: string) {
  const [bankAccounts, cashLocations] = await Promise.all([
    prisma.bankAccount.findMany({
      where: { entityId, archivedAt: null, ledgerAccountId: { not: null } },
      orderBy: { nickname: 'asc' },
    }),
    prisma.cashLocation.findMany({
      where: { entityId, archivedAt: null, ledgerAccountId: { not: null } },
      orderBy: { name: 'asc' },
    }),
  ])
  const balances = await accountBalances([
    ...bankAccounts.map((a) => a.ledgerAccountId!),
    ...cashLocations.map((l) => l.ledgerAccountId!),
  ])
  const banks = bankAccounts.map((a) => ({
    id: a.id,
    accountId: a.ledgerAccountId!,
    label: a.nickname,
    balance: balances.get(a.ledgerAccountId!) ?? '0.00',
  }))
  const cash = cashLocations.map((l) => ({
    id: l.id,
    accountId: l.ledgerAccountId!,
    label: l.name,
    balance: balances.get(l.ledgerAccountId!) ?? '0.00',
  }))
  const sum = (rows: { balance: string }[]) =>
    rows.reduce((t, r) => t.plus(r.balance), new Prisma.Decimal(0)).toFixed(2)
  return { banks, cash, bankTotal: sum(banks), cashTotal: sum(cash) }
}

/** Work waiting on people: tagging queue, unconfirmed imports, claims. */
export async function queueTiles(entityId: string) {
  const [pendingTags, taggedUnposted, unconfirmedImports, claims] = await Promise.all([
    prisma.statementTransaction.count({ where: { entityId, status: 'PENDING' } }),
    prisma.statementTransaction.count({ where: { entityId, status: 'TAGGED' } }),
    prisma.statementImport.count({ where: { entityId, status: 'DETECTED' } }),
    prisma.reimbursement.aggregate({
      where: { entityId, status: 'PENDING' },
      _count: true,
      _sum: { amount: true },
    }),
  ])
  return {
    pendingTags,
    taggedUnposted,
    unconfirmedImports,
    pendingClaims: claims._count,
    pendingClaimsAmount: new Prisma.Decimal(String(claims._sum.amount ?? 0)).toFixed(2),
  }
}

/** Upcoming dues within N days, plus anything already overdue (spec §9). */
export async function duesTiles(entityId: string, withinDays = 7) {
  const today = new Date()
  const horizon = new Date(today.getTime() + withinDays * 86_400_000)
  const [tasks, bills] = await Promise.all([
    prisma.financeTask.findMany({
      where: { entityId, status: 'OPEN', dueDate: { lte: horizon } },
      orderBy: { dueDate: 'asc' },
      take: 10,
    }),
    prisma.bill.findMany({
      where: { entityId, status: 'PENDING', dueDate: { lte: horizon } },
      orderBy: { dueDate: 'asc' },
      take: 10,
    }),
  ])
  const items = [
    ...tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      dueDate: t.dueDate,
      amount: t.amount === null ? null : new Prisma.Decimal(String(t.amount)).toFixed(2),
      source: 'task' as const,
    })),
    ...bills.map((b) => ({
      id: b.id,
      kind: b.billType,
      title: `${b.vendor} — ${b.billType}`,
      dueDate: b.dueDate,
      amount: new Prisma.Decimal(String(b.amount))
        .plus(String(b.gstAmount))
        .minus(String(b.tdsAmount))
        .toFixed(2),
      source: 'bill' as const,
    })),
  ].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())

  const todayStr = today.toISOString().slice(0, 10)
  const total = items.reduce((t, i) => t.plus(i.amount ?? 0), new Prisma.Decimal(0))
  return {
    items,
    total: total.toFixed(2),
    overdueCount: items.filter((i) => i.dueDate.toISOString().slice(0, 10) < todayStr).length,
  }
}

/** Overdue receivables with aging (spec §9). */
export async function receivableTiles(entityId: string) {
  const invoices = await prisma.invoice.findMany({
    where: { entityId, status: { in: ['OPEN', 'PARTIAL'] } },
    include: { payments: true },
    orderBy: { dueDate: 'asc' },
  })
  const today = new Date()
  const rows = invoices.map((invoice) => {
    const paid = invoice.payments.reduce(
      (sum, p) => sum.plus(String(p.amount)),
      new Prisma.Decimal(0),
    )
    return {
      id: invoice.id,
      number: invoice.number,
      customer: invoice.customer,
      dueDate: invoice.dueDate,
      outstanding: new Prisma.Decimal(String(invoice.amount)).minus(paid).toFixed(2),
      bucket: agingBucket(invoice.dueDate, today),
    }
  })
  const overdue = rows.filter((r) => r.bucket !== 'current')
  return {
    overdue,
    outstandingTotal: rows.reduce((t, r) => t.plus(r.outstanding), new Prisma.Decimal(0)).toFixed(2),
    overdueTotal: overdue.reduce((t, r) => t.plus(r.outstanding), new Prisma.Decimal(0)).toFixed(2),
  }
}

/**
 * Low-balance alerts (spec §9, groundwork for §8): an account is flagged
 * when its balance cannot cover what is committed against it in the next
 * 7 days. Full source-suggestion logic lands with Phase 7.
 */
export async function balanceAlerts(entityId: string) {
  const [{ banks, bankTotal }, dues] = await Promise.all([
    balanceTiles(entityId),
    duesTiles(entityId, 7),
  ])
  const committed = new Prisma.Decimal(dues.total)
  const total = new Prisma.Decimal(bankTotal)
  const alerts: { label: string; message: string }[] = []
  if (committed.greaterThan(0) && total.lessThan(committed)) {
    alerts.push({
      label: 'Funding shortfall',
      message: `Commitments due in 7 days (${committed.toFixed(2)}) exceed total bank balance (${total.toFixed(2)}).`,
    })
  }
  for (const bank of banks) {
    if (new Prisma.Decimal(bank.balance).isNegative()) {
      alerts.push({ label: bank.label, message: `Overdrawn by ${bank.balance.replace('-', '')}.` })
    }
  }
  return alerts
}

/** Recent activity across every module — straight from the audit trail. */
export async function recentActivity(limit = 8) {
  const rows = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { actor: { select: { name: true } } },
  })
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    summary: r.summary,
    actor: r.actor?.name ?? 'System',
    at: r.createdAt,
  }))
}
