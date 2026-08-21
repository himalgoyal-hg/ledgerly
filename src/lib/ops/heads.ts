import { Prisma } from '@/generated/prisma/client'
import { nextChildCode } from '@/lib/ledger/coa'
import { NATURE_GROUP, stripCcType, CC_TYPE_ALIAS } from '@/lib/budget/nature'

/** Where a head created outside the master register lands on it. */
export const NEW_HEAD_SECTION = 'New Added'

/** The chart's kind → the master register's own word for it. */
const NATURE_OF_KIND: Record<string, string> = {
  EXPENSE: 'Expense',
  INCOME: 'Income',
  ASSET: 'Asset',
  LIABILITY: 'Liability',
  EQUITY: 'Liability',
}

/**
 * Resolve the head pair a creatable head-combobox submits: a picked id plus
 * free text. The id wins; otherwise non-empty text finds a same-named leaf
 * head in these books (case-insensitive) or creates one on the spot.
 *
 * A brand-new head born here checks the master register first (Himal, 19
 * Aug 2026: "master sheet hi saglyansathi ekach asel, tite kay change zala
 * ki to automatically saglikade zala pahije") — a category the master
 * already knows gets born exactly where applyMasterRow would put it: the
 * nature-correct group, and the master's cost centre pre-set. No match →
 * the old rule (Income/Expense by direction), no cost centre, same as
 * always. Anything fancier (loans, banks, contra heads) still comes from
 * Admin → Chart of accounts.
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

  const masterRow = await tx.headMode.findFirst({ where: { category: { equals: name, mode: 'insensitive' } } })
  const spot = masterRow ? (NATURE_GROUP[masterRow.nature ?? 'Expense'] ?? NATURE_GROUP.Expense) : null
  const groupCode = spot?.code ?? (args.isOutflow ? '5000' : '4000')
  const group = await tx.ledgerAccount.findUniqueOrThrow({
    where: { entityId_code: { entityId: args.entityId, code: groupCode } },
  })
  const created = await tx.ledgerAccount.create({
    data: {
      entityId: args.entityId,
      code: await nextChildCode(tx, args.entityId, groupCode),
      name,
      kind: spot?.kind ?? (args.isOutflow ? 'EXPENSE' : 'INCOME'),
      parentId: group.id,
    },
  })

  // A head born here also joins the master register (Himal, 20 Aug: "tag
  // entry made new expense head add kela re to master register made javun
  // add zala pahije"), under a "New Added" section that sorts above every
  // other — so what was just created is the first thing on that screen,
  // waiting for its bank mode, cost centre and budget.
  if (!masterRow) {
    const lowest = await tx.headMode.aggregate({ _min: { sortOrder: true } })
    const entity = await tx.entity.findUniqueOrThrow({
      where: { id: args.entityId },
      select: { code: true },
    })
    await tx.headMode.create({
      data: {
        category: name,
        section: NEW_HEAD_SECTION,
        // newest first inside the section, and the whole section on top
        sortOrder: (lowest._min.sortOrder ?? 1) - 1,
        nature: NATURE_OF_KIND[created.kind] ?? 'Expense',
        books: entity.code,
      },
    })
  }

  if (masterRow?.expenseType) {
    const want = masterRow.expenseType
    const ws = stripCcType(want)
    const centres = await tx.costCentre.findMany({ where: { entityId: args.entityId, archivedAt: null } })
    const cc =
      centres.find((c) => c.name.toLowerCase() === want.toLowerCase()) ??
      centres.find((c) => stripCcType(c.name) === ws || c.name.toLowerCase() === (CC_TYPE_ALIAS[ws] ?? ws)) ??
      (await tx.costCentre.create({ data: { entityId: args.entityId, name: want } }))
    await tx.ledgerAccount.update({ where: { id: created.id }, data: { defaultCostCentreId: cc.id } })
  }

  return created.id
}
