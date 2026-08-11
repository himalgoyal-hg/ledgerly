import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { accountBalances } from '@/lib/ledger/queries'

// Smart payment source suggestions (spec §8). Three inputs decide where a
// payment should come from:
//   1. entity/purpose mapping — the account that normally pays for this
//   2. live balance from the reconciled ledger
//   3. commitment protection — money already spoken for in the next 7 days
//      is reserved, so ad-hoc spends get steered elsewhere
// The engine only advises: it never picks the account for you.

export const COMMITMENT_WINDOW_DAYS = 7

export interface SourceOption {
  ledgerAccountId: string
  label: string
  type: 'bank' | 'cash'
  balance: string
  reserved: string // committed within the window
  available: string // balance − reserved
  sufficient: boolean // available covers the amount
  reasons: string[]
  preferred: boolean
}

export interface SourceSuggestion {
  options: SourceOption[]
  best: SourceOption | null
  /** Set when nothing can comfortably cover the payment. */
  warning: string | null
}

/**
 * Purpose keys, most specific first. A bill for "Rent" checks
 * head:<rentAccountId>, then "bill", then "default".
 */
export function purposeKeys(args: {
  module: 'bill' | 'salary' | 'reimbursement' | 'gst' | 'tds' | 'invoice_receipt'
  taskKind?: string | null
  expenseAccountId?: string | null
}): string[] {
  const keys: string[] = []
  if (args.expenseAccountId) keys.push(`head:${args.expenseAccountId}`)
  if (args.taskKind) keys.push(args.taskKind)
  keys.push(args.module, 'default')
  return keys
}

/**
 * Commitments falling due within the window (spec §8.3): unpaid bills. Each
 * is reserved against the account its mapping points at; unmapped
 * commitments reserve against the entity's largest balance, which is where
 * they would naturally be paid from.
 */
async function reservations(entityId: string, accountIds: string[], balances: Map<string, string>) {
  const horizon = new Date(Date.now() + COMMITMENT_WINDOW_DAYS * 86_400_000)
  const [bills, preferences] = await Promise.all([
    prisma.bill.findMany({ where: { entityId, status: 'PENDING', dueDate: { lte: horizon } } }),
    prisma.paymentPreference.findMany({ where: { entityId }, orderBy: { priority: 'asc' } }),
  ])

  const prefFor = (keys: string[]): string | null => {
    for (const key of keys) {
      const hit = preferences.find((p) => p.purpose === key && accountIds.includes(p.ledgerAccountId))
      if (hit) return hit.ledgerAccountId
    }
    return null
  }
  const fallback = [...accountIds].sort(
    (a, b) => Number(balances.get(b) ?? 0) - Number(balances.get(a) ?? 0),
  )[0]

  const reserved = new Map<string, Prisma.Decimal>()
  const add = (accountId: string | null, amount: Prisma.Decimal) => {
    const target = accountId ?? fallback
    if (!target) return
    reserved.set(target, (reserved.get(target) ?? new Prisma.Decimal(0)).plus(amount))
  }
  for (const bill of bills) {
    const payable = new Prisma.Decimal(String(bill.amount))
      .plus(String(bill.gstAmount))
      .minus(String(bill.tdsAmount))
    add(prefFor(purposeKeys({ module: 'bill', expenseAccountId: bill.expenseAccountId })), payable)
  }
  return { reserved, preferences }
}

