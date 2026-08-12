import { Prisma } from '@/generated/prisma/client'
import { nextChildCode } from '@/lib/ledger/coa'

/**
 * Resolve the head pair a creatable head-combobox submits: a picked id plus
 * free text. The id wins; otherwise non-empty text finds a same-named leaf
 * head in these books (case-insensitive) or creates one on the spot —
 * under Income (4000) when the money comes in, Expenses (5000) when it goes
 * out — so a new head is born right where you type it. Anything fancier
 * (loans, banks, contra heads) still comes from Admin → Chart of accounts.
 */
export async function resolveHeadAccount(
  tx: Prisma.TransactionClient,
  args: {
    entityId: string
    headAccountId?: string | null
    headText?: string | null
    isOutflow: boolean
  },
): Promise<string> {
  if (args.headAccountId) return args.headAccountId
  const name = args.headText?.trim()
  if (!name) throw new Error('Pick a head')
  const existing = await tx.ledgerAccount.findFirst({
    where: {
      entityId: args.entityId,
      isGroup: false,
      archivedAt: null,
      name: { equals: name, mode: 'insensitive' },
    },
  })
  if (existing) return existing.id
  const groupCode = args.isOutflow ? '5000' : '4000'
  const group = await tx.ledgerAccount.findUniqueOrThrow({
    where: { entityId_code: { entityId: args.entityId, code: groupCode } },
  })
  const created = await tx.ledgerAccount.create({
    data: {
      entityId: args.entityId,
      code: await nextChildCode(tx, args.entityId, groupCode),
      name,
      kind: args.isOutflow ? 'EXPENSE' : 'INCOME',
      parentId: group.id,
    },
  })
  return created.id
}
