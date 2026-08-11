import { Prisma } from '@/generated/prisma/client'
import { COA } from '@/lib/ledger/coa'
import { createJournalDocument, type LineInput } from '@/lib/ledger/posting'
import { parsePaise, formatPaise } from '@/lib/ledger/money'
import { writeTaxLine } from '@/lib/tax/register'
import { getPartyAccount } from './party'
import { OpsError } from './reimburse'

// Salary register (spec §6.4): people masters (Salary / Consultants), then a
// monthly run — draft (variables editable) → Admin approves (ONE consolidated
// posting: Dr expense by cost centre / Cr per-person payables + Cr TDS
// Payable) → mark-paid (Dr payables / Cr Bank) → TDS deposit becomes a
// Finance Task due the 7th of the next month.

export async function upsertPerson(
  tx: Prisma.TransactionClient,
  args: {
    id?: string | null
    entityId: string
    name: string
    type: 'SALARY' | 'CONSULTANT'
    team?: string | null
    costCentreId?: string | null
    monthlyGross: string
    tdsRate: string // %
  },
) {
  const name = args.name.trim()
  if (!name) throw new OpsError('Name is required')
  if (parsePaise(args.monthlyGross) <= 0n) throw new OpsError('Monthly gross must be positive')
  const rate = Number(args.tdsRate)
  if (!Number.isFinite(rate) || rate < 0 || rate > 50) throw new OpsError('TDS rate must be 0–50%')
  const payable = await getPartyAccount(
    tx, args.entityId, COA.PAYABLES_GROUP, `Payable — ${name}`,
  )
  const data = {
    entityId: args.entityId,
    name,
    type: args.type,
    team: args.team?.trim() || null,
    costCentreId: args.costCentreId ?? null,
    monthlyGross: formatPaise(parsePaise(args.monthlyGross)),
    tdsSection: args.type === 'SALARY' ? '192' : '194J',
    tdsRate: args.tdsRate,
    payableAccountId: payable.id,
  }
  if (args.id) return tx.salaryPerson.update({ where: { id: args.id }, data })
  return tx.salaryPerson.create({ data })
}

/** Draft the month's run: one line per active person, gross/TDS pre-filled. */
export async function createRun(
  tx: Prisma.TransactionClient,
  args: { entityId: string; year: number; month: number; actorId: string },
) {
  const people = await tx.salaryPerson.findMany({
    where: { entityId: args.entityId, archivedAt: null },
    orderBy: { name: 'asc' },
  })
  if (people.length === 0) throw new OpsError('Add people to the register first')
  return tx.salaryRun.create({
    data: {
      entityId: args.entityId,
      year: args.year,
      month: args.month,
      createdById: args.actorId,
      lines: {
        create: people.map((p) => {
          const gross = parsePaise(String(p.monthlyGross))
          // paise-accurate percentage, rounded to the nearest paisa
          const tds = (gross * BigInt(Math.round(Number(p.tdsRate) * 100)) + 5000n) / 10000n
          return {
            personId: p.id,
            gross: formatPaise(gross),
            tds: formatPaise(tds),
            net: formatPaise(gross - tds),
            costCentreId: p.costCentreId,
          }
        }),
      },
    },
    include: { lines: true },
  })
}

/** HR fills variables (spec §6.4): update one draft line's gross/TDS. */
export async function updateRunLine(
  tx: Prisma.TransactionClient,
  args: { lineId: string; gross: string; tds: string },
) {
  const line = await tx.salaryRunLine.findUniqueOrThrow({
    where: { id: args.lineId },
    include: { run: true },
  })
  if (line.run.status !== 'DRAFT') throw new OpsError('Run is already approved')
  const gross = parsePaise(args.gross)
  const tds = parsePaise(args.tds)
  if (gross <= 0n || tds < 0n || tds > gross) throw new OpsError('Invalid gross/TDS amounts')
  return tx.salaryRunLine.update({
    where: { id: line.id },
    data: { gross: formatPaise(gross), tds: formatPaise(tds), net: formatPaise(gross - tds) },
  })
}

