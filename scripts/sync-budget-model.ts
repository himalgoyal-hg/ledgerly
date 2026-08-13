import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { monthlyEquivalent } from '../src/lib/budget/plan'

// Fill the Budget-vs-Actual report's rows (Budget model: head × month) from
// the cash-flow plan's BudgetLine rows — FY 2026-27 (Apr 2026 – Mar 2027).
// Head totals sum across pool splits; income lines are negative in the plan
// but the report expects the target on the account's normal side, so abs.

const FY: { year: number; month: number }[] = [
  ...Array.from({ length: 9 }, (_, i) => ({ year: 2026, month: i + 4 })), // Apr–Dec 26
  ...Array.from({ length: 3 }, (_, i) => ({ year: 2027, month: i + 1 })), // Jan–Mar 27
]

async function main() {
  const lines = await prisma.budgetLine.findMany({
    where: { archivedAt: null, headAccountId: { not: null } },
  })
  // Per head: recurring monthly total + one-offs per month, + frequency label
  const heads = new Map<
    string,
    { entityId: string; monthly: number; once: Map<string, number>; freqs: Set<string> }
  >()
  for (const l of lines) {
    const h = heads.get(l.headAccountId!) ?? {
      entityId: l.entityId, monthly: 0, once: new Map(), freqs: new Set<string>(),
    }
    if (l.frequency === 'ONCE' && l.onMonth) {
      h.once.set(l.onMonth, (h.once.get(l.onMonth) ?? 0) + Number(l.amount))
    } else {
      h.monthly += monthlyEquivalent(Number(l.amount), l.frequency)
      h.freqs.add(l.frequency)
    }
    heads.set(l.headAccountId!, h)
  }

  await prisma.budget.deleteMany({
    where: { OR: [{ year: 2026 }, { year: 2027, month: { lte: 3 } }] },
  })
  let rows = 0
  for (const [accountId, h] of heads) {
    const frequency = h.freqs.size === 1 ? [...h.freqs][0] : 'MONTHLY'
    for (const { year, month } of FY) {
      const key = `${year}-${String(month).padStart(2, '0')}`
      const amount = Math.abs(h.monthly) + Math.abs(h.once.get(key) ?? 0)
      if (amount === 0) continue
      await prisma.budget.create({
        data: {
          entityId: h.entityId, accountId, year, month,
          amount: amount.toFixed(2), frequency,
        },
      })
      rows++
    }
  }
  console.log(`heads budgeted: ${heads.size} | Budget rows written: ${rows}`)
  const perEntity = await prisma.budget.groupBy({ by: ['entityId'], _count: true })
  const codes = new Map((await prisma.entity.findMany()).map((e) => [e.id, e.code]))
  perEntity.forEach((p) => console.log(`${codes.get(p.entityId)}: ${p._count} rows`))
}

main().finally(() => prisma.$disconnect())
