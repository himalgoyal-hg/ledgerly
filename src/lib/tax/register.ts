import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'

// Tax registers (spec §7): TaxLine rows carry the metadata; the ledger
// carries the money. Register queries exclude rows whose journal doc has
// been deleted, so edits/deletes never leave phantom register entries.

export interface TaxLineInput {
  entityId: string
  docId: string
  date: Date
  direction: 'output' | 'input'
  party?: string | null
  gstType?: string | null
  gstRate?: string | null
  hsn?: string | null
  counterpartyGstin?: string | null
  taxableValue: string
  gstAmount?: string
  tdsSection?: string | null
  tdsRate?: string | null
  deducteePan?: string | null
  tdsAmount?: string
  sourceType: string
  sourceId: string
}

export async function writeTaxLine(tx: Prisma.TransactionClient, input: TaxLineInput) {
  return tx.taxLine.create({
    data: {
      entityId: input.entityId,
      docId: input.docId,
      date: input.date,
      direction: input.direction,
      party: input.party ?? null,
      gstType: input.gstType ?? null,
      gstRate: input.gstRate ?? null,
      hsn: input.hsn ?? null,
      counterpartyGstin: input.counterpartyGstin ?? null,
      taxableValue: input.taxableValue,
      gstAmount: input.gstAmount ?? '0',
      tdsSection: input.tdsSection ?? null,
      tdsRate: input.tdsRate ?? null,
      deducteePan: input.deducteePan ?? null,
      tdsAmount: input.tdsAmount ?? '0',
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    },
  })
}

/**
 * TDS deposit reminder (spec §7.2): due the 7th of the month AFTER the
 * deduction. One OPEN task per entity-month accumulates every deduction.
 */
export async function ensureTdsDepositTask(
  tx: Prisma.TransactionClient,
  args: { entityId: string; deductionDate: Date; amount: string; actorId: string },
) {
  const due = new Date(Date.UTC(
    args.deductionDate.getUTCFullYear(),
    args.deductionDate.getUTCMonth() + 1,
    7,
  ))
  const seriesId = `tds-auto-${args.entityId}`
  const periodKey = due.toISOString().slice(0, 7)
  const existing = await tx.financeTask.findFirst({ where: { seriesId, periodKey } })
  if (existing) {
    if (existing.status === 'OPEN') {
      const total = new Prisma.Decimal(String(existing.amount ?? 0)).plus(args.amount)
      return tx.financeTask.update({
        where: { id: existing.id },
        data: { amount: total.toFixed(2) },
      })
    }
    return existing // already deposited this period — leave it be
  }
  return tx.financeTask.create({
    data: {
      entityId: args.entityId,
      title: `TDS deposit — due ${periodKey}-07`,
      kind: 'tds',
      amount: args.amount,
      dueDate: due,
      seriesId,
      periodKey,
      createdById: args.actorId,
    },
  })
}

export interface PeriodRange {
  from: Date
  to: Date
}

export function monthRange(year: number, month: number): PeriodRange {
  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    to: new Date(Date.UTC(year, month, 0)),
  }
}

/**
 * TaxLines in a period whose journal doc still stands (not deleted).
 * Salary rows key on "<docId>:<lineId>" — the prefix resolves to the doc.
 */
async function liveTaxLines(entityId: string, range: PeriodRange) {
  const lines = await prisma.taxLine.findMany({
    where: { entityId, date: { gte: range.from, lte: range.to } },
    orderBy: { date: 'asc' },
  })
  if (lines.length === 0) return lines
  const baseDocId = (docId: string) => docId.split(':')[0]
  const docs = await prisma.journalDoc.findMany({
    where: { id: { in: [...new Set(lines.map((l) => baseDocId(l.docId)))] }, deletedAt: null },
    select: { id: true },
  })
  const alive = new Set(docs.map((d) => d.id))
  return lines.filter((l) => alive.has(baseDocId(l.docId)))
}

