import 'dotenv/config'
import { prisma } from '../src/lib/db'

// Part 1 of the ACPL re-derive (Himal, 18 Aug 2026): tag rows and tag rules
// take the tagged head's default cost centre — plain app-level rows the
// tagging form itself edits, no ledger involved. The journal-line part runs
// separately (fix-acpl-cc.ts) since it needs the append-only guard asleep.

async function main() {
  const acpl = await prisma.entity.findFirst({ where: { code: 'ACPL' } })
  if (!acpl) { console.log('no ACPL entity'); return }

  const heads = await prisma.ledgerAccount.findMany({
    where: { entityId: acpl.id },
    select: { id: true, defaultCostCentreId: true },
  })
  const defOf = new Map(heads.map((h) => [h.id, h.defaultCostCentreId]))

  let txnChanged = 0
  const txns = await prisma.statementTransaction.findMany({
    where: { entityId: acpl.id, headAccountId: { not: null } },
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
  const rules = await prisma.tagRule.findMany({
    where: { entityId: acpl.id },
    select: { id: true, headAccountId: true, costCentreId: true },
  })
  for (const r of rules) {
    const to = defOf.get(r.headAccountId as string) ?? null
    if (r.costCentreId !== to) {
      await prisma.tagRule.update({ where: { id: r.id }, data: { costCentreId: to } })
      ruleChanged++
    }
  }
  console.log(`tag rows re-derived: ${txnChanged}/${txns.length}; tag rules: ${ruleChanged}/${rules.length}`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
