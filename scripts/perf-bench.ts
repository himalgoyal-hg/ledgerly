// Large-ledger performance bench (spec §12.9).
//
//   npm run perf                 # ~50k entries / ~115k lines
//   npm run perf -- 200000       # bigger
//   npm run perf -- 50000 keep   # leave the data in place (for a restore drill)
//
// Seeds a realistic multi-year ledger, then times every query a user actually
// waits on. Reports the median of several runs so one cold cache doesn't
// dominate, and flags anything over the budget below.
import 'dotenv/config'
import { Client } from 'pg'
import { prisma } from '../src/lib/db'
import { seedChartOfAccounts, COA } from '../src/lib/ledger/coa'
import { trialBalance, accountLedger, booksTally } from '../src/lib/ledger/queries'
import { profitAndLoss, balanceSheet, cashFlow } from '../src/lib/reports/statements'
import { costCentreReport, partyLedgers } from '../src/lib/reports/analysis'
import { balanceTiles, queueTiles, duesTiles, receivableTiles } from '../src/lib/reports/dashboard'
import { gstr3bView, tdsRegister, monthRange } from '../src/lib/tax/register'
import { suggestPaymentSource } from '../src/lib/automation/suggest'

/** A screen feels instant below this; past it, someone notices. */
const BUDGET_MS = 400

const TARGET = Number(process.argv[2] ?? 50_000)
const KEEP = process.argv[3] === 'keep'
const ENTITY_CODE = 'PERF'

async function median(label: string, fn: () => Promise<unknown>, runs = 5) {
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const ms = times[Math.floor(times.length / 2)]
  const flag = ms > BUDGET_MS ? '  ⚠ SLOW' : ''
  console.log(`  ${label.padEnd(46)}${ms.toFixed(0).padStart(6)} ms${flag}`)
  return { label, ms }
}

