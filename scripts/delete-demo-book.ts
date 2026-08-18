import 'dotenv/config'
import { prisma } from '../src/lib/db'

// Wipe the DEMO book completely — postings, cash entries, budgets, chart,
// cost centres, bank/cash setup, the entity itself. The append-only guards
// sleep only for DEMO's journal rows and wake right after. Real books and
// the global master (HeadMode, plan lines) are untouched by construction:
// every delete is scoped to the DEMO entity id.

async function main() {
  const demo = await prisma.entity.findUnique({ where: { code: 'DEMO' } })
  if (!demo) { console.log('no DEMO book'); return }
  const id = demo.id

  await prisma.$executeRawUnsafe('ALTER TABLE "JournalLine" DISABLE TRIGGER USER')
  await prisma.$executeRawUnsafe('ALTER TABLE "JournalEntry" DISABLE TRIGGER USER')
  try {
    await prisma.$executeRaw`DELETE FROM "JournalLine" WHERE "entryId" IN (SELECT id FROM "JournalEntry" WHERE "entityId" = ${id})`
    await prisma.$executeRaw`UPDATE "JournalDoc" SET "currentEntryId" = NULL WHERE "entityId" = ${id}`
    await prisma.$executeRaw`UPDATE "JournalEntry" SET "reversesId" = NULL WHERE "entityId" = ${id}`
    await prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "entityId" = ${id}`
    await prisma.$executeRaw`DELETE FROM "JournalDoc" WHERE "entityId" = ${id}`
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "JournalLine" ENABLE TRIGGER USER')
    await prisma.$executeRawUnsafe('ALTER TABLE "JournalEntry" ENABLE TRIGGER USER')
  }

  await prisma.cashEntry.deleteMany({ where: { entityId: id } })
  await prisma.budget.deleteMany({ where: { entityId: id } })
  await prisma.bankAccount.deleteMany({ where: { entityId: id } })
  await prisma.cashLocation.deleteMany({ where: { entityId: id } })
  await prisma.$executeRaw`UPDATE "LedgerAccount" SET "parentId" = NULL, "defaultCostCentreId" = NULL WHERE "entityId" = ${id}`
  await prisma.costCentre.deleteMany({ where: { entityId: id } })
  await prisma.ledgerAccount.deleteMany({ where: { entityId: id } })
  await prisma.userEntityScope.deleteMany({ where: { entityId: id } })
  await prisma.periodLock.deleteMany({ where: { entityId: id } })
  await prisma.entity.delete({ where: { id } })
  console.log('DEMO book fully deleted')
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
