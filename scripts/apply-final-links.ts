import 'dotenv/config'
import { prisma } from '../src/lib/db'

// Himal's definitive list (19 Aug 2026): exactly these categories, each with
// its bank mode and default cost centre — blanks mean BLANK (earlier
// Compulsory/Lifestyle guesses come off). Sections and row order come along
// so the register reads like the sheet. Head defaults across all books
// follow the same list; extra master rows (none expected) are reported.

// name | bankMode | costCentre  — '' = blank on purpose
type Row = [string, string, string]
const SECTIONS: [string, Row[]][] = [
  ['HG/ MG EXPENSES', [
    ['Synergy EMI', 'HDFC 2762', 'Compulsory'],
    ['Food & Dining', 'HDFC 4271', 'Optional-Lifestyle'],
    ['Zomato health dinner', 'Greeshma balance', 'Optional-Lifestyle'],
    ['Books', 'HDFC 2762', 'Optional-growth'],
    ['Medical', 'HDFC 2762', 'Compulsory'],
    ['Entertainment & Subscriptions', 'HDFC 4271', 'Optional-Lifestyle'],
    ['Gym & Health', 'HDFC 2762', 'Compulsory'],
    ['Petrol', 'HDFC 2762', 'Compulsory'],
    ['Clothing & Shoping', 'HDFC 4271', 'Optional-Lifestyle'],
    ['Hobbies', 'HDFC 4271', 'Compulsory'],
    ['Salon', 'HDFC 4271', 'Compulsory'],
    ['Steve', 'HDFC 2762', 'Compulsory'],
    ['ACPL business exp', 'HDFC 2762', 'Optional-growth'],
    ['Finance expenses', 'HDFC 2762', 'Optional-growth'],
    ['Insurance', 'HDFC 2762', 'Compulsory'],
    ['Bike/ Car Expenses', 'HDFC 2762', 'Optional-Lifestyle'],
    ['Car maintenance', 'HDFC 2762', 'Compulsory'],
    ['Bike maintenance', 'HDFC 2762', 'Compulsory'],
    ['Property tax - Synergy', 'HDFC 2762', 'Compulsory'],
    ['Synergy events', '', 'Compulsory'],
    ['Telephone expenses', 'HDFC 2762', 'Compulsory'],
    ['Asset management', 'HDFC 2762', 'Compulsory'],
    ['Poker', '', 'Optional-Lifestyle'],
    ['Socialising', 'HDFC 4271', 'Compulsory'],
    ['Mom travel', '', 'Optional-Lifestyle'],
    ['Synergy Maintenance', '', 'Compulsory'],
    ['Gadgets', '', 'Optional-Lifestyle'],
    ['Mom gifts', '', 'Optional-Lifestyle'],
    ['Professional Fees', '', ''],
    ['Synergy Insurance EMI', '', ''],
    ['Forex', '', ''],
    ['Gifting', '', ''],
    ['Meena Goyal- Ration', 'HDFC 2762', 'Compulsory'],
    ['Meena Goyal- Fruit/ vegetables', 'HDFC 2762', 'Compulsory'],
    ['Income tax', 'HDFC 2762', 'Compulsory'],
  ]],
  ['HG EXPENSES- from ACPL (Full or part)', [
    ['Investment expenses- Octanom (AOS)', '', 'Compulsory'],
    ['Travel', 'ACPL HDFC 7838', 'Optional-Lifestyle'],
    ['Light Bill', 'HDFC 2762', 'Compulsory'],
  ]],
  ['INVESTMENTS & Personal income', [
    ['Investment', 'HDFC 2762', 'Optional-Investment'],
    ['MG SIP', 'Meena ICICI', 'Compulsory'],
    ['SIP', 'HDFC 2762', 'Optional-Investment'],
    ['Income', 'HDFC 2762', 'Optional-growth'],
    ['Interest', 'HDFC 2762', 'Optional-growth'],
    ['Property tax - ABC', 'HDFC 2762', 'Compulsory'],
    ['ABC rent', 'HG ICICI', 'Compulsory'],
    ['ABC EMI', 'HG ICICI', 'Compulsory'],
    ['Return Payment', 'HDFC 2762', 'Optional-growth'],
    ['Investment expenses- Others', '', 'Compulsory'],
    ['Dividend', 'ACPL HDFC 7838', 'Compulsory'],
    ['Asset', 'ACPL HDFC 7838', 'Compulsory'],
    ['Shares', '', ''],
    ['SIP Income', '', ''],
    ['Investment in Land', '', ''],
    ['Capital Receipts', '', ''],
    ['Hedged investments', '', ''],
  ]],
  ['Contra accounts', [
    ['HDFC CC', 'HDFC 2762', 'Optional-growth'],
    ['AMEX CC', '', ''],
    ['2762 <<-->> ICICI', '', ''],
    ['Cash', '', ''],
    ['MG Axis <<-->> ICICI', '', ''],
    ['2762 <<-->>  Federal', '', ''],
    ['ICICI <<-->> Kotak', '', ''],
    ['2762 <<-->> Kotak', '', ''],
    ['4271 <<-->> ICICI', '', ''],
    ['2762 <<-->> 4271', '', ''],
  ]],
  ['Personal accounts', [
    ['ACPL', 'HDFC 2762', ''],
    ['Meena Goyal', 'HDFC 2762', ''],
    ['Sanjay Goyal', '', ''],
    ['HG -->> MG (Expense)', '', 'Compulsory'],
    ['HG <<-->> MG', '', ''],
    ['ACPL <<-->> HG', '', ''],
    ['ACPL <<-->> HG Federal', '', ''],
    ['HG <<--->> PG', '', ''],
    ['Loan given', 'HDFC 2762', ''],
    ['Devendra Mandhana HUF', '', ''],
    ['Darshan Pahade HUF', '', ''],
    ['Ashish', '', ''],
    ['MG <<--->> PG', '', ''],
    ['ABC Deposit', '', ''],
    ['ABC Sales proceeds', '', ''],
  ]],
  ['ACPL TRANSACTIONS', [
    ['AJ Revenue', 'Cash', 'Compulsory'],
    ['Pattern', 'ACPL HDFC 7838', 'Compulsory'],
    ['Neat Method', 'ACPL HDFC 7838', 'Compulsory'],
    ['Noria revenue', 'ACPL HDFC 7838', 'Compulsory'],
    ['Shubham Jain', 'ACPL HDFC 7838', 'Compulsory'],
    ['Payroll', 'ACPL HDFC 7838', 'Compulsory'],
    ['PF', 'ACPL HDFC 7838', 'Compulsory'],
    ['Softwares', 'ACPL HDFC 7838', 'Compulsory'],
    ['Marketing', 'ACPL HDFC 7838', 'Compulsory'],
    ['Verve', 'ACPL HDFC 7838', 'Compulsory'],
    ['Harin', 'ACPL HDFC 7838', 'Compulsory'],
    ['Software development', 'ACPL HDFC 7838', 'Compulsory'],
    ['HG Professional fees', 'HDFC 2762', 'Compulsory'],
    ['MG Salary', '', 'Compulsory'],
    ['Upwork', 'ACPL HDFC 7838', 'Compulsory'],
    ['GSuite', 'ACPL HDFC 7838', 'Compulsory'],
    ['TDS compliances', 'ACPL HDFC 7838', 'Compulsory'],
    ['MIRO', 'ACPL HDFC 7838', 'Compulsory'],
    ['Official travel expense', 'ACPL HDFC 7838', 'Compulsory'],
    ['Zoom', 'ACPL HDFC 7838', 'Compulsory'],
    ['ChatGPT', 'ACPL HDFC 7838', 'Compulsory'],
    ['Video editing', 'ACPL HDFC 7838', 'Compulsory'],
    ['Digital Ocean', 'ACPL HDFC 7838', 'Compulsory'],
    ['Square Associate', 'ACPL HDFC 7838', 'Compulsory'],
    ['Tanmeet Professional fees', 'ACPL HDFC 7838', 'Compulsory'],
    ['Hiring Expense- Tests', 'ACPL HDFC 7838', 'Compulsory'],
    ['Platform Hiring Expense', 'ACPL HDFC 7838', 'Compulsory'],
    ['Learning', '', ''],
    ['Professional Tax', 'ACPL HDFC 7838', 'Compulsory'],
    ['ACPL Salary', '', ''],
    ['Helium 10 Subscription', '', ''],
    ['Office Equipments', '', ''],
    ['Google Workspace', '', ''],
    ['ACPL Hyrox', '', 'Compulsory'],
    ['Proton VPN', 'ACPL HDFC 7838', 'Compulsory'],
    ['Office Interiors - Furniture & Fixtures', '', ''],
    ['Charges', '', ''],
    ['Sports', '', ''],
    ['Loan to Harshal Pahade', '', ''],
    ['HG--> Greeshma', '', ''],
    ['Car Loan Stamp Duty', '', ''],
    ['New Car', '', ''],
  ]],
]

