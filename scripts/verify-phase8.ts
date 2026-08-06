// Phase 8 verification (spec §12.8): the AI layer's guard rails.
//
// The model itself is not under test here — the layer around it is, and that
// is the part that matters for a set of books: what happens to output that is
// wrong, invented, duplicated, or absent, and what happens when the API is not
// configured at all. Every check below runs without an API key.
//
// With ANTHROPIC_API_KEY set, a live end-to-end smoke test runs too.
import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { seedChartOfAccounts } from '../src/lib/ledger/coa'
import { aiConfigured, AI_UNCONFIGURED_MESSAGE, aiUsageSummary } from '../src/lib/ai/client'
import { normalizeAiRow, type AiRawRow } from '../src/lib/ai/extract'
import { resolveSuggestions, saveSuggestions, type RawSuggestion } from '../src/lib/ai/tag'
import { parseAnyUpload, createStatementImport, confirmStatementImport } from '../src/lib/statements/import'
import { applyTag } from '../src/lib/statements/post'
import { partyToken } from '../src/lib/statements/rules'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const row = (over: Partial<AiRawRow> = {}): AiRawRow => ({
  date: '05/07/2026', narration: 'UPI/1234/SWIGGY', reference: null,
  debit: '500.00', credit: null, balance: null, ...over,
})

