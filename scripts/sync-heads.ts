// Sync the chart of accounts to Himal's tagging list (the v2 prototype
// master, 118 heads across HG / MG / PG / ACPL).
//
//   npx tsx --conditions=react-server scripts/sync-heads.ts --dry
//   npx tsx --conditions=react-server scripts/sync-heads.ts
//
// Creates every head under the group its prototype ledger maps to, sets each
// head's default cost centre, and archives leftover seed heads that are not
// on the list and carry no postings. Idempotent: re-running changes nothing.
import 'dotenv/config'
import { readFileSync } from 'fs'
import { prisma } from '../src/lib/db'
import { nextChildCode } from '../src/lib/ledger/coa'
import type { AccountKind } from '../src/generated/prisma/client'

interface Head {
  name: string
  ledger: string
  cc: string
  entities: string[]
}

// Extra groups the seed doesn't have. Codes sit in the gaps of COA_SEED.
const EXTRA_GROUPS: { code: string; name: string; kind: AccountKind; parent: string }[] = [
  { code: '1700', name: 'Investments', kind: 'ASSET', parent: '1000' },
  { code: '1800', name: 'Transfers in transit (contra)', kind: 'ASSET', parent: '1000' },
  { code: '2500', name: 'Credit Cards', kind: 'LIABILITY', parent: '2000' },
  { code: '2600', name: 'Deposits Received', kind: 'LIABILITY', parent: '2000' },
]

// Prototype ledger -> the group new heads hang under. The prototype files
// personal spending under "Drawings" (equity); here it stays an EXPENSE so
// household heads keep showing in the weekly/monthly expense reports and in
// Budget vs Actual — what's claimable is a tax attribute, not a ledger kind.
const LEDGER_GROUP: Record<string, string> = {
  'Business Expenses (claimable)': '5000',
  'Household Expenses': '5000',
  'Professional & Statutory Fees': '5000',
  'Payroll & Staff Costs': '5000',
  'Software & Subscriptions': '5000',
  'Marketing & Advertising': '5000',
  'Professional Fees Paid': '5000',
  Drawings: '5000',
  'Capital Introduced': '3100',
  'Consulting Revenue': '4000',
  'Professional Fee Income': '4000',
  'Salary Income': '4000',
  'Rental Income': '4000',
  'Other Income': '4000',
  'Interest Income': '4000',
  'Dividend Income': '4000',
  'Loans & Advances Given': '1400',
  'Loans Taken': '2300',
  Investments: '1700',
  'Fixed Assets': '1900',
  'Statutory Dues Payable': '2200',
  'Deposits Received': '2600',
  'Bank Transfer (Contra)': '1800',
}

// Cards are liabilities, not contra clearing accounts.
const CARD_NAMES = new Set(['HDFC CC', 'AMEX CC'])
// Already covered by the real cash-location accounts (1201…).
const SKIP_NAMES = new Set(['Cash'])

// Cost centres I named differently when seeding them earlier.
const CC_ALIAS: Record<string, Record<string, string>> = {
  HG: { 'Family & Personal': 'Personal' },
  // A company has no household bucket — its heads land on the ops centre.
  ACPL: { 'ACPL Business': 'Office Operations', 'Family & Personal': 'Office Operations' },
}

const dry = process.argv.includes('--dry')
const log = (s: string) => console.log(s)

