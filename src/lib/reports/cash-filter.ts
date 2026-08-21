import { prisma } from '@/lib/db'

// Hiding cash across the reports (Himal, 20 Aug: "te button saglikade havy
// jite jite cash releted transaction aahet").
//
// "Cash-related" means the entry's money side was a cash location rather
// than a bank. Hiding drops the WHOLE entry, both legs — which is what
// keeps a statement honest: a balanced pair leaves together, so the
// Balance Sheet still balances and no half-entry is left stranded.

/** The ledger accounts that ARE cash for these books. */
export async function cashAccountIds(entityId: string): Promise<string[]> {
  const locs = await prisma.cashLocation.findMany({
    where: { entityId },
    select: { ledgerAccountId: true },
  })
  return locs.map((l) => l.ledgerAccountId).filter((x): x is string => !!x)
}

/** Read the toggle off a report's URL — cash is IN unless switched off. */
export function readCashToggle(params: { cash?: string }): boolean {
  return params.cash !== '0'
}
