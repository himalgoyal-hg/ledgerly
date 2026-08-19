import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { createJournalDocument, type LineInput } from '@/lib/ledger/posting'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { OpsError } from './reimburse'

// Cash management (spec §6.2): receipt / payment / inter-location transfer /
// adjustment (mandatory reason, flagged in audit). "Where is cash" is a live
// query over the cash-location ledger accounts.

export async function createCashEntry(
  tx: Prisma.TransactionClient,
  args: {
    entityId: string
    kind: 'RECEIPT' | 'PAYMENT' | 'TRANSFER' | 'ADJUSTMENT'
    date: Date
    locationId: string
    toLocationId?: string | null
    headAccountId?: string | null
    costCentreId?: string | null
    /** 2nd tagging type — Yes sends the head line to the separate-report lens. */
    separateReport?: boolean
    inflow?: boolean
    amount: string
    remarks?: string | null
    reason?: string | null
    actorId: string
  },
) {
  if (parsePaise(args.amount) <= 0n) throw new OpsError('Amount must be positive')
  const amount = formatPaise(parsePaise(args.amount))
  const location = await tx.cashLocation.findUniqueOrThrow({ where: { id: args.locationId } })
  if (location.entityId !== args.entityId || location.archivedAt || !location.ledgerAccountId) {
    throw new OpsError('Invalid cash location')
  }
  // v2 prototype: a blank cost centre falls back to the head's default.
  let ccId = args.costCentreId ?? null
  if (!ccId && args.headAccountId) {
    const head = await tx.ledgerAccount.findUnique({ where: { id: args.headAccountId } })
    if (head?.defaultCostCentreId) {
      const dc = await tx.costCentre.findUnique({ where: { id: head.defaultCostCentreId } })
      if (dc && dc.entityId === args.entityId && !dc.archivedAt) ccId = dc.id
    }
  }
  const cc = ccId ?? undefined
  // the 2nd tag rides the head line only — the cash-location line stays unmarked
  const sep = args.separateReport ?? false

  let lines: LineInput[]
  let summary: string
  switch (args.kind) {
    case 'RECEIPT': {
      if (!args.headAccountId) throw new OpsError('Pick where the cash came from')
      lines = [
        { accountId: location.ledgerAccountId, debit: amount },
        { accountId: args.headAccountId, credit: amount, costCentreId: cc, separateReport: sep },
      ]
      summary = `Cash receipt — ${location.name}`
      break
    }
    case 'PAYMENT': {
      if (!args.headAccountId) throw new OpsError('Pick what the cash paid for')
      lines = [
        { accountId: args.headAccountId, debit: amount, costCentreId: cc, separateReport: sep },
        { accountId: location.ledgerAccountId, credit: amount },
      ]
      summary = `Cash payment — ${location.name}`
      break
    }
    case 'TRANSFER': {
      if (!args.toLocationId) throw new OpsError('Pick the destination location')
      if (args.toLocationId === args.locationId) throw new OpsError('Transfer needs two different locations')
      const to = await tx.cashLocation.findUniqueOrThrow({ where: { id: args.toLocationId } })
      if (to.entityId !== args.entityId || to.archivedAt || !to.ledgerAccountId) {
        throw new OpsError('Invalid destination location')
      }
      lines = [
        { accountId: to.ledgerAccountId, debit: amount },
        { accountId: location.ledgerAccountId, credit: amount },
      ]
      summary = `Cash transfer — ${location.name} → ${to.name}`
      break
    }
    case 'ADJUSTMENT': {
      // Spec §6.2: adjustments carry a mandatory reason and are audit-flagged.
      if (!args.reason?.trim()) throw new OpsError('Adjustments require a reason')
      if (!args.headAccountId) throw new OpsError('Pick the adjustment head')
      lines = args.inflow
        ? [
            { accountId: location.ledgerAccountId, debit: amount },
            { accountId: args.headAccountId, credit: amount, costCentreId: cc, separateReport: sep },
          ]
        : [
            { accountId: args.headAccountId, debit: amount, costCentreId: cc, separateReport: sep },
            { accountId: location.ledgerAccountId, credit: amount },
          ]
      summary = `Cash adjustment — ${location.name} (${args.reason.trim()})`
      break
    }
  }

  const { doc } = await createJournalDocument(tx, {
    entityId: args.entityId,
    sourceType: 'cash_entry',
    actorId: args.actorId,
    content: { date: args.date, narration: summary, lines },
  })
  const entry = await tx.cashEntry.create({
    data: {
      entityId: args.entityId,
      kind: args.kind,
      date: args.date,
      locationId: args.locationId,
      toLocationId: args.toLocationId ?? null,
      headAccountId: args.headAccountId ?? null,
      costCentreId: args.costCentreId ?? null,
      separateReport: sep,
      inflow: args.kind === 'RECEIPT' || (args.kind === 'ADJUSTMENT' && Boolean(args.inflow)),
      amount,
      remarks: args.remarks ?? null,
      reason: args.reason?.trim() || null,
      docId: doc.id,
      createdById: args.actorId,
    },
  })
  await tx.journalDoc.update({ where: { id: doc.id }, data: { sourceId: entry.id } })
  return entry
}

export interface CashBalanceRow {
  locationId: string
  name: string
  archived: boolean
  balance: string
}

/** "Where is cash" (spec §6.2): live balance per location + total. */
export async function cashBalances(entityId: string) {
  const locations = await prisma.cashLocation.findMany({
    where: { entityId },
    orderBy: { name: 'asc' },
  })
  const ids = locations.map((l) => l.ledgerAccountId).filter((x): x is string => x !== null)
  const rows = ids.length
    ? await prisma.$queryRaw<{ accountId: string; balance: string }[]>`
        SELECT l."accountId", (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0))::text as balance
        FROM "JournalLine" l WHERE l."accountId" IN (${Prisma.join(ids)})
        GROUP BY l."accountId"
      `
    : []
  const byAccount = new Map(rows.map((r) => [r.accountId, r.balance]))
  let total = new Prisma.Decimal(0)
  const perLocation: CashBalanceRow[] = locations.map((l) => {
    const balance = new Prisma.Decimal(
      (l.ledgerAccountId && byAccount.get(l.ledgerAccountId)) ?? 0,
    )
    total = total.plus(balance)
    return {
      locationId: l.id,
      name: l.name,
      archived: l.archivedAt !== null,
      balance: balance.toFixed(2),
    }
  })
  return { perLocation, total: total.toFixed(2) }
}
