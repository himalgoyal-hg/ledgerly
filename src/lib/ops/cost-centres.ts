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
