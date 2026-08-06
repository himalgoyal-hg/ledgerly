// Phase 2 verification (spec §11):
//   §11.1 Invariant: after ANY sequence of operations, total Dr = total Cr.
//   §11.4 Undo chain: edit → edit → delete → undo → undo → undo restores the
//         exact original, ledger balanced at every step.
//   §11.5 Period lock: locked month rejects all mutations.
//   Plus: DB tamper tests — the invariants hold even against raw SQL.
// Runs against the dev database through the real service layer.
import 'dotenv/config'
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { seedChartOfAccounts } from '../src/lib/ledger/coa'
import {
  createJournalDocument,
  editJournalDocument,
  deleteJournalDocument,
  undoJournalDocument,
} from '../src/lib/ledger/posting'

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function tally(entityId: string) {
  const rows = await prisma.$queryRaw<{ debit: string | null; credit: string | null }[]>`
    SELECT SUM(l.debit)::text as debit, SUM(l.credit)::text as credit
    FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE e."entityId" = ${entityId}`
  return { debit: rows[0]?.debit ?? '0', credit: rows[0]?.credit ?? '0' }
}

async function balanced(entityId: string) {
  const t = await tally(entityId)
  return Number(t.debit) === Number(t.credit)
}

async function currentContent(docId: string) {
  const doc = await prisma.journalDoc.findUniqueOrThrow({
    where: { id: docId },
    include: { currentEntry: { include: { lines: { orderBy: { accountId: 'asc' } } } } },
  })
  if (!doc.currentEntry) return null
  return {
    narration: doc.currentEntry.narration,
    date: doc.currentEntry.date.toISOString().slice(0, 10),
    lines: doc.currentEntry.lines.map((l) => ({
      accountId: l.accountId,
      debit: String(l.debit),
      credit: String(l.credit),
    })),
  }
}

