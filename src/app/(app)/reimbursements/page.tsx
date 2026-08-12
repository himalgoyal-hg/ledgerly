import Link from 'next/link'
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { memberPayableName } from '@/lib/ops/reimburse'
import { suggestPaymentSource, rankForAmount } from '@/lib/automation/suggest'
import { HeadCombobox } from '@/components/head-combobox'
import { SmartCombobox } from '@/components/smart-combobox'
import { SourceSelect } from '../source-select'
import {
  submitClaimAction,
  approveClaimAction,
  rejectClaimAction,
  settleMemberAction,
} from './actions'

// Reimbursements (spec §6.1): sub-tabs per member with the LIVE payable
// balance in the header — read from the ledger, so it always matches reports.

export default async function ReimbursementsPage(props: {
  searchParams: Promise<{ member?: string }>
}) {
  const user = await requireUser()
  const admin = isAdmin(user)
  if (!admin && !hasPermission(user, 'reimbursementSubmit')) {
    throw new Error('Forbidden: missing permission "reimbursementSubmit"')
  }
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  // Tabs: admin sees every active user; a member sees only their own.
  const tabUsers = admin
    ? await prisma.user.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
      })
    : [user]

  // Live balances: each member's payable ledger account (Cr balance = owed).
  const payables = await prisma.ledgerAccount.findMany({
    where: {
      entityId: entity.id,
      name: { in: tabUsers.map((u) => memberPayableName(u.name)) },
    },
  })
  const balances = payables.length
    ? await prisma.$queryRaw<{ accountId: string; balance: string }[]>`
        SELECT l."accountId", (COALESCE(SUM(l.credit), 0) - COALESCE(SUM(l.debit), 0))::text as balance
        FROM "JournalLine" l WHERE l."accountId" IN (${Prisma.join(payables.map((p) => p.id))})
        GROUP BY l."accountId"
      `
    : []
  const owedTo = (name: string) => {
    const account = payables.find((p) => p.name === memberPayableName(name))
    const row = account && balances.find((b) => b.accountId === account.id)
    return new Prisma.Decimal(row?.balance ?? 0).toFixed(2)
  }

  const { member: memberParam } = await props.searchParams
  const selected = tabUsers.find((u) => u.id === memberParam) ?? (admin ? tabUsers[0] : user)

  const [claims, heads, costCentres, baseSuggestion] = await Promise.all([
    prisma.reimbursement.findMany({
      where: { entityId: entity.id, memberId: selected.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null, kind: 'EXPENSE' },
      orderBy: { code: 'asc' },
    }),
    prisma.costCentre.findMany({
      where: { entityId: entity.id, archivedAt: null },
      orderBy: { name: 'asc' },
    }),
    suggestPaymentSource({ entityId: entity.id, module: 'reimbursement' }),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">
          Reimbursements — {entity.name} ({entity.code})
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Approving posts the expense immediately; the balance in each tab is
          that member&apos;s live payable ledger.
        </p>
      </div>

      {/* Member sub-tabs with live running balance (spec §6.1) */}
      <div className="flex flex-wrap gap-1 border-b border-zinc-200 pb-2">
        {tabUsers.map((u) => (
          <Link
            key={u.id}
            href={`/reimbursements?member=${u.id}`}
            className={`rounded-md px-3 py-1.5 text-sm ${
              u.id === selected.id
                ? 'bg-zinc-900 text-white'
                : 'text-zinc-600 hover:bg-zinc-100'
            }`}
          >
            {u.name}
            <span className={`ml-2 text-xs ${u.id === selected.id ? 'text-zinc-300' : 'text-zinc-400'}`}>
              {displayINR(owedTo(u.name))}
            </span>
          </Link>
        ))}
      </div>

      {/* Submit own claim */}
      {selected.id === user.id && (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="font-medium text-zinc-900">Submit a claim</h2>
          <form action={submitClaimAction} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="entityId" value={entity.id} />
            <input name="date" type="date" required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
            <input name="category" required placeholder="Category (Travel, Food…)" className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
            <input name="amount" required inputMode="decimal" placeholder="Amount ₹" className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
            <label className="flex cursor-pointer items-center gap-1 rounded-md border border-dashed border-zinc-300 px-2 py-1.5 text-xs text-zinc-500 hover:border-zinc-400">
              📎 receipt
              <input type="file" name="file" accept="application/pdf,image/*" className="w-40 text-xs" />
            </label>
            <input name="link" placeholder="…or Drive link" className="w-44 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
            <input name="remarks" placeholder="Remarks" className="flex-1 min-w-40 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
            <button type="submit" className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700">
              Submit
            </button>
          </form>
        </div>
      )}

      {/* Admin settle */}
      {admin && baseSuggestion.options.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="font-medium text-zinc-900">
            Settle {selected.name} — owed {displayINR(owedTo(selected.name))}
          </h2>
          <form action={settleMemberAction} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="entityId" value={entity.id} />
            <input type="hidden" name="memberId" value={selected.id} />
            <input name="date" type="date" required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
            <input name="amount" required inputMode="decimal" defaultValue={owedTo(selected.name)} className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
            <SourceSelect
              suggestion={rankForAmount(baseSuggestion.options, owedTo(selected.name))}
            />
            <button type="submit" className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700">
              Settle (Dr payable / Cr source)
            </button>
          </form>
        </div>
      )}

      {/* Claims */}
      <div className="space-y-2">
        {claims.map((claim) => (
          <div key={claim.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-xs text-zinc-400">{claim.date.toISOString().slice(0, 10)}</span>
              <span className="font-medium text-zinc-800">{claim.category}</span>
              {claim.link && (
                <a href={claim.link} target="_blank" rel="noreferrer" className="text-xs text-sky-600 hover:underline">
                  bill
                </a>
              )}
              {claim.remarks && <span className="text-xs text-zinc-400">{claim.remarks}</span>}
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  claim.status === 'PENDING'
                    ? 'bg-amber-100 text-amber-700'
                    : claim.status === 'APPROVED'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-red-100 text-red-700'
                }`}
              >
                {claim.status.toLowerCase()}
              </span>
              {claim.status === 'REJECTED' && claim.rejectReason && (
                <span className="text-xs text-red-500">{claim.rejectReason}</span>
              )}
              <span className="ml-auto font-semibold text-zinc-900">
                {displayINR(String(claim.amount))}
              </span>
            </div>
            {admin && claim.status === 'PENDING' && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <form action={approveClaimAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="claimId" value={claim.id} />
                  <HeadCombobox
                    heads={heads.map((h) => ({ id: h.id, code: h.code, name: h.name, kind: h.kind }))}
                    name="expenseAccountId"
                    required
                    placeholder="Expense head — type to search"
                  />
                  <SmartCombobox
                    options={costCentres.map((c) => ({ id: c.id, label: c.name }))}
                    name="costCentreId"
                    createName="costCentreText"
                    placeholder="cost centre — new name adds it"
                    className="w-52 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                  />
                  <button type="submit" className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600">
                    Approve & post
                  </button>
                </form>
                <form action={rejectClaimAction} className="flex items-center gap-2">
                  <input type="hidden" name="claimId" value={claim.id} />
                  <input name="reason" required placeholder="Rejection remarks" className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                  <button type="submit" className="rounded-md border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50">
                    Reject
                  </button>
                </form>
              </div>
            )}
          </div>
        ))}
        {claims.length === 0 && (
          <p className="text-sm text-zinc-400">No claims yet for {selected.name} in these books.</p>
        )}
      </div>
    </div>
  )
}
