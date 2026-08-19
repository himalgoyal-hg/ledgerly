import 'dotenv/config'
import { prisma } from '../src/lib/db'

// ACPL book joins the master's word (Himal, 18 Aug 2026): every tag row and
// journal line re-derives its cost centre from the tagged head's default —
// the blanket "Office Operations" stamped before the master register existed
// comes off. Blank default means blank (transfers and the heads his list
// left empty carry no cost centre). Classification only — no amounts move —
// so the append-only guard sleeps for the journal-line block and wakes in
// finally. Backup taken first.

async function main() {
  const acpl = await prisma.entity.findFirst({ where: { code: 'ACPL' } })
  if (!acpl) { console.log('no ACPL entity'); return }

  const heads = await prisma.ledgerAccount.findMany({
    where: { entityId: acpl.id },
    select: { id: true, defaultCostCentreId: true },
  })
  const defOf = new Map(heads.map((h) => [h.id, h.defaultCostCentreId]))

  // tag rows + tag rules already re-derived by fix-acpl-cc-tags.ts
  const lines: { id: string; accountId: string; costCentreId: string | null }[] = await prisma.$queryRaw`
    SELECT l.id, l."accountId", l."costCentreId"
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE e."entityId" = ${acpl.id}`
  let lineChanged = 0
  await prisma.$executeRawUnsafe('ALTER TABLE "JournalLine" DISABLE TRIGGER USER')
  try {
    for (const l of lines) {
      const to = defOf.get(l.accountId) ?? null
      if (l.costCentreId !== to) {
        await prisma.$executeRaw`UPDATE "JournalLine" SET "costCentreId" = ${to} WHERE id = ${l.id}`
        lineChanged++
      }
    }
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "JournalLine" ENABLE TRIGGER USER')
  }

  const bal: { dr: string; cr: string }[] = await prisma.$queryRaw`
    SELECT SUM(l.debit)::text AS dr, SUM(l.credit)::text AS cr
    FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE e."entityId" = ${acpl.id}`
  console.log(`journal lines re-derived: ${lineChanged}/${lines.length}`)
  console.log(`ACPL ledger Dr ${bal[0].dr} = Cr ${bal[0].cr} → ${bal[0].dr === bal[0].cr ? 'BALANCED' : 'MISMATCH!'}`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
