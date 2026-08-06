// Phase 3 verification (spec §11):
//   §11.1 Invariant: total Dr = total Cr after any sequence of operations.
//   §11.2 Statement round-trip: correct auto-routing, dedupe, closing-balance.
//   §11.5 Period lock: locked month rejects posting.
//   §11.6 Tag-to-report trace: a tag lands in the ledger + cost centre report.
// Runs against the dev database through the real service layer.
import 'dotenv/config'
import * as XLSX from 'xlsx'
import { prisma } from '../src/lib/db'
import { seedChartOfAccounts } from '../src/lib/ledger/coa'
import { deleteJournalDocument, undoJournalDocument } from '../src/lib/ledger/posting'
import { parseStatementFile } from '../src/lib/statements/parse'
import {
  detectAccountForStatement,
  createStatementImport,
  confirmStatementImport,
  importBalanceCheck,
  parseUpload,
} from '../src/lib/statements/import'
import {
  applyTag,
  clearTag,
  postAllConfirmed,
  retagPostedTransaction,
} from '../src/lib/statements/post'

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

  // --- Setup: entity, two bank accounts, a cost centre ---
  const entity = await prisma.$transaction(async (tx) => {
    const e = await tx.entity.create({
      data: { name: 'Verify P3', code: 'VP3', type: 'INDIVIDUAL', pan: 'AAAPV0003A' },
    })
    await seedChartOfAccounts(tx, e.id)
    return e
  })
  const account = (code: string) =>
    prisma.ledgerAccount.findUniqueOrThrow({
      where: { entityId_code: { entityId: entity.id, code } },
    })
  const bankGroup = await account('1100')
  const [iciciLedger, axisLedger] = await prisma.$transaction((tx) =>
    Promise.all([
      tx.ledgerAccount.create({
        data: { entityId: entity.id, code: '1101', name: 'VP3 ICICI', kind: 'ASSET', parentId: bankGroup.id },
      }),
      tx.ledgerAccount.create({
        data: { entityId: entity.id, code: '1102', name: 'VP3 Axis', kind: 'ASSET', parentId: bankGroup.id },
      }),
    ]),
  )
  const icici = await prisma.bankAccount.create({
    data: {
      entityId: entity.id, bankName: 'ICICI Bank', accountNumber: '000901544321',
      ifsc: 'ICIC0000009', nickname: 'VP3 ICICI', openingBalance: 0,
      openingDate: new Date('2026-06-01'), ledgerAccountId: iciciLedger.id,
    },
  })
  const axis = await prisma.bankAccount.create({
    data: {
      entityId: entity.id, bankName: 'Axis Bank', accountNumber: '918010012345',
      ifsc: 'UTIB0000123', nickname: 'VP3 Axis', openingBalance: 0,
      openingDate: new Date('2026-06-01'), ledgerAccountId: axisLedger.id,
    },
  })
  const hyrox = await prisma.costCentre.create({
    data: { entityId: entity.id, name: 'Hyrox Project' },
  })

  // --- Statement A: ICICI CSV, Dr/Cr columns, account number in metadata ---
  const stmtA = csv([
    'ICICI Bank Limited',
    'Account Number: 000901544321',
    'Transaction Date,Transaction Remarks,Ref No./Cheque No,Withdrawal Amount,Deposit Amount,Balance',
    '01/07/2026,NEFT FROM ACME CONSULTING,N001,,50000.00,50000.00',
    '02/07/2026,UPI/512345/SWIGGY LTD/swiggy@ybl,U001,500.00,,49500.00',
    '02/07/2026,UPI/512345/SWIGGY LTD/swiggy@ybl,U002,500.00,,49000.00',
    '03/07/2026,IMPS TRANSFER TO VP3 AXIS,I001,10000.00,,39000.00',
    '04/07/2026,ATM WDL 123456,,1000.00,,38000.00',
  ])
  const parsedA = parseStatementFile('icici-jul.csv', stmtA)
  check('CSV parse: 5 rows extracted', parsedA.rows.length === 5)
  check('CSV parse: closing balance from last row', parsedA.closingBalance === '38000.00', parsedA.closingBalance)
  check(
    'CSV parse: Dr/Cr columns split correctly',
    parsedA.rows[0].credit === '50000.00' && parsedA.rows[1].debit === '500.00',
  )

  const importA = await prisma.$transaction(async (tx) => {
    const { record, detection } = await createStatementImport(tx, {
      fileName: 'icici-jul.csv', parsed: parsedA, actorId: admin.id,
    })
    check('§11.2 detection: routed via account number', detection.via === 'account_number')
    check('§11.2 detection: right account + entity', detection.bankAccountId === icici.id && detection.entityId === entity.id)
    return record
  })
  const confirmA = await prisma.$transaction((tx) =>
    confirmStatementImport(tx, { importId: importA.id, bankAccountId: icici.id, actorId: admin.id }),
  )
  check('confirm A: 5 rows materialized, none duplicate', confirmA.created === 5 && confirmA.duplicates === 0)
  const swiggyRows = await prisma.statementTransaction.findMany({
    where: { importId: importA.id, narration: { contains: 'SWIGGY' } },
    orderBy: { reference: 'asc' },
  })
  check('same-file identical rows both kept (occurrence hash)', swiggyRows.length === 2)

  // --- Re-import the same file: everything is "previously imported" ---
  const importA2 = await prisma.$transaction(async (tx) => {
    const { record } = await createStatementImport(tx, {
      fileName: 'icici-jul.csv', parsed: parsedA, actorId: admin.id,
    })
    return record
  })
  const confirmA2 = await prisma.$transaction((tx) =>
    confirmStatementImport(tx, { importId: importA2.id, bankAccountId: icici.id, actorId: admin.id }),
  )
  check('§11.2 dedupe: re-import creates 0, flags 5 previously imported', confirmA2.created === 0 && confirmA2.duplicates === 5)

  // --- Tag guards ---
  const txnsA = await prisma.statementTransaction.findMany({
    where: { importId: importA.id }, orderBy: { date: 'asc' },
  })
  const [neft, swiggy1, swiggy2, transfer, atm] = txnsA
  const expenses = await account('5310')
  const income = await account('4100')
  const misc = await account('5900')
  const groupHead = await account('5000')
  await prisma.$transaction((tx) =>
    applyTag(tx, { txnId: neft.id, headAccountId: groupHead.id, nature: 'income', actorId: admin.id }),
  ).then(
    () => check('guard: tagging to a group head rejected', false),
    (e) => check('guard: tagging to a group head rejected', /group head/.test(String(e))),
  )
  await prisma.$transaction((tx) => clearTag(tx, neft.id)).then(
    () => check('guard: untagging a pending row rejected', false),
    (e) => check('guard: untagging a pending row rejected', /Only tagged/.test(String(e))),
  )

  // --- Tag statement A (spec §3 step 5) ---
  await prisma.$transaction(async (tx) => {
    await applyTag(tx, { txnId: neft.id, headAccountId: income.id, nature: 'income', actorId: admin.id })
    await applyTag(tx, { txnId: swiggy1.id, headAccountId: expenses.id, nature: 'expense', costCentreId: hyrox.id, actorId: admin.id })
    await applyTag(tx, { txnId: swiggy2.id, headAccountId: expenses.id, nature: 'expense', costCentreId: hyrox.id, actorId: admin.id })
    await applyTag(tx, { txnId: transfer.id, headAccountId: axisLedger.id, nature: 'transfer_own', actorId: admin.id })
    await applyTag(tx, { txnId: atm.id, headAccountId: misc.id, nature: 'expense', actorId: admin.id })
  })
  const swiggyRule = await prisma.tagRule.findUnique({
    where: { entityId_pattern: { entityId: entity.id, pattern: 'SWIGGY' } },
  })
  check(
    'learning engine: manual tag creates the SWIGGY rule (head + cost centre)',
    swiggyRule?.headAccountId === expenses.id && swiggyRule?.costCentreId === hyrox.id,
  )

  // --- Post All Confirmed (spec §3 step 6) ---
  const postA = await postAllConfirmed(entity.id, admin.id)
  check('post all: 5 posted, 0 failed', postA.posted.length === 5 && postA.failed.length === 0, JSON.stringify(postA.failed))

  const incomeDoc = await prisma.journalDoc.findFirst({
    where: { entityId: entity.id, sourceType: 'statement_txn', sourceId: neft.id },
    include: { currentEntry: { include: { lines: true } } },
  })
  const incomeLines = incomeDoc?.currentEntry?.lines ?? []
  check(
    'posting rule income: Dr Bank / Cr Income head',
    incomeLines.some((l) => l.accountId === iciciLedger.id && String(l.debit) === '50000') &&
      incomeLines.some((l) => l.accountId === income.id && String(l.credit) === '50000'),
  )
  const expenseDoc = await prisma.journalDoc.findFirst({
    where: { entityId: entity.id, sourceType: 'statement_txn', sourceId: swiggy1.id },
    include: { currentEntry: { include: { lines: true } } },
  })
  const expenseLines = expenseDoc?.currentEntry?.lines ?? []
  check(
    'posting rule expense: Dr Expense head / Cr Bank, cost centre on head line',
    expenseLines.some((l) => l.accountId === expenses.id && String(l.debit) === '500' && l.costCentreId === hyrox.id) &&
      expenseLines.some((l) => l.accountId === iciciLedger.id && String(l.credit) === '500'),
  )
  await prisma.$transaction((tx) =>
    applyTag(tx, { txnId: neft.id, headAccountId: income.id, nature: 'income', actorId: admin.id }),
  ).then(
    () => check('guard: re-tagging a posted row rejected (use retag)', false),
    (e) => check('guard: re-tagging a posted row rejected (use retag)', /retag/.test(String(e))),
  )

  // --- Statement B: Axis XLSX, single amount + Dr/Cr marker, masked a/c ---
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Axis Bank Statement'],
      ['A/c No: XX2345'],
      ['Tran Date', 'Particulars', 'Chq No', 'Amount', 'Dr / Cr', 'Balance'],
      ['03/07/2026', 'IMPS FROM VP3 ICICI', '', '10000.00', 'CR', '10000.00'],
    ]),
    'Sheet1',
  )
  const parsedB = parseStatementFile('axis-jul.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
  check('XLSX parse: amount + Dr/Cr marker layout', parsedB.rows.length === 1 && parsedB.rows[0].credit === '10000.00')
  const importB = await prisma.$transaction(async (tx) => {
    const { record, detection } = await createStatementImport(tx, {
      fileName: 'axis-jul.xlsx', parsed: parsedB, actorId: admin.id,
    })
    check('§11.2 detection: masked account number (XX2345)', detection.via === 'account_number' && detection.bankAccountId === axis.id)
    return record
  })
  await prisma.$transaction((tx) =>
    confirmStatementImport(tx, { importId: importB.id, bankAccountId: axis.id, actorId: admin.id }),
  )
  const axisTxn = await prisma.statementTransaction.findFirstOrThrow({ where: { importId: importB.id } })
  await prisma.$transaction((tx) =>
    applyTag(tx, { txnId: axisTxn.id, headAccountId: iciciLedger.id, nature: 'transfer_own', actorId: admin.id }),
  )
  const docsBefore = await prisma.journalDoc.count({ where: { entityId: entity.id } })
  const postB = await postAllConfirmed(entity.id, admin.id)
  const docsAfter = await prisma.journalDoc.count({ where: { entityId: entity.id } })
  const [transferAfter, axisAfter] = await Promise.all([
    prisma.statementTransaction.findUniqueOrThrow({ where: { id: transfer.id } }),
    prisma.statementTransaction.findUniqueOrThrow({ where: { id: axisTxn.id } }),
  ])
  check('own-transfer mirror: second side posts without a second journal', postB.posted.length === 1 && docsAfter === docsBefore)
  check(
    'own-transfer mirror: both rows linked, mirror row carries no doc',
    transferAfter.mirrorTxnId === axisTxn.id && axisAfter.mirrorTxnId === transfer.id && axisAfter.docId === null && axisAfter.status === 'POSTED',
  )
  await prisma.$transaction((tx) =>
    retagPostedTransaction(tx, { txnId: axisTxn.id, headAccountId: misc.id, nature: 'expense', actorId: admin.id }),
  ).then(
    () => check('guard: retagging the mirror side rejected', false),
    (e) => check('guard: retagging the mirror side rejected', /other/.test(String(e))),
  )

  // --- Statement C: auto-verify from the learned rule (spec §3 step 4) ---
  const stmtC = csv([
    'ICICI Bank Limited',
    'Account Number: 000901544321',
    'Transaction Date,Transaction Remarks,Ref No./Cheque No,Withdrawal Amount,Deposit Amount,Balance',
    '05/07/2026,UPI/998877/SWIGGY LTD/swiggy@ybl,U003,500.00,,37500.00',
  ])
  const parsedC = parseUpload('icici-jul2.csv', stmtC)
  const importC = await prisma.$transaction(async (tx) => {
    const { record } = await createStatementImport(tx, { fileName: 'icici-jul2.csv', parsed: parsedC, actorId: admin.id })
    return record
  })
  const confirmC = await prisma.$transaction((tx) =>
    confirmStatementImport(tx, { importId: importC.id, bankAccountId: icici.id, actorId: admin.id }),
  )
  const swiggyC = await prisma.statementTransaction.findFirstOrThrow({ where: { importId: importC.id } })
  check(
    'auto-verify: rule match tags the row "Verified by System"',
    confirmC.autoTagged === 1 && swiggyC.status === 'TAGGED' && swiggyC.autoTagged &&
      swiggyC.headAccountId === expenses.id && swiggyC.costCentreId === hyrox.id,
  )
  const ruleAfterC = await prisma.tagRule.findUniqueOrThrow({ where: { id: swiggyRule!.id } })
  check('learning engine: rule hit count grows', ruleAfterC.hits >= 1)

  // --- Closing-balance validation (spec §3 step 3) ---
  const impC = await prisma.statementImport.findUniqueOrThrow({ where: { id: importC.id } })
  const heldOpen = await importBalanceCheck(impC)
  check(
    'closing balance: held open before posting, difference shown',
    heldOpen !== null && !heldOpen.matched && heldOpen.difference === '-500.00',
    JSON.stringify(heldOpen),
  )
  await postAllConfirmed(entity.id, admin.id)
  const resolved = await importBalanceCheck(impC)
  check('§11.2 closing balance matches ledger after full posting', resolved !== null && resolved.matched, JSON.stringify(resolved))

  // --- Unrecognized statement → Admin maps once → remembered (spec §3 step 2) ---
  const stmtD = csv([
    'Date,Description,Debit,Credit,Balance',
    '06/07/2026,POS AMAZON PAY,200.00,,9800.00',
  ])
  const parsedD = parseUpload('mystery.csv', stmtD)
  const importD = await prisma.$transaction(async (tx) => {
    const { record, detection } = await createStatementImport(tx, { fileName: 'mystery.csv', parsed: parsedD, actorId: admin.id })
    check('unrecognized statement: flagged, not silently routed', detection.via === 'unrecognized' && record.bankAccountId === null)
    return record
  })
  await prisma.$transaction((tx) =>
    confirmStatementImport(tx, { importId: importD.id, bankAccountId: axis.id, actorId: admin.id, rememberMapping: true }),
  )
  const mapping = await prisma.statementMapping.findUnique({ where: { signature: parsedD.headerSignature } })
  check('mapping remembered after Admin maps it once', mapping?.bankAccountId === axis.id)
  const stmtE = csv([
    'Date,Description,Debit,Credit,Balance',
    '07/07/2026,POS AMAZON,100.00,,9700.00',
  ])
  const parsedE = parseUpload('mystery2.csv', stmtE)
  const detectionE = await prisma.$transaction((tx) => detectAccountForStatement(tx, parsedE))
  check('next unrecognized upload auto-routes via mapping', detectionE.via === 'mapping' && detectionE.bankAccountId === axis.id)
  const importE = await prisma.$transaction(async (tx) => {
    const { record } = await createStatementImport(tx, { fileName: 'mystery2.csv', parsed: parsedE, actorId: admin.id })
    return record
  })
  await prisma.$transaction((tx) =>
    confirmStatementImport(tx, { importId: importE.id, bankAccountId: axis.id, actorId: admin.id }),
  )
  const [amazonD, amazonE] = await Promise.all([
    prisma.statementTransaction.findFirstOrThrow({ where: { importId: importD.id } }),
    prisma.statementTransaction.findFirstOrThrow({ where: { importId: importE.id } }),
  ])
  await prisma.$transaction(async (tx) => {
    await applyTag(tx, { txnId: amazonD.id, headAccountId: misc.id, nature: 'expense', actorId: admin.id })
    await applyTag(tx, { txnId: amazonE.id, headAccountId: misc.id, nature: 'expense', actorId: admin.id })
  })
  await postAllConfirmed(entity.id, admin.id)
  const impE = await prisma.statementImport.findUniqueOrThrow({ where: { id: importE.id } })
  const axisBalance = await importBalanceCheck(impE)
  check('§11.2 round-trip on second account: closing balance matches', axisBalance !== null && axisBalance.matched, JSON.stringify(axisBalance))

  // --- Period lock (spec §11.5) ---
  await prisma.periodLock.create({
    data: { entityId: entity.id, year: 2026, month: 8, lockedById: admin.id },
  })
  const stmtF = csv([
    'ICICI Bank Limited',
    'Account Number: 000901544321',
    'Transaction Date,Transaction Remarks,Ref No./Cheque No,Withdrawal Amount,Deposit Amount,Balance',
    '01/08/2026,RENT PAYMENT AUG,R001,5000.00,,32500.00',
  ])
  const parsedF = parseUpload('icici-aug.csv', stmtF)
  const importF = await prisma.$transaction(async (tx) => {
    const { record } = await createStatementImport(tx, { fileName: 'icici-aug.csv', parsed: parsedF, actorId: admin.id })
    return record
  })
  await prisma.$transaction((tx) =>
    confirmStatementImport(tx, { importId: importF.id, bankAccountId: icici.id, actorId: admin.id }),
  )
  const rentTxn = await prisma.statementTransaction.findFirstOrThrow({ where: { importId: importF.id } })
  const rent = await account('5200')
  await prisma.$transaction((tx) =>
    applyTag(tx, { txnId: rentTxn.id, headAccountId: rent.id, nature: 'expense', actorId: admin.id }),
  )
  const postLocked = await postAllConfirmed(entity.id, admin.id)
  check(
    '§11.5 locked month rejects posting; batch reports the row, not a crash',
    postLocked.posted.length === 0 && postLocked.failed.length === 1 && /locked/.test(postLocked.failed[0].error),
    JSON.stringify(postLocked),
  )
  await prisma.periodLock.deleteMany({ where: { entityId: entity.id } })
  const postUnlocked = await postAllConfirmed(entity.id, admin.id)
  check(
    'unlock: same row posts cleanly',
    postUnlocked.posted.length === 1 && postUnlocked.failed.length === 0,
    JSON.stringify(postUnlocked),
  )

  // --- Retag a posted row (spec §5 edit = reversal + new version) ---
  const gym = await account('5320')
  await prisma.$transaction((tx) =>
    retagPostedTransaction(tx, {
      txnId: swiggyC.id, headAccountId: gym.id, nature: 'expense', costCentreId: hyrox.id, actorId: admin.id,
    }),
  )
  const retagged = await prisma.statementTransaction.findUniqueOrThrow({ where: { id: swiggyC.id } })
  const retagDoc = await prisma.journalDoc.findUniqueOrThrow({
    where: { id: retagged.docId! },
    include: { entries: true, currentEntry: { include: { lines: true } } },
  })
  check(
    'retag: reversal + new version underneath, head updated',
    retagged.headAccountId === gym.id &&
      retagDoc.entries.some((e) => e.kind === 'REVERSAL') &&
      (retagDoc.currentEntry?.lines ?? []).some((l) => l.accountId === gym.id && String(l.debit) === '500'),
  )
  check('retag keeps the books balanced', await balanced(entity.id))
  const ruleRetrained = await prisma.tagRule.findUniqueOrThrow({ where: { id: swiggyRule!.id } })
  check('learning engine: correction retrains the rule', ruleRetrained.headAccountId === gym.id)

  // --- Cost centre trace (spec §11.6): tag → report ---
  const ccRows = await prisma.$queryRaw<{ net: string | null }[]>`
    SELECT (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0))::text as net
    FROM "JournalLine" l WHERE l."costCentreId" = ${hyrox.id}`
  check(
    '§11.6 cost centre report: three tagged Swiggy rows net ₹1500 (reversals cancel)',
    Number(ccRows[0]?.net ?? 0) === 1500,
    ccRows[0]?.net ?? '0',
  )

  // --- Delete + undo a posted transaction (spec §5) ---
  const amazonD2 = await prisma.statementTransaction.findUniqueOrThrow({ where: { id: amazonD.id } })
  await prisma.$transaction((tx) =>
    deleteJournalDocument(tx, { docId: amazonD2.docId!, actorId: admin.id }),
  )
  const deletedDoc = await prisma.journalDoc.findUniqueOrThrow({ where: { id: amazonD2.docId! } })
  check('delete posted txn: doc soft-deleted, reversal posted', deletedDoc.deletedAt !== null && (await balanced(entity.id)))
  await prisma.$transaction((tx) =>
    undoJournalDocument(tx, { docId: amazonD2.docId!, actorId: admin.id }),
  )
  const restoredDoc = await prisma.journalDoc.findUniqueOrThrow({
    where: { id: amazonD2.docId! },
    include: { currentEntry: { include: { lines: true } } },
  })
  check(
    'undo restores the deleted posting exactly',
    restoredDoc.deletedAt === null &&
      (restoredDoc.currentEntry?.lines ?? []).some((l) => l.accountId === misc.id && String(l.debit) === '200'),
  )

  // --- §11.1: the invariant, after everything above ---
  check('§11.1 invariant after the full pipeline: Dr = Cr', await balanced(entity.id))

  // --- Clean up test data ---
  await prisma.statementImport.deleteMany({ where: { bankAccountId: { in: [icici.id, axis.id] } } })
  await prisma.statementMapping.deleteMany({ where: { bankAccountId: { in: [icici.id, axis.id] } } })
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
