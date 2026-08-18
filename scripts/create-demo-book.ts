import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { seedChartOfAccounts, nextChildCode, COA } from '../src/lib/ledger/coa'

// A DEMO book, master-complete: fresh entity with the seeded chart, every
// one of the master register's categories as a head (nature → the right
// group), the four master cost centres with defaults applied, FY 2026-27
// budgets from the master's bank+cash figures, one demo bank account and
// one cash drawer. Global things (plan lines, HeadMode, projections) are
// NOT touched — the demo never leaks into the real cash flow. Idempotent.

const GROUP_BY_NATURE: Record<string, string> = {
  Expense: '5000',
  Income: '4000',
  Asset: '1900', // fixed assets group
  Liability: '2300', // loans taken
  Contra: '1900',
  Personal: '1900',
}
const KIND_BY_GROUP: Record<string, 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE'> = {
  '5000': 'EXPENSE', '4000': 'INCOME', '1900': 'ASSET', '2300': 'LIABILITY',
}
const MONTHS_PER_YEAR: Record<string, number> = {
  DAILY: 365 / 12, WEEKLY: 52 / 12, MONTHLY: 1, QUARTERLY: 1 / 3, HALF_YEARLY: 1 / 6, ANNUAL: 1 / 12,
}
const FY = [
  ...Array.from({ length: 9 }, (_, i) => ({ year: 2026, month: i + 4 })),
  ...Array.from({ length: 3 }, (_, i) => ({ year: 2027, month: i + 1 })),
]

async function main() {
  // 1. the book itself
  let demo = await prisma.entity.findUnique({ where: { code: 'DEMO' } })
  if (!demo) {
    demo = await prisma.$transaction(async (tx) => {
      const e = await tx.entity.create({
        data: { name: 'Demo Book', code: 'DEMO', type: 'INDIVIDUAL', pan: 'DEMOP0000D' },
      })
      await seedChartOfAccounts(tx, e.id)
      return e
    })
    console.log('entity DEMO created + chart seeded')
  } else {
    console.log('entity DEMO exists — refreshing its data')
  }
  const demoId = demo.id

  // 2. bank account + cash drawer (with their ledger accounts)
  if (!(await prisma.bankAccount.findFirst({ where: { entityId: demoId } }))) {
    await prisma.$transaction(async (tx) => {
      const code = await nextChildCode(tx, demoId, COA.BANK_GROUP)
      const la = await tx.ledgerAccount.create({
        data: {
          entityId: demoId, code, name: 'Demo HDFC 0001', kind: 'ASSET',
          parentId: (await tx.ledgerAccount.findUniqueOrThrow({ where: { entityId_code: { entityId: demoId, code: COA.BANK_GROUP } } })).id,
        },
      })
      await tx.bankAccount.create({
        data: {
          entityId: demoId, bankName: 'HDFC Bank', accountNumber: '00000000000001', ifsc: 'HDFC0000001',
          nickname: 'Demo HDFC 0001', openingBalance: '100000.00', openingDate: new Date('2026-04-01'),
          ledgerAccountId: la.id,
        },
      })
    })
    console.log('demo bank account created (₹1,00,000 opening)')
  }
  if (!(await prisma.cashLocation.findFirst({ where: { entityId: demoId } }))) {
    await prisma.$transaction(async (tx) => {
      const code = await nextChildCode(tx, demoId, COA.CASH_GROUP)
      const la = await tx.ledgerAccount.create({
        data: {
          entityId: demoId, code, name: 'Demo Drawer', kind: 'ASSET',
          parentId: (await tx.ledgerAccount.findUniqueOrThrow({ where: { entityId_code: { entityId: demoId, code: COA.CASH_GROUP } } })).id,
        },
      })
      await tx.cashLocation.create({ data: { entityId: demoId, name: 'Demo Drawer', ledgerAccountId: la.id } })
    })
    console.log('demo cash drawer created')
  }

  // 3. the four master cost centres
  const ccByType = new Map<string, string>()
  for (const name of ['Compulsory', 'Optional-Lifestyle', 'Optional-growth', 'Optional-Investment']) {
    const cc =
      (await prisma.costCentre.findFirst({ where: { entityId: demoId, name } })) ??
      (await prisma.costCentre.create({ data: { entityId: demoId, name } }))
    ccByType.set(name, cc.id)
  }

  // 4. every master category as a head — nature-placed, CC-defaulted, budgeted
  const modes = await prisma.headMode.findMany({ orderBy: { category: 'asc' } })
  let heads = 0
  let budgeted = 0
  for (const m of modes) {
    if (m.category.toLowerCase() === 'cash') continue // cash lives as locations
    const groupCode = GROUP_BY_NATURE[m.nature ?? 'Expense'] ?? '5000'
    let head = await prisma.ledgerAccount.findFirst({
      where: { entityId: demoId, isGroup: false, name: { equals: m.category, mode: 'insensitive' } },
    })
    if (!head) {
      head = await prisma.$transaction(async (tx) => {
        const group = await tx.ledgerAccount.findUniqueOrThrow({
          where: { entityId_code: { entityId: demoId, code: groupCode } },
        })
        return tx.ledgerAccount.create({
          data: {
            entityId: demoId,
            code: await nextChildCode(tx, demoId, groupCode),
            name: m.category,
            kind: KIND_BY_GROUP[groupCode],
            parentId: group.id,
          },
        })
      })
      heads++
    }
    if (m.expenseType && ccByType.has(m.expenseType) && head.defaultCostCentreId !== ccByType.get(m.expenseType)) {
      await prisma.ledgerAccount.update({
        where: { id: head.id },
        data: { defaultCostCentreId: ccByType.get(m.expenseType) },
      })
    }
    const yearly =
      (Number(m.bankBudget ?? 0) + Number(m.cashBudget ?? 0)) *
      (m.frequency ? (MONTHS_PER_YEAR[m.frequency] ?? 0) * 12 : 0)
    if (yearly !== 0) {
      const totalPaise = Math.round(Math.abs(yearly) * 100)
      const sign = yearly < 0 ? -1 : 1
      const base = Math.floor(totalPaise / 12)
      const rem = totalPaise % 12
      for (const [i, fm] of FY.entries()) {
        const amount = ((sign * (base + (i < rem ? 1 : 0))) / 100).toFixed(2)
        await prisma.budget.upsert({
          where: { entityId_accountId_year_month: { entityId: demoId, accountId: head.id, year: fm.year, month: fm.month } },
          create: { entityId: demoId, accountId: head.id, year: fm.year, month: fm.month, amount, frequency: 'ANNUAL' },
          update: { amount },
        })
      }
      budgeted++
    }
  }
  console.log(`${modes.length - 1} categories in DEMO: ${heads} heads created, ${budgeted} with FY budgets, cost centres defaulted`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
