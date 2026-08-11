// Phase 5 verification (spec §7 + §11): GST/TDS split-posting is exact to the
// paisa, registers reflect the ledger, filing locks the period, and the books
// still tally after every tax path.
import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { seedChartOfAccounts, COA } from '../src/lib/ledger/coa'
import { deleteJournalDocument } from '../src/lib/ledger/posting'
import { ledgerBalance } from '../src/lib/ops/party'
import { createBill } from '../src/lib/ops/bills'
import { createInvoice } from '../src/lib/ops/invoices'
import { upsertPerson, createRun, approveRun } from '../src/lib/ops/salary'
import { parseUpload, createStatementImport, confirmStatementImport } from '../src/lib/statements/import'
import { applyTag, postAllConfirmed } from '../src/lib/statements/post'
import { gstOnNet, splitGrossGst, tdsOnGross, grossFromNetTds, rateBp } from '../src/lib/tax/calc'
import { gstr1Summary, gstr3bView, tdsRegister, monthRange } from '../src/lib/tax/register'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function balanced(entityId: string) {
  const rows = await prisma.$queryRaw<{ debit: string | null; credit: string | null }[]>`
    SELECT SUM(l.debit)::text as debit, SUM(l.credit)::text as credit
    FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE e."entityId" = ${entityId}`
  return Number(rows[0]?.debit ?? 0) === Number(rows[0]?.credit ?? 0)
}

function csv(lines: string[]): Buffer {
  return Buffer.from(lines.join('\n'), 'utf8')
}

