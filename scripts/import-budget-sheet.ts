import 'dotenv/config'
import * as XLSX from 'xlsx'
import { prisma } from '../src/lib/db'

// One-time import of the "Cash flow" sheet into BudgetLine rows: one line
// per head × paying pool, amounts per frequency period, receipts negative
// (the sheet's own convention). Source pools come from the periodic split
// columns; the "HG Bank" column maps to AC when the row's paying account is
// HDFC 2762 (that account lives in the AC books now).

const FILE =
  '/private/tmp/claude-501/-Users-himalgoyal-Desktop-Project-ledgerly/7dc12e52-9d59-414f-9264-410b9e4df0c8/scratchpad/cashflow.xlsx'

const FREQ: Record<string, string> = {
  daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', quarterly: 'QUARTERLY',
  'half yearly': 'HALF_YEARLY', 'half-yearly': 'HALF_YEARLY', annual: 'ANNUAL', once: 'ONCE',
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(/[,₹\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

async function main() {
  const wb = XLSX.readFile(FILE)
  const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], {
    header: 1, raw: false, defval: '',
  })

  const entities = await prisma.entity.findMany({ where: { archivedAt: null } })
  const byCode = new Map(entities.map((e) => [e.code, e]))
  const heads = await prisma.ledgerAccount.findMany({
    where: { isGroup: false, archivedAt: null },
    select: { id: true, name: true, entityId: true },
  })
  const entityCode = new Map(entities.map((e) => [e.id, e.code]))
  const findHead = (label: string, preferPool: string) => {
    const matches = heads.filter((h) => h.name.trim().toLowerCase() === label.trim().toLowerCase())
    if (matches.length === 0) return null
    const preferred = matches.find((h) => entityCode.get(h.entityId) === preferPool)
    return preferred ?? matches.find((h) => entityCode.get(h.entityId) === 'HG') ?? matches[0]
  }

  await prisma.budgetLine.deleteMany({}) // idempotent re-import

  let created = 0
  const unmatched: string[] = []
  for (const r of rows.slice(3)) {
    const label = String(r[3] ?? '').trim()
    if (!label) continue
    const freq = FREQ[String(r[6] ?? '').trim().toLowerCase()]
    const splits: [string, number][] = [
      ['ACPL', num(r[9])],
      ['MG', num(r[10])],
      ['CASH', num(r[11])],
      [String(r[0] ?? '').includes('2762') ? 'AC' : 'HG', num(r[12])],
    ]
    const total = num(r[4])
    const active = splits.filter(([, v]) => v !== 0)
    // No split but a budget → one line on the row's own paying account.
    if (active.length === 0 && total !== 0) {
      const mode = String(r[0] ?? '')
      const pool = mode.includes('7838') ? 'ACPL' : mode.includes('2762') ? 'AC'
        : /meena|mg/i.test(mode) ? 'MG' : /cash/i.test(mode) ? 'CASH' : 'HG'
      active.push([pool, total])
    }
    if (active.length === 0 || !freq) continue

    for (const [pool, amount] of active) {
      const head = findHead(label, pool)
      const entity = head
        ? entities.find((e) => e.id === head.entityId)!
        : byCode.get(pool === 'CASH' ? 'HG' : pool) ?? byCode.get('HG')!
      await prisma.budgetLine.create({
        data: {
          entityId: entity.id,
          headAccountId: head?.id ?? null,
          label,
          source: pool,
          frequency: freq,
          amount: amount.toFixed(2),
          expenseType: String(r[2] ?? '').trim() || null,
          taxTreatment: String(r[5] ?? '').trim() || null,
          dayNote: String(r[17] ?? '').trim() || null,
        },
      })
      created++
      if (!head) unmatched.push(`${label} (${pool})`)
    }
  }
  console.log(`created ${created} budget lines`)
  console.log(`heads not matched (label kept): ${[...new Set(unmatched)].join(', ') || 'none'}`)
  const perPool = await prisma.budgetLine.groupBy({ by: ['source'], _count: true })
  perPool.forEach((p) => console.log(`${p.source}: ${p._count} lines`))
}

main().finally(() => prisma.$disconnect())
