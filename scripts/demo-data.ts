// Demo books for design work and walkthroughs: a synthetic entity
// ("Northwind Traders Pvt Ltd", code PERF) with a recent-dated trailing year
// of balanced postings plus ops rows (bills, tasks, invoices, claims, tax
// lines) so every Overview card and chart has content. Reuses the perf-bench
// technique — raw inserts with triggers off, Dr = Cr proven at the end.
//
//   npm run demo           # (re)seed the demo entity
//   npm run demo -- clean  # remove it and everything it owns
import 'dotenv/config'
import { Client } from 'pg'
import { prisma } from '../src/lib/db'
import { seedChartOfAccounts, COA } from '../src/lib/ledger/coa'

const ENTITY_CODE = 'PERF'
const MODE = process.argv[2] ?? 'seed'
const DAY = 86_400_000

async function cleanup(client: Client, entityId: string) {
  await prisma.invoicePayment.deleteMany({ where: { invoice: { entityId } } })
  await prisma.invoice.deleteMany({ where: { entityId } })
  await prisma.bill.deleteMany({ where: { entityId } })
  await prisma.reimbursement.deleteMany({ where: { entityId } })
  await client.query(`ALTER TABLE "JournalLine" DISABLE TRIGGER USER`)
  await client.query(`ALTER TABLE "JournalEntry" DISABLE TRIGGER USER`)
  await client.query(`DELETE FROM "JournalLine" WHERE "entryId" IN (SELECT id FROM "JournalEntry" WHERE "entityId" = $1)`, [entityId])
  await client.query(`UPDATE "JournalDoc" SET "currentEntryId" = NULL WHERE "entityId" = $1`, [entityId])
  await client.query(`DELETE FROM "JournalEntry" WHERE "entityId" = $1`, [entityId])
  await client.query(`ALTER TABLE "JournalLine" ENABLE TRIGGER USER`)
  await client.query(`ALTER TABLE "JournalEntry" ENABLE TRIGGER USER`)
  await client.query(`DELETE FROM "JournalDoc" WHERE "entityId" = $1`, [entityId])
  for (const t of ['TaxLine', 'CostCentre', 'BankAccount', 'CashLocation', 'PeriodLock', 'LedgerAccount']) {
    await client.query(`DELETE FROM "${t}" WHERE "entityId" = $1`, [entityId])
  }
  await client.query(`DELETE FROM "Entity" WHERE id = $1`, [entityId])
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    const existing = await prisma.entity.findUnique({ where: { code: ENTITY_CODE } })
    if (existing) {
      console.log('Clearing previous PERF data…')
      await cleanup(client, existing.id)
    }
    if (MODE === 'clean') {
      console.log('Cleaned.')
      return
    }

    const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
    const member = await prisma.user.findFirstOrThrow({ where: { role: 'MEMBER' } })

    const entity = await prisma.$transaction(async (tx) => {
      const e = await tx.entity.create({
        data: { name: 'Northwind Traders Pvt Ltd', code: ENTITY_CODE, type: 'PVT_LTD', pan: 'AAAPP0001A' },
      })
      await seedChartOfAccounts(tx, e.id)
      return e
    })
    const acct = async (code: string) =>
      (await prisma.ledgerAccount.findUniqueOrThrow({
        where: { entityId_code: { entityId: entity.id, code } },
      })).id

    const bankGroup = await acct(COA.BANK_GROUP)
    const cashGroup = await acct(COA.CASH_GROUP)
    const mk = async (code: string, name: string, parentId: string) =>
      (await prisma.ledgerAccount.create({
        data: { entityId: entity.id, code, name, kind: 'ASSET', parentId },
      })).id
    const bank1 = await mk('1101', 'ICICI Current', bankGroup)
    const bank2 = await mk('1102', 'Axis Savings', bankGroup)
    const cash = await mk('1201', 'Office cash', cashGroup)
    await prisma.bankAccount.create({
      data: {
        entityId: entity.id, bankName: 'ICICI', accountNumber: '900000000001', ifsc: 'ICIC0000001',
        nickname: 'ICICI Current', openingBalance: 0, openingDate: new Date(Date.now() - 400 * DAY), ledgerAccountId: bank1,
      },
    })
    await prisma.bankAccount.create({
      data: {
        entityId: entity.id, bankName: 'Axis', accountNumber: '900000000002', ifsc: 'UTIB0000001',
        nickname: 'Axis Savings', openingBalance: 0, openingDate: new Date(Date.now() - 400 * DAY), ledgerAccountId: bank2,
      },
    })
    await prisma.cashLocation.create({ data: { entityId: entity.id, name: 'Office drawer', ledgerAccountId: cash } })

    const { getPartyAccount } = await import('../src/lib/ops/party')
    const debtor = (await prisma.$transaction((tx) => getPartyAccount(tx, entity.id, COA.DEBTORS_GROUP, 'Globex LLP'))).id
    const vendor = (await prisma.$transaction((tx) => getPartyAccount(tx, entity.id, COA.CREDITORS_GROUP, 'Initech Services'))).id

    const a = {
      bank1, bank2, cash, debtor, vendor,
      fees: await acct('4100'), rent: await acct('5200'), travel: await acct('5300'),
      food: await acct('5310'), misc: await acct('5900'),
    }

    // ~14 months of postings, weighted like a real consultancy: fees in,
    // rent/vendor/food/travel out, growing slightly month over month.
    const start = Date.now() - 420 * DAY
    const shapes: ((i: number) => [string, string, number])[] = [
      (i) => [a.bank1, a.fees, 180_000 + (i % 9) * 22_000],
      (i) => [a.debtor, a.fees, 120_000 + (i % 7) * 15_000],
      (i) => [a.bank2, a.debtor, 110_000 + (i % 7) * 15_000],
      // Vendor accrues a little more than we pay, so payables stay positive.
      (i) => [a.rent, a.vendor, 65_000 + (i % 2) * 1_000],
      (i) => [a.vendor, a.bank1, 58_000 + (i % 5) * 1_500],
      (i) => [a.travel, a.bank2, 9_000 + (i % 11) * 1_800],
      (i) => [a.food, a.cash, 2_200 + (i % 13) * 350],
      // Periodic cash withdrawal keeps the drawer funded.
      (i) => [a.cash, a.bank2, 6_000 + (i % 4) * 500],
      (i) => [a.misc, a.bank1, 5_500 + (i % 6) * 900],
    ]

    const N = 700
    await client.query('BEGIN')
    await client.query(`ALTER TABLE "JournalLine" DISABLE TRIGGER USER`)
    await client.query(`ALTER TABLE "JournalEntry" DISABLE TRIGGER USER`)
    for (let i = 0; i < N; i++) {
      const date = new Date(start + Math.floor((i / N) * 420) * DAY)
      const [dr, cr, amt] = shapes[i % shapes.length](i)
      const amount = amt.toFixed(2)
      await client.query(
        `INSERT INTO "JournalDoc" (id, "entityId", "sourceType", "updatedAt") VALUES ($1, $2, 'demo', now())`,
        [`demo-d-${i}`, entity.id],
      )
      await client.query(
        `INSERT INTO "JournalEntry" (id, "entityId", "docId", version, kind, state, date, narration, action, "createdById", "createdAt")
         VALUES ($1, $2, $3, 1, 'FORWARD'::"EntryKind", 'ACTIVE'::"EntryState", $4, $5, 'create', $6, now())`,
        [`demo-e-${i}`, entity.id, `demo-d-${i}`, date, `Demo txn ${i}`, admin.id],
      )
      await client.query(
        `INSERT INTO "JournalLine" (id, "entryId", "accountId", debit, credit) VALUES
         ($1, $3, $4, $6, 0), ($2, $3, $5, 0, $6)`,
        [`demo-l-${i}-0`, `demo-l-${i}-1`, `demo-e-${i}`, dr, cr, amount],
      )
    }
    await client.query(
      `UPDATE "JournalDoc" d SET "currentEntryId" = e.id FROM "JournalEntry" e
       WHERE e."docId" = d.id AND d."entityId" = $1`,
      [entity.id],
    )
    await client.query(`ALTER TABLE "JournalLine" ENABLE TRIGGER USER`)
    await client.query(`ALTER TABLE "JournalEntry" ENABLE TRIGGER USER`)
    await client.query('COMMIT')

    // Tax register rows for the GST chart (not tied to postings — display data).
    for (let m = 0; m < 6; m++) {
      const d = new Date(Date.now() - (5 - m) * 30 * DAY)
      await prisma.taxLine.createMany({
        data: [
          {
            entityId: entity.id, docId: `demo-tax-o-${m}`, date: d, direction: 'output',
            gstType: 'intra', gstRate: 18, taxableValue: 400_000 + m * 40_000,
            gstAmount: (400_000 + m * 40_000) * 0.18, sourceType: 'invoice', sourceId: `demo-src-o-${m}`,
          },
          {
            entityId: entity.id, docId: `demo-tax-i-${m}`, date: d, direction: 'input',
            gstType: 'intra', gstRate: 18, taxableValue: 150_000 + m * 12_000,
            gstAmount: (150_000 + m * 12_000) * 0.18, sourceType: 'bill', sourceId: `demo-src-i-${m}`,
          },
        ],
      })
    }

    // Ops rows so the cards, tasks and bell have content.
    const soon = (days: number) => new Date(Date.now() + days * DAY)
    await prisma.bill.createMany({
      data: [
        { entityId: entity.id, vendor: 'Initech Services', billType: 'Consulting', amount: 84_000, gstAmount: 15_120, billDate: soon(-6), dueDate: soon(3), expenseAccountId: a.misc, createdById: admin.id },
        { entityId: entity.id, vendor: 'Tata Power', billType: 'Electricity', amount: 18_400, billDate: soon(-4), dueDate: soon(5), expenseAccountId: a.rent, createdById: admin.id },
        { entityId: entity.id, vendor: 'Acme Insurance', billType: 'Insurance', amount: 46_000, billDate: soon(-30), dueDate: soon(-2), expenseAccountId: a.misc, createdById: admin.id },
      ] as never,
    })
    await prisma.invoice.createMany({
      data: [
        { entityId: entity.id, number: 'NW-0042', customer: 'Globex LLP', date: soon(-40), dueDate: soon(-10), amount: 236_000, gstAmount: 36_000, incomeAccountId: a.fees, debtorAccountId: a.debtor, createdById: admin.id },
        { entityId: entity.id, number: 'NW-0043', customer: 'Globex LLP', date: soon(-12), dueDate: soon(18), amount: 177_000, gstAmount: 27_000, incomeAccountId: a.fees, debtorAccountId: a.debtor, createdById: admin.id },
      ],
    })
    await prisma.reimbursement.createMany({
      data: [
        { entityId: entity.id, memberId: member.id, date: soon(-3), category: 'Client travel', amount: 6_450 },
        { entityId: entity.id, memberId: member.id, date: soon(-1), category: 'Team lunch', amount: 2_310 },
      ],
    })

    const tally = await client.query(
      `SELECT SUM(l.debit)::text d, SUM(l.credit)::text c FROM "JournalLine" l
       JOIN "JournalEntry" e ON e.id = l."entryId" WHERE e."entityId" = $1`,
      [entity.id],
    )
    console.log(`Seeded ${N} entries for ${entity.name}. Dr ${tally.rows[0].d} = Cr ${tally.rows[0].c}`)
  } finally {
    await client.end().catch(() => {})
    await prisma.$disconnect().catch(() => {})
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
