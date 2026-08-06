import type { Prisma } from '@/generated/prisma/client'

// Rules + learning engine (spec §3 step 4). Every manual tag correction
// feeds the engine; auto-verify coverage grows over time. (Smarter AI
// tagging arrives with the Phase 8 layer — same rule store.)

const NOISE_TOKENS = new Set([
  'UPI', 'NEFT', 'IMPS', 'RTGS', 'ACH', 'NACH', 'POS', 'ATM', 'ATW', 'VPS',
  'TPT', 'FT', 'BIL', 'BILLPAY', 'PAYTM', 'TRANSFER', 'TXN', 'PAYMENT', 'PMT',
  'REF', 'INB', 'MB', 'CMS', 'ECS', 'CHQ', 'CLG', 'DEP', 'WDL', 'CASH', 'INR',
  'FROM', 'TO', 'BY', 'THE', 'AND', 'FOR', 'LTD', 'PVT', 'PRIVATE', 'LIMITED',
  'BANK', 'INDIA', 'OKAXIS', 'OKICICI', 'OKHDFCBANK', 'OKSBI', 'YBL', 'IBL',
  'AXL', 'PAYTMQR', 'BHARATPE', 'RAZORPAY', 'RAZP', 'PAYU', 'BILLDESK', 'CCA',
])

/**
 * Extract the "party token" from a bank narration — the stable merchant /
 * payee fragment that survives across transactions, e.g.
 * "UPI/512345/SWIGGY LTD/swiggy@ybl" → "SWIGGY".
 */
export function partyToken(narration: string): string | null {
  const tokens = narration
    .toUpperCase()
    .split(/[/\\|:;,.\-_@ ]+/)
    .map((t) => t.trim())
    .filter(
      (t) =>
        t.length >= 3 &&
        !/^\d+$/.test(t) && // pure numbers (refs, dates)
        !/^\d/.test(t) && // leading digit → ref-ish
        !NOISE_TOKENS.has(t),
    )
  if (tokens.length === 0) return null
  // Longest token wins; ties → earliest.
  return tokens.reduce((a, b) => (b.length > a.length ? b : a))
}

export function normalizedNarration(narration: string): string {
  return narration.toUpperCase().replace(/\s+/g, ' ').trim()
}

export interface RuleMatch {
  ruleId: string
  headAccountId: string
  nature: string
  costCentreId: string | null
}

/** Find the best rule for a narration within an entity's books. */
export async function matchRule(
  tx: Prisma.TransactionClient,
  entityId: string,
  narration: string,
): Promise<RuleMatch | null> {
  const token = partyToken(narration)
  if (!token) return null
  const rule = await tx.tagRule.findUnique({
    where: { entityId_pattern: { entityId, pattern: token } },
  })
  if (!rule) return null
  return {
    ruleId: rule.id,
    headAccountId: rule.headAccountId,
    nature: rule.nature,
    costCentreId: rule.costCentreId,
  }
}

/** Learn (or correct) a rule from a manual tag (spec §3 step 4). */
export async function learnRule(
  tx: Prisma.TransactionClient,
  args: {
    entityId: string
    narration: string
    headAccountId: string
    nature: string
    costCentreId?: string | null
  },
) {
  const token = partyToken(args.narration)
  if (!token) return null
  return tx.tagRule.upsert({
    where: { entityId_pattern: { entityId: args.entityId, pattern: token } },
    create: {
      entityId: args.entityId,
      pattern: token,
      headAccountId: args.headAccountId,
      nature: args.nature,
      costCentreId: args.costCentreId ?? null,
    },
    // A correction retrains the rule to the newest choice.
    update: {
      headAccountId: args.headAccountId,
      nature: args.nature,
      costCentreId: args.costCentreId ?? null,
    },
  })
}
