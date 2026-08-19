import { Prisma } from '@/generated/prisma/client'

/**
 * Resolve the cost-centre pair every creatable combobox submits: a picked id
 * plus free text. The id wins; otherwise non-empty text finds a same-named
 * centre in these books (case-insensitive) or creates it on the spot — so a
 * missing cost centre can be added right where the entry is made, without a
 * detour through a masters screen. An archived match is revived rather than
 * duplicated (entityId+name is unique).
 */
export async function resolveCostCentre(
  tx: Prisma.TransactionClient,
  args: { entityId: string; costCentreId?: string | null; costCentreText?: string | null },
): Promise<string | null> {
  if (args.costCentreId) {
    const cc = await tx.costCentre.findUnique({ where: { id: args.costCentreId } })
    if (!cc || cc.entityId !== args.entityId) throw new Error('Cost centre belongs to other books')
    return cc.id
  }
  const name = args.costCentreText?.trim()
  if (!name) return null
  const existing = await tx.costCentre.findFirst({
    where: { entityId: args.entityId, name: { equals: name, mode: 'insensitive' } },
  })
  if (existing) {
    if (existing.archivedAt) {
      await tx.costCentre.update({ where: { id: existing.id }, data: { archivedAt: null } })
    }
    return existing.id
  }
  const created = await tx.costCentre.create({ data: { entityId: args.entityId, name } })
  return created.id
}

/**
 * The master's word as the fallback: an entry submitted with no cost centre
 * takes the head's default — which applyMasterRow keeps equal to the master
 * register's type for that category. Tagging (statements/post.ts) and cash
 * entry (ops/cash.ts) have always done this inline; invoices and
 * reimbursements now share it, so no screen can post a blank cost centre
 * while the master has an opinion. A stale default (archived, or belonging
 * to other books) is skipped rather than trusted.
 */
export async function resolveDefaultCostCentre(
  tx: Prisma.TransactionClient,
  args: { entityId: string; headAccountId?: string | null; costCentreId?: string | null },
): Promise<string | null> {
  if (args.costCentreId) return args.costCentreId
  if (!args.headAccountId) return null
  const head = await tx.ledgerAccount.findUnique({ where: { id: args.headAccountId } })
  if (!head?.defaultCostCentreId) return null
  const cc = await tx.costCentre.findUnique({ where: { id: head.defaultCostCentreId } })
  return cc && cc.entityId === args.entityId && !cc.archivedAt ? cc.id : null
}
