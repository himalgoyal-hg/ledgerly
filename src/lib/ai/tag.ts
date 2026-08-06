import { z } from 'zod'
import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { NATURES, isNature } from '@/lib/statements/natures'
import { partyToken } from '@/lib/statements/rules'
import { displayINR } from '@/lib/ledger/money'
import { runStructured, AiError } from './client'

// AI tagging suggestions (spec §12.8, extending §3 step 4).
//
// The rule engine handles anything it has seen before. This fills the gap it
// cannot: a narration with no learned rule. Suggestions are advisory — a
// member accepts one (which tags the row and teaches the rule engine, so the
// same party never needs the model again) or ignores it. Nothing auto-posts.

/** How many rows to send in one call — keeps the reply well inside its budget. */
export const SUGGEST_BATCH = 25

const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The transaction id given in the input.' },
          headCode: {
            type: ['string', 'null'],
            description: 'Account code from the chart of accounts, or null if unsure.',
          },
          nature: {
            type: ['string', 'null'],
            enum: [...NATURES.map((n) => n.value), null],
            description: 'Tag nature, or null if unsure.',
          },
          costCentreName: {
            type: ['string', 'null'],
            description: 'Exact cost centre name from the list, or null.',
          },
          confidence: {
            type: 'number',
            description: '0 to 1. Below 0.5 means you are guessing.',
          },
          reason: {
            type: 'string',
            description: 'One short sentence naming the evidence in the narration.',
          },
        },
        required: ['id', 'headCode', 'nature', 'costCentreName', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
} as const

const replySchema = z.object({
  suggestions: z.array(
    z.object({
      id: z.string(),
      headCode: z.string().nullable(),
      nature: z.string().nullable(),
      costCentreName: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
    }),
  ),
})

const SYSTEM = `You are a bookkeeping assistant for Indian small-business accounts.
You classify bank transactions that an existing keyword-rule engine could not match.

You will be given the entity's chart of accounts, its cost centres, and how
similar transactions were tagged before. Use them: an account code you did not
receive is not a valid answer, and neither is a cost centre name that is not
on the list.

Return null for headCode and nature when the narration does not actually tell
you what the transaction was — bank narrations are frequently just a reference
number and a counterparty code, and "unknown" is the correct answer for those.
A wrong tag costs a bookkeeper more time than an absent one, because they have
to notice it first. Set confidence honestly: above 0.8 only when the narration
names a recognizable merchant, party, or purpose.

Nature follows the money: an outflow to a vendor or for a service is expense;
money received for work is income; movement between the entity's own bank or
cash accounts is transfer_own. Salary and consultant payouts are expense.`

export interface SuggestionInput {
  id: string
  date: Date
  narration: string
  reference?: string | null
  debit: string
  credit: string
}

export interface TagSuggestion {
  txnId: string
  headAccountId: string | null
  nature: string | null
  costCentreId: string | null
  confidence: number
  reason: string
}

/** Recent confirmed tags for the same entity — the model's few-shot context. */
async function priorExamples(tx: Prisma.TransactionClient, entityId: string, limit = 20) {
  const tagged = await tx.statementTransaction.findMany({
    where: { entityId, status: { in: ['TAGGED', 'POSTED'] }, headAccountId: { not: null } },
    orderBy: { taggedAt: 'desc' },
    take: limit,
    select: { narration: true, headAccountId: true, nature: true },
  })
  if (tagged.length === 0) return []
  const accounts = await tx.ledgerAccount.findMany({
    where: { id: { in: tagged.map((t) => t.headAccountId!) } },
    select: { id: true, code: true, name: true },
  })
  const byId = new Map(accounts.map((a) => [a.id, a]))
  return tagged
    .map((t) => {
      const account = byId.get(t.headAccountId!)
      if (!account) return null
      return `${partyToken(t.narration) ?? t.narration.slice(0, 30)} → ${account.code} (${t.nature})`
    })
    .filter((s): s is string => s !== null)
}

/**
 * Ask Claude to classify rows the rule engine could not. Returns only
 * suggestions that resolve to real accounts for this entity.
 */
