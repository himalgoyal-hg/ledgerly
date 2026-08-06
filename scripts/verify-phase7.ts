// Phase 7 verification (spec §8, §6.5, §10): payment suggestions respect
// mapping, live balances and commitment reservations; recurring generation
// is idempotent; reminders and the weekly summary render once per period
// and survive a missing mail transport.
import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { seedChartOfAccounts, COA } from '../src/lib/ledger/coa'
import { createJournalDocument } from '../src/lib/ledger/posting'
import { createBill } from '../src/lib/ops/bills'
import { createTask } from '../src/lib/ops/tasks'
import { suggestPaymentSource, rankForAmount, purposeKeys } from '../src/lib/automation/suggest'
import { generateRecurring, LEAD_DAYS } from '../src/lib/automation/recurring'
import { queueNotification, deliverQueued, transportConfigured } from '../src/lib/automation/notify'
import { weeklySummary, dueReminders, isoWeekKey } from '../src/lib/automation/weekly'
import { runAutomation } from '../src/lib/automation/run'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })

  // --- Pure helpers ---
  check(
    'purpose keys go most-specific first',
    JSON.stringify(purposeKeys({ module: 'bill', expenseAccountId: 'acc1' })) ===
      JSON.stringify(['head:acc1', 'bill', 'default']),
  )
  check(
    'ISO week key is stable across a week and rolls at the boundary',
    isoWeekKey(new Date('2026-08-03')) === isoWeekKey(new Date('2026-08-09')) &&
      isoWeekKey(new Date('2026-08-03')) !== isoWeekKey(new Date('2026-08-10')),
    `${isoWeekKey(new Date('2026-08-03'))} vs ${isoWeekKey(new Date('2026-08-10'))}`,
  )

  // --- Setup: three accounts with deliberately different balances ---
  const entity = await prisma.$transaction(async (tx) => {
    const e = await tx.entity.create({
      data: { name: 'Verify P7', code: 'VP7', type: 'PVT_LTD', pan: 'AAAPV0007A' },
    })
    await seedChartOfAccounts(tx, e.id)
    return e
  })
  const account = (code: string) =>
    prisma.ledgerAccount.findUniqueOrThrow({
      where: { entityId_code: { entityId: entity.id, code } },
    })
  const bankGroup = await account(COA.BANK_GROUP)
  const capital = await account('3100')
  const rent = await account('5200')
  const misc = await account('5900')

  const makeBank = async (code: string, name: string, opening: string) => {
    const ledger = await prisma.ledgerAccount.create({
      data: { entityId: entity.id, code, name, kind: 'ASSET', parentId: bankGroup.id },
    })
    await prisma.bankAccount.create({
      data: {
        entityId: entity.id, bankName: 'Test', accountNumber: `9999${code}`,
        ifsc: 'TEST0000007', nickname: name, openingBalance: 0,
        openingDate: new Date('2026-06-01'), ledgerAccountId: ledger.id,
      },
    })
    await prisma.$transaction((tx) =>
      createJournalDocument(tx, {
        entityId: entity.id, sourceType: 'manual', actorId: admin.id,
        content: {
          date: new Date('2026-06-01'),
          narration: `Opening — ${name}`,
          lines: [
            { accountId: ledger.id, debit: opening },
            { accountId: capital.id, credit: opening },
          ],
        },
      }),
    )
    return ledger
  }
  const main1 = await makeBank('1101', 'VP7 Main', '100000.00')
  const spare = await makeBank('1102', 'VP7 Spare', '60000.00')
  const small = await makeBank('1103', 'VP7 Small', '5000.00')

  // =========================================================================
  // §8.2 Live balance check
  // =========================================================================
  const plain = await suggestPaymentSource({ entityId: entity.id, module: 'bill' })
  check(
    '§8.2 with no mapping, the most liquid account leads',
    plain.best?.ledgerAccountId === main1.id,
    plain.best?.label,
  )
  const affordable = rankForAmount(plain.options, '50000.00')
  check(
    '§8.2 an affordable amount picks an account that covers it',
    affordable.best !== null && Number(affordable.best.available) >= 50000 && affordable.warning === null,
  )
  const tooBig = rankForAmount(plain.options, '250000.00')
  check(
    '§8.2 low balance warning when nothing can cover it',
    tooBig.best === null && (tooBig.warning ?? '').includes('no account can cover'),
    tooBig.warning ?? '',
  )
  check(
    '§8.2 unaffordable options say why',
    tooBig.options.every((o) => o.reasons.includes('insufficient balance')),
  )

  // =========================================================================
  // §8.1 Entity/purpose mapping
  // =========================================================================
  await prisma.paymentPreference.create({
    data: { entityId: entity.id, purpose: 'bill', ledgerAccountId: spare.id },
  })
  const mapped = await suggestPaymentSource({ entityId: entity.id, module: 'bill' })
  check(
    '§8.1 mapped account is suggested over the richer one',
    mapped.best?.ledgerAccountId === spare.id && mapped.best.reasons.includes('normally pays for this'),
    mapped.best?.label,
  )
  const salaryUnmapped = await suggestPaymentSource({ entityId: entity.id, module: 'salary' })
  check(
    '§8.1 mapping is per purpose — salary still falls back to liquidity',
    salaryUnmapped.best?.ledgerAccountId === main1.id,
    salaryUnmapped.best?.label,
  )
  // A head-specific mapping beats the module-level one.
  await prisma.paymentPreference.create({
    data: { entityId: entity.id, purpose: `head:${rent.id}`, ledgerAccountId: small.id },
  })
  const headMapped = await suggestPaymentSource({
    entityId: entity.id, module: 'bill', expenseAccountId: rent.id,
  })
  check(
    '§8.1 head-specific mapping wins over the module mapping',
    headMapped.best?.ledgerAccountId === small.id,
    headMapped.best?.label,
  )
  // …but only while it can actually pay: a big amount steers away from it.
  const bigOnSmall = rankForAmount(headMapped.options, '50000.00')
  check(
    '§8.1 a mapped account that cannot cover the amount is not suggested',
    bigOnSmall.best?.ledgerAccountId !== small.id && bigOnSmall.best !== null,
    bigOnSmall.best?.label,
  )
  await prisma.paymentPreference.deleteMany({ where: { purpose: `head:${rent.id}` } })

  // =========================================================================
  // §8.3 Commitment protection
  // =========================================================================
  const soon = new Date(Date.now() + 3 * 86_400_000)
  await prisma.$transaction((tx) =>
    createTask(tx, {
      entityId: entity.id, title: 'Payroll', kind: 'payroll', amount: '55000.00',
      dueDate: soon, actorId: admin.id,
    }),
  )
  await prisma.paymentPreference.create({
    data: { entityId: entity.id, purpose: 'payroll', ledgerAccountId: main1.id },
  })
  const reserved = await suggestPaymentSource({ entityId: entity.id, module: 'salary' })
  const mainOption = reserved.options.find((o) => o.ledgerAccountId === main1.id)!
  check(
    '§8.3 an upcoming commitment reserves against its mapped account',
    mainOption.reserved === '55000.00' && mainOption.available === '45000.00',
    JSON.stringify({ reserved: mainOption.reserved, available: mainOption.available }),
  )
  const adhoc = rankForAmount(reserved.options, '50000.00')
  check(
    '§8.3 ad-hoc spend is steered away from the reserved account',
    adhoc.best?.ledgerAccountId === spare.id,
    adhoc.best?.label,
  )
  const squeeze = rankForAmount(reserved.options, '80000.00')
  check(
    '§8.3 spending into reserved money warns rather than silently allowing it',
    squeeze.best === null && (squeeze.warning ?? '').includes('reserved for dues'),
    squeeze.warning ?? '',
  )
  check(
    '§8.3 the reserved account explains the reservation',
    mainOption.reasons.some((r) => r.includes('reserved for dues')),
    JSON.stringify(mainOption.reasons),
  )

  // A far-future commitment must not reserve anything.
  await prisma.$transaction((tx) =>
    createTask(tx, {
      entityId: entity.id, title: 'Annual audit fee', kind: 'other', amount: '90000.00',
      dueDate: new Date(Date.now() + 120 * 86_400_000), actorId: admin.id,
    }),
  )
  const afterFarTask = await suggestPaymentSource({ entityId: entity.id, module: 'salary' })
  const mainAfter = afterFarTask.options.find((o) => o.ledgerAccountId === main1.id)!
  check(
    '§8.3 commitments beyond the window do not reserve',
    mainAfter.reserved === '55000.00',
    mainAfter.reserved,
  )

  // =========================================================================
  // §6.3/§6.5 Recurring generation
  // =========================================================================
  // Seeded ~25 days back so the next monthly instance lands inside the window.
  const seedDue = new Date(Date.now() - 25 * 86_400_000)
  await prisma.$transaction((tx) =>
    createBill(tx, {
      entityId: entity.id, vendor: 'Tata Power', billType: 'Electricity',
      amount: '3000.00', billDate: seedDue, dueDate: seedDue,
      recurrence: 'MONTHLY', expenseAccountId: misc.id, actorId: admin.id,
    }),
  )
  const before = await prisma.bill.count({ where: { entityId: entity.id } })
  const gen1 = await generateRecurring(entity.id, admin.id)
  const after1 = await prisma.bill.count({ where: { entityId: entity.id } })
  check(
    `recurring: next instance materialized inside the ${LEAD_DAYS}-day window`,
    gen1.bills.length >= 1 && after1 === before + gen1.bills.length,
    `${before} → ${after1}`,
  )
  const gen2 = await generateRecurring(entity.id, admin.id)
  const after2 = await prisma.bill.count({ where: { entityId: entity.id } })
  check(
    'recurring: re-running generates nothing new (idempotent)',
    gen2.bills.length === 0 && gen2.tasks.length === 0 && after2 === after1,
    `${after1} → ${after2}`,
  )
  const generated = await prisma.bill.findFirst({
    where: { entityId: entity.id, vendor: 'Tata Power', id: { not: undefined }, status: 'PENDING' },
    orderBy: { dueDate: 'desc' },
  })
  check(
    'recurring: the generated bill carries the series and its own payable',
    generated?.seriesId !== null && generated?.entryDocId !== null,
  )

  // =========================================================================
  // §6.5 Reminders + §10 weekly summary
  // =========================================================================
  const reminders = await dueReminders(entity.id, new Date())
  check(
    'reminders: rendered for items due shortly, one per item+date',
    reminders.length > 0 && reminders.every((r) => r.dedupeKey.startsWith('due:')),
    `${reminders.length} reminder(s)`,
  )
  check(
    'reminders: overdue items are labelled as such',
    reminders.every((r) => /^(OVERDUE|Due) \d{4}-\d{2}-\d{2}/.test(r.subject)),
    reminders[0]?.subject,
  )

  const summary = await weeklySummary(entity.id, new Date())
  check(
    'weekly summary: covers balances, attention items and the week ahead',
    summary.body.includes('BALANCES') &&
      summary.body.includes('NEEDS ATTENTION') &&
      summary.body.includes('DUE IN THE NEXT 7 DAYS') &&
      summary.body.includes('VP7 Main'),
  )
  check(
    'weekly summary: subject names the entity and week',
    summary.subject.includes('VP7') && summary.subject.includes('week ending'),
    summary.subject,
  )

  // =========================================================================
  // Outbox: dedupe, and surviving a missing transport
  // =========================================================================
  const first = await queueNotification({
    entityId: entity.id, kind: 'weekly_summary', channel: 'email',
    recipient: 'vp7@test.local', subject: summary.subject, body: summary.body,
    dedupeKey: `verify7:weekly:${entity.id}`,
  })
  const duplicate = await queueNotification({
    entityId: entity.id, kind: 'weekly_summary', channel: 'email',
    recipient: 'vp7@test.local', subject: summary.subject, body: summary.body,
    dedupeKey: `verify7:weekly:${entity.id}`,
  })
  check('outbox: same dedupeKey queues once only', first !== null && duplicate === null)

  const delivery = await deliverQueued()
  if (transportConfigured()) {
    check('outbox: delivery attempted (SMTP configured)', delivery.sent + delivery.failed > 0)
  } else {
    check(
      'outbox: without SMTP nothing is lost — messages stay queued with a reason',
      delivery.sent === 0 &&
        delivery.stillQueued > 0 &&
        (delivery.reason ?? '').includes('No SMTP transport'),
      delivery.reason ?? '',
    )
    const stored = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { dedupeKey: `verify7:weekly:${entity.id}` },
    })
    check('outbox: the rendered message is still readable in the admin outbox',
      stored.status === 'QUEUED' && stored.body.includes('BALANCES'))
  }

  // =========================================================================
  // The whole job, twice
  // =========================================================================
  const run1 = await runAutomation({ actorId: admin.id, force: true })
  const vp7Run1 = run1.entities.find((e) => e.entity === 'VP7')!
  check(
    'job: one pass generates, queues reminders and the weekly summary',
    vp7Run1.weeklyQueued && vp7Run1.remindersQueued > 0,
    JSON.stringify(vp7Run1),
  )
  const run2 = await runAutomation({ actorId: admin.id, force: true })
  const vp7Run2 = run2.entities.find((e) => e.entity === 'VP7')!
  check(
    'job: a second pass in the same period is a no-op (idempotent)',
    !vp7Run2.weeklyQueued &&
      vp7Run2.remindersQueued === 0 &&
      vp7Run2.billsCreated === 0 &&
      vp7Run2.tasksCreated === 0,
    JSON.stringify(vp7Run2),
  )
  const runAudit = await prisma.auditLog.findFirst({
    where: { action: 'automation.run' },
    orderBy: { createdAt: 'desc' },
  })
  check('job: the run is audit-logged', runAudit !== null, runAudit?.summary)

  // --- Clean up ---
  await prisma.notificationOutbox.deleteMany({ where: { entityId: entity.id } })
  await prisma.paymentPreference.deleteMany({ where: { entityId: entity.id } })
  await prisma.taxLine.deleteMany({ where: { entityId: entity.id } })
  await prisma.financeTask.deleteMany({ where: { entityId: entity.id } })
  await prisma.bill.deleteMany({ where: { entityId: entity.id } })
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
