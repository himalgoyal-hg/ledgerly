import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { resolveHeadAccount } from '../src/lib/ops/heads'

// The "Expenses M/M (HG)" tab's head list + yearly budgets → HG books.
// Every sheet head becomes (or matches, case-insensitive) an expense head
// under 5000; heads with a year budget get FY 2026-27 Budget rows (the
// yearly figure spread paise-exact over Apr..Mar). Existing budget rows
// for these heads are overwritten with the sheet's figure; other heads'
// budgets are untouched. Idempotent.

const HEADS: [string, number][] = [
  ['Food & Dining', 65000], ['Zomato health dinner', 0], ['Medical', 24000],
  ['Entertainment & Subscriptions', 18000], ['Gym & Health', 151000], ['Petrol', 39000],
  ['Clothing & Shoping', 120000], ['Hobbies', 26000], ['Salon', 12000], ['Steve', 24000],
  ['ACPL business exp', 12000], ['Finance expenses', 2000], ['Insurance', 40000],
  ['Bike/ Car Expenses', 10000], ['Car maintenance', 9600], ['Bike maintenance', 11200],
  ['Property tax - Synergy', 67797], ['Synergy events', 20000], ['Telephone expenses', 7200],
  ['Asset management', 50000], ['Poker', 18000], ['Socialising', 20000], ['Mom travel', 150000],
  ['Synergy Maintenance', 120000], ['Gadgets', 100000], ['Mom gifts', 200000],
  ['Professional Fees', 0], ['Forex', 0], ['Gifting', 50000], ['Meena Goyal- Ration', 0],
  ['Meena Goyal- Fruit/ vegetables', 0], ['Income tax', 500000],
  ['Investment expenses- Octanom (AOS)', 0], ['Travel', 320000], ['Light Bill', 0],
  ['MG SIP', 0], ['Property tax - ABC', 0], ['Investment expenses- Others', 60000],
  ['Asset', 0], ['Sanjay Goyal', 0], ['HG -->> MG (Expense)', 840000], ['ACPL <<-->> HG', 0],
  ['Shubham Jain', 0], ['Payroll', 0], ['PF', 0], ['Softwares', 0], ['Marketing', 0],
  ['Verve', 0], ['Harin', 0], ['Software development', 0], ['HG Professional fees', -3600000],
  ['MG Salary', 0], ['Upwork', 0], ['GSuite', 0], ['TDS compliances', 0], ['MIRO', 0],
  ['Official travel expense', 0], ['Zoom', 0], ['ChatGPT', 0], ['Video editing', 0],
  ['Digital Ocean', 0], ['Square Associate', 0], ['Tanmeet Professional fees', 0],
  ['Hiring Expense- Tests', 0], ['Platform Hiring Expense', 0], ['Learning', 0],
  ['Professional Tax', 0], ['Proton VPN', 0],
]

// FY 2026-27 rows: Apr-Dec under 2026, Jan-Mar under 2027
const FY: { year: number; month: number }[] = [
  ...Array.from({ length: 9 }, (_, i) => ({ year: 2026, month: i + 4 })),
  ...Array.from({ length: 3 }, (_, i) => ({ year: 2027, month: i + 1 })),
]

async function main() {
  const hg = await prisma.entity.findUniqueOrThrow({ where: { code: 'HG' } })
  let createdHeads = 0
  let budgeted = 0

  for (const [name, yearBudget] of HEADS) {
    const before = await prisma.ledgerAccount.findFirst({
      where: { entityId: hg.id, isGroup: false, archivedAt: null, name: { equals: name, mode: 'insensitive' } },
    })
    const accountId = await prisma.$transaction((tx) =>
      resolveHeadAccount(tx, { entityId: hg.id, headText: name, isOutflow: true }),
    )
    if (!before) createdHeads++

    if (yearBudget !== 0) {
      // paise-exact spread: every month gets the base, the first r months a paisa more
      const totalPaise = Math.round(yearBudget * 100)
      const sign = totalPaise < 0 ? -1 : 1
      const abs = Math.abs(totalPaise)
      const base = Math.floor(abs / 12)
      const rem = abs % 12
      for (const [i, fm] of FY.entries()) {
        const amount = ((sign * (base + (i < rem ? 1 : 0))) / 100).toFixed(2)
        await prisma.budget.upsert({
          where: { entityId_accountId_year_month: { entityId: hg.id, accountId, year: fm.year, month: fm.month } },
          create: { entityId: hg.id, accountId, year: fm.year, month: fm.month, amount, frequency: 'ANNUAL' },
          update: { amount, frequency: 'ANNUAL' },
        })
      }
      budgeted++
    }
  }
  console.log(`${HEADS.length} heads ensured (${createdHeads} newly created), ${budgeted} with FY 2026-27 budgets`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
