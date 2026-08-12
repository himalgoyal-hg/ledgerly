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
  'NETBANK', 'MUM', 'INTL', 'TXN', 'PRIVA',
  // Words that belong to dozens of different company names — as the longest
  // word in a line they hijack the token and lump unrelated payees together
  // ("KHOOBI CONSULTING" and "ACCUREST CONSULTING" are not the same party).
  'CONSULTING', 'CONSULTANCY', 'ADVISORY', 'ASSOCIATES', 'SOLUTIONS', 'VENTURES',
  'TECHNOLOGIES', 'TECHNOLOGY', 'ENTERPRISES', 'SERVICES', 'INDUSTRIES',
  'TRADERS', 'COMPANY', 'CORPORATION', 'HOLDINGS', 'GLOBAL', 'GROUP',
  'FOREIGN', 'INWARD', 'PACB', 'REMITTANCE', 'INTERNAL',
])

/**
 * Extract the "party token" from a bank narration — the stable merchant /
 * payee fragment that survives across transactions, e.g.
 * "UPI/512345/SWIGGY LTD/swiggy@ybl" → "SWIGGY".
 */
/** Every meaningful token of a narration — refs, IFSCs and rails stripped. */
export function salientTokens(narration: string): string[] {
  return narration
    .toUpperCase()
    // Statements occasionally carry control bytes; Postgres rejects a NUL in
    // text, and they are never part of a payee's name.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .split(/[/\\|:;,.\-_@ ]+/)
    .map((t) => t.trim())
    .filter(
      (t) =>
        t.length >= 3 &&
        !/^\d+$/.test(t) && // pure numbers (refs, dates)
        !/^\d/.test(t) && // leading digit → ref-ish
        // An IFSC (HDFC0000007, YESB0YBLUPI) names a branch, not a payee, and
        // it is usually the longest token in the line — as a rule pattern it
        // would tag everything routed through that branch alike.
        !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(t) &&
        // Netbanking references (NBAJTT7KXGLJAOY4) carry no digits at all and
        // would otherwise beat the payee on length.
        !/^NB[A-Z0-9]{12,}$/.test(t) &&
        // Reference numbers that start with letters (HDFCH00926070).
        (t.replace(/\D/g, '').length < 3) &&
        !NOISE_TOKENS.has(t),
    )
}

export function partyToken(narration: string): string | null {
  const tokens = salientTokens(narration)
  if (tokens.length === 0) return null
  // Longest token wins; ties → earliest.
  const winner = tokens.reduce((a, b) => (b.length > a.length ? b : a))
  // Card descriptors bolt punctuation onto the merchant ("ANTHROPIC* CLAUDE",
  // "OPENAI *CHATGPT"); trimming it keeps both spellings on one rule.
  return winner.replace(/^[^A-Z0-9]+/, '').replace(/[^A-Z0-9]+$/, '') || null
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

/**
 * Human title for a raw bank narration: the transaction kind and the party.
 * "POS 419188XXXXXX1038 618207585956 01JUL26 DIGITALOCEAN.COM"
 *   → { kind: 'Card', title: 'Digitalocean' }
 * Display-only — matching keeps using partyToken/normalizedNarration.
 */
const KIND_PATTERNS: [RegExp, string][] = [
  [/\bUPI\b/i, 'UPI'],
  [/\bPOS\b|\bECOM\b|\bDC INTL\b/i, 'Card'],
  [/\bNEFT\b/i, 'NEFT'],
  [/\bIMPS\b/i, 'IMPS'],
  [/\bRTGS\b/i, 'RTGS'],
  [/\bTPT\b|\bFT\b/i, 'Transfer'],
  [/\bACH\b|\bNACH\b/i, 'ACH'],
  [/\bATW\b|\bATM\b|\bNWD\b/i, 'ATM'],
  [/\bCHQ\b|CHEQUE/i, 'Cheque'],
  [/MARKUP|CHRG|CHARGES?\b|\bAMC\b/i, 'Charges'],
  [/INTEREST|\bINT PAID\b/i, 'Interest'],
]

export function describeNarration(narration: string): { kind: string | null; title: string } {
  const kind = KIND_PATTERNS.find(([re]) => re.test(narration))?.[1] ?? null
  const token = partyToken(narration)
  const title = token ? token.charAt(0) + token.slice(1).toLowerCase() : narration
  return { kind, title }
}