async function main() {
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })

  // --- Pure math first (no DB) ---
  check('math: GST on net 18% of 10000 = 1800', gstOnNet(1000000n, rateBp('18')) === 180000n)
  const split = splitGrossGst(1180000n, rateBp('18'))
  check('math: inclusive split of 11800 @18% = 10000 + 1800', split.taxable === 1000000n && split.gst === 180000n)
  check('math: TDS 10% on 50000 = 5000', tdsOnGross(5000000n, rateBp('10')) === 500000n)
  const gross = grossFromNetTds(4500000n, rateBp('10'))
  check('math: net 45000 after 10% TDS → gross 50000, tds 5000', gross.gross === 5000000n && gross.tds === 500000n)
  const odd = splitGrossGst(10000n, rateBp('5')) // ₹100 inclusive @5%
  check('math: rounding stays exact (taxable + gst = gross)', odd.taxable + odd.gst === 10000n, `${odd.taxable}+${odd.gst}`)

  // --- Setup ---
  const entity = await prisma.$transaction(async (tx) => {
    const e = await tx.entity.create({
      data: { name: 'Verify P5', code: 'VP5', type: 'PVT_LTD', pan: 'AAAPV0005A', gstin: '27AAAPV0005A1Z5' },
    })
    await seedChartOfAccounts(tx, e.id)
    return e
  })
  const account = (code: string) =>
    prisma.ledgerAccount.findUniqueOrThrow({
      where: { entityId_code: { entityId: entity.id, code } },
    })
  const bankGroup = await account('1100')
  const bankLedger = await prisma.ledgerAccount.create({
    data: { entityId: entity.id, code: '1101', name: 'VP5 Bank', kind: 'ASSET', parentId: bankGroup.id },
  })
  const bank = await prisma.bankAccount.create({
    data: {
      entityId: entity.id, bankName: 'Test', accountNumber: '555500002222', ifsc: 'TEST0000002',
      nickname: 'VP5 Bank', openingBalance: 0, openingDate: new Date('2026-06-01'),
      ledgerAccountId: bankLedger.id,
    },
  })
  const fees = await account('4100')
  const misc = await account('5900')
  const consultFees = await account('5110')
  const outputLiability = await account('2210')
  const inputCredit = await account('1500')
  const tdsPayable = await account(COA.TDS_PAYABLE)
  const tdsReceivable = await account('1600')

  // =========================================================================
  // §7.1 GST on an invoice (outward)
  // =========================================================================
  const invoice = await prisma.$transaction((tx) =>
    createInvoice(tx, {
      entityId: entity.id, customer: 'Acme Corp', date: new Date('2026-07-05'),
      dueDate: new Date('2026-08-04'), amount: '100000.00',
      incomeAccountId: fees.id, gstType: 'intra', gstRate: '18',
      hsn: '998311', customerGstin: '27AAACA1111A1Z1', actorId: admin.id,
    }),
  )
  check(
    'invoice GST: total = taxable + GST, stored split',
    String(invoice.amount) === '118000' && String(invoice.gstAmount) === '18000',
    `${invoice.amount} / ${invoice.gstAmount}`,
  )
  const debtor = await prisma.ledgerAccount.findFirstOrThrow({
    where: { entityId: entity.id, name: 'Acme Corp' },
  })
  const [debtorBal, incomeBal, outputBal] = await prisma.$transaction((tx) =>
    Promise.all([ledgerBalance(tx, debtor.id), ledgerBalance(tx, fees.id), ledgerBalance(tx, outputLiability.id)]),
  )
  check(
    'invoice GST: Dr Debtor 118000 / Cr Income 100000 / Cr Output 18000',
    Number(debtorBal) === 118000 && Number(incomeBal) === -100000 && Number(outputBal) === -18000,
    `${debtorBal} / ${incomeBal} / ${outputBal}`,
  )

  // =========================================================================
  // §7.1 GST + §7.2 TDS on a bill (inward)
  // =========================================================================
  const bill = await prisma.$transaction((tx) =>
    createBill(tx, {
      entityId: entity.id, vendor: 'Design Studio', billType: 'Professional fees',
      amount: '50000.00', billDate: new Date('2026-07-10'), dueDate: new Date('2026-07-25'),
      gstType: 'intra', gstRate: '18', hsn: '998314', vendorGstin: '27AAACD2222B1Z2',
      tdsSection: '194J', tdsRate: '10', vendorPan: 'AAACD2222B',
      actorId: admin.id,
    }),
  )
  check(
    'bill: GST 9000 + TDS 5000 computed on the taxable value (metadata only)',
    String(bill.gstAmount) === '9000' && String(bill.tdsAmount) === '5000',
    `${bill.gstAmount} / ${bill.tdsAmount}`,
  )
  // Bills are a document store: no vendor payable, no journal, no tax line —
  // GST/TDS reach the registers from the tagged statement row instead.
  check(
    'bill: document store — nothing posts, no vendor account created',
    (await prisma.ledgerAccount.findFirst({ where: { entityId: entity.id, name: 'Design Studio' } })) === null &&
      (await prisma.journalDoc.count({ where: { sourceType: 'bill', sourceId: bill.id } })) === 0,
  )

  // =========================================================================
  // Statement rows: inclusive GST expense + net-of-TDS payment (§3 step 5)
  // =========================================================================
  const statement = parseUpload('vp5.csv', csv([
    'Account Number: 555500002222',
    'Date,Particulars,Debit,Credit,Balance',
    '15/07/2026,AWS INDIA CLOUD SERVICES,11800.00,,100000.00',
    '16/07/2026,CONTRACTOR PAYMENT KUMAR,49000.00,,51000.00',
    '17/07/2026,CLIENT PAYOUT BETA LLP,,90000.00,141000.00',
  ]))
  const imp = await prisma.$transaction(async (tx) => {
    const { record } = await createStatementImport(tx, { fileName: 'vp5.csv', parsed: statement, actorId: admin.id })
    return record
  })
  await prisma.$transaction((tx) =>
    confirmStatementImport(tx, { importId: imp.id, bankAccountId: bank.id, actorId: admin.id }),
  )
  const [aws, contractor, payout] = await prisma.statementTransaction.findMany({
    where: { importId: imp.id }, orderBy: { date: 'asc' },
  })

  await prisma.$transaction((tx) =>
    applyTag(tx, {
      txnId: aws.id, headAccountId: misc.id, nature: 'expense',
      tax: { gstType: 'inter', gstRate: '18', hsn: '998315', counterpartyGstin: '29AAACA3333C1Z3' },
      actorId: admin.id,
    }),
  )
  await prisma.$transaction((tx) =>
    applyTag(tx, {
      txnId: contractor.id, headAccountId: consultFees.id, nature: 'expense',
      tax: { tdsSection: '194C', tdsRate: '2', deducteePan: 'AAAPK4444D' },
      actorId: admin.id,
    }),
  )
  await prisma.$transaction((tx) =>
    applyTag(tx, {
      txnId: payout.id, headAccountId: fees.id, nature: 'income',
      tax: { tdsSection: '194J', tdsRate: '10', deducteePan: 'AAACB5555E' },
      actorId: admin.id,
    }),
  )
  await prisma.$transaction((tx) =>
    applyTag(tx, {
      txnId: aws.id, headAccountId: misc.id, nature: 'transfer_own',
      tax: { gstRate: '18' }, actorId: admin.id,
    }),
  ).then(
    () => check('guard: tax details on a transfer row refused', false),
    (e) => check('guard: tax details on a transfer row refused', /expense \/ income/.test(String(e))),
  )
  await prisma.$transaction((tx) =>
    applyTag(tx, {
      txnId: aws.id, headAccountId: misc.id, nature: 'expense',
      tax: { gstRate: '18', tdsRate: '10', tdsSection: '194J' }, actorId: admin.id,
    }),
  ).then(
    () => check('guard: GST and TDS together refused', false),
    (e) => check('guard: GST and TDS together refused', /not both/.test(String(e))),
  )
  // restore the AWS tag the guard tests overwrote
  await prisma.$transaction((tx) =>
    applyTag(tx, {
      txnId: aws.id, headAccountId: misc.id, nature: 'expense',
      tax: { gstType: 'inter', gstRate: '18', hsn: '998315', counterpartyGstin: '29AAACA3333C1Z3' },
      actorId: admin.id,
    }),
  )

  const posted = await postAllConfirmed(entity.id, admin.id)
  check('statement tax rows post cleanly', posted.posted.length === 3 && posted.failed.length === 0, JSON.stringify(posted.failed))

  const awsDoc = await prisma.journalDoc.findFirstOrThrow({
    where: { sourceType: 'statement_txn', sourceId: aws.id },
    include: { currentEntry: { include: { lines: true } } },
  })
  const awsLines = awsDoc.currentEntry!.lines
  check(
    'statement GST: 11800 outflow splits into 10000 expense + 1800 ITC',
    awsLines.some((l) => l.accountId === misc.id && String(l.debit) === '10000') &&
      awsLines.some((l) => l.accountId === inputCredit.id && String(l.debit) === '1800') &&
      awsLines.some((l) => l.accountId === bankLedger.id && String(l.credit) === '11800'),
  )
  const contractorDoc = await prisma.journalDoc.findFirstOrThrow({
    where: { sourceType: 'statement_txn', sourceId: contractor.id },
    include: { currentEntry: { include: { lines: true } } },
  })
  const contractorLines = contractorDoc.currentEntry!.lines
  check(
    'statement TDS out: net 49000 → gross 50000 expense, 1000 TDS payable',
    contractorLines.some((l) => l.accountId === consultFees.id && String(l.debit) === '50000') &&
      contractorLines.some((l) => l.accountId === tdsPayable.id && String(l.credit) === '1000') &&
      contractorLines.some((l) => l.accountId === bankLedger.id && String(l.credit) === '49000'),
  )
  const payoutDoc = await prisma.journalDoc.findFirstOrThrow({
    where: { sourceType: 'statement_txn', sourceId: payout.id },
    include: { currentEntry: { include: { lines: true } } },
  })
  const payoutLines = payoutDoc.currentEntry!.lines
  check(
    'statement TDS in: 90000 received + 10000 TDS receivable = 100000 income',
    payoutLines.some((l) => l.accountId === bankLedger.id && String(l.debit) === '90000') &&
      payoutLines.some((l) => l.accountId === tdsReceivable.id && String(l.debit) === '10000') &&
      payoutLines.some((l) => l.accountId === fees.id && String(l.credit) === '100000'),
  )

  // =========================================================================
  // Salary TDS lands in the register too (§6.4 → §7.2)
  // =========================================================================
  await prisma.$transaction((tx) =>
    upsertPerson(tx, {
      entityId: entity.id, name: 'Asha', type: 'SALARY',
      monthlyGross: '80000.00', tdsRate: '10',
    }),
  )
  const run = await prisma.$transaction((tx) =>
    createRun(tx, { entityId: entity.id, year: 2026, month: 7, actorId: admin.id }),
  )
  await prisma.$transaction((tx) => approveRun(tx, { runId: run.id, actorId: admin.id }))

  // =========================================================================
  // §7.1/§7.2 Registers
  // =========================================================================
  const range = monthRange(2026, 7)
  const gstr1 = await gstr1Summary(entity.id, range)
  check(
    'GSTR-1: only outward supplies, rate-wise',
    gstr1.byRate.length === 1 && gstr1.byRate[0].rate === '18' &&
      gstr1.byRate[0].taxable === '100000.00' && gstr1.byRate[0].gst === '18000.00',
    JSON.stringify(gstr1.byRate),
  )
  const gstr3b = await gstr3bView(entity.id, range)
  check(
    'GSTR-3B: output 18000 − ITC 1800 (statement row) = 16200 net payable',
    gstr3b.outputLiability === '18000.00' && gstr3b.inputCredit === '1800.00' &&
      gstr3b.netPayable === '16200.00' && gstr3b.refundable === '0.00',
    JSON.stringify(gstr3b),
  )
  const register = await tdsRegister(entity.id, range)
  const bySection = Object.fromEntries(register.map((s) => [s.section, s.total]))
  check(
    'TDS register: by section (194C statement, 192 salary — bills feed nothing)',
    bySection['194J'] === undefined && bySection['194C'] === '1000.00' && bySection['192'] === '8000.00',
    JSON.stringify(bySection),
  )
  const c194 = register.find((s) => s.section === '194C')!
  check(
    'TDS register: deductee-wise with PAN',
    c194.deductees.some((d) => d.pan === 'AAAPK4444D' && d.tds === '1000.00'),
    JSON.stringify(c194.deductees),
  )

  // Deleting a taxed posting drops it from the registers (no phantom rows).
  await prisma.$transaction((tx) =>
    deleteJournalDocument(tx, { docId: awsDoc.id, actorId: admin.id }),
  )
  const gstr3bAfter = await gstr3bView(entity.id, range)
  check(
    'registers: deleting a taxed row removes its ITC (1800 → 0)',
    gstr3bAfter.inputCredit === '0.00' && gstr3bAfter.netPayable === '18000.00',
    JSON.stringify(gstr3bAfter),
  )

  // =========================================================================
  // §7.1 Filing locks the period (§11.5)
  // =========================================================================
  await prisma.periodLock.create({
    data: { entityId: entity.id, year: 2026, month: 7, lockedById: admin.id },
  })
  await prisma.$transaction((tx) =>
    createInvoice(tx, {
      entityId: entity.id, customer: 'Late Corp', date: new Date('2026-07-31'),
      dueDate: new Date('2026-08-30'), amount: '1000.00',
      incomeAccountId: fees.id, gstRate: '18', actorId: admin.id,
    }),
  ).then(
    () => check('§7.1 filed period rejects new postings', false),
    (e) => check('§7.1 filed period rejects new postings', /locked/.test(String(e))),
  )
  const gstr3bLocked = await gstr3bView(entity.id, range)
  check(
    '§11.5 filed period returns are immutable',
    gstr3bLocked.outputLiability === gstr3bAfter.outputLiability &&
      gstr3bLocked.netPayable === gstr3bAfter.netPayable,
  )

  check('§11.1 invariant after every tax path: Dr = Cr', await balanced(entity.id))

  // --- Clean up ---
  await prisma.periodLock.deleteMany({ where: { entityId: entity.id } })
  await prisma.taxLine.deleteMany({ where: { entityId: entity.id } })
  await prisma.invoicePayment.deleteMany({ where: { invoice: { entityId: entity.id } } })
  await prisma.invoice.deleteMany({ where: { entityId: entity.id } })
  await prisma.salaryRun.deleteMany({ where: { entityId: entity.id } })
  await prisma.salaryPerson.deleteMany({ where: { entityId: entity.id } })
  await prisma.bill.deleteMany({ where: { entityId: entity.id } })
  await prisma.statementImport.deleteMany({ where: { bankAccountId: bank.id } })
  await prisma.statementMapping.deleteMany({ where: { bankAccountId: bank.id } })
  await prisma.tagRule.deleteMany({ where: { entityId: entity.id } })
  await prisma.bankAccount.deleteMany({ where: { entityId: entity.id } })
  await prisma.$executeRaw`ALTER TABLE "JournalLine" DISABLE TRIGGER USER`
  await prisma.$executeRaw`ALTER TABLE "JournalEntry" DISABLE TRIGGER USER`
  await prisma.$executeRaw`DELETE FROM "JournalLine" WHERE "entryId" IN (SELECT id FROM "JournalEntry" WHERE "entityId" = ${entity.id})`
  await prisma.journalDoc.updateMany({ where: { entityId: entity.id }, data: { currentEntryId: null } })
  await prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "entityId" = ${entity.id}`
  await prisma.$executeRaw`ALTER TABLE "JournalLine" ENABLE TRIGGER USER`
  await prisma.$executeRaw`ALTER TABLE "JournalEntry" ENABLE TRIGGER USER`
  await prisma.journalDoc.deleteMany({ where: { entityId: entity.id } })
  await prisma.costCentre.deleteMany({ where: { entityId: entity.id } })
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
