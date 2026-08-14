import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { createBill } from '../src/lib/ops/bills'

// One-time import of the "EMI Subscriptions Phone Property" sheet into
// Bills & insurance (HG books — Himal pays all of these). Stale next-due
// dates from the sheet are advanced to the next natural occurrence
// (monthly → next day-of-month, quarterly +3mo, yearly +1yr, prepaid
// phone packs +84 days from the last recharge). Portal credentials in the
// sheet are deliberately NOT imported.

type Row = {
  vendor: string
  billType: string
  amount: string
  dueDate: string // already advanced, YYYY-MM-DD
  recurrence: 'NONE' | 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY'
  policyNumber?: string
  insuredValue?: string
  insuredFor?: string
  payFrom?: string
  remarks?: string
  link?: string
}

const ROWS: Row[] = [
  // --- Insurance & EMI ---
  {
    vendor: 'Star Health', billType: 'Insurance', amount: '27963.00', dueDate: '2027-03-23',
    recurrence: 'YEARLY', policyNumber: 'P/900000/01/2025/000361', insuredValue: '2500000',
    insuredFor: 'Meena / Sanjay Goyal', payFrom: 'BOB',
    remarks: 'Medical policy — Personal Accident ₹7,50,000 + Health ₹25,00,000 (sheet due 23-Mar-2026, advanced)',
  },
  {
    vendor: 'Star Health', billType: 'Insurance', amount: '9913.00', dueDate: '2027-05-12',
    recurrence: 'YEARLY', policyNumber: '4440112203048193', insuredValue: '1000000',
    insuredFor: 'Himal Goyal', payFrom: 'BOB', remarks: 'Medical policy',
  },
  {
    vendor: 'Max Life Insurance', billType: 'Insurance', amount: '11293.00', dueDate: '2027-07-14',
    recurrence: 'YEARLY', insuredFor: 'Himal Goyal',
    remarks: 'Life insurance premium (sheet due 14-Jul-2024 — stale, advanced; confirm policy still live)',
  },
  {
    vendor: 'Bajaj Allianz', billType: 'Insurance', amount: '4718.00', dueDate: '2027-05-22',
    recurrence: 'YEARLY', policyNumber: '3001/390265004/00/000', insuredValue: '355578',
    insuredFor: 'Baleno — Himal Goyal', remarks: 'Car insurance (sheet due 22-May-2026, advanced)',
  },
  {
    vendor: 'ICICI Lombard', billType: 'Insurance', amount: '7408.00', dueDate: '2027-04-08',
    recurrence: 'YEARLY', policyNumber: '3005/O/389218110/00/000', insuredValue: '521566',
    insuredFor: 'Honda — Himal Goyal', remarks: 'Bike insurance',
  },
  {
    vendor: 'Federal Bank', billType: 'EMI', amount: '260000.00', dueDate: '2026-09-02',
    recurrence: 'MONTHLY', payFrom: 'Federal bank', insuredFor: 'Synergy home loan',
    remarks: 'Home loan EMI — Repo+2% (8.50% May-24) · 360 months · first EMI 29-Mar-2024 · ends 22-Mar-2054',
  },
  {
    vendor: 'Ageas Federal', billType: 'EMI', amount: '3000.00', dueDate: '2026-09-02',
    recurrence: 'MONTHLY', payFrom: 'Federal bank', insuredValue: '40260190',
    insuredFor: 'Synergy home loan', remarks: 'Home loan insurance — Repo+3.85% (10.35% May-24)',
  },
  // --- Subscriptions ---
  { vendor: 'Amazon Prime', billType: 'Subscription', amount: '459.00', dueDate: '2026-11-13', recurrence: 'QUARTERLY', payFrom: 'HDFC 4271 (Card 3715)', remarks: 'Quarterly, 13th' },
  { vendor: 'Audible', billType: 'Subscription', amount: '199.00', dueDate: '2026-09-03', recurrence: 'MONTHLY', payFrom: 'HDFC 4271 (Card 3715)', remarks: 'Monthly, 3rd' },
  { vendor: 'Spotify', billType: 'Subscription', amount: '119.00', dueDate: '2026-09-10', recurrence: 'MONTHLY', payFrom: 'HDFC 2762 (Card 3491)', remarks: 'Monthly, 10th' },
  { vendor: 'Hotstar', billType: 'Subscription', amount: '1499.00', dueDate: '2027-05-23', recurrence: 'YEARLY', payFrom: 'GPay — 2762' },
  { vendor: 'Mails app for Mac', billType: 'Subscription', amount: '799.00', dueDate: '2027-05-29', recurrence: 'YEARLY', payFrom: 'GPay — 4271' },
  { vendor: 'Lionsgate', billType: 'Subscription', amount: '699.00', dueDate: '2027-05-16', recurrence: 'YEARLY', payFrom: 'GPay — 4271' },
  { vendor: 'Netflix', billType: 'Subscription', amount: '199.00', dueDate: '2026-09-03', recurrence: 'MONTHLY', payFrom: 'GPay — 2762', remarks: 'Monthly, 3rd' },
  { vendor: 'Sonyliv', billType: 'Subscription', amount: '999.00', dueDate: '2026-11-26', recurrence: 'YEARLY', payFrom: 'GPay — 4271' },
  // --- Phone ---
  { vendor: 'Airtel', billType: 'Phone', amount: '972.00', dueDate: '2026-09-21', recurrence: 'QUARTERLY', insuredFor: '7875659945 (Himal)', remarks: 'Prepaid ₹972 / 84 days — last recharge 29-Jun-2026' },
  { vendor: 'Jio', billType: 'Phone', amount: '860.90', dueDate: '2026-09-26', recurrence: 'QUARTERLY', insuredFor: '8686299998', remarks: 'Prepaid ₹799+GST / 84 days — last recharge 11-Apr-2026' },
  // --- Property tax ---
  {
    vendor: 'PMC', billType: 'Property tax', amount: '33898.50', dueDate: '2026-12-31',
    recurrence: 'HALF_YEARLY', insuredFor: 'Synergy — 802', policyNumber: 'Account 00351018',
    remarks: 'Annual ₹67,797 — H1 due 31-May, H2 due 31-Dec (H2 2026 next)',
  },
]

