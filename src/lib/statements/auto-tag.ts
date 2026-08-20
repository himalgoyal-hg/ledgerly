import type { Prisma } from '@/generated/prisma/client'
import { applyTag } from './post'
import { partyToken } from './rules'

// Settling the repeats (Himal, 20 Aug: "2-3 vela kinva jast transaction
// aahet ashe fix automatically karaych"). A party tagged once is already
// remembered as a rule, and a fresh import applies it as the rows land —
// but rows that were sitting PENDING before the rule was learned, or whose
// sibling was tagged through the bulk bar (which does not spread to the
// party), keep waiting for nothing. This sweeps them.

export interface AutoTagResult {
  tagged: number
  parties: number
}

/** Tag every pending row whose party this books has tagged before. */
export async function autoTagKnownParties(
  tx: Prisma.TransactionClient,
  args: { entityId: string; actorId: string },
): Promise<AutoTagResult> {
  const pending = await tx.statementTransaction.findMany({
    where: { entityId: args.entityId, status: 'PENDING' },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  })
  const tokens = [...new Set(pending.map((p) => partyToken(p.narration)).filter((t): t is string => !!t))]
  if (tokens.length === 0) return { tagged: 0, parties: 0 }

  const rules = await tx.tagRule.findMany({
    where: { entityId: args.entityId, pattern: { in: tokens } },
  })
  const byToken = new Map(rules.map((r) => [r.pattern, r]))
  const hits = new Map<string, number>()
  let tagged = 0

  for (const txn of pending) {
    const token = partyToken(txn.narration)
    const rule = token ? byToken.get(token) : undefined
    if (!rule) continue
    await applyTag(tx, {
      txnId: txn.id,
      headAccountId: rule.headAccountId,
      nature: rule.nature,
      costCentreId: rule.costCentreId,
      accountingHeadId: rule.accountingHeadId,
      tax: {
        gstType: rule.gstType,
        gstRate: rule.gstRate === null ? null : String(rule.gstRate),
        hsn: rule.hsn,
        counterpartyGstin: rule.counterpartyGstin,
        tdsSection: rule.tdsSection,
        tdsRate: rule.tdsRate === null ? null : String(rule.tdsRate),
        deducteePan: rule.deducteePan,
      },
      actorId: args.actorId,
    })
    await tx.statementTransaction.update({
      where: { id: txn.id },
      data: { tagSource: 'rule', autoTagged: true },
    })
    hits.set(rule.id, (hits.get(rule.id) ?? 0) + 1)
    tagged++
  }
  for (const [ruleId, n] of hits) {
    await tx.tagRule.update({ where: { id: ruleId }, data: { hits: { increment: n } } })
  }
  return { tagged, parties: hits.size }
}

/** How many pending rows the sweep would settle — drives the button's count. */
export async function countAutoTaggable(
  prismaLike: Prisma.TransactionClient,
  entityId: string,
  pending: { narration: string }[],
): Promise<number> {
  const tokens = [...new Set(pending.map((p) => partyToken(p.narration)).filter((t): t is string => !!t))]
  if (tokens.length === 0) return 0
  const known = new Set(
    (
      await prismaLike.tagRule.findMany({
        where: { entityId, pattern: { in: tokens } },
        select: { pattern: true },
      })
    ).map((r) => r.pattern),
  )
  return pending.filter((p) => {
    const t = partyToken(p.narration)
    return t ? known.has(t) : false
  }).length
}
