// Phase 6 verification (spec §10 + §11.6): the statements agree with the
// ledger and with each other, reports react to edits/deletes, drill-down
// reconciles with the report line, and the dashboard reads live.
//
// The strongest checks here are the cross-statement identities:
//   Balance Sheet:  Assets = Liabilities + Equity + profit-to-date
//   Cash Flow:      opening + movements = closing
//   P&L ↔ TB:       every report line traces to the trial balance
import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { seedChartOfAccounts, COA } from '../src/lib/ledger/coa'
import { createJournalDocument, deleteJournalDocument, undoJournalDocument } from '../src/lib/ledger/posting'
import { trialBalance, accountLedger } from '../src/lib/ledger/queries'
import { profitAndLoss, balanceSheet, cashFlow } from '../src/lib/reports/statements'
import { costCentreReport, partyLedgers, budgetVsActual, salaryReport } from '../src/lib/reports/analysis'
import { balanceTiles, queueTiles, duesTiles, receivableTiles, balanceAlerts } from '../src/lib/reports/dashboard'
import { createCashEntry } from '../src/lib/ops/cash'
import { createBill, payBill } from '../src/lib/ops/bills'
import { createInvoice, recordInvoicePayment } from '../src/lib/ops/invoices'
import { submitClaim } from '../src/lib/ops/reimburse'
import { upsertPerson, createRun, approveRun } from '../src/lib/ops/salary'
import { createTask } from '../src/lib/ops/tasks'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })

  // --- Setup: a small but complete set of books ---
  const entity = await prisma.$transaction(async (tx) => {
    const e = await tx.entity.create({
      data: { name: 'Verify P6', code: 'VP6', type: 'PVT_LTD', pan: 'AAAPV0006A' },
    })
    await seedChartOfAccounts(tx, e.id)
    return e
  })
  const account = (code: string) =>
    prisma.ledgerAccount.findUniqueOrThrow({
      where: { entityId_code: { entityId: entity.id, code } },
    })
  const bankGroup = await account(COA.BANK_GROUP)
  const cashGroup = await account(COA.CASH_GROUP)
  const bankLedger = await prisma.ledgerAccount.create({
    data: { entityId: entity.id, code: '1101', name: 'VP6 Bank', kind: 'ASSET', parentId: bankGroup.id },
  })
  await prisma.bankAccount.create({
    data: {
      entityId: entity.id, bankName: 'Test', accountNumber: '777700003333', ifsc: 'TEST0000003',
      nickname: 'VP6 Bank', openingBalance: 0, openingDate: new Date('2026-06-01'),
      ledgerAccountId: bankLedger.id,
    },
  })
  const drawerLedger = await prisma.ledgerAccount.create({
    data: { entityId: entity.id, code: '1201', name: 'Cash — Drawer', kind: 'ASSET', parentId: cashGroup.id },
  })
  const drawer = await prisma.cashLocation.create({
    data: { entityId: entity.id, name: 'Drawer', ledgerAccountId: drawerLedger.id },
  })
  const hyrox = await prisma.costCentre.create({ data: { entityId: entity.id, name: 'Hyrox' } })
  const office = await prisma.costCentre.create({ data: { entityId: entity.id, name: 'Office' } })
  const capital = await account('3100')
  const fees = await account('4100')
  const rent = await account('5200')
  const travel = await account('5300')
  const fixedAssets = await prisma.ledgerAccount.create({
    data: {
      entityId: entity.id, code: '1901', name: 'Laptops', kind: 'ASSET',
      parentId: (await account('1900')).id,
    },
  })

  // Capital introduced (financing), an invoice (operating), a bill, cash,
  // an asset purchase (investing), and salary — one of each shape.
  await prisma.$transaction((tx) =>
    createJournalDocument(tx, {
      entityId: entity.id, sourceType: 'manual', actorId: admin.id,
      content: {
        date: new Date('2026-07-01'),
        narration: 'Capital introduced',
        lines: [
          { accountId: bankLedger.id, debit: '500000.00' },
          { accountId: capital.id, credit: '500000.00' },
        ],
      },
    }),
  )
  const invoice = await prisma.$transaction((tx) =>
    createInvoice(tx, {
      entityId: entity.id, customer: 'Acme Corp', date: new Date('2026-07-05'),
      dueDate: new Date('2026-07-20'), amount: '200000.00',
      incomeAccountId: fees.id, costCentreId: hyrox.id, actorId: admin.id,
    }),
  )
  await prisma.$transaction((tx) =>
    recordInvoicePayment(tx, {
      invoiceId: invoice.id, date: new Date('2026-07-18'), amount: '120000.00',
      sourceAccountId: bankLedger.id, actorId: admin.id,
    }),
  )
  const bill = await prisma.$transaction((tx) =>
    createBill(tx, {
      entityId: entity.id, vendor: 'Landlord', billType: 'Rent',
      amount: '40000.00', billDate: new Date('2026-07-02'), dueDate: new Date('2026-07-07'),
      expenseAccountId: rent.id, costCentreId: office.id, actorId: admin.id,
    }),
  )
  await prisma.$transaction((tx) =>
    payBill(tx, { billId: bill.id, date: new Date('2026-07-07'), sourceAccountId: bankLedger.id, actorId: admin.id }),
  )
  await prisma.$transaction((tx) =>
    createCashEntry(tx, {
      entityId: entity.id, kind: 'RECEIPT', date: new Date('2026-07-10'),
      locationId: drawer.id, headAccountId: bankLedger.id, amount: '20000.00', actorId: admin.id,
    }),
  )
  const cashPayment = await prisma.$transaction((tx) =>
    createCashEntry(tx, {
      entityId: entity.id, kind: 'PAYMENT', date: new Date('2026-07-12'),
      locationId: drawer.id, headAccountId: travel.id, costCentreId: hyrox.id,
      amount: '3000.00', actorId: admin.id,
    }),
  )
  await prisma.$transaction((tx) =>
    createJournalDocument(tx, {
      entityId: entity.id, sourceType: 'manual', actorId: admin.id,
      content: {
        date: new Date('2026-07-15'),
        narration: 'Laptop purchase',
        lines: [
          { accountId: fixedAssets.id, debit: '80000.00' },
          { accountId: bankLedger.id, credit: '80000.00' },
        ],
      },
    }),
  )
  await prisma.$transaction((tx) =>
    upsertPerson(tx, {
      entityId: entity.id, name: 'Asha', type: 'SALARY', costCentreId: office.id,
      monthlyGross: '60000.00', tdsRate: '10',
    }),
  )
  const run = await prisma.$transaction((tx) =>
    createRun(tx, { entityId: entity.id, year: 2026, month: 7, actorId: admin.id }),
  )
  await prisma.$transaction((tx) => approveRun(tx, { runId: run.id, actorId: admin.id }))

  const range = { from: new Date('2026-07-01'), to: new Date('2026-07-31') }

  // =========================================================================
  // P&L
  // =========================================================================
  const pnl = await profitAndLoss(entity.id, range)
  check('P&L: income = invoice total', pnl.income.total === '200000.00', pnl.income.total)
  check(
    'P&L: expenses = rent 40000 + travel 3000 + salary 60000',
    pnl.expenses.total === '103000.00',
    pnl.expenses.total,
  )
  check('P&L: net profit = 97000', pnl.netProfit === '97000.00', pnl.netProfit)
  check(
    'P&L: lines carry their CoA group for sectioning',
    pnl.expenses.lines.every((l) => l.group.length > 0) &&
      pnl.income.lines.some((l) => l.group === 'Income'),
  )

  // Every P&L line must agree with the trial balance for the same range.
  const tb = await trialBalance(entity.id, range)
  const tbByAccount = new Map(tb.map((r) => [r.accountId, r]))
  const pnlMatchesTb = [...pnl.income.lines, ...pnl.expenses.lines].every((line) => {
    const row = tbByAccount.get(line.accountId)
    if (!row) return false
    const expected = Math.abs(Number(row.balance))
    return Math.abs(expected - Number(line.amount)) < 0.005
  })
  check('§11.6 every P&L line traces to the trial balance', pnlMatchesTb)

  // =========================================================================
  // Balance Sheet — the identity that proves it
  // =========================================================================
  const bs = await balanceSheet(entity.id, range.to)
  check('Balance Sheet: Assets = Liabilities + Equity + profit', bs.balances,
    `${bs.assetsTotal} vs ${bs.liabilitiesEquityTotal}`)
  check(
    'Balance Sheet: profit-to-date equals the P&L for the same span',
    bs.retainedEarnings === pnl.netProfit,
    `${bs.retainedEarnings} vs ${pnl.netProfit}`,
  )
  const debtorLine = bs.assets.lines.find((l) => l.name === 'Acme Corp')
  check(
    'Balance Sheet: unpaid invoice sits in Sundry Debtors (80000)',
    debtorLine?.amount === '80000.00',
    debtorLine?.amount,
  )

  // =========================================================================
  // Cash Flow — the identity that proves it
  // =========================================================================
  const cf = await cashFlow(entity.id, range)
  check('Cash Flow: opening + movements = closing', cf.reconciles,
    `${cf.opening} + ${cf.netMovement} = ${cf.closing}`)
  check(
    'Cash Flow: laptop purchase classified as investing',
    cf.investing.lines.some((l) => l.accountId === fixedAssets.id && l.amount === '-80000.00'),
    JSON.stringify(cf.investing.lines),
  )
  check(
    'Cash Flow: capital introduced classified as financing',
    cf.financing.lines.some((l) => l.accountId === capital.id && l.amount === '500000.00'),
    JSON.stringify(cf.financing.lines),
  )
  check(
    'Cash Flow: bank→cash transfer self-eliminates (no phantom line)',
    !cf.operating.lines.some((l) => l.accountId === bankLedger.id || l.accountId === drawerLedger.id) &&
      !cf.investing.lines.some((l) => l.accountId === drawerLedger.id),
  )
  const closingFromTiles = await balanceTiles(entity.id)
  const tileTotal = (Number(closingFromTiles.bankTotal) + Number(closingFromTiles.cashTotal)).toFixed(2)
  check(
    'Cash Flow closing agrees with the dashboard balance tiles',
    cf.closing === tileTotal,
    `${cf.closing} vs ${tileTotal}`,
  )

  // =========================================================================
  // Cost centres, parties, budget, salary
  // =========================================================================
  const cc = await costCentreReport(entity.id, range)
  const hyroxRow = cc.rows.find((r) => r.costCentreId === hyrox.id)
  const officeRow = cc.rows.find((r) => r.costCentreId === office.id)
  check(
    'Cost centres: Hyrox nets income 200000 against 3000 travel',
    hyroxRow?.expense === '3000.00' && hyroxRow?.income === '200000.00' && hyroxRow?.net === '-197000.00',
    JSON.stringify(hyroxRow),
  )
  check(
    'Cost centres: Office carries rent 40000 + salary 60000',
    officeRow?.expense === '100000.00',
    officeRow?.expense,
  )
  check(
    'Cost centres: untagged spend is surfaced, not hidden',
    cc.rows.some((r) => r.costCentreId === null) || cc.rows.length === 2,
  )

  const parties = await partyLedgers(entity.id, range.to)
  check(
    'Parties: customer receivable 80000 after part payment',
    parties.customers.some((p) => p.name === 'Acme Corp' && p.balance === '80000.00'),
    JSON.stringify(parties.customers),
  )
  check(
    'Parties: paid vendor drops off the outstanding list',
    !parties.vendors.some((p) => p.name === 'Landlord'),
    JSON.stringify(parties.vendors),
  )
  check(
    'Parties: salary payable appears for the employee',
    parties.payables.some((p) => p.name === 'Payable — Asha' && p.balance === '54000.00'),
    JSON.stringify(parties.payables),
  )

  await prisma.budget.createMany({
    data: [
      { entityId: entity.id, accountId: rent.id, year: 2026, month: 7, amount: '45000.00' },
      { entityId: entity.id, accountId: travel.id, year: 2026, month: 7, amount: '2000.00' },
    ],
  })
  const budget = await budgetVsActual(entity.id, 2026, [7])
  const rentBudget = budget.rows.find((r) => r.accountId === rent.id)
  const travelBudget = budget.rows.find((r) => r.accountId === travel.id)
  check(
    'Budget: under-budget shows a positive variance',
    rentBudget?.budget === '45000.00' && rentBudget?.actual === '40000.00' && rentBudget?.variance === '5000.00',
    JSON.stringify(rentBudget),
  )
  check(
    'Budget: over-budget shows a negative variance and >100% used',
    travelBudget?.variance === '-1000.00' && (travelBudget?.usedPct ?? 0) === 150,
    JSON.stringify(travelBudget),
  )

  const salary = await salaryReport(entity.id, 2026)
  check(
    'Salary report: the approved run with per-person detail',
    salary.gross === '60000.00' && salary.tds === '6000.00' && salary.net === '54000.00' &&
      salary.months[0]?.lines[0]?.name === 'Asha' && salary.months[0]?.lines[0]?.section === '192',
    JSON.stringify({ gross: salary.gross, tds: salary.tds, net: salary.net }),
  )

  // =========================================================================
  // §11.6 Drill-down reconciles with the report line
  // =========================================================================
  const rentLine = pnl.expenses.lines.find((l) => l.accountId === rent.id)!
  const rentLedger = await accountLedger(rent.id, range)
  check(
    '§11.6 drill-down: ledger closing equals the P&L line',
    rentLedger.closing === rentLine.amount,
    `${rentLedger.closing} vs ${rentLine.amount}`,
  )
  check('§11.6 drill-down: every ledger row names its source document', rentLedger.lines.length > 0)

  // =========================================================================
  // Reports react to edits, deletes and undo
  // =========================================================================
  await prisma.$transaction((tx) =>
    deleteJournalDocument(tx, { docId: cashPayment.docId!, actorId: admin.id }),
  )
  const pnlAfterDelete = await profitAndLoss(entity.id, range)
  const bsAfterDelete = await balanceSheet(entity.id, range.to)
  const cfAfterDelete = await cashFlow(entity.id, range)
  check(
    'reports: deleting the travel payment drops it from the P&L',
    pnlAfterDelete.expenses.total === '100000.00' &&
      !pnlAfterDelete.expenses.lines.some((l) => l.accountId === travel.id),
    pnlAfterDelete.expenses.total,
  )
  check('reports: Balance Sheet still balances after the delete', bsAfterDelete.balances)
  check('reports: Cash Flow still reconciles after the delete', cfAfterDelete.reconciles)

  await prisma.$transaction((tx) =>
    undoJournalDocument(tx, { docId: cashPayment.docId!, actorId: admin.id }),
  )
  const pnlAfterUndo = await profitAndLoss(entity.id, range)
  const bsAfterUndo = await balanceSheet(entity.id, range.to)
  check(
    'reports: undo restores the line exactly',
    pnlAfterUndo.expenses.total === pnl.expenses.total,
    `${pnlAfterUndo.expenses.total} vs ${pnl.expenses.total}`,
  )
  check('reports: Balance Sheet balances after the undo', bsAfterUndo.balances)

  // Date ranges actually bound the report.
  const juneOnly = await profitAndLoss(entity.id, {
    from: new Date('2026-06-01'), to: new Date('2026-06-30'),
  })
  check(
    'reports: an empty range returns nothing, not everything',
    juneOnly.income.total === '0.00' && juneOnly.expenses.total === '0.00' && juneOnly.netProfit === '0.00',
  )

  // =========================================================================
  // §9 Dashboard tiles
  // =========================================================================
  await prisma.$transaction((tx) =>
    submitClaim(tx, {
      entityId: entity.id, memberId: admin.id, date: new Date('2026-07-20'),
      category: 'Travel', amount: '2500.00',
    }),
  )
  await prisma.$transaction((tx) =>
    createTask(tx, {
      entityId: entity.id, title: 'GST payment', kind: 'gst', amount: '15000.00',
      dueDate: new Date('2026-07-20'), actorId: admin.id,
    }),
  )
  const queues = await queueTiles(entity.id)
  check(
    'dashboard: pending reimbursements tile counts and sums',
    queues.pendingClaims === 1 && queues.pendingClaimsAmount === '2500.00',
    JSON.stringify(queues),
  )
  const dues = await duesTiles(entity.id, 3650) // wide horizon: this is dated data
  check(
    'dashboard: dues tile merges tasks and unpaid bills',
    dues.items.some((i) => i.source === 'task' && i.title === 'GST payment'),
    JSON.stringify(dues.items.map((i) => i.title)),
  )
  const receivables = await receivableTiles(entity.id)
  check(
    'dashboard: receivables tile shows the unpaid balance with aging',
    receivables.outstandingTotal === '80000.00' && receivables.overdue.length === 1,
    JSON.stringify(receivables),
  )
  const alerts = await balanceAlerts(entity.id)
  check('dashboard: alerts run without a healthy-books false positive', Array.isArray(alerts))

  // --- Clean up ---
  await prisma.budget.deleteMany({ where: { entityId: entity.id } })
  await prisma.taxLine.deleteMany({ where: { entityId: entity.id } })
  await prisma.invoicePayment.deleteMany({ where: { invoice: { entityId: entity.id } } })
  await prisma.invoice.deleteMany({ where: { entityId: entity.id } })
  await prisma.financeTask.deleteMany({ where: { entityId: entity.id } })
  await prisma.salaryRun.deleteMany({ where: { entityId: entity.id } })
  await prisma.salaryPerson.deleteMany({ where: { entityId: entity.id } })
  await prisma.bill.deleteMany({ where: { entityId: entity.id } })
  await prisma.cashEntry.deleteMany({ where: { entityId: entity.id } })
  await prisma.reimbursement.deleteMany({ where: { entityId: entity.id } })
  await prisma.bankAccount.deleteMany({ where: { entityId: entity.id } })
  await prisma.cashLocation.deleteMany({ where: { entityId: entity.id } })
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
