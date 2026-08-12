import { prisma } from '@/lib/db'
import { partyToken, salientTokens } from './rules'

// Key-free smart suggestions: what the user already tagged IS the model.
// Two lookups fill the gap the exact-match rule engine leaves:
//
//   1. Fuzzy history — a pending narration that shares enough salient tokens
//      with an already-tagged one inherits its head/nature/cost centre
//      ("SWIGGY INSTAMART BLR" looks like "SWIGGY BANGALORE" → Food & Dining).
//   2. Cross-books party — the same party tagged in ANOTHER set of books
//      maps over when a head with the same name exists here (Zomato is
//      Food & Dining in HG, so suggest MG's own Food & Dining for it).
//
// Suggestions land in the same advisory ai* fields the AI uses — the queue's
// accept/dismiss line works unchanged, and accepting teaches a real rule.
// Rows with no confident match are left untouched (aiSuggestedAt stays null)
// so the AI can still try them when a key is configured.

/** Overlap of pending-row tokens against a history row's, 0..1. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let hit = 0
  let strong = false
  for (const t of a) {
    if (b.has(t)) {
      hit++
      if (t.length >= 4) strong = true
    }
  }
  if (!strong) return 0 // 3-letter coincidences alone don't identify a party
  return hit / Math.min(a.size, b.size)
}

export async function suggestFromHistory(entityId: string, limit = 200) {
  const pending = await prisma.statementTransaction.findMany({
    where: { entityId, status: 'PENDING', aiSuggestedAt: null },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    take: limit,
  })
  if (pending.length === 0) return { considered: 0, suggested: 0 }

  const [history, myHeads, otherRules] = await Promise.all([
    prisma.statementTransaction.findMany({
      where: { entityId, status: { in: ['TAGGED', 'POSTED'] }, headAccountId: { not: null } },
      orderBy: { taggedAt: 'desc' },
      take: 1000,
      select: { narration: true, headAccountId: true, nature: true, costCentreId: true },
    }),
    prisma.ledgerAccount.findMany({
      where: { entityId, isGroup: false, archivedAt: null },
      select: { id: true, name: true, defaultCostCentreId: true },
    }),
    prisma.tagRule.findMany({
      where: { entityId: { not: entityId } },
      select: { entityId: true, pattern: true, headAccountId: true, nature: true },
    }),
  ])
  const myHeadIds = new Set(myHeads.map((h) => h.id))
  const myHeadByName = new Map(myHeads.map((h) => [h.name.toLowerCase(), h]))
  const historyTokens = history.map((h) => ({ row: h, tokens: new Set(salientTokens(h.narration)) }))

  // Other-books rule heads → names (to map onto this books' same-named head).
  const foreignHeadIds = [...new Set(otherRules.map((r) => r.headAccountId))]
  const foreignHeads = await prisma.ledgerAccount.findMany({
    where: { id: { in: foreignHeadIds } },
    select: { id: true, name: true, entityId: true },
  })
  const foreignHeadById = new Map(foreignHeads.map((h) => [h.id, h]))
  const entityCodes = new Map(
    (await prisma.entity.findMany({ select: { id: true, code: true } })).map((e) => [e.id, e.code]),
  )

  let suggested = 0
  for (const txn of pending) {
    const tokens = new Set(salientTokens(txn.narration))

    // 1. Fuzzy match against own tagged history — most recent best match wins.
    let best: { score: number; head: string; nature: string | null; cc: string | null; why: string } | null = null
    for (const h of historyTokens) {
      if (!h.row.headAccountId || !myHeadIds.has(h.row.headAccountId)) continue
      const score = overlap(tokens, h.tokens)
      if (score >= 0.5 && (!best || score > best.score)) {
        best = {
          score,
          head: h.row.headAccountId,
          nature: h.row.nature,
          cc: h.row.costCentreId,
          why: `Looks like an earlier row you tagged: "${h.row.narration.slice(0, 60)}"`,
        }
        if (score === 1) break
      }
    }

    // 2. Same party already ruled in another set of books, same-named head here.
    if (!best) {
      const party = partyToken(txn.narration)
      if (party) {
        const rule = otherRules.find((r) => r.pattern === party)
        const foreign = rule ? foreignHeadById.get(rule.headAccountId) : undefined
        const mine = foreign ? myHeadByName.get(foreign.name.toLowerCase()) : undefined
        if (rule && foreign && mine) {
          best = {
            score: 0.55,
            head: mine.id,
            nature: rule.nature,
            cc: mine.defaultCostCentreId ?? null,
            why: `${entityCodes.get(foreign.entityId) ?? 'Other'} books tag this party as "${foreign.name}"`,
          }
        }
      }
    }

    if (!best || !best.nature) continue
    await prisma.statementTransaction.update({
      where: { id: txn.id },
      data: {
        aiHeadAccountId: best.head,
        aiNature: best.nature,
        aiCostCentreId: best.cc,
        aiConfidence: Math.min(0.45 + best.score * 0.3, 0.79).toFixed(3),
        aiReason: best.why,
        aiSuggestedAt: new Date(),
      },
    })
    suggested++
  }
  return { considered: pending.length, suggested }
}