/** Rank the accounts that could fund a payment (spec §8). */
export async function suggestPaymentSource(args: {
  entityId: string
  amount?: string | null
  module: 'bill' | 'salary' | 'reimbursement' | 'gst' | 'tds' | 'invoice_receipt'
  taskKind?: string | null
  expenseAccountId?: string | null
  /** Exclude a commitment already counted in the reservations (e.g. this bill). */
  excludeBillId?: string | null
}): Promise<SourceSuggestion> {
  const [banks, cashLocations] = await Promise.all([
    prisma.bankAccount.findMany({
      where: { entityId: args.entityId, archivedAt: null, ledgerAccountId: { not: null } },
      orderBy: { nickname: 'asc' },
    }),
    prisma.cashLocation.findMany({
      where: { entityId: args.entityId, archivedAt: null, ledgerAccountId: { not: null } },
      orderBy: { name: 'asc' },
    }),
  ])
  const candidates = [
    ...banks.map((b) => ({ ledgerAccountId: b.ledgerAccountId!, label: b.nickname, type: 'bank' as const })),
    ...cashLocations.map((c) => ({ ledgerAccountId: c.ledgerAccountId!, label: `Cash — ${c.name}`, type: 'cash' as const })),
  ]
  if (candidates.length === 0) {
    return { options: [], best: null, warning: 'No bank accounts or cash locations set up yet.' }
  }

  const accountIds = candidates.map((c) => c.ledgerAccountId)
  const balances = await accountBalances(accountIds)
  const { reserved, preferences } = await reservations(args.entityId, accountIds, balances)

  // If we are funding one of the reserved commitments, don't reserve against
  // ourselves — that would make the account look poorer than it is.
  if (args.excludeBillId) {
    const bill = await prisma.bill.findUnique({ where: { id: args.excludeBillId } })
    if (bill && bill.status === 'PENDING') {
      const payable = new Prisma.Decimal(String(bill.amount))
        .plus(String(bill.gstAmount))
        .minus(String(bill.tdsAmount))
      for (const [accountId, amount] of reserved) {
        if (amount.greaterThanOrEqualTo(payable)) {
          reserved.set(accountId, amount.minus(payable))
          break
        }
      }
    }
  }

  const keys = purposeKeys(args)
  const preferredId =
    keys
      .map((key) => preferences.find((p) => p.purpose === key && accountIds.includes(p.ledgerAccountId)))
      .find(Boolean)?.ledgerAccountId ?? null
  const amount = args.amount ? new Prisma.Decimal(args.amount) : null

  const base: SourceOption[] = candidates.map((candidate) => {
    const balance = new Prisma.Decimal(balances.get(candidate.ledgerAccountId) ?? 0)
    const res = reserved.get(candidate.ledgerAccountId) ?? new Prisma.Decimal(0)
    return {
      ledgerAccountId: candidate.ledgerAccountId,
      label: candidate.label,
      type: candidate.type,
      balance: balance.toFixed(2),
      reserved: res.toFixed(2),
      available: balance.minus(res).toFixed(2),
      sufficient: false, // decided per amount by rankForAmount
      reasons: [],
      preferred: candidate.ledgerAccountId === preferredId,
    }
  })
  return rankForAmount(base, amount?.toFixed(2) ?? null)
}

/**
 * Score a pre-computed option set against one amount. Screens that show many
 * payable rows (bills, invoices) call suggestPaymentSource once for the
 * balances and reservations, then rank per row — no repeated queries.
 */
export function rankForAmount(
  base: SourceOption[],
  amountStr: string | null,
): SourceSuggestion {
  const amount = amountStr ? new Prisma.Decimal(amountStr) : null
  const options = base.map((option) => {
    const balance = new Prisma.Decimal(option.balance)
    const reserved = new Prisma.Decimal(option.reserved)
    const available = new Prisma.Decimal(option.available)
    const sufficient =
      amount === null ? available.greaterThan(0) : available.greaterThanOrEqualTo(amount)

    const reasons: string[] = []
    if (option.preferred) reasons.push('normally pays for this')
    if (reserved.greaterThan(0)) {
      reasons.push(`${reserved.toFixed(2)} reserved for dues in ${COMMITMENT_WINDOW_DAYS} days`)
    }
    if (!sufficient && amount !== null) {
      reasons.push(
        balance.greaterThanOrEqualTo(amount)
          ? 'would eat into reserved commitments'
          : 'insufficient balance',
      )
    }
    if (sufficient && !option.preferred && available.greaterThan(0)) reasons.push('has liquidity')
    return { ...option, sufficient, reasons }
  })

  // Preferred-and-sufficient first, then the most liquid.
  options.sort((a, b) => {
    if (a.sufficient !== b.sufficient) return a.sufficient ? -1 : 1
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
    return Number(b.available) - Number(a.available)
  })

  const best = options.find((o) => o.sufficient) ?? null
  let warning: string | null = null
  if (amount !== null && !best) {
    const richest = options[0]
    const byRawBalance = options.find((o) =>
      new Prisma.Decimal(o.balance).greaterThanOrEqualTo(amount),
    )
    warning = byRawBalance
      ? `Low balance: paying ${amount.toFixed(2)} from ${byRawBalance.label} would use money reserved for dues in the next ${COMMITMENT_WINDOW_DAYS} days.`
      : `Low balance: no account can cover ${amount.toFixed(2)}. Largest available is ${richest?.label ?? '—'} at ${richest?.available ?? '0.00'}.`
  }
  return { options, best, warning }
}
