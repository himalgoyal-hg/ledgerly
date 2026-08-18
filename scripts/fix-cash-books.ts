import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { applyMasterRow } from '../src/lib/budget/master-sync'

// Only AJ Revenue is truly Cash (its bank mode says so). Every other row
// marked CASH gets its real books — where its head lives (HG preferred) —
// and rows with live plan lines re-apply, so the lines leave the cash pool.

async function main() {
  const wrong = (await prisma.headMode.findMany({ where: { books: 'CASH' } })).filter(
    (m) => (m.modeBank ?? '').toLowerCase() !== 'cash',
  )
  let moved = 0
  let relined = 0
  for (const m of wrong) {
    const head = await prisma.ledgerAccount.findFirst({
      where: { isGroup: false, archivedAt: null, name: { equals: m.category, mode: 'insensitive' } },
      include: { entity: { select: { code: true } } },
      orderBy: { entity: { code: 'asc' } }, // ACPL < HG — prefer specific below
    })
    const heads = await prisma.ledgerAccount.findMany({
      where: { isGroup: false, archivedAt: null, name: { equals: m.category, mode: 'insensitive' } },
      include: { entity: { select: { code: true } } },
    })
    const books =
      heads.find((h) => h.entity.code === 'HG')?.entity.code ??
      heads[0]?.entity.code ??
      'HG'
    const hasLine = await prisma.budgetLine.findFirst({
      where: { archivedAt: null, frequency: { not: 'ONCE' }, label: { equals: m.category, mode: 'insensitive' } },
    })
    if (hasLine) {
      await applyMasterRow({
        category: m.category,
        bankMode: m.modeBank,
        expenseType: m.expenseType,
        bankBudget: m.bankBudget ? Number(m.bankBudget) : 0,
        cashBudget: m.cashBudget ? Number(m.cashBudget) : 0,
        frequency: m.frequency,
        dayNote: m.dayNote,
        nature: m.nature,
        books,
      })
      relined++
    } else {
      await prisma.headMode.update({ where: { id: m.id }, data: { books } })
    }
    moved++
    void head
  }
  const stillCash = await prisma.headMode.findMany({ where: { books: 'CASH' }, select: { category: true } })
  const cashLines = await prisma.budgetLine.findMany({
    where: { archivedAt: null, source: 'CASH', frequency: { not: 'ONCE' } },
    select: { label: true },
  })
  console.log(`${moved} rows corrected (${relined} plan lines moved out of the cash pool)`)
  console.log('still Cash (books):', stillCash.map((s) => s.category).join(', ') || 'none')
  console.log('recurring cash-pool lines left:', cashLines.map((l) => l.label).join(', ') || 'none')
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
