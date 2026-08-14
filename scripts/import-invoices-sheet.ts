import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { createInvoice, recordFxReceipt } from '../src/lib/ops/invoices'

// Re-import of the workbook's Invoices tab, replacing whatever invoices
// exist (all are FX register rows with no postings). Entity mapping:
// "ACPL (7838)" → ACPL books; "AC (2762)" → HG (that account merged into
// HG); "Verve US" → HG with the platform noted in the description.
// Invoice dates weren't on the sheet — credit date − 7 days where a credit
// exists, else the 1st of the sheet's month (disclosed to the user).

type Row = {
  books: 'ACPL' | 'HG'
  client: string
  country: string
  date: string
  amountFx: string
  narration?: string
  fcDisposal?: string
  receipt?: { receivedFx: string; realizedInr: string; bankCharges: string; providerFees: string; creditDate: string }
  remark?: string
}

const ROWS: Row[] = [
  {
    books: 'ACPL', client: 'Noria Enterprises', country: 'New Zealand',
    date: '2026-06-03', amountFx: '2018.00', fcDisposal: 'Yes',
    receipt: { receivedFx: '2005.00', realizedInr: '187394.00', bankCharges: '258.66', providerFees: '0', creditDate: '2026-06-10' },
  },
  {
    books: 'HG', client: 'Neat Method', country: 'USA',
    date: '2026-06-01', amountFx: '2654.00', fcDisposal: 'Skydo',
    receipt: { receivedFx: '2654.00', realizedInr: '253874.00', bankCharges: '0', providerFees: '0', creditDate: '2026-06-08' },
  },
  {
    books: 'HG', client: 'Amberjack', country: 'USA',
    date: '2026-06-01', amountFx: '1500.00', narration: 'Verve US',
    remark: 'Received $1,500 per sheet — INR credit pending; books TBD (Verve US)',
  },
  {
    books: 'ACPL', client: 'Noria Enterprises', country: 'New Zealand',
    date: '2026-07-01', amountFx: '1202.00', fcDisposal: 'Yes',
    receipt: { receivedFx: '1202.00', realizedInr: '112770.00', bankCharges: '191.50', providerFees: '0', creditDate: '2026-07-08' },
  },
  {
    books: 'HG', client: 'Neat Method', country: 'USA',
    date: '2026-07-01', amountFx: '3298.00', fcDisposal: 'Skydo',
    remark: '₹3,12,242 received per sheet — add the credit date via Record / edit to settle',
  },
]

async function main() {
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const entities = new Map((await prisma.entity.findMany()).map((e) => [e.code, e]))

  // Clean slate: every existing invoice is an FX register row (no journal,
  // no payments) — verified before running. Counters reset for clean numbers.
  const existing = await prisma.invoice.findMany({ include: { payments: true } })
  for (const inv of existing) {
    if (inv.docId || inv.payments.length > 0) {
      throw new Error(`Refusing: ${inv.number} has postings/payments — delete via the app`)
    }
  }
  await prisma.invoice.deleteMany({})
  await prisma.entity.updateMany({
    where: { code: { in: ['ACPL', 'HG'] } },
    data: { nextInvoiceNumber: 1 },
  })
  console.log(`wiped ${existing.length} invoices, counters reset`)

  for (const r of ROWS) {
    const entity = entities.get(r.books)!
    await prisma.$transaction(async (tx) => {
      const inv = await createInvoice(tx, {
        entityId: entity.id,
        customer: r.client,
        date: new Date(r.date),
        dueDate: new Date(new Date(r.date).getTime() + 7 * 86_400_000),
        amount: '0',
        narration: [r.narration, r.remark].filter(Boolean).join(' — ') || null,
        actorId: admin.id,
      })
      await tx.invoice.update({
        where: { id: inv.id },
        data: {
          currency: 'USD', amountFx: r.amountFx, country: r.country,
          firc: 'Awaited', fcDisposal: r.fcDisposal ?? null,
          ...(r.client === 'Amberjack' ? { receivedFx: '1500.00' } : {}),
        },
      })
      if (r.receipt) {
        await recordFxReceipt(tx, {
          invoiceId: inv.id,
          receivedFx: r.receipt.receivedFx,
          realizedInr: r.receipt.realizedInr,
          bankCharges: r.receipt.bankCharges,
          providerFees: r.receipt.providerFees,
          creditDate: new Date(r.receipt.creditDate),
          firc: 'Awaited',
          actorId: admin.id,
        })
      }
      await tx.auditLog.create({
        data: {
          actorId: admin.id, action: 'invoice.import', targetType: 'Invoice', targetId: inv.id,
          summary: `Imported from sheet: ${inv.number} ${r.client} $${r.amountFx} (${r.books})${r.receipt ? ` realized ₹${r.receipt.realizedInr}` : ' open'}`,
        },
      })
      console.log(`+ ${r.books} ${inv.number} | ${r.client} | $${r.amountFx} | ${r.receipt ? 'settled' : 'OPEN'}`)
    })
  }
}

main().finally(() => prisma.$disconnect())
