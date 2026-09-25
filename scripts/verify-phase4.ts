// Phase 4 verification (spec §6 + §11.1): each operations module posts the
// right journal through the real service layer, party ledgers stay live, and
// the books tally after everything.
import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { seedChartOfAccounts, COA } from '../src/lib/ledger/coa'
import { deleteJournalDocument, undoJournalDocument } from '../src/lib/ledger/posting'
import { getPartyAccount, ledgerBalance } from '../src/lib/ops/party'
import {
  submitClaim, approveClaim, rejectClaim, recordMemberMoney, memberAdvanceName,
  submitAdvanceReceived, approveAdvance, deleteRecord,
} from '../src/lib/ops/reimburse'
import { createCashEntry, cashBalances } from '../src/lib/ops/cash'
import { createBill, payBill } from '../src/lib/ops/bills'
import { upsertPerson, createRun, updateRunLine, approveRun, payRun } from '../src/lib/ops/salary'
import { createInvoice, recordInvoicePayment, agingBucket } from '../src/lib/ops/invoices'

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

async function main() {
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })

  // --- Setup: entity, bank, two cash locations, cost centre, a member ---
  const entity = await prisma.$transaction(async (tx) => {
    const e = await tx.entity.create({
      data: { name: 'Verify P4', code: 'VP4', type: 'INDIVIDUAL', pan: 'AAAPV0004A' },
    })
    await seedChartOfAccounts(tx, e.id)
    return e
  })
  const account = (code: string) =>
    prisma.ledgerAccount.findUniqueOrThrow({
      where: { entityId_code: { entityId: entity.id, code } },
    })
  const bankGroup = await account('1100')
  const cashGroup = await account('1200')
  const bankLedger = await prisma.ledgerAccount.create({
    data: { entityId: entity.id, code: '1101', name: 'VP4 Bank', kind: 'ASSET', parentId: bankGroup.id },
  })
  await prisma.bankAccount.create({
    data: {
      entityId: entity.id, bankName: 'Test', accountNumber: '999900001111', ifsc: 'TEST0000001',
      nickname: 'VP4 Bank', openingBalance: 0, openingDate: new Date('2026-06-01'),
      ledgerAccountId: bankLedger.id,
    },
  })
  const [drawerLedger, lockerLedger] = await prisma.$transaction((tx) =>
    Promise.all([
      tx.ledgerAccount.create({ data: { entityId: entity.id, code: '1201', name: 'Cash — Drawer', kind: 'ASSET', parentId: cashGroup.id } }),
      tx.ledgerAccount.create({ data: { entityId: entity.id, code: '1202', name: 'Cash — Locker', kind: 'ASSET', parentId: cashGroup.id } }),
    ]),
  )
  const drawer = await prisma.cashLocation.create({
    data: { entityId: entity.id, name: 'Drawer', ledgerAccountId: drawerLedger.id },
  })
  const locker = await prisma.cashLocation.create({
    data: { entityId: entity.id, name: 'Locker', ledgerAccountId: lockerLedger.id },
  })
  const hyrox = await prisma.costCentre.create({ data: { entityId: entity.id, name: 'VP4 Hyrox' } })
  const member = await prisma.user.create({
    data: { name: 'VP4 Member', email: 'vp4-member@test.local', passwordHash: 'x', role: 'MEMBER' },
  })
  const travel = await account('5300')
  const misc = await account('5900')
  const otherIncome = await account('4900')
  const fees = await account('4100')

  // =========================================================================
  // §6.1 Reimbursements
  // =========================================================================
  const claim = await prisma.$transaction((tx) =>
    submitClaim(tx, {
      entityId: entity.id, memberId: member.id, date: new Date('2026-07-05'),
      category: 'Travel', amount: '1200.00', remarks: 'Client visit',
    }),
  )
  check('reimburse: claim submitted PENDING', claim.status === 'PENDING')

  const approved = await prisma.$transaction((tx) =>
    approveClaim(tx, { claimId: claim.id, expenseAccountId: travel.id, costCentreId: hyrox.id, actorId: admin.id }),
  )
  const payable = await prisma.ledgerAccount.findFirstOrThrow({
    where: { entityId: entity.id, name: memberAdvanceName(member.name) },
  })
  const payableParent = await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: payable.parentId! } })
  check('reimburse: approve posts, advance account auto-created under 1400', approved.status === 'APPROVED' && approved.docId !== null && payableParent.code === COA.ADVANCES_GROUP)
  const owed = await prisma.$transaction((tx) => ledgerBalance(tx, payable.id))
  check('reimburse: live member balance = −claim (owed to member)', Number(owed) === -1200, owed)

  const claim2 = await prisma.$transaction((tx) =>
    submitClaim(tx, {
      entityId: entity.id, memberId: member.id, date: new Date('2026-07-06'),
      category: 'Food', amount: '300.00',
    }),
  )
  await prisma.$transaction((tx) =>
    rejectClaim(tx, { claimId: claim2.id, reason: '', actorId: admin.id }),
  ).then(
    () => check('reimburse: reject without remarks refused', false),
    (e) => check('reimburse: reject without remarks refused', /remarks/.test(String(e))),
  )
  const rejected = await prisma.$transaction((tx) =>
    rejectClaim(tx, { claimId: claim2.id, reason: 'No bill attached', actorId: admin.id }),
  )
  check('reimburse: reject stores remarks, posts nothing', rejected.status === 'REJECTED' && rejected.docId === null)
  await prisma.$transaction((tx) =>
    approveClaim(tx, { claimId: claim.id, expenseAccountId: travel.id, actorId: admin.id }),
  ).then(
    () => check('reimburse: double review refused', false),
    (e) => check('reimburse: double review refused', /already reviewed/.test(String(e))),
  )

  await prisma.$transaction((tx) =>
    recordMemberMoney(tx, {
      entityId: entity.id, memberId: member.id, amount: '1200.00', direction: 'paid',
      date: new Date('2026-07-10'), sourceAccountId: bankLedger.id, actorId: admin.id,
    }),
  )
  const owedAfter = await prisma.$transaction((tx) => ledgerBalance(tx, payable.id))
  check('reimburse: settlement clears the member balance', Number(owedAfter) === 0, owedAfter)
  await prisma.$transaction((tx) =>
    recordMemberMoney(tx, {
      entityId: entity.id, memberId: member.id, amount: '5000.00', direction: 'paid',
      date: new Date('2026-07-11'), sourceAccountId: bankLedger.id, actorId: admin.id,
    }),
  )
  const advance = await prisma.$transaction((tx) => ledgerBalance(tx, payable.id))
  check('reimburse: advance paid shows as Dr balance with member', Number(advance) === 5000, advance)
  await prisma.$transaction((tx) =>
    recordMemberMoney(tx, {
      entityId: entity.id, memberId: member.id, amount: '5000.00', direction: 'received',
      date: new Date('2026-07-12'), sourceAccountId: bankLedger.id, actorId: admin.id,
    }),
  )
  const returned = await prisma.$transaction((tx) => ledgerBalance(tx, payable.id))
  check('reimburse: advance returned brings balance back to zero', Number(returned) === 0, returned)
  const recorded = await prisma.$transaction((tx) =>
    submitAdvanceReceived(tx, {
      entityId: entity.id, memberId: member.id, date: new Date('2026-07-13'), amount: '2000.00', remarks: 'cash',
    }),
  )
  check('reimburse: member-recorded advance is PENDING, posts nothing', recorded.kind === 'ADVANCE' && recorded.status === 'PENDING' && recorded.docId === null)
  await prisma.$transaction((tx) =>
    approveClaim(tx, { claimId: recorded.id, expenseAccountId: travel.id, actorId: admin.id }),
  ).then(
    () => check('reimburse: advance record cannot be approved as a claim', false),
    (e) => check('reimburse: advance record cannot be approved as a claim', /paying account/.test(String(e))),
  )
  const confirmed = await prisma.$transaction((tx) =>
    approveAdvance(tx, { claimId: recorded.id, sourceAccountId: bankLedger.id, actorId: admin.id }),
  )
  const afterConfirm = await prisma.$transaction((tx) => ledgerBalance(tx, payable.id))
  check('reimburse: confirming a recorded advance posts Dr member / Cr bank', confirmed.status === 'APPROVED' && confirmed.docId !== null && Number(afterConfirm) === 2000, afterConfirm)
  await prisma.$transaction((tx) =>
    deleteRecord(tx, { claimId: recorded.id, actor: { id: admin.id + '-someone-else', isAdmin: false } }),
  ).then(
    () => check('reimburse: member cannot delete someone else’s record', false),
    (e) => check('reimburse: member cannot delete someone else’s record', /own records/.test(String(e))),
  )
  await prisma.$transaction((tx) =>
    deleteRecord(tx, { claimId: recorded.id, actor: { id: admin.id, isAdmin: true } }),
  )
  const afterRecordDelete = await prisma.$transaction((tx) => ledgerBalance(tx, payable.id))
  const gone = await prisma.reimbursement.findUnique({ where: { id: recorded.id } })
  check('reimburse: admin delete reverses the posting and removes the record', gone === null && Number(afterRecordDelete) === 0, afterRecordDelete)

  // =========================================================================
  // §6.2 Cash
  // =========================================================================
  await prisma.$transaction((tx) =>
    createCashEntry(tx, {
      entityId: entity.id, kind: 'RECEIPT', date: new Date('2026-07-01'),
      locationId: drawer.id, headAccountId: otherIncome.id, amount: '5000.00', actorId: admin.id,
    }),
  )
  const payment = await prisma.$transaction((tx) =>
    createCashEntry(tx, {
      entityId: entity.id, kind: 'PAYMENT', date: new Date('2026-07-02'),
      locationId: drawer.id, headAccountId: misc.id, costCentreId: hyrox.id,
      amount: '800.00', actorId: admin.id,
    }),
  )
  await prisma.$transaction((tx) =>
    createCashEntry(tx, {
      entityId: entity.id, kind: 'TRANSFER', date: new Date('2026-07-03'),
      locationId: drawer.id, toLocationId: locker.id, amount: '1000.00', actorId: admin.id,
    }),
  )
  await prisma.$transaction((tx) =>
    createCashEntry(tx, {
      entityId: entity.id, kind: 'ADJUSTMENT', date: new Date('2026-07-04'),
      locationId: locker.id, headAccountId: misc.id, amount: '50.00', actorId: admin.id,
    }),
  ).then(
    () => check('cash: adjustment without reason refused', false),
    (e) => check('cash: adjustment without reason refused', /reason/.test(String(e))),
  )
  await prisma.$transaction((tx) =>
    createCashEntry(tx, {
      entityId: entity.id, kind: 'ADJUSTMENT', date: new Date('2026-07-04'),
      locationId: locker.id, headAccountId: misc.id, amount: '50.00',
      reason: 'Count shortfall', actorId: admin.id,
    }),
  )
  const balances = await cashBalances(entity.id)
  const drawerBal = balances.perLocation.find((b) => b.locationId === drawer.id)?.balance
  const lockerBal = balances.perLocation.find((b) => b.locationId === locker.id)?.balance
  check('cash: where-is-cash per location', drawerBal === '3200.00' && lockerBal === '950.00', `drawer ${drawerBal}, locker ${lockerBal}`)
  check('cash: total across locations', balances.total === '4150.00', balances.total)

  await prisma.$transaction((tx) =>
    deleteJournalDocument(tx, { docId: payment.docId!, actorId: admin.id }),
  )
  const afterDelete = await cashBalances(entity.id)
  check('cash: delete reverses (drawer back up)', afterDelete.perLocation.find((b) => b.locationId === drawer.id)?.balance === '4000.00')
  await prisma.$transaction((tx) =>
    undoJournalDocument(tx, { docId: payment.docId!, actorId: admin.id }),
  )
  const afterUndo = await cashBalances(entity.id)
  check('cash: undo restores the payment', afterUndo.perLocation.find((b) => b.locationId === drawer.id)?.balance === '3200.00')

  // =========================================================================
  // §6.3 Bills
  // =========================================================================
  const bill = await prisma.$transaction((tx) =>
    createBill(tx, {
      entityId: entity.id, vendor: 'Tata Power', billType: 'Electricity',
      amount: '2400.00', billDate: new Date('2026-07-01'), dueDate: new Date('2026-07-15'),
      recurrence: 'MONTHLY', actorId: admin.id,
    }),
  )
  // Bills are a document store: nothing posts, no vendor payable appears —
  // the expense reaches the books from the tagged statement row instead.
  const billDocs = await prisma.journalDoc.count({ where: { sourceType: 'bill', sourceId: bill.id } })
  const vendorAccount = await prisma.ledgerAccount.findFirst({
    where: { entityId: entity.id, name: 'Tata Power' },
  })
  check('bills: document store — nothing posts, no vendor payable created', billDocs === 0 && vendorAccount === null)

  const { nextBill } = await prisma.$transaction((tx) =>
    payBill(tx, { billId: bill.id, date: new Date('2026-07-14'), actorId: admin.id }),
  )
  const paymentDocs = await prisma.journalDoc.count({ where: { sourceType: 'bill_payment', sourceId: bill.id } })
  check(
    'bills: mark paid flips status without posting',
    paymentDocs === 0 &&
      (await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).status === 'PAID',
  )
  check(
    'bills: recurring spawns next month PENDING',
    nextBill !== null && nextBill.status === 'PENDING' &&
      nextBill.dueDate.toISOString().slice(0, 10) === '2026-08-15' &&
      nextBill.seriesId === bill.id,
    nextBill?.dueDate.toISOString().slice(0, 10),
  )
  await prisma.$transaction((tx) =>
    payBill(tx, { billId: bill.id, date: new Date('2026-07-15'), actorId: admin.id }),
  ).then(
    () => check('bills: double payment refused', false),
    (e) => check('bills: double payment refused', /already paid/.test(String(e))),
  )

  // =========================================================================
  // §6.4 Salary
  // =========================================================================
  const emp = await prisma.$transaction((tx) =>
    upsertPerson(tx, {
      entityId: entity.id, name: 'Asha', type: 'SALARY', team: 'Ops',
      costCentreId: hyrox.id, monthlyGross: '50000.00', tdsRate: '10',
    }),
  )
  const consultant = await prisma.$transaction((tx) =>
    upsertPerson(tx, {
      entityId: entity.id, name: 'Ravi', type: 'CONSULTANT',
      monthlyGross: '30000.00', tdsRate: '10',
    }),
  )
  check('salary: sections auto-assigned', emp.tdsSection === '192' && consultant.tdsSection === '194J')

  const run = await prisma.$transaction((tx) =>
    createRun(tx, { entityId: entity.id, year: 2026, month: 7, actorId: admin.id }),
  )
  const ashaLine = run.lines.find((l) => l.personId === emp.id)!
  check('salary: draft computes TDS + net', String(ashaLine.tds) === '5000' && String(ashaLine.net) === '45000', `${ashaLine.tds}/${ashaLine.net}`)

  await prisma.$transaction((tx) =>
    updateRunLine(tx, { lineId: ashaLine.id, gross: '52000.00', tds: '5200.00' }),
  )
  await prisma.$transaction((tx) => approveRun(tx, { runId: run.id, actorId: admin.id }))
  const tdsPayable = await account(COA.TDS_PAYABLE)
  const tdsBal = await prisma.$transaction((tx) => ledgerBalance(tx, tdsPayable.id))
  check('salary: approve credits total TDS payable', Number(tdsBal) === -(5200 + 3000), tdsBal)
  const ashaPayable = await prisma.ledgerAccount.findFirstOrThrow({
    where: { entityId: entity.id, name: 'Payable — Asha' },
  })
  const ashaOwed = await prisma.$transaction((tx) => ledgerBalance(tx, ashaPayable.id))
  check('salary: per-person net payable posted', Number(ashaOwed) === -46800, ashaOwed)
  await prisma.$transaction((tx) =>
    payRun(tx, { runId: run.id, date: new Date('2026-07-31'), sourceAccountId: bankLedger.id, actorId: admin.id }),
  )
  const ashaAfter = await prisma.$transaction((tx) => ledgerBalance(tx, ashaPayable.id))
  const runAfter = await prisma.salaryRun.findUniqueOrThrow({ where: { id: run.id } })
  check('salary: mark-paid clears payables, run PAID', Number(ashaAfter) === 0 && runAfter.status === 'PAID')
  await prisma.$transaction((tx) => approveRun(tx, { runId: run.id, actorId: admin.id })).then(
    () => check('salary: double approve refused', false),
    (e) => check('salary: double approve refused', /already approved/.test(String(e))),
  )


  // =========================================================================
  // §6.6 Invoices
  // =========================================================================
  const inv1 = await prisma.$transaction((tx) =>
    createInvoice(tx, {
      entityId: entity.id, customer: 'Acme Corp', date: new Date('2026-07-01'),
      dueDate: new Date('2026-07-31'), amount: '60000.00',
      incomeAccountId: fees.id, costCentreId: hyrox.id, actorId: admin.id,
    }),
  )
  const inv2 = await prisma.$transaction((tx) =>
    createInvoice(tx, {
      entityId: entity.id, customer: 'Beta LLP', date: new Date('2026-07-02'),
      dueDate: new Date('2026-08-01'), amount: '10000.00',
      incomeAccountId: fees.id, actorId: admin.id,
    }),
  )
  check('invoices: sequential auto numbering', inv1.number === 'INV-0001' && inv2.number === 'INV-0002', `${inv1.number}, ${inv2.number}`)
  const debtor = await prisma.ledgerAccount.findFirstOrThrow({
    where: { entityId: entity.id, name: 'Acme Corp' },
  })
  const debtorParent = await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: debtor.parentId! } })
  const receivable = await prisma.$transaction((tx) => ledgerBalance(tx, debtor.id))
  check('invoices: Dr Debtor under 1300 / Cr Income', debtorParent.code === COA.DEBTORS_GROUP && Number(receivable) === 60000, receivable)

  await prisma.$transaction((tx) =>
    recordInvoicePayment(tx, {
      invoiceId: inv1.id, date: new Date('2026-07-20'), amount: '70000.00',
      sourceAccountId: bankLedger.id, actorId: admin.id,
    }),
  ).then(
    () => check('invoices: overpayment refused', false),
    (e) => check('invoices: overpayment refused', /exceeds/.test(String(e))),
  )
  const partial = await prisma.$transaction((tx) =>
    recordInvoicePayment(tx, {
      invoiceId: inv1.id, date: new Date('2026-07-20'), amount: '40000.00',
      sourceAccountId: bankLedger.id, actorId: admin.id,
    }),
  )
  const inv1Partial = await prisma.invoice.findUniqueOrThrow({ where: { id: inv1.id } })
  check('invoices: partial payment → PARTIAL', !partial.settled && inv1Partial.status === 'PARTIAL')
  const final = await prisma.$transaction((tx) =>
    recordInvoicePayment(tx, {
      invoiceId: inv1.id, date: new Date('2026-08-02'), amount: '20000.00',
      sourceAccountId: bankLedger.id, actorId: admin.id,
    }),
  )
  const inv1Settled = await prisma.invoice.findUniqueOrThrow({ where: { id: inv1.id } })
  const debtorAfter = await prisma.$transaction((tx) => ledgerBalance(tx, debtor.id))
  check('invoices: full payment settles, debtor at zero', final.settled && inv1Settled.status === 'SETTLED' && Number(debtorAfter) === 0)
  check(
    'invoices: aging buckets',
    agingBucket(new Date('2026-08-10'), new Date('2026-08-06')) === 'current' &&
      agingBucket(new Date('2026-08-01'), new Date('2026-08-06')) === '1–30' &&
      agingBucket(new Date('2026-06-20'), new Date('2026-08-06')) === '31–60' &&
      agingBucket(new Date('2026-03-01'), new Date('2026-08-06')) === '90+',
  )

  // Party account reuse: same vendor/customer maps to the same ledger account.
  const debtor2 = await prisma.$transaction((tx) =>
    getPartyAccount(tx, entity.id, COA.DEBTORS_GROUP, 'Acme Corp'),
  )
  check('party ledgers: same party reuses its account', debtor2.id === debtor.id)

  // =========================================================================
  // §11.1 The invariant, after every module
  // =========================================================================
  check('§11.1 invariant across all operations: Dr = Cr', await balanced(entity.id))

  // --- Clean up ---
  await prisma.invoicePayment.deleteMany({ where: { invoice: { entityId: entity.id } } })
  await prisma.invoice.deleteMany({ where: { entityId: entity.id } })
  await prisma.salaryRun.deleteMany({ where: { entityId: entity.id } })
  await prisma.salaryPerson.deleteMany({ where: { entityId: entity.id } })
  await prisma.bill.deleteMany({ where: { entityId: entity.id } })
  await prisma.cashEntry.deleteMany({ where: { entityId: entity.id } })
  await prisma.reimbursement.deleteMany({ where: { entityId: entity.id } })
  await prisma.bankAccount.deleteMany({ where: { entityId: entity.id } })
  await prisma.cashLocation.deleteMany({ where: { entityId: entity.id } })
  await prisma.user.delete({ where: { id: member.id } })
  await prisma.$executeRaw`ALTER TABLE "JournalLine" DISABLE TRIGGER USER`
  await prisma.$executeRaw`ALTER TABLE "JournalEntry" DISABLE TRIGGER USER`
  await prisma.$executeRaw`DELETE FROM "JournalLine" WHERE "entryId" IN (SELECT id FROM "JournalEntry" WHERE "entityId" = ${entity.id})`
  await prisma.journalDoc.updateMany({ where: { entityId: entity.id }, data: { currentEntryId: null } })
  await prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "entityId" = ${entity.id}`
  await prisma.$executeRaw`ALTER TABLE "JournalLine" ENABLE TRIGGER USER`
  await prisma.$executeRaw`ALTER TABLE "JournalEntry" ENABLE TRIGGER USER`
  await prisma.journalDoc.deleteMany({ where: { entityId: entity.id } })
  await prisma.costCentre.deleteMany({ where: { entityId: entity.id } })
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