/** GSTR-1 (spec §7.1): outward supplies, invoice-wise + rate-wise totals. */
export async function gstr1Summary(entityId: string, range: PeriodRange) {
  const lines = (await liveTaxLines(entityId, range)).filter(
    (l) => l.direction === 'output' && Number(l.gstAmount) !== 0,
  )
  const byRate = new Map<string, { taxable: Prisma.Decimal; gst: Prisma.Decimal }>()
  for (const line of lines) {
    const key = String(line.gstRate ?? '0')
    const acc = byRate.get(key) ?? { taxable: new Prisma.Decimal(0), gst: new Prisma.Decimal(0) }
    byRate.set(key, {
      taxable: acc.taxable.plus(String(line.taxableValue)),
      gst: acc.gst.plus(String(line.gstAmount)),
    })
  }
  return {
    rows: lines,
    byRate: [...byRate.entries()].map(([rate, t]) => ({
      rate,
      taxable: t.taxable.toFixed(2),
      gst: t.gst.toFixed(2),
    })),
  }
}

/**
 * GSTR-3B view (spec §7.1): output liability vs ITC for the period, straight
 * from the ledger (reversal pairs cancel by construction).
 */
export async function gstr3bView(entityId: string, range: PeriodRange) {
  const sumOn = async (code: string, side: 'credit' | 'debit') => {
    const rows = await prisma.$queryRaw<{ total: string | null }[]>`
      SELECT (COALESCE(SUM(l.credit), 0) - COALESCE(SUM(l.debit), 0))::text as total
      FROM "JournalLine" l
      JOIN "JournalEntry" e ON e.id = l."entryId"
      JOIN "LedgerAccount" a ON a.id = l."accountId"
      WHERE a."entityId" = ${entityId} AND a.code = ${code}
        AND e.date >= ${range.from}::date AND e.date <= ${range.to}::date
    `
    const net = new Prisma.Decimal(rows[0]?.total ?? 0)
    return side === 'credit' ? net : net.negated()
  }
  const output = await sumOn('2210', 'credit') // GST Output Liability grows Cr
  const itc = await sumOn('1500', 'debit') // Input Credit grows Dr
  const net = output.minus(itc)
  return {
    outputLiability: output.toFixed(2),
    inputCredit: itc.toFixed(2),
    netPayable: net.isNegative() ? '0.00' : net.toFixed(2),
    refundable: net.isNegative() ? net.negated().toFixed(2) : '0.00',
  }
}

/** TDS register (spec §7.2): by section, then deductee. */
export async function tdsRegister(entityId: string, range: PeriodRange) {
  const lines = (await liveTaxLines(entityId, range)).filter((l) => Number(l.tdsAmount) !== 0)
  const sections = new Map<
    string,
    { deductees: Map<string, { taxable: Prisma.Decimal; tds: Prisma.Decimal; pan: string | null }>; total: Prisma.Decimal }
  >()
  for (const line of lines) {
    const section = line.tdsSection ?? '?'
    const entry = sections.get(section) ?? { deductees: new Map(), total: new Prisma.Decimal(0) }
    const name = line.party ?? '(unknown)'
    const acc = entry.deductees.get(name) ?? {
      taxable: new Prisma.Decimal(0),
      tds: new Prisma.Decimal(0),
      pan: line.deducteePan,
    }
    entry.deductees.set(name, {
      taxable: acc.taxable.plus(String(line.taxableValue)),
      tds: acc.tds.plus(String(line.tdsAmount)),
      pan: acc.pan ?? line.deducteePan,
    })
    entry.total = entry.total.plus(String(line.tdsAmount))
    sections.set(section, entry)
  }
  return [...sections.entries()].map(([section, entry]) => ({
    section,
    total: entry.total.toFixed(2),
    deductees: [...entry.deductees.entries()].map(([name, d]) => ({
      name,
      pan: d.pan,
      taxable: d.taxable.toFixed(2),
      tds: d.tds.toFixed(2),
    })),
  }))
}
