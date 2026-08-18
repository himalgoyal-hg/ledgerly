import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { createJournalDocument } from '../src/lib/ledger/posting'
import { createCashEntry } from '../src/lib/ops/cash'

// One demo month (Aug 2026) in the DEMO book, posted through the real
// machinery — opening balance, a client receipt, bank expenses with their
// master cost centres, a bank→cash withdrawal and two cash spends — then
// the expected arithmetic printed so every report can be checked against it.
//
// Hand math:
//   Bank: 1,00,000 open + 50,000 Pattern − 4,000 Food − 1,500 Petrol
//         − 20,000 Payroll − 10,000 to cash            = 1,14,500
//   Cash: 10,000 in − 2,000 Poker − 3,000 Mom gifts    =    5,000
//   P&L : income 50,000 − expenses 30,500              =   19,500 profit
//   BS  : assets 1,19,500 = opening 1,00,000 + profit  =  1,19,500 ✓

async function main() {
  const demo = await prisma.entity.findUniqueOrThrow({ where: { code: 'DEMO' } })
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN', deletedAt: null } })
  const already = await prisma.journalDoc.count({ where: { entityId: demo.id } })
  if (already > 0) {
    console.log('DEMO already has postings — not doubling them')
    return
  }

  const acc = async (name: string) => {
    const a = await prisma.ledgerAccount.findFirstOrThrow({
      where: { entityId: demo.id, isGroup: false, name: { equals: name, mode: 'insensitive' } },
    })
    return a
  }
  const bank = await acc('Demo HDFC 0001')
  const drawer = await acc('Demo Drawer')
  const opening = await prisma.ledgerAccount.findFirstOrThrow({
    where: { entityId: demo.id, code: '3200' },
  })

  const post = (date: string, narration: string, lines: { accountId: string; debit?: string; credit?: string; costCentreId?: string }[]) =>
    prisma.$transaction((tx) =>
      createJournalDocument(tx, {
        entityId: demo.id,
        sourceType: 'manual',
        content: { date: new Date(date), narration, lines },
        actorId: admin.id,
      }),
    )

  const withCc = async (name: string) => {
    const a = await acc(name)
    return { id: a.id, cc: a.defaultCostCentreId ?? undefined }
  }

  // 1. opening balance
  await post('2026-08-01', 'Opening balance — Demo HDFC', [
    { accountId: bank.id, debit: '100000.00' },
    { accountId: opening.id, credit: '100000.00' },
  ])
  // 2. client receipt
  const pattern = await withCc('Pattern')
  await post('2026-08-05', 'Pattern — August payout', [
    { accountId: bank.id, debit: '50000.00' },
    { accountId: pattern.id, credit: '50000.00', costCentreId: pattern.cc },
  ])
  // 3. bank expenses, master cost centres riding along
  for (const [date, name, amt, what] of [
    ['2026-08-07', 'Payroll', '20000.00', 'Payroll — August'],
    ['2026-08-10', 'Food & Dining', '4000.00', 'Groceries + dining'],
    ['2026-08-12', 'Petrol', '1500.00', 'Fuel'],
  ] as const) {
    const h = await withCc(name)
    await post(date, what, [
      { accountId: h.id, debit: amt, costCentreId: h.cc },
      { accountId: bank.id, credit: amt },
    ])
  }
  // 4. bank → cash withdrawal
  await post('2026-08-15', 'Cash withdrawal to drawer', [
    { accountId: drawer.id, debit: '10000.00' },
    { accountId: bank.id, credit: '10000.00' },
  ])
  // 5. cash spends through the cash machinery (CC defaults ride inside)
  const loc = await prisma.cashLocation.findFirstOrThrow({ where: { entityId: demo.id } })
  for (const [date, name, amt, what] of [
    ['2026-08-18', 'Poker', '2000.00', 'Poker night'],
    ['2026-08-20', 'Mom gifts', '3000.00', 'Gift for Mom'],
  ] as const) {
    const h = await acc(name)
    await prisma.$transaction(async (tx) => {
      const e = await createCashEntry(tx, {
        entityId: demo.id,
        kind: 'PAYMENT',
        date: new Date(date),
        locationId: loc.id,
        headAccountId: h.id,
        costCentreId: null, // head default rides along
        amount: amt,
        remarks: what,
        actorId: admin.id,
      })
      void e
    })
  }

  console.log('9 postings made. Expected: bank ₹1,14,500 · cash ₹5,000 · P&L profit ₹19,500 · BS total ₹1,19,500')
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