const strip = (s: string) => s.toLowerCase().trim().replace(/^optional-?\s*/, '')
const ALIAS: Record<string, string> = { investment: 'invesment' }

async function main() {
  const banks = await prisma.bankAccount.findMany({
    where: { archivedAt: null },
    select: { id: true, nickname: true, accountNumber: true },
  })
  const norm = (x: string) => x.toLowerCase().replace(/meena/g, 'mg').replace(/himal/g, 'hg')
  const resolveBank = (mode: string): string | null => {
    const m = norm(mode)
    const digits = m.match(/\d{3,}/g) ?? []
    if (digits.length) {
      const hit = banks.find((b) => digits.some((d) => b.accountNumber.endsWith(d) || norm(b.nickname).includes(d)))
      if (hit) return hit.id
    }
    const toks = m.split(/[^a-z0-9]+/).filter((t) => t && !['bank', 'account', 'balance'].includes(t))
    return banks.find((b) => toks.length > 0 && toks.every((t) => norm(b.nickname).includes(t)))?.id ?? null
  }

  const listed = new Set<string>()
  let order = 0
  let modes = 0
  let ccSet = 0
  let ccCleared = 0
  for (const [section, rows] of SECTIONS) {
    for (const [name, mode, cc] of rows) {
      order++
      listed.add(name.toLowerCase())
      const hm = await prisma.headMode.findFirst({ where: { category: { equals: name, mode: 'insensitive' } } })
      const data = {
        modeBank: mode || null,
        expenseType: cc || null,
        bankAccountId: mode ? resolveBank(mode) : null,
        section,
        sortOrder: order,
      }
      if (hm) await prisma.headMode.update({ where: { id: hm.id }, data })
      else await prisma.headMode.create({ data: { category: name, modeCc: null, ...data } })
      modes++

      // head defaults in every books follow the list — blanks CLEAR
      const heads = await prisma.ledgerAccount.findMany({
        where: { isGroup: false, archivedAt: null, name: { equals: name, mode: 'insensitive' } },
      })
      for (const head of heads) {
        if (!cc) {
          if (head.defaultCostCentreId) {
            await prisma.ledgerAccount.update({ where: { id: head.id }, data: { defaultCostCentreId: null } })
            ccCleared++
          }
          continue
        }
        const existing = await prisma.costCentre.findMany({ where: { entityId: head.entityId, archivedAt: null } })
        const ws = strip(cc)
        const centre =
          existing.find((c) => c.name.toLowerCase() === cc.toLowerCase()) ??
          existing.find((c) => strip(c.name) === ws || c.name.toLowerCase() === (ALIAS[ws] ?? ws)) ??
          (await prisma.costCentre.create({ data: { entityId: head.entityId, name: cc } }))
        if (head.defaultCostCentreId !== centre.id) {
          await prisma.ledgerAccount.update({ where: { id: head.id }, data: { defaultCostCentreId: centre.id } })
          ccSet++
        }
      }
    }
  }
  const extras = await prisma.headMode.findMany()
  const extraNames = extras.filter((m) => !listed.has(m.category.toLowerCase())).map((m) => m.category)
  console.log(`${modes} categories applied in ${SECTIONS.length} sections; CC set on ${ccSet} heads, cleared on ${ccCleared}`)
  console.log('extras not in your list:', extraNames.length ? extraNames.join(', ') : 'none')
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
