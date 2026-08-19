// Shared between master-sync.ts and ops/heads.ts — kept separate from both
// so a new head (born anywhere: tagging, cash entry, invoices…) can consult
// the master's word without a circular import (master-sync already imports
// resolveHeadAccount from heads.ts).

/** nature → where a master-born head lives in the chart. */
export const NATURE_GROUP: Record<string, { code: string; kind: 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE' }> = {
  Expense: { code: '5000', kind: 'EXPENSE' },
  Income: { code: '4000', kind: 'INCOME' },
  Asset: { code: '1900', kind: 'ASSET' },
  Liability: { code: '2300', kind: 'LIABILITY' },
  Contra: { code: '5000', kind: 'EXPENSE' },
  Personal: { code: '5000', kind: 'EXPENSE' },
}

/** "Optional-Lifestyle" / "Lifestyle" / "Invesment" all resolve to one type. */
export const stripCcType = (s: string) => s.toLowerCase().trim().replace(/^optional-?\s*/, '')
export const CC_TYPE_ALIAS: Record<string, string> = { investment: 'invesment' }