export async function suggestTags(
  entityId: string,
  rows: SuggestionInput[],
): Promise<TagSuggestion[]> {
  if (rows.length === 0) return []
  if (rows.length > SUGGEST_BATCH) rows = rows.slice(0, SUGGEST_BATCH)

  const [heads, costCentres, examples] = await Promise.all([
    prisma.ledgerAccount.findMany({
      where: { entityId, isGroup: false, archivedAt: null },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, kind: true },
    }),
    prisma.costCentre.findMany({
      where: { entityId, archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    priorExamples(prisma, entityId),
  ])
  if (heads.length === 0) throw new AiError('This entity has no postable accounts yet.')

  const prompt = [
    'CHART OF ACCOUNTS (code · name · type):',
    ...heads.map((h) => `${h.code} · ${h.name} · ${h.kind.toLowerCase()}`),
    '',
    'COST CENTRES:',
    costCentres.length ? costCentres.map((c) => c.name).join(', ') : '(none defined)',
    '',
    'NATURES:',
    NATURES.map((n) => n.value).join(', '),
    '',
    ...(examples.length
      ? ['HOW SIMILAR TRANSACTIONS WERE TAGGED BEFORE:', ...examples, '']
      : []),
    'TRANSACTIONS TO CLASSIFY:',
    ...rows.map((row) => {
      const outflow = Number(row.debit) > 0
      const amount = displayINR(outflow ? row.debit : row.credit)
      return `id=${row.id} | ${row.date.toISOString().slice(0, 10)} | ${
        outflow ? 'PAID OUT' : 'RECEIVED'
      } ${amount} | ${row.narration}${row.reference ? ` | ref ${row.reference}` : ''}`
    }),
    '',
    'Return one suggestion per transaction id, in the same order.',
  ].join('\n')

  const reply = await runStructured({
    kind: 'tag_suggestion',
    entityId,
    system: SYSTEM,
    prompt,
    schema: SUGGESTION_SCHEMA,
    validate: (value) => replySchema.parse(value),
    maxTokens: 8000,
  })

  return resolveSuggestions({
    replies: reply.suggestions,
    requestedIds: rows.map((r) => r.id),
    heads,
    costCentres,
  })
}

export interface RawSuggestion {
  id: string
  headCode: string | null
  nature: string | null
  costCentreName: string | null
  confidence: number
  reason: string
}

/**
 * Resolve model output against this entity's real accounts — the guard that
 * keeps a hallucinated code out of the books. A suggestion survives only if
 * it names a row we asked about, an account code that exists for THIS entity,
 * and a nature from the fixed list. Everything else is dropped rather than
 * repaired: a suggestion we can't verify is worth less than none.
 */
export function resolveSuggestions(args: {
  replies: RawSuggestion[]
  requestedIds: string[]
  heads: { id: string; code: string }[]
  costCentres: { id: string; name: string }[]
}): TagSuggestion[] {
  const headByCode = new Map(args.heads.map((h) => [h.code, h]))
  const centreByName = new Map(args.costCentres.map((c) => [c.name.toLowerCase(), c]))
  const requested = new Set(args.requestedIds)
  const seen = new Set<string>()

  const suggestions: TagSuggestion[] = []
  for (const item of args.replies) {
    if (!requested.has(item.id)) continue // not a row we asked about
    if (seen.has(item.id)) continue // duplicate reply for one row
    const head = item.headCode ? headByCode.get(item.headCode.trim()) : undefined
    const nature = item.nature && isNature(item.nature) ? item.nature : null
    // A head without a nature (or vice versa) isn't actionable — drop both.
    if (!head || !nature) continue
    const centre = item.costCentreName
      ? centreByName.get(item.costCentreName.trim().toLowerCase())
      : undefined
    seen.add(item.id)
    suggestions.push({
      txnId: item.id,
      headAccountId: head.id,
      nature,
      costCentreId: centre?.id ?? null,
      confidence: Math.max(0, Math.min(1, Number.isFinite(item.confidence) ? item.confidence : 0)),
      reason: item.reason.slice(0, 300),
    })
  }
  return suggestions
}

/** Store suggestions against their rows so the queue can offer them. */
export async function saveSuggestions(suggestions: TagSuggestion[]) {
  for (const s of suggestions) {
    await prisma.statementTransaction.update({
      where: { id: s.txnId },
      data: {
        aiHeadAccountId: s.headAccountId,
        aiNature: s.nature,
        aiCostCentreId: s.costCentreId,
        aiConfidence: s.confidence.toFixed(3),
        aiReason: s.reason,
        aiSuggestedAt: new Date(),
      },
    })
  }
}

/** Suggest for an entity's pending, unsuggested rows. Returns the count. */
export async function suggestForPending(entityId: string, limit = SUGGEST_BATCH) {
  const pending = await prisma.statementTransaction.findMany({
    where: { entityId, status: 'PENDING', aiSuggestedAt: null },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, date: true, narration: true, reference: true, debit: true, credit: true },
  })
  if (pending.length === 0) return { considered: 0, suggested: 0 }

  const suggestions = await suggestTags(
    entityId,
    pending.map((p) => ({
      id: p.id,
      date: p.date,
      narration: p.narration,
      reference: p.reference,
      debit: String(p.debit),
      credit: String(p.credit),
    })),
  )
  await saveSuggestions(suggestions)
  // Mark the rest as considered so they don't get re-sent on every click.
  const suggestedIds = new Set(suggestions.map((s) => s.txnId))
  const skipped = pending.filter((p) => !suggestedIds.has(p.id)).map((p) => p.id)
  if (skipped.length > 0) {
    await prisma.statementTransaction.updateMany({
      where: { id: { in: skipped } },
      data: { aiSuggestedAt: new Date(), aiReason: 'No confident suggestion' },
    })
  }
  return { considered: pending.length, suggested: suggestions.length }
}
