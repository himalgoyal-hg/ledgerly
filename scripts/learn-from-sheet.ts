// Teach the rule engine from the FY 2026-27 workbook.
//
//   npx tsx --conditions=react-server scripts/learn-from-sheet.ts --dry
//   npx tsx --conditions=react-server scripts/learn-from-sheet.ts
//   npx tsx --conditions=react-server scripts/learn-from-sheet.ts --apply
//
// scripts/data/sheet-tagged-rows.json holds every already-tagged row Himal
// keeps in the sheet: the bank narration and the head he filed it under
// ("Category 1"). Each narration collapses to the same party token the import
// pipeline uses, so a token that always went to one head becomes a TagRule —
// and the next statement tags itself. --apply also sweeps the rules over rows
// already sitting in the pending queue.
import 'dotenv/config'
import { readFileSync } from 'fs'
import { prisma } from '../src/lib/db'
import { partyToken } from '../src/lib/statements/rules'
import { suggestNature } from '../src/lib/statements/natures'
import { applyTag } from '../src/lib/statements/post'
import { audit, auditedTransaction } from '../src/lib/audit'

interface Pair { sheet: string; book: string; narration: string; head: string }

// Labels the sheet writes differently from the head master.
const ALIAS: Record<string, string> = {
  'kotak transfer': 'ICICI <<-->> Kotak',
  'bike expenses': 'Bike/ Car Expenses',
  'professional fees': 'Professional Fees',
}
// Transfer labels that don't say which of two own accounts sits on the other
// side. A guess here posts money into the wrong account, so they are left for
// Himal to tag by hand.
const AMBIGUOUS = new Set(['icici transfer', 'self transfer', 'federal account'])

const dry = process.argv.includes('--dry')
const apply = process.argv.includes('--apply')
const CTRL = new RegExp('[\\u0000-\\u001F\\u007F]', 'g')