/** Admin approve: the consolidated posting, dated last day of the month. */
export async function approveRun(
  tx: Prisma.TransactionClient,
  args: { runId: string; actorId: string },
) {
  const run = await tx.salaryRun.findUniqueOrThrow({
    where: { id: args.runId },
    include: { lines: true },
  })
  if (run.status !== 'DRAFT') throw new OpsError('Run is already approved')
  if (run.lines.length === 0) throw new OpsError('Run has no lines')

  const people = await tx.salaryPerson.findMany({
    where: { id: { in: run.lines.map((l) => l.personId) } },
  })
  const personById = new Map(people.map((p) => [p.id, p]))

  const lines: LineInput[] = []
  let totalTds = 0n
  for (const line of run.lines) {
    const person = personById.get(line.personId)
    if (!person?.payableAccountId) throw new OpsError('Person is missing a payable account')
    const expenseCode = person.type === 'SALARY' ? COA.SALARIES : COA.CONSULTANT_FEES
    const expense = await tx.ledgerAccount.findUniqueOrThrow({
      where: { entityId_code: { entityId: run.entityId, code: expenseCode } },
    })
    lines.push({
      accountId: expense.id,
      debit: formatPaise(parsePaise(String(line.gross))),
      memo: person.name,
      costCentreId: line.costCentreId ?? undefined,
    })
    lines.push({
      accountId: person.payableAccountId,
      credit: formatPaise(parsePaise(String(line.net))),
      memo: person.name,
    })
    totalTds += parsePaise(String(line.tds))
  }
  if (totalTds > 0n) {
    const tdsPayable = await tx.ledgerAccount.findUniqueOrThrow({
      where: { entityId_code: { entityId: run.entityId, code: COA.TDS_PAYABLE } },
    })
    lines.push({ accountId: tdsPayable.id, credit: formatPaise(totalTds) })
  }

  const monthEnd = new Date(Date.UTC(run.year, run.month, 0)) // last day of month
  const { doc } = await createJournalDocument(tx, {
    entityId: run.entityId,
    sourceType: 'salary_run',
    sourceId: run.id,
    actorId: args.actorId,
    content: {
      date: monthEnd,
      narration: `Salary run ${run.year}-${String(run.month).padStart(2, '0')}`,
      lines,
    },
  })

  if (totalTds > 0n) {
    // TDS register rows (spec §7.2): one per person with a deduction. The
    // consolidated posting is one doc, so per-person rows key on
    // "<docId>:<lineId>" — register queries resolve the prefix to the doc.
    for (const line of run.lines) {
      const tds = parsePaise(String(line.tds))
      if (tds === 0n) continue
      const person = personById.get(line.personId)!
      await writeTaxLine(tx, {
        entityId: run.entityId,
        docId: `${doc.id}:${line.id}`,
        date: monthEnd,
        direction: 'input',
        party: person.name,
        taxableValue: formatPaise(parsePaise(String(line.gross))),
        tdsSection: person.tdsSection,
        tdsRate: String(person.tdsRate),
        tdsAmount: formatPaise(tds),
        sourceType: 'salary_run',
        sourceId: run.id,
      })
    }
  }

  return tx.salaryRun.update({
    where: { id: run.id },
    data: { status: 'APPROVED', docId: doc.id, approvedById: args.actorId },
  })
}

/** Mark-paid run: Dr every person's payable / Cr the paying bank account. */
export async function payRun(
  tx: Prisma.TransactionClient,
  args: { runId: string; date: Date; sourceAccountId: string; actorId: string },
) {
  const run = await tx.salaryRun.findUniqueOrThrow({
    where: { id: args.runId },
    include: { lines: true },
  })
  if (run.status !== 'APPROVED') throw new OpsError('Approve the run first')

  const people = await tx.salaryPerson.findMany({
    where: { id: { in: run.lines.map((l) => l.personId) } },
  })
  const personById = new Map(people.map((p) => [p.id, p]))
  const lines: LineInput[] = []
  let total = 0n
  for (const line of run.lines) {
    const person = personById.get(line.personId)!
    const net = parsePaise(String(line.net))
    if (net === 0n) continue
    lines.push({ accountId: person.payableAccountId!, debit: formatPaise(net), memo: person.name })
    total += net
  }
  if (total === 0n) throw new OpsError('Nothing to pay')
  lines.push({ accountId: args.sourceAccountId, credit: formatPaise(total) })

  const { doc } = await createJournalDocument(tx, {
    entityId: run.entityId,
    sourceType: 'salary_payment',
    sourceId: run.id,
    actorId: args.actorId,
    content: {
      date: args.date,
      narration: `Salary payout ${run.year}-${String(run.month).padStart(2, '0')}`,
      lines,
    },
  })
  return tx.salaryRun.update({
    where: { id: run.id },
    data: { status: 'PAID', paymentDocId: doc.id },
  })
}