async function main() {
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })

  // Isolated test entity
  const entity = await prisma.$transaction(async (tx) => {
    const e = await tx.entity.create({
      data: { name: 'Verify P2', code: 'VP2', type: 'INDIVIDUAL', pan: 'AAAPV0000A' },
    })
    await seedChartOfAccounts(tx, e.id)
    return e
  })
  const account = async (code: string) =>
    prisma.ledgerAccount.findUniqueOrThrow({
      where: { entityId_code: { entityId: entity.id, code } },
    })
  const bank = await prisma.$transaction(async (tx) => {
    const group = await tx.ledgerAccount.findUniqueOrThrow({
      where: { entityId_code: { entityId: entity.id, code: '1100' } },
    })
    return tx.ledgerAccount.create({
      data: { entityId: entity.id, code: '1101', name: 'Test Bank', kind: 'ASSET', parentId: group.id },
    })
  })
  const food = await account('5310')
  const travel = await account('5300')
  const rent = await account('5200')

  // --- §11.4 Undo chain: create → edit → edit → delete → undo ×3 ---
  const original = {
    date: new Date('2026-07-05'),
    narration: 'Dinner',
    lines: [
      { accountId: food.id, debit: '500.00' },
      { accountId: bank.id, credit: '500.00' },
    ],
  }
  const { doc } = await prisma.$transaction((tx) =>
    createJournalDocument(tx, {
      entityId: entity.id, sourceType: 'manual', actorId: admin.id, content: original,
    }),
  )
  const v1 = await currentContent(doc.id)
  check('create posts', v1 !== null && (await balanced(entity.id)))

  await prisma.$transaction((tx) =>
    editJournalDocument(tx, {
      docId: doc.id, actorId: admin.id,
      content: {
        date: new Date('2026-07-05'), narration: 'Dinner (team)',
        lines: [
          { accountId: food.id, debit: '750.00' },
          { accountId: bank.id, credit: '750.00' },
        ],
      },
    }),
  )
  check('edit 1: balanced', await balanced(entity.id))

  await prisma.$transaction((tx) =>
    editJournalDocument(tx, {
      docId: doc.id, actorId: admin.id,
      content: {
        date: new Date('2026-07-06'), narration: 'Dinner + cab',
        lines: [
          { accountId: food.id, debit: '750.00' },
          { accountId: travel.id, debit: '250.00' },
          { accountId: bank.id, credit: '1000.00' },
        ],
      },
    }),
  )
  check('edit 2: balanced', await balanced(entity.id))

  await prisma.$transaction((tx) => deleteJournalDocument(tx, { docId: doc.id, actorId: admin.id }))
  const afterDelete = await prisma.journalDoc.findUniqueOrThrow({ where: { id: doc.id } })
  check(
    'delete: soft (in bin), ledger balanced',
    afterDelete.deletedAt !== null && afterDelete.currentEntryId === null && (await balanced(entity.id)),
  )

  await prisma.$transaction((tx) => undoJournalDocument(tx, { docId: doc.id, actorId: admin.id }))
  const afterUndo1 = await currentContent(doc.id)
  check(
    'undo 1: restores deleted (content of edit 2), balanced',
    afterUndo1?.narration === 'Dinner + cab' && afterUndo1.lines.length === 3 && (await balanced(entity.id)),
  )

  await prisma.$transaction((tx) => undoJournalDocument(tx, { docId: doc.id, actorId: admin.id }))
  const afterUndo2 = await currentContent(doc.id)
  check(
    'undo 2: reverts edit 2 (content of edit 1), balanced',
    afterUndo2?.narration === 'Dinner (team)' && afterUndo2.lines.some((l) => l.debit === '750') === false
      ? false
      : afterUndo2?.narration === 'Dinner (team)' && (await balanced(entity.id)),
  )

  await prisma.$transaction((tx) => undoJournalDocument(tx, { docId: doc.id, actorId: admin.id }))
  const afterUndo3 = await currentContent(doc.id)
  const matchesOriginal =
    afterUndo3?.narration === 'Dinner' &&
    afterUndo3.date === '2026-07-05' &&
    afterUndo3.lines.length === 2 &&
    afterUndo3.lines.some((l) => l.accountId === food.id && Number(l.debit) === 500) &&
    afterUndo3.lines.some((l) => l.accountId === bank.id && Number(l.credit) === 500)
  check('undo 3: restores the EXACT original, balanced', matchesOriginal && (await balanced(entity.id)))

  let noMore = false
  try {
    await prisma.$transaction((tx) => undoJournalDocument(tx, { docId: doc.id, actorId: admin.id }))
  } catch {
    noMore = true
  }
  check('undo past original refused', noMore)

  // --- §11.5 Period lock ---
  await prisma.periodLock.create({
    data: { entityId: entity.id, year: 2026, month: 7, lockedById: admin.id },
  })
  const blocked = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      return false
    } catch {
      return true
    }
  }
  check(
    'locked month: new posting rejected',
    await blocked(() =>
      prisma.$transaction((tx) =>
        createJournalDocument(tx, {
          entityId: entity.id, sourceType: 'manual', actorId: admin.id,
          content: {
            date: new Date('2026-07-15'), narration: 'Should fail',
            lines: [
              { accountId: rent.id, debit: '100.00' },
              { accountId: bank.id, credit: '100.00' },
            ],
          },
        }),
      ),
    ),
  )
  check(
    'locked month: edit rejected',
    await blocked(() =>
      prisma.$transaction((tx) =>
        editJournalDocument(tx, {
          docId: doc.id, actorId: admin.id,
          content: {
            date: new Date('2026-08-01'), narration: 'Move out of locked month',
            lines: [
              { accountId: food.id, debit: '500.00' },
              { accountId: bank.id, credit: '500.00' },
            ],
          },
        }),
      ),
    ),
  )
  check(
    'locked month: delete rejected',
    await blocked(() =>
      prisma.$transaction((tx) => deleteJournalDocument(tx, { docId: doc.id, actorId: admin.id })),
    ),
  )
  check(
    'locked month: undo rejected',
    await blocked(() =>
      prisma.$transaction((tx) => undoJournalDocument(tx, { docId: doc.id, actorId: admin.id })),
    ),
  )
  // Raw SQL straight at the DB — the trigger must hold even without the app.
  check(
    'locked month: raw SQL insert rejected by trigger',
    await blocked(() =>
      prisma.$executeRaw`
        INSERT INTO "JournalEntry" (id, "entityId", "docId", version, kind, date, narration, action, "createdById")
        VALUES ('tamper1', ${entity.id}, ${doc.id}, 99, 'FORWARD', '2026-07-20', 'tamper', 'create', ${admin.id})`,
    ),
  )
  await prisma.periodLock.deleteMany({ where: { entityId: entity.id } })

  // --- DB tamper tests: raw SQL cannot break the ledger ---
  const entry = await prisma.journalEntry.findFirstOrThrow({
    where: { entityId: entity.id },
    include: { lines: true },
  })
  check(
    'tamper: UPDATE a journal line rejected',
    await blocked(() => prisma.$executeRaw`UPDATE "JournalLine" SET debit = debit + 1 WHERE id = ${entry.lines[0].id}`),
  )
  check(
    'tamper: DELETE a journal line rejected',
    await blocked(() => prisma.$executeRaw`DELETE FROM "JournalLine" WHERE id = ${entry.lines[0].id}`),
  )
  check(
    'tamper: DELETE a journal entry rejected',
    await blocked(() => prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE id = ${entry.id}`),
  )
  check(
    'tamper: rewrite entry narration rejected',
    await blocked(() => prisma.$executeRaw`UPDATE "JournalEntry" SET narration = 'rewritten' WHERE id = ${entry.id}`),
  )
  check(
    'tamper: one-sided line rejected by CHECK',
    await blocked(() =>
      prisma.$executeRaw`INSERT INTO "JournalLine" (id, "entryId", "accountId", debit, credit) VALUES ('tamper2', ${entry.id}, ${bank.id}, 10, 10)`,
    ),
  )

  // --- §11.1 Invariant after a random operation storm ---
  const accounts = [food, travel, rent]
  const docs: string[] = []
  let seed = 42
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  for (let i = 0; i < 60; i++) {
    const op = rand()
    try {
      if (op < 0.45 || docs.length === 0) {
        const amount = (Math.floor(rand() * 99900) / 100 + 1).toFixed(2)
        const acct = accounts[Math.floor(rand() * accounts.length)]
        const { doc: d } = await prisma.$transaction((tx) =>
          createJournalDocument(tx, {
            entityId: entity.id, sourceType: 'manual', actorId: admin.id,
            content: {
              date: new Date(Date.UTC(2026, 7, 1 + Math.floor(rand() * 28))),
              narration: `Storm ${i}`,
              lines: [
                { accountId: acct.id, debit: amount },
                { accountId: bank.id, credit: amount },
              ],
            },
          }),
        )
        docs.push(d.id)
      } else if (op < 0.65) {
        const d = docs[Math.floor(rand() * docs.length)]
        const amount = (Math.floor(rand() * 99900) / 100 + 1).toFixed(2)
        await prisma.$transaction((tx) =>
          editJournalDocument(tx, {
            docId: d, actorId: admin.id,
            content: {
              date: new Date(Date.UTC(2026, 7, 1 + Math.floor(rand() * 28))),
              narration: `Storm edit ${i}`,
              lines: [
                { accountId: accounts[Math.floor(rand() * accounts.length)].id, debit: amount },
                { accountId: bank.id, credit: amount },
              ],
            },
          }),
        )
      } else if (op < 0.85) {
        const d = docs[Math.floor(rand() * docs.length)]
        await prisma.$transaction((tx) => deleteJournalDocument(tx, { docId: d, actorId: admin.id }))
      } else {
        const d = docs[Math.floor(rand() * docs.length)]
        await prisma.$transaction((tx) => undoJournalDocument(tx, { docId: d, actorId: admin.id }))
      }
    } catch {
      // deleted docs rejecting edits etc. — expected; the invariant is what matters
    }
    if (!(await balanced(entity.id))) {
      check(`invariant after op ${i}`, false)
      break
    }
  }
  const finalTally = await tally(entity.id)
  check(
    '§11.1 invariant after 60-op storm: Dr = Cr',
    Number(finalTally.debit) === Number(finalTally.credit),
    `Dr ${finalTally.debit} = Cr ${finalTally.credit}`,
  )

  // --- Clean up test entity (raw: every safety trigger must be lifted,
  //     which is itself evidence they guard the ledger) ---
  await prisma.$executeRaw`ALTER TABLE "JournalLine" DISABLE TRIGGER USER`
  await prisma.$executeRaw`ALTER TABLE "JournalEntry" DISABLE TRIGGER USER`
  await prisma.$executeRaw`DELETE FROM "JournalLine" WHERE "entryId" IN (SELECT id FROM "JournalEntry" WHERE "entityId" = ${entity.id})`
  await prisma.journalDoc.updateMany({ where: { entityId: entity.id }, data: { currentEntryId: null } })
  await prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "entityId" = ${entity.id}`
  await prisma.$executeRaw`ALTER TABLE "JournalLine" ENABLE TRIGGER USER`
  await prisma.$executeRaw`ALTER TABLE "JournalEntry" ENABLE TRIGGER USER`
  await prisma.journalDoc.deleteMany({ where: { entityId: entity.id } })
  await prisma.periodLock.deleteMany({ where: { entityId: entity.id } })
  await prisma.ledgerAccount.deleteMany({ where: { entityId: entity.id } })
  await prisma.entity.delete({ where: { id: entity.id } })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exitCode = failed.length ? 1 : 0
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
