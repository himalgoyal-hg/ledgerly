import 'dotenv/config'
import { prisma } from '../src/lib/db'

// Cashflow-tab follow-through: (1) plan lines still pointing at the retired
// AC pool move to HG (AC merged into HG on 13 Aug), so they re-enter the
// projections; (2) the tab's own lines come in — Synergy EMI, the monthly
// receipt from the company, and the Rakhi one-off. Idempotent by label.

async function main() {
  const ac = await prisma.budgetLine.updateMany({
    where: { source: 'AC', archivedAt: null },
    data: { source: 'HG' },
  })

  const hg = await prisma.entity.findUniqueOrThrow({ where: { code: 'HG' } })
  const LINES = [
    { label: 'Synergy EMI', source: 'HG', frequency: 'MONTHLY', amount: '250000.00', taxTreatment: 'HG Business Expense', dayNote: '27', onMonth: null as string | null },
    { label: 'Receipt from company', source: 'HG', frequency: 'MONTHLY', amount: '-300000.00', taxTreatment: null, dayNote: null, onMonth: null as string | null },
    { label: 'Rakhi Gift', source: 'HG', frequency: 'ONCE', amount: '2000.00', taxTreatment: null, dayNote: '25', onMonth: '2026-08' },
  ]
  let added = 0
  for (const l of LINES) {
    const existing = await prisma.budgetLine.findFirst({
      where: { label: { equals: l.label, mode: 'insensitive' }, archivedAt: null },
    })
    const head = await prisma.ledgerAccount.findFirst({
      where: { entityId: hg.id, isGroup: false, archivedAt: null, name: { equals: l.label, mode: 'insensitive' } },
    })
    const data = { entityId: hg.id, headAccountId: head?.id ?? null, ...l }
    if (existing) await prisma.budgetLine.update({ where: { id: existing.id }, data })
    else { await prisma.budgetLine.create({ data }); added++ }
  }
  console.log(`AC→HG remapped: ${ac.count}; sheet lines added: ${added} (rest updated)`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
