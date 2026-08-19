import 'dotenv/config'
import { prisma } from '../src/lib/db'

// Part 2 of the everywhere re-derive (Himal, 18 Aug 2026, approved): the
// remaining ~20 HG journal lines take the tagged head's default cost centre,
// same as ACPL got via fix-acpl-cc.ts. Classification only — no amounts
// move — so the append-only guard sleeps for exactly this block and wakes
// in finally. Backup taken first.

async function main() {
  const heads = await prisma.ledgerAccount.findMany({ select: { id: true, defaultCostCentreId: true } })
  const defOf = new Map(heads.map((h) => [h.id, h.defaultCostCentreId]))

  const lines: { id: string; accountId: string; costCentreId: string | null }[] = await prisma.$queryRaw`
    SELECT id, "accountId", "costCentreId" FROM "JournalLine"`
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
  console.log(`journal lines re-derived: ${lineChanged}/${lines.length}`)

  const bal: { code: string; dr: string; cr: string }[] = await prisma.$queryRaw`
    SELECT en.code, SUM(l.debit)::text AS dr, SUM(l.credit)::text AS cr
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN "Entity" en ON en.id = e."entityId"
    GROUP BY en.code ORDER BY en.code`
  for (const b of bal) console.log(`${b.code}: Dr ${b.dr} = Cr ${b.cr} → ${b.dr === b.cr ? 'BALANCED' : 'MISMATCH!'}`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
