import 'dotenv/config'
import { prisma } from '../src/lib/db'

// Part 1 of the everywhere re-derive (Himal, 18 Aug 2026): tag rows, tag
// rules and cash entries in EVERY books take the tagged head's default cost
// centre — plain app-level rows the forms themselves edit, no ledger
// involved. Journal lines run separately (fix-all-cc-lines.ts).

async function main() {
  const heads = await prisma.ledgerAccount.findMany({ select: { id: true, defaultCostCentreId: true } })
  const defOf = new Map(heads.map((h) => [h.id, h.defaultCostCentreId]))

  let txnChanged = 0
  const txns = await prisma.statementTransaction.findMany({
    where: { headAccountId: { not: null } },
    select: { id: true, headAccountId: true, costCentreId: true },
  })
  for (const t of txns) {
    const to = defOf.get(t.headAccountId as string) ?? null
    if (t.costCentreId !== to) {
      await prisma.statementTransaction.update({ where: { id: t.id }, data: { costCentreId: to } })
      txnChanged++
    }
  }

  let ruleChanged = 0
  const rules = await prisma.tagRule.findMany({ select: { id: true, headAccountId: true, costCentreId: true } })
  for (const r of rules) {
    const to = defOf.get(r.headAccountId) ?? null
    if (r.costCentreId !== to) {
      await prisma.tagRule.update({ where: { id: r.id }, data: { costCentreId: to } })
      ruleChanged++
    }
  }

  let cashChanged = 0
  const cash = await prisma.cashEntry.findMany({
    where: { headAccountId: { not: null } },
    select: { id: true, headAccountId: true, costCentreId: true },
  })
  for (const c of cash) {
    const to = defOf.get(c.headAccountId as string) ?? null
    if (c.costCentreId !== to) {
      await prisma.cashEntry.update({ where: { id: c.id }, data: { costCentreId: to } })
      cashChanged++
    }
  }
  console.log(`tag rows: ${txnChanged}, tag rules: ${ruleChanged}, cash entries: ${cashChanged} re-derived`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