async function seed(client: Client, entityId: string, accounts: Record<string, string>) {
  const { bank1, bank2, cash, fees, rent, food, travel, misc, debtor, vendor, output, itc } = accounts
  const start = new Date('2021-04-01').getTime()
  const day = 86_400_000

  // Shapes in roughly the mix a real small business produces.
  const shapes = [
    (i: number) => [{ a: bank1, d: 1 }, { a: fees, c: 1 }, { amt: 25000 + (i % 40) * 500 }],
    (i: number) => [{ a: food, d: 1 }, { a: bank1, c: 1 }, { amt: 300 + (i % 25) * 40 }],
    (i: number) => [{ a: travel, d: 1 }, { a: bank2, c: 1 }, { amt: 1200 + (i % 30) * 90 }],
    (i: number) => [{ a: rent, d: 1 }, { a: vendor, c: 1 }, { amt: 40000 + (i % 3) * 1000 }],
    (i: number) => [{ a: vendor, d: 1 }, { a: bank1, c: 1 }, { amt: 40000 + (i % 3) * 1000 }],
    (i: number) => [{ a: debtor, d: 1 }, { a: fees, c: 1 }, { amt: 60000 + (i % 20) * 750 }],
    (i: number) => [{ a: bank2, d: 1 }, { a: debtor, c: 1 }, { amt: 60000 + (i % 20) * 750 }],
    (i: number) => [{ a: misc, d: 1 }, { a: cash, c: 1 }, { amt: 500 + (i % 15) * 60 }],
  ]

  console.log(`Seeding ~${TARGET.toLocaleString('en-IN')} entries…`)
  await client.query('BEGIN')
  await client.query(`ALTER TABLE "JournalLine" DISABLE TRIGGER USER`)
  await client.query(`ALTER TABLE "JournalEntry" DISABLE TRIGGER USER`)

  const BATCH = 2000
  let made = 0
  const t0 = performance.now()
  while (made < TARGET) {
    const n = Math.min(BATCH, TARGET - made)
    const docs: string[] = []
    const entries: string[] = []
    const lines: string[] = []
    const docParams: unknown[] = []
    const entryParams: unknown[] = []
    const lineParams: unknown[] = []

    for (let k = 0; k < n; k++) {
      const i = made + k
      const docId = `perf-d-${i}`
      const entryId = `perf-e-${i}`
      const date = new Date(start + (i % 1800) * day)
      const shape = shapes[i % shapes.length](i)
      const amount = (shape[2] as { amt: number }).amt.toFixed(2)
      const legs = shape.slice(0, 2) as { a: string; d?: number; c?: number }[]
      // A GST-bearing slice, so the tax registers have something to chew on.
      const withGst = i % 7 === 0

      // updatedAt is Prisma's @updatedAt: application-populated, NOT NULL,
      // and no database default — a raw insert has to supply it.
      docParams.push(docId, entityId, 'perf', date)
      const dp = docParams.length
      docs.push(`($${dp - 3}, $${dp - 2}, $${dp - 1}, $${dp})`)

      entryParams.push(entryId, entityId, docId, date, `Perf txn ${i}`, 'create')
      const p = entryParams.length
      entries.push(`($${p - 5}, $${p - 4}, $${p - 3}, 1, 'FORWARD'::"EntryKind", 'ACTIVE'::"EntryState", $${p - 2}, $${p - 1}, $${p}, 'perf-user', now())`)

      for (const [li, leg] of legs.entries()) {
        const isDebit = Boolean(leg.d)
        lineParams.push(`perf-l-${i}-${li}`, entryId, leg.a, isDebit ? amount : '0', isDebit ? '0' : amount,
          withGst && li === 0 ? accounts.hyrox : null)
        const q = lineParams.length
        lines.push(`($${q - 5}, $${q - 4}, $${q - 3}, $${q - 2}, $${q - 1}, $${q})`)
      }
      if (withGst) {
        // A small GST split so 2210/1500 carry real volume.
        const gst = (Number(amount) * 0.18).toFixed(2)
        const gstAccount = legs[0].d ? itc : output
        lineParams.push(`perf-l-${i}-g`, entryId, gstAccount, legs[0].d ? gst : '0', legs[0].d ? '0' : gst, null)
        const q = lineParams.length
        lines.push(`($${q - 5}, $${q - 4}, $${q - 3}, $${q - 2}, $${q - 1}, $${q})`)
        // Balance it against the counter-leg so the entry still tallies.
        lineParams.push(`perf-l-${i}-gb`, entryId, legs[1].a, legs[0].d ? '0' : gst, legs[0].d ? gst : '0', null)
        const r = lineParams.length
        lines.push(`($${r - 5}, $${r - 4}, $${r - 3}, $${r - 2}, $${r - 1}, $${r})`)
      }
    }

    await client.query(
      `INSERT INTO "JournalDoc" (id, "entityId", "sourceType", "updatedAt") VALUES ${docs.join(',')}`,
      docParams,
    )
    await client.query(
      `INSERT INTO "JournalEntry" (id, "entityId", "docId", version, kind, state, date, narration, action, "createdById", "createdAt") VALUES ${entries.join(',')}`,
      entryParams,
    )
    await client.query(
      `INSERT INTO "JournalLine" (id, "entryId", "accountId", debit, credit, "costCentreId") VALUES ${lines.join(',')}`,
      lineParams,
    )
    made += n
    if (made % 10000 === 0) process.stdout.write(`  ${made.toLocaleString('en-IN')}…\n`)
  }

  // Back-fill the doc→current-entry pointers once, not per batch: inside the
  // loop this re-scans every doc written so far and turns seeding quadratic.
  await client.query(
    `UPDATE "JournalDoc" d SET "currentEntryId" = e.id
     FROM "JournalEntry" e
     WHERE e."docId" = d.id AND d."entityId" = $1 AND d."currentEntryId" IS NULL`,
    [entityId],
  )

  await client.query(`ALTER TABLE "JournalLine" ENABLE TRIGGER USER`)
  await client.query(`ALTER TABLE "JournalEntry" ENABLE TRIGGER USER`)
  await client.query('COMMIT')
  await client.query('ANALYZE')
  console.log(`  seeded in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
}

async function main() {
  const url = process.env.DATABASE_URL!
  const client = new Client({ connectionString: url })
  await client.connect()
  // An open pg connection keeps Node alive, so a failure here would look like
  // a hang rather than an error. Always close it.
  try {
    await run(client)
  } finally {
    await client.end().catch(() => {})
    await prisma.$disconnect().catch(() => {})
  }
}

async function run(client: Client) {

  // Fresh perf entity every run.
  const existing = await prisma.entity.findUnique({ where: { code: ENTITY_CODE } })
  if (existing) {
    console.log('Clearing previous perf data…')
    await cleanup(client, existing.id)
  }

  const entity = await prisma.$transaction(async (tx) => {
    const e = await tx.entity.create({
      data: { name: 'Perf Bench', code: ENTITY_CODE, type: 'PVT_LTD', pan: 'AAAPP0001A' },
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
  const bank1 = await mk('1101', 'Perf ICICI', bankGroup)
  const bank2 = await mk('1102', 'Perf Axis', bankGroup)
  const cash = await mk('1201', 'Cash — Drawer', cashGroup)
  for (const [id, nickname, number] of [[bank1, 'Perf ICICI', '900000000001'], [bank2, 'Perf Axis', '900000000002']] as const) {
    await prisma.bankAccount.create({
      data: {
        entityId: entity.id, bankName: 'Perf', accountNumber: number, ifsc: 'PERF0000001',
        nickname, openingBalance: 0, openingDate: new Date('2021-04-01'), ledgerAccountId: id,
      },
    })
  }
  await prisma.cashLocation.create({
    data: { entityId: entity.id, name: 'Drawer', ledgerAccountId: cash },
  })
  const hyrox = (await prisma.costCentre.create({ data: { entityId: entity.id, name: 'Perf CC' } })).id
  const { getPartyAccount } = await import('../src/lib/ops/party')
  const debtor = (await prisma.$transaction((tx) => getPartyAccount(tx, entity.id, COA.DEBTORS_GROUP, 'Perf Customer'))).id
  const vendor = (await prisma.$transaction((tx) => getPartyAccount(tx, entity.id, COA.CREDITORS_GROUP, 'Perf Vendor'))).id

  const accounts = {
    bank1, bank2, cash, hyrox, debtor, vendor,
    fees: await acct('4100'), rent: await acct('5200'), food: await acct('5310'),
    travel: await acct('5300'), misc: await acct('5900'),
    output: await acct('2210'), itc: await acct('1500'),
  }

  await seed(client, entity.id, accounts)

  const counts = await client.query<{ entries: string; lines: string }>(`
    SELECT (SELECT count(*) FROM "JournalEntry" WHERE "entityId" = $1)::text AS entries,
           (SELECT count(*) FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId" WHERE e."entityId" = $1)::text AS lines
  `, [entity.id])
  console.log(
    `\nLedger: ${Number(counts.rows[0].entries).toLocaleString('en-IN')} entries, ` +
      `${Number(counts.rows[0].lines).toLocaleString('en-IN')} lines\n`,
  )

  const fy = { from: new Date('2024-04-01'), to: new Date('2025-03-31') }
  const timings: { label: string; ms: number }[] = []
  const t = async (label: string, fn: () => Promise<unknown>) => timings.push(await median(label, fn))

  console.log('Reports (one financial year):')
  await t('Trial balance', () => trialBalance(entity.id, fy))
  await t('Profit & Loss', () => profitAndLoss(entity.id, fy))
  await t('Balance Sheet (as at)', () => balanceSheet(entity.id, fy.to))
  await t('Cash Flow', () => cashFlow(entity.id, fy))
  await t('Cost centre report', () => costCentreReport(entity.id, fy))
  await t('Party ledgers', () => partyLedgers(entity.id, fy.to))
  await t('Bank ledger drill-down', () => accountLedger(bank1, fy))

  console.log('\nReports (all time — the worst case):')
  await t('Trial balance (all time)', () => trialBalance(entity.id, {}))
  await t('Balance Sheet (all time)', () => balanceSheet(entity.id, undefined))
  await t('Books tally check', () => booksTally(entity.id))

  console.log('\nDashboard and daily screens:')
  await t('Dashboard: balances', () => balanceTiles(entity.id))
  await t('Dashboard: queues', () => queueTiles(entity.id))
  await t('Dashboard: dues', () => duesTiles(entity.id))
  await t('Dashboard: receivables', () => receivableTiles(entity.id))
  await t('Payment source suggestion', () => suggestPaymentSource({ entityId: entity.id, module: 'bill' }))

  console.log('\nTax registers (one month):')
  const month = monthRange(2024, 7)
  await t('GSTR-3B', () => gstr3bView(entity.id, month))
  await t('TDS register', () => tdsRegister(entity.id, month))

  const tally = await booksTally(entity.id)
  console.log(`\nInvariant on the seeded ledger: Dr ${tally.debit} = Cr ${tally.credit} → ${tally.tallies ? 'OK' : 'MISMATCH'}`)

  const slow = timings.filter((x) => x.ms > BUDGET_MS)
  console.log(
    slow.length
      ? `\n${slow.length} query(ies) over ${BUDGET_MS}ms:\n` + slow.map((s) => `  ${s.label}: ${s.ms.toFixed(0)}ms`).join('\n')
      : `\nAll ${timings.length} queries within the ${BUDGET_MS}ms budget.`,
  )

  if (KEEP) {
    console.log(`\nLeaving perf data in place (entity ${ENTITY_CODE}). Remove with: npm run perf -- 0`)
  } else {
    console.log('\nCleaning up…')
    await cleanup(client, entity.id)
  }
  process.exitCode = slow.length || !tally.tallies ? 1 : 0
}

async function cleanup(client: Client, entityId: string) {
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

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
