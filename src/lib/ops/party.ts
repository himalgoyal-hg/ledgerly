import type { Prisma } from '@/generated/prisma/client'
import { getSystemAccount, nextChildCode } from '@/lib/ledger/coa'

// Party ledger accounts (spec §10 "party/vendor/customer ledgers"): a leaf
// account per party, auto-created on first use under its group —
//   members  → 2400 Employee & Member Payables
//   vendors  → 2100 Sundry Creditors
//   customers→ 1300 Sundry Debtors
// Reused forever after, so every party has one continuous ledger.

export async function getPartyAccount(
  tx: Prisma.TransactionClient,
  entityId: string,
  groupCode: string,
  name: string,
) {
  const group = await getSystemAccount(tx, entityId, groupCode)
  const existing = await tx.ledgerAccount.findFirst({
    where: { entityId, parentId: group.id, name },
  })
  if (existing) {
    if (existing.archivedAt) {
      return tx.ledgerAccount.update({ where: { id: existing.id }, data: { archivedAt: null } })
    }
    return existing
  }
  const code = await nextChildCode(tx, entityId, groupCode)
  return tx.ledgerAccount.create({
    data: { entityId, code, name, kind: group.kind, parentId: group.id, system: true },
  })
}

/** Dr − Cr balance of one account (party ledgers, payables, debtors). */
export async function ledgerBalance(
  tx: Prisma.TransactionClient,
  accountId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<{ balance: string | null }[]>`
    SELECT (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0))::text as balance
    FROM "JournalLine" l WHERE l."accountId" = ${accountId}
  `
  return rows[0]?.balance ?? '0'
}
