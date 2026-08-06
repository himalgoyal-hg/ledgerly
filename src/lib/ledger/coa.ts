import type { Prisma, AccountKind } from '@/generated/prisma/client'

// Chart of Accounts auto-seed (spec §4): standard Indian heads, created for
// every entity on creation. Group accounts structure the tree; leaves are
// postable. System accounts cannot be archived. Admin can add heads.

interface SeedAccount {
  code: string
  name: string
  kind: AccountKind
  isGroup?: boolean
  children?: SeedAccount[]
}

export const COA_SEED: SeedAccount[] = [
  {
    code: '1000', name: 'Assets', kind: 'ASSET', isGroup: true,
    children: [
      { code: '1100', name: 'Bank Accounts', kind: 'ASSET', isGroup: true },
      { code: '1200', name: 'Cash', kind: 'ASSET', isGroup: true },
      { code: '1300', name: 'Sundry Debtors', kind: 'ASSET', isGroup: true },
      { code: '1400', name: 'Loans & Advances Given', kind: 'ASSET', isGroup: true },
      { code: '1500', name: 'GST Input Credit', kind: 'ASSET' },
      { code: '1600', name: 'TDS Receivable', kind: 'ASSET' },
      { code: '1900', name: 'Fixed Assets', kind: 'ASSET', isGroup: true },
    ],
  },
  {
    code: '2000', name: 'Liabilities', kind: 'LIABILITY', isGroup: true,
    children: [
      { code: '2100', name: 'Sundry Creditors', kind: 'LIABILITY', isGroup: true },
      {
        code: '2200', name: 'Duties & Taxes', kind: 'LIABILITY', isGroup: true,
        children: [
          { code: '2210', name: 'GST Output Liability', kind: 'LIABILITY' },
          { code: '2220', name: 'GST Payable', kind: 'LIABILITY' },
          { code: '2230', name: 'TDS Payable', kind: 'LIABILITY' },
        ],
      },
      { code: '2300', name: 'Loans Taken', kind: 'LIABILITY', isGroup: true },
      { code: '2400', name: 'Employee & Member Payables', kind: 'LIABILITY', isGroup: true },
    ],
  },
  {
    code: '3000', name: 'Equity', kind: 'EQUITY', isGroup: true,
    children: [
      { code: '3100', name: 'Capital', kind: 'EQUITY' },
      { code: '3200', name: 'Opening Balances', kind: 'EQUITY' },
      { code: '3300', name: 'Reserves & Surplus', kind: 'EQUITY' },
    ],
  },
  {
    code: '4000', name: 'Income', kind: 'INCOME', isGroup: true,
    children: [
      { code: '4100', name: 'Professional Fees / Client Payments', kind: 'INCOME' },
      { code: '4200', name: 'Interest Income', kind: 'INCOME' },
      { code: '4900', name: 'Other Income', kind: 'INCOME' },
    ],
  },
  {
    code: '5000', name: 'Expenses', kind: 'EXPENSE', isGroup: true,
    children: [
      { code: '5100', name: 'Salaries & Wages', kind: 'EXPENSE' },
      { code: '5110', name: 'Consultant Fees', kind: 'EXPENSE' },
      { code: '5200', name: 'Rent', kind: 'EXPENSE' },
      { code: '5210', name: 'Telephone & Internet', kind: 'EXPENSE' },
      { code: '5220', name: 'Electricity & Utilities', kind: 'EXPENSE' },
      { code: '5300', name: 'Travel & Conveyance', kind: 'EXPENSE' },
      { code: '5310', name: 'Food & Dining', kind: 'EXPENSE' },
      { code: '5320', name: 'Gym & Health', kind: 'EXPENSE' },
      { code: '5400', name: 'Insurance', kind: 'EXPENSE' },
      { code: '5500', name: 'Business Expenses', kind: 'EXPENSE' },
      { code: '5600', name: 'Bank Charges', kind: 'EXPENSE' },
      { code: '5700', name: 'Interest Paid', kind: 'EXPENSE' },
      { code: '5900', name: 'Miscellaneous Expenses', kind: 'EXPENSE' },
    ],
  },
]

// Well-known codes the rest of the app relies on.
export const COA = {
  BANK_GROUP: '1100',
  CASH_GROUP: '1200',
  DEBTORS_GROUP: '1300',
  CREDITORS_GROUP: '2100',
  PAYABLES_GROUP: '2400',
  TDS_PAYABLE: '2230',
  OPENING_BALANCES: '3200',
  SALARIES: '5100',
  CONSULTANT_FEES: '5110',
} as const

/** Create the full seed tree for a new entity. Idempotent per (entity, code). */
export async function seedChartOfAccounts(
  tx: Prisma.TransactionClient,
  entityId: string,
) {
  async function createLevel(nodes: SeedAccount[], parentId: string | null) {
    for (const node of nodes) {
      const existing = await tx.ledgerAccount.findUnique({
        where: { entityId_code: { entityId, code: node.code } },
      })
      const account =
        existing ??
        (await tx.ledgerAccount.create({
          data: {
            entityId,
            code: node.code,
            name: node.name,
            kind: node.kind,
            isGroup: node.isGroup ?? false,
            system: true,
            parentId,
          },
        }))
      if (node.children?.length) await createLevel(node.children, account.id)
    }
  }
  await createLevel(COA_SEED, null)
}

/** Fetch a well-known system account for an entity (self-heals missing CoA). */
export async function getSystemAccount(
  tx: Prisma.TransactionClient,
  entityId: string,
  code: string,
) {
  let account = await tx.ledgerAccount.findUnique({
    where: { entityId_code: { entityId, code } },
  })
  if (!account) {
    await seedChartOfAccounts(tx, entityId)
    account = await tx.ledgerAccount.findUniqueOrThrow({
      where: { entityId_code: { entityId, code } },
    })
  }
  return account
}

/** Next free child code under a group, e.g. 1101, 1102… under 1100. */
export async function nextChildCode(
  tx: Prisma.TransactionClient,
  entityId: string,
  parentCode: string,
) {
  const siblings = await tx.ledgerAccount.findMany({
    where: { entityId, code: { startsWith: parentCode.slice(0, 2) }, NOT: { code: parentCode } },
    select: { code: true },
  })
  const base = parseInt(parentCode, 10)
  const taken = new Set(
    siblings
      .map((s) => parseInt(s.code, 10))
      .filter((n) => n > base && n < base + 100),
  )
  for (let n = base + 1; n < base + 100; n++) {
    if (!taken.has(n)) return String(n)
  }
  throw new Error(`No free account codes under ${parentCode}`)
}