async function main() {
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })

  // =========================================================================
  // Extraction normalization — what happens to bad rows
  // =========================================================================
  const good = normalizeAiRow(row())
  check(
    'extract: a clean row normalizes to the pipeline shape',
    good !== null && good.debit === '500.00' && good.credit === '0.00' &&
      good.date.toISOString().slice(0, 10) === '2026-07-05',
    JSON.stringify(good && { d: good.debit, c: good.credit }),
  )
  check(
    'extract: Indian dd/mm dates are not read as US mm/dd',
    normalizeAiRow(row({ date: '05/07/2026' }))?.date.getUTCMonth() === 6, // July
  )
  check(
    'extract: a row with neither amount is dropped, not zero-posted',
    normalizeAiRow(row({ debit: null, credit: null })) === null,
  )
  check(
    'extract: a row with BOTH amounts is dropped (ambiguous misread)',
    normalizeAiRow(row({ debit: '500.00', credit: '500.00' })) === null,
  )
  check(
    'extract: an unparseable date is dropped rather than guessed',
    normalizeAiRow(row({ date: 'sometime in July' })) === null,
  )
  check(
    'extract: an empty narration is dropped',
    normalizeAiRow(row({ narration: '   ' })) === null,
  )
  check(
    'extract: currency symbols and separators are stripped',
    normalizeAiRow(row({ debit: '₹ 1,23,456.78' }))?.debit === '123456.78',
    normalizeAiRow(row({ debit: '₹ 1,23,456.78' }))?.debit,
  )
  check(
    'extract: a credit row lands on the credit side',
    normalizeAiRow(row({ debit: null, credit: '900.50' }))?.credit === '900.50',
  )

  // =========================================================================
  // Setup for the suggestion guard rails
  // =========================================================================
  const entity = await prisma.$transaction(async (tx) => {
    const e = await tx.entity.create({
      data: { name: 'Verify P8', code: 'VP8', type: 'PVT_LTD', pan: 'AAAPV0008A' },
    })
    await seedChartOfAccounts(tx, e.id)
    return e
  })
  const account = (code: string) =>
    prisma.ledgerAccount.findUniqueOrThrow({
      where: { entityId_code: { entityId: entity.id, code } },
    })
  const food = await account('5310')
  const groupHead = await account('5000') // a group — never postable
  const hyrox = await prisma.costCentre.create({
    data: { entityId: entity.id, name: 'Hyrox' },
  })
  // A second entity, to prove suggestions can't cross the books boundary.
  const other = await prisma.$transaction(async (tx) => {
    const e = await tx.entity.create({
      data: { name: 'Verify P8 Other', code: 'VP8B', type: 'INDIVIDUAL', pan: 'AAAPV0009A' },
    })
    await seedChartOfAccounts(tx, e.id)
    return e
  })
  const otherFood = await prisma.ledgerAccount.findUniqueOrThrow({
    where: { entityId_code: { entityId: other.id, code: '5310' } },
  })

  const heads = await prisma.ledgerAccount.findMany({
    where: { entityId: entity.id, isGroup: false, archivedAt: null },
    select: { id: true, code: true },
  })
  const centres = [{ id: hyrox.id, name: hyrox.name }]
  const resolve = (replies: RawSuggestion[], ids: string[]) =>
    resolveSuggestions({ replies, requestedIds: ids, heads, costCentres: centres })

  const base: RawSuggestion = {
    id: 'txn-1', headCode: '5310', nature: 'expense',
    costCentreName: 'Hyrox', confidence: 0.9, reason: 'Swiggy is food delivery',
  }

  // =========================================================================
  // Suggestion guard rails — the part that protects the ledger
  // =========================================================================
  const ok = resolve([base], ['txn-1'])
  check(
    'suggest: a valid suggestion resolves to real ids',
    ok.length === 1 && ok[0].headAccountId === food.id && ok[0].costCentreId === hyrox.id &&
      ok[0].nature === 'expense' && ok[0].confidence === 0.9,
    JSON.stringify(ok[0]),
  )
  check(
    'suggest: an invented account code is dropped, not created',
    resolve([{ ...base, headCode: '9999' }], ['txn-1']).length === 0,
  )
  check(
    'suggest: another entity\'s account code cannot be used',
    // The other entity's 5310 exists as a row but under a different id —
    // resolution is by code within THIS entity's chart, so ids never cross.
    resolve([base], ['txn-1'])[0].headAccountId !== otherFood.id,
  )
  check(
    'suggest: an unknown nature is dropped',
    resolve([{ ...base, nature: 'creative_accounting' }], ['txn-1']).length === 0,
  )
  check(
    'suggest: a null head (model unsure) yields no suggestion',
    resolve([{ ...base, headCode: null }], ['txn-1']).length === 0,
  )
  check(
    'suggest: a reply for a row we never asked about is ignored',
    resolve([{ ...base, id: 'txn-elsewhere' }], ['txn-1']).length === 0,
  )
  check(
    'suggest: duplicate replies for one row collapse to the first',
    resolve([base, { ...base, headCode: '5900' }], ['txn-1']).length === 1,
  )
  check(
    'suggest: an unknown cost centre degrades to none, keeping the tag',
    resolve([{ ...base, costCentreName: 'Atlantis' }], ['txn-1'])[0].costCentreId === null,
  )
  check(
    'suggest: out-of-range confidence is clamped',
    resolve([{ ...base, confidence: 4.2 }], ['txn-1'])[0].confidence === 1 &&
      resolve([{ ...base, confidence: -1 }], ['txn-1'])[0].confidence === 0,
  )
  const longReason = resolve([{ ...base, reason: 'x'.repeat(1000) }], ['txn-1'])[0]
  check('suggest: an overlong reason is truncated', longReason.reason.length === 300)

  // Group heads are never offered to the model (the candidate list is leaf
  // accounts only), so a suggested group code has nothing to resolve against
  // and is dropped — one layer before the posting service would refuse it.
  check(
    'suggest: a group head is not a candidate, so it cannot be suggested',
    !heads.some((h) => h.id === groupHead.id) &&
      resolve([{ ...base, headCode: groupHead.code }], ['txn-1']).length === 0,
  )

  // =========================================================================
  // Accept flow — a suggestion becomes a tag AND teaches the rule engine
  // =========================================================================
  const bankGroup = await account('1100')
  const bankLedger = await prisma.ledgerAccount.create({
    data: { entityId: entity.id, code: '1101', name: 'VP8 Bank', kind: 'ASSET', parentId: bankGroup.id },
  })
  const bank = await prisma.bankAccount.create({
    data: {
      entityId: entity.id, bankName: 'Test', accountNumber: '888800004444',
      ifsc: 'TEST0000008', nickname: 'VP8 Bank', openingBalance: 0,
      openingDate: new Date('2026-06-01'), ledgerAccountId: bankLedger.id,
    },
  })
  const statement = await parseAnyUpload('vp8.csv', Buffer.from([
    'Account Number: 888800004444',
    'Date,Particulars,Debit,Credit,Balance',
    '05/07/2026,UPI/9911/SWIGGY LTD/swiggy@ybl,500.00,,9500.00',
  ].join('\n')))
  check('upload: a spreadsheet still parses heuristically, not via AI', statement.via === 'heuristic')
  const imp = await prisma.$transaction(async (tx) => {
    const { record } = await createStatementImport(tx, {
      fileName: 'vp8.csv', parsed: statement.parsed, parsedVia: statement.via, actorId: admin.id,
    })
    return record
  })
  await prisma.$transaction((tx) =>
    confirmStatementImport(tx, { importId: imp.id, bankAccountId: bank.id, actorId: admin.id }),
  )
  const txn = await prisma.statementTransaction.findFirstOrThrow({ where: { importId: imp.id } })

  await saveSuggestions([{
    txnId: txn.id, headAccountId: food.id, nature: 'expense',
    costCentreId: hyrox.id, confidence: 0.91, reason: 'Swiggy is food delivery',
  }])
  const suggested = await prisma.statementTransaction.findUniqueOrThrow({ where: { id: txn.id } })
  check(
    'accept: a stored suggestion leaves the row PENDING until a human acts',
    suggested.status === 'PENDING' && suggested.headAccountId === null &&
      suggested.aiHeadAccountId === food.id && String(suggested.aiConfidence) === '0.91',
    `status ${suggested.status}, tagged head ${suggested.headAccountId}`,
  )

  // Accepting applies the tag through the ordinary path (which is what makes
  // the rule engine learn it).
  await prisma.$transaction(async (tx) => {
    await applyTag(tx, {
      txnId: txn.id,
      headAccountId: suggested.aiHeadAccountId!,
      nature: suggested.aiNature!,
      costCentreId: suggested.aiCostCentreId,
      actorId: admin.id,
    })
    await tx.statementTransaction.update({ where: { id: txn.id }, data: { tagSource: 'ai' } })
  })
  const accepted = await prisma.statementTransaction.findUniqueOrThrow({ where: { id: txn.id } })
  check(
    'accept: the row becomes TAGGED with the suggested values',
    accepted.status === 'TAGGED' && accepted.headAccountId === food.id &&
      accepted.costCentreId === hyrox.id && accepted.tagSource === 'ai',
  )
  const learned = await prisma.tagRule.findUnique({
    where: { entityId_pattern: { entityId: entity.id, pattern: partyToken(txn.narration)! } },
  })
  check(
    'accept: accepting teaches the rule engine, so AI is not needed next time',
    learned?.headAccountId === food.id && learned?.nature === 'expense',
    `rule for "${partyToken(txn.narration)}"`,
  )

  // =========================================================================
  // Degradation without an API key, and usage accounting
  // =========================================================================
  const configured = aiConfigured()
  if (!configured) {
    check(
      'degradation: aiConfigured() is false without ANTHROPIC_API_KEY',
      !configured,
    )
    check(
      'degradation: the message tells the user what to do instead',
      AI_UNCONFIGURED_MESSAGE.includes('ANTHROPIC_API_KEY') &&
        AI_UNCONFIGURED_MESSAGE.includes('CSV'),
      AI_UNCONFIGURED_MESSAGE,
    )
    await parseAnyUpload('scan.pdf', Buffer.from('%PDF-1.4 fake')).then(
      () => check('degradation: a PDF upload is refused with that message', false),
      (e) => check(
        'degradation: a PDF upload is refused with that message',
        /ANTHROPIC_API_KEY/.test(String(e)),
        String(e).slice(0, 90),
      ),
    )
  } else {
    check('AI is configured — live smoke test runs below', true)
  }

  const usage = await aiUsageSummary(30)
  check(
    'usage: the accounting query runs and reports per-kind totals',
    Array.isArray(usage.byKind) && typeof usage.failures === 'number',
    `${usage.byKind.length} kind(s), ${usage.failures} failure(s)`,
  )

  // =========================================================================
  // Live smoke test — only with a configured key
  // =========================================================================
  if (configured) {
    const { suggestTags } = await import('../src/lib/ai/tag')
    try {
      const live = await suggestTags(entity.id, [{
        id: txn.id, date: txn.date, narration: 'UPI/4455/INDIAN OIL PETROL PUMP',
        reference: null, debit: '2000.00', credit: '0.00',
      }])
      check(
        'live: a real call returns a resolvable suggestion (or an honest none)',
        live.every((s) => heads.some((h) => h.id === s.headAccountId)),
        live.length ? `${live[0].reason}` : 'no confident suggestion',
      )
      const after = await aiUsageSummary(1)
      check(
        'live: the call was logged with token usage',
        after.byKind.some((k) => k.kind === 'tag_suggestion' && k.inputTokens > 0),
      )
    } catch (e) {
      check('live: a real call succeeds', false, String(e).slice(0, 120))
    }
  }

  // --- Clean up ---
  await prisma.aiCall.deleteMany({ where: { entityId: { in: [entity.id, other.id] } } })
  await prisma.statementImport.deleteMany({ where: { bankAccountId: bank.id } })
  await prisma.tagRule.deleteMany({ where: { entityId: entity.id } })
  await prisma.bankAccount.deleteMany({ where: { entityId: entity.id } })
  for (const e of [entity.id, other.id]) {
    await prisma.$executeRaw`ALTER TABLE "JournalLine" DISABLE TRIGGER USER`
    await prisma.$executeRaw`ALTER TABLE "JournalEntry" DISABLE TRIGGER USER`
    await prisma.$executeRaw`DELETE FROM "JournalLine" WHERE "entryId" IN (SELECT id FROM "JournalEntry" WHERE "entityId" = ${e})`
    await prisma.journalDoc.updateMany({ where: { entityId: e }, data: { currentEntryId: null } })
    await prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "entityId" = ${e}`
    await prisma.$executeRaw`ALTER TABLE "JournalLine" ENABLE TRIGGER USER`
    await prisma.$executeRaw`ALTER TABLE "JournalEntry" ENABLE TRIGGER USER`
    await prisma.journalDoc.deleteMany({ where: { entityId: e } })
    await prisma.costCentre.deleteMany({ where: { entityId: e } })
    await prisma.ledgerAccount.deleteMany({ where: { entityId: e } })
    await prisma.entity.delete({ where: { id: e } })
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (!configured) {
    console.log('(live model calls skipped — ANTHROPIC_API_KEY is not set)')
  }
  process.exitCode = failed.length ? 1 : 0
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