async function main() {
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const pairs: Pair[] = JSON.parse(readFileSync('scripts/data/sheet-tagged-rows.json', 'utf8'))
  const entities = await prisma.entity.findMany({
    where: { archivedAt: null },
    select: { id: true, code: true },
  })
  const byCode = new Map(entities.map((e) => [e.code, e.id]))

  // book -> token -> head tallies. Nested maps rather than one composite
  // string key: bank narrations carry odd bytes, and a separator that has to
  // survive them is a bug waiting to happen.
  const tally = new Map<string, Map<string, Map<string, number>>>()
  let noToken = 0
  let ambiguous = 0
  for (const p of pairs) {
    const label = p.head.trim()
    const key = label.toLowerCase().replace(/\s+/g, ' ')
    if (AMBIGUOUS.has(key)) { ambiguous++; continue }
    const head = ALIAS[key] ?? label
    const token = partyToken(p.narration)?.replace(CTRL, '')
    if (!token) { noToken++; continue }
    const forBook = tally.get(p.book) ?? new Map<string, Map<string, number>>()
    const m = forBook.get(token) ?? new Map<string, number>()
    m.set(head, (m.get(head) ?? 0) + 1)
    forBook.set(token, m)
    tally.set(p.book, forBook)
  }

  const conflicts: string[] = []
  const unmatched = new Map<string, number>()
  // book -> token -> head name the sheet agrees on ('' when it contradicts
  // itself, which also stops another book's answer leaking in).
  const decided = new Map<string, Map<string, string>>()
  const decide = (book: string, token: string, head: string) => {
    const m = decided.get(book) ?? new Map<string, string>()
    m.set(token, head)
    decided.set(book, m)
  }
  let written = 0

  const write = async (entityId: string, token: string, headName: string, source: string) => {
    const account = await prisma.ledgerAccount.findFirst({
      where: { entityId, name: headName, isGroup: false, archivedAt: null },
    })
    if (!account) return false
    if (!dry) {
      await prisma.tagRule.upsert({
        where: { entityId_pattern: { entityId, pattern: token } },
        create: {
          entityId, pattern: token, headAccountId: account.id,
          nature: suggestNature(account, true),
          costCentreId: account.defaultCostCentreId, source,
        },
        update: {
          headAccountId: account.id, nature: suggestNature(account, true),
          costCentreId: account.defaultCostCentreId, source,
        },
      })
    }
    written++
    return true
  }

  for (const [book, tokens] of tally) {
    const entityId = byCode.get(book)
    if (!entityId) continue
    for (const [token, heads] of tokens) {
      const ranked = [...heads.entries()].sort((a, b) => b[1] - a[1])
      const [winner, wins] = ranked[0]
      const total = ranked.reduce((s, [, n]) => s + n, 0)
      // A token that went two ways in the sheet teaches nothing reliable.
      if (ranked.length > 1 && wins / total < 0.7) {
        conflicts.push(`${book} "${token}": ${ranked.map(([h, n]) => h + ' x' + n).join(' vs ')}`)
        decide(book, token, '')
        continue
      }
      decide(book, token, winner)
      if (!(await write(entityId, token, winner, 'sheet'))) {
        const k = `${book}: ${winner}`
        unmatched.set(k, (unmatched.get(k) ?? 0) + total)
      }
    }
  }

  // A merchant learnt in one set of books carries to the others that keep a
  // head of the same name — the names are Himal's own vocabulary, so the same
  // name means the same thing everywhere. A book that decided the token from
  // its own rows (or found it ambiguous) is never overwritten.
  const already = new Map<string, Set<string>>()
  for (const r of await prisma.tagRule.findMany({ select: { entityId: true, pattern: true } })) {
    const s = already.get(r.entityId) ?? new Set<string>()
    s.add(r.pattern)
    already.set(r.entityId, s)
  }
  let crossed = 0
  for (const [, tokens] of decided) {
    for (const [token, headName] of tokens) {
      if (!headName) continue
      for (const e of entities) {
        if (decided.get(e.code)?.has(token)) continue
        const seen = already.get(e.id) ?? new Set<string>()
        if (seen.has(token)) continue
        if (await write(e.id, token, headName, 'sheet-cross')) {
          seen.add(token)
          already.set(e.id, seen)
          crossed++
        }
      }
    }
  }

  // Rows already tagged inside the app are the freshest decision there is —
  // they win over anything the sheet taught.
  let fromApp = 0
  const appRows = await prisma.statementTransaction.findMany({
    where: { status: { in: ['TAGGED', 'POSTED'] }, headAccountId: { not: null } },
    select: { entityId: true, narration: true, headAccountId: true, nature: true, costCentreId: true },
    orderBy: { taggedAt: 'asc' },
  })
  for (const row of appRows) {
    const token = partyToken(row.narration)?.replace(CTRL, '')
    if (!token || dry) continue
    await prisma.tagRule.upsert({
      where: { entityId_pattern: { entityId: row.entityId, pattern: token } },
      create: {
        entityId: row.entityId, pattern: token, headAccountId: row.headAccountId!,
        nature: row.nature ?? 'expense', costCentreId: row.costCentreId, source: 'app',
      },
      update: {
        headAccountId: row.headAccountId!, nature: row.nature ?? 'expense',
        costCentreId: row.costCentreId, source: 'app',
      },
    })
    fromApp++
  }
  if (fromApp) console.log(`plus ${fromApp} rule(s) refreshed from rows already tagged in the app`)

  const tokenCount = [...tally.values()].reduce((s, m) => s + m.size, 0)
  console.log(`rows read ${pairs.length} · tokens ${tokenCount} · rules ${dry ? 'that would be written' : 'written'} ${written} (${crossed} carried across books)`)
  console.log(`skipped: ${noToken} with no usable party token, ${ambiguous} ambiguous transfer labels`)
  if (conflicts.length) {
    console.log('\ntokens the sheet tagged two ways (left alone):')
    conflicts.forEach((c) => console.log('  ' + c))
  }
  if (unmatched.size) {
    console.log("\nheads the sheet uses that those books don't have:")
    ;[...unmatched.entries()].sort((a, b) => b[1] - a[1]).forEach(([h, n]) => console.log(`  ${String(n).padStart(3)}  ${h}`))
  }

  // --- coverage over what's already waiting ---
  const pending = await prisma.statementTransaction.findMany({
    where: { status: 'PENDING' },
    select: { id: true, entityId: true, narration: true },
  })
  const rules = await prisma.tagRule.findMany()
  const byEntity = new Map<string, Map<string, (typeof rules)[number]>>()
  for (const r of rules) {
    const m = byEntity.get(r.entityId) ?? new Map()
    m.set(r.pattern, r)
    byEntity.set(r.entityId, m)
  }
  const hits: { id: string; entityId: string; rule: (typeof rules)[number] }[] = []
  for (const t of pending) {
    const token = partyToken(t.narration)?.replace(CTRL, '')
    const rule = token ? byEntity.get(t.entityId)?.get(token) : undefined
    if (rule) hits.push({ id: t.id, entityId: t.entityId, rule })
  }
  console.log(`\npending queue: ${pending.length} rows · ${hits.length} now match a rule`)

  if (!apply || dry) {
    if (hits.length) console.log('run again with --apply to tag them')
    return
  }

  for (const h of hits) {
    await auditedTransaction(async (tx) => {
      await applyTag(tx, {
        txnId: h.id,
        headAccountId: h.rule.headAccountId,
        nature: h.rule.nature,
        costCentreId: h.rule.costCentreId,
        actorId: admin.id,
      })
      // Tagged by the engine, not by a person — the queue says so.
      await tx.statementTransaction.update({
        where: { id: h.id },
        data: { autoTagged: true, tagSource: 'rule' },
      })
    })
  }
  if (hits.length) {
    await auditedTransaction((tx) =>
      audit(tx, {
        actorId: admin.id,
        action: 'statement_txn.auto_tag_from_sheet',
        targetType: 'Entity',
        targetId: hits[0].entityId,
        summary: `Auto-tagged ${hits.length} pending row(s) from rules learned off the FY 2026-27 sheet`,
      }),
    )
  }
  console.log(`auto-tagged ${hits.length} row(s) — they now sit in "Tagged, awaiting post"`)
}

main().finally(() => prisma.$disconnect())