async function main() {
  const heads: Head[] = JSON.parse(readFileSync('scripts/data/prototype-heads.json', 'utf8'))
  const entities = await prisma.entity.findMany({ select: { id: true, code: true } })
  const wanted = new Map<string, Set<string>>() // entity code -> head names

  let created = 0
  let groupsMade = 0
  let ccSet = 0
  let archived = 0

  for (const entity of entities) {
    const mine = heads.filter((h) => h.entities.includes(entity.code) && !SKIP_NAMES.has(h.name))
    if (mine.length === 0) continue
    wanted.set(entity.code, new Set(mine.map((h) => h.name)))

    // --- groups this entity will need ---
    for (const g of EXTRA_GROUPS) {
      const needed = mine.some(
        (h) => (CARD_NAMES.has(h.name) ? '2500' : LEDGER_GROUP[h.ledger]) === g.code,
      )
      if (!needed) continue
      const exists = await prisma.ledgerAccount.findUnique({
        where: { entityId_code: { entityId: entity.id, code: g.code } },
      })
      if (exists) continue
      const parent = await prisma.ledgerAccount.findUniqueOrThrow({
        where: { entityId_code: { entityId: entity.id, code: g.parent } },
      })
      log(`GROUP ${entity.code}: ${g.code} ${g.name}`)
      groupsMade++
      if (!dry) {
        await prisma.ledgerAccount.create({
          data: {
            entityId: entity.id,
            code: g.code,
            name: g.name,
            kind: g.kind,
            parentId: parent.id,
            isGroup: true,
          },
        })
      }
    }

    const costCentres = await prisma.costCentre.findMany({
      where: { entityId: entity.id, archivedAt: null },
    })
    const ccIdFor = async (protoName: string) => {
      const name = CC_ALIAS[entity.code]?.[protoName] ?? protoName
      const found = costCentres.find((c) => c.name === name)
      if (found) return found.id
      if (dry) return null
      const made = await prisma.costCentre.create({ data: { entityId: entity.id, name } })
      costCentres.push(made)
      log(`CC    ${entity.code}: ${name}`)
      return made.id
    }

    // --- heads ---
    for (const head of mine) {
      const groupCode = CARD_NAMES.has(head.name) ? '2500' : LEDGER_GROUP[head.ledger]
      if (!groupCode) {
        log(`SKIP  ${entity.code}: ${head.name} — unmapped ledger "${head.ledger}"`)
        continue
      }
      const ccId = head.cc ? await ccIdFor(head.cc) : null
      // Leaves only: the list has heads whose names collide with group heads
      // ("Income", "Investments"), and a group must never be re-homed.
      const existing = await prisma.ledgerAccount.findFirst({
        where: { entityId: entity.id, name: head.name, isGroup: false },
      })
      const parent = await prisma.ledgerAccount.findUnique({
        where: { entityId_code: { entityId: entity.id, code: groupCode } },
      })
      if (!parent) {
        log(`SKIP  ${entity.code}: ${head.name} — group ${groupCode} missing`)
        continue
      }
      if (existing) {
        // Already there (seeded head with the same name, or a re-run): make
        // sure it's live, sits under the mapped group, and carries its
        // default cost centre. Re-homing only ever moves untouched heads —
        // one with postings keeps its code so no history moves under it.
        const misfiled = existing.parentId !== parent.id
        const postings = misfiled
          ? await prisma.journalLine.count({ where: { accountId: existing.id } })
          : 0
        const move = misfiled && postings === 0
        if (misfiled && postings > 0) {
          log(`STAY  ${entity.code}: ${existing.code} ${existing.name} — ${postings} posting(s), left where it is`)
        }
        const needsCc = ccId && existing.defaultCostCentreId !== ccId
        if (!dry && (move || existing.archivedAt || needsCc)) {
          const code = move ? await nextChildCode(prisma, entity.id, parent.code) : existing.code
          await prisma.ledgerAccount.update({
            where: { id: existing.id },
            data: {
              archivedAt: null,
              ...(ccId ? { defaultCostCentreId: ccId } : {}),
              ...(move ? { parentId: parent.id, kind: parent.kind, code } : {}),
            },
          })
          if (move) log(`MOVE  ${entity.code}: ${existing.name} → ${code} (${parent.name})`)
          ccSet++
        } else if (dry && move) {
          log(`MOVE  ${entity.code}: ${existing.name} → ${parent.name}`)
        }
        continue
      }
      created++
      if (dry) {
        log(`HEAD  ${entity.code}: ${head.name} → ${groupCode} ${parent.name} · cc ${head.cc}`)
        continue
      }
      const code = await nextChildCode(prisma, entity.id, parent.code)
      await prisma.ledgerAccount.create({
        data: {
          entityId: entity.id,
          parentId: parent.id,
          code,
          name: head.name,
          kind: parent.kind,
          defaultCostCentreId: ccId,
        },
      })
      log(`HEAD  ${entity.code}: ${code} ${head.name} (${parent.name})`)
    }
  }

  // --- retire seed heads that aren't on the list ---
  // Anything with postings stays, so no balance can disappear behind an
  // archive. Seed leaves the engine itself posts to are protected by code.
  const PROTECTED = new Set([
    '1500', // GST Input Credit
    '1600', // TDS Receivable
    '2210', // GST Output Liability
    '2220', // GST Payable — tagged directly for GST payments
    '2230', // TDS Payable
    '3100', // Capital
    '3200', // Opening Balances
    '3300', // Reserves & Surplus
    '5100', // Salaries — the salary run posts here
    '5110', // Consultant fees — 194J side of the salary run
  ])
  for (const entity of entities) {
    const keep = wanted.get(entity.code)
    if (!keep) continue
    const leaves = await prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null },
      include: { _count: { select: { lines: true } } },
    })
    for (const a of leaves) {
      // Bank/cash/party/opening plumbing is not a "tag" — leave it alone.
      if (/^(11|12|13|24|32|33)/.test(a.code)) continue
      if (PROTECTED.has(a.code)) continue
      if (keep.has(a.name)) continue
      if (a._count.lines > 0) {
        log(`KEEP  ${entity.code}: ${a.code} ${a.name} — has ${a._count.lines} posting(s)`)
        continue
      }
      archived++
      log(`ARCH  ${entity.code}: ${a.code} ${a.name}`)
      if (!dry) {
        await prisma.ledgerAccount.update({ where: { id: a.id }, data: { archivedAt: new Date() } })
      }
    }
  }

  log(
    `\n${dry ? '[dry run] ' : ''}${created} head(s) created, ${groupsMade} group(s), ` +
      `${ccSet} default(s) refreshed, ${archived} unused seed head(s) archived`,
  )
}

main().finally(() => prisma.$disconnect())