async function main() {
  const hg = await prisma.entity.findFirstOrThrow({ where: { code: 'HG' } })
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  let created = 0
  for (const r of ROWS) {
    const dupe = await prisma.bill.findFirst({
      where: {
        entityId: hg.id, vendor: r.vendor, billType: r.billType, status: 'PENDING',
        policyNumber: r.policyNumber ?? null,
        insuredFor: r.insuredFor ?? null,
      },
    })
    if (dupe) {
      console.log(`skip (exists): ${r.vendor} ${r.billType}`)
      continue
    }
    await prisma.$transaction(async (tx) => {
      const bill = await createBill(tx, {
        entityId: hg.id,
        vendor: r.vendor,
        billType: r.billType,
        amount: r.amount,
        billDate: new Date(),
        dueDate: new Date(r.dueDate),
        policyNumber: r.policyNumber ?? null,
        insuredValue: r.insuredValue ?? null,
        insuredFor: r.insuredFor ?? null,
        payFrom: r.payFrom ?? null,
        remarks: r.remarks ?? null,
        recurrence: r.recurrence,
        actorId: admin.id,
      })
      await tx.auditLog.create({
        data: {
          actorId: admin.id, action: 'bill.import', targetType: 'Bill', targetId: bill.id,
          summary: `Imported from EMI sheet: ${r.vendor} (${r.billType}) ₹${r.amount} due ${r.dueDate} ${r.recurrence.toLowerCase()}`,
        },
      })
    })
    created++
    console.log(`+ ${r.billType.padEnd(12)} ${r.vendor} ₹${r.amount} due ${r.dueDate} (${r.recurrence})`)
  }
  console.log(`\ncreated ${created}/${ROWS.length}`)
}

main().finally(() => prisma.$disconnect())
