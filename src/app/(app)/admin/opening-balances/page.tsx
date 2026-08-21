import { Fragment } from 'react'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { LiveFilter } from '@/components/live-filter'
import { PageHeader, Badge, tableWrapClass, theadClass } from '@/components/ui'
import { openingDateFor } from '@/lib/ledger/opening'
import { saveOpeningBalanceAction } from './actions'

// Opening balances, all of them on one screen (Himal, 20 Aug: "add opening
// balance for all account", then "jevade expenses head aahet tevade add
// kar"). Every postable head is here — assets and liabilities first, then
// the expense and income heads, since these books are never closed into
// reserves and a head can genuinely be carrying spend from before this
// year.
//
// Nothing new is stored: each figure IS a journal document dated 31 Mar,
// posted against Opening Balances — so this screen and the ledger can
// never disagree. Because that date falls before 1 April, an expense
// opening reads as brought-forward: it shows in the all-time P&L and in
// the Balance Sheet's profit-to-date, and stays out of this FY's Month by
// month and Budget vs Actual.

const inr = (n: number) => (n < 0 ? '−' : '') + '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN')

const KIND_LABEL: Record<string, string> = {
  ASSET: 'Assets — what you own or are owed',
  LIABILITY: 'Liabilities — what you owe',
  EQUITY: 'Capital',
  EXPENSE: 'Expense heads — spend brought forward from before this year',
  INCOME: 'Income heads — receipts brought forward from before this year',
}

export default async function OpeningBalancesPage() {
  const user = await requireAdmin()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>

  const [accounts, docs, banks, cash] = await Promise.all([
    prisma.ledgerAccount.findMany({
      // archived heads are here too (Himal, 20 Aug: "sagl disl pahije") —
      // one can still be carrying a balance worth opening. They sort after
      // the live ones and wear a tag, so nothing is opened by mistake.
      where: {
        entityId: entity.id,
        isGroup: false,
        kind: { in: ['ASSET', 'LIABILITY', 'EQUITY', 'EXPENSE', 'INCOME'] },
      },
      orderBy: [{ kind: 'asc' }, { code: 'asc' }],
      select: { id: true, code: true, name: true, kind: true, system: true, archivedAt: true },
    }),
    prisma.journalDoc.findMany({
      where: { entityId: entity.id, sourceType: 'opening_balance', deletedAt: null },
      select: {
        currentEntry: { select: { lines: { select: { accountId: true, debit: true, credit: true } } } },
      },
    }),
    prisma.bankAccount.findMany({ where: { entityId: entity.id }, select: { ledgerAccountId: true } }),
    prisma.cashLocation.findMany({ where: { entityId: entity.id }, select: { ledgerAccountId: true } }),
  ])

  // what each account's opening document currently says
  const openingBy = new Map<string, number>()
  for (const d of docs) {
    for (const l of d.currentEntry?.lines ?? []) {
      const v = Number(l.debit) - Number(l.credit)
      if (v !== 0) openingBy.set(l.accountId, (openingBy.get(l.accountId) ?? 0) + v)
    }
  }
  const moneyIds = new Set(
    [...banks, ...cash].map((x) => x.ledgerAccountId).filter((x): x is string => !!x),
  )
  // the Opening Balances control account is the other side of every one of
  // these — it is not something to type a figure into
  const rows = accounts.filter((a) => !(a.system && a.name.toLowerCase().includes('opening')))
  const done = rows.filter((a) => openingBy.has(a.id)).length
  const asAt = openingDateFor().toISOString().slice(0, 10)

  const cellCls =
    'w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-right text-xs tabular-nums hover:border-line focus:border-primary focus:bg-surface focus:outline-none'

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Setup & masters"
        title={`Opening balances — ${entity.code}`}
        subtitle={`As at ${asAt}, the day before this financial year. Positive = you own it, are owed it, or spent it; negative = you owe it or received it. Each figure posts against Opening Balances, so the books stay balanced.`}
        actions={
          <>
            <Badge tone={done === rows.length ? 'success' : 'warning'}>
              {done} of {rows.length} set
            </Badge>
            <LiveFilter selector="[data-live-filter='ob']" placeholder="Type to search accounts…" />
          </>
        }
      />

      <div className={tableWrapClass}>
        <table data-live-filter="ob" className="w-full min-w-[46rem] text-left text-sm">
          <thead className={theadClass}>
            <tr>
              <th className="px-4 py-2.5">Account</th>
              <th className="px-2 py-2.5">Type</th>
              <th className="px-2 py-2.5 text-right">Opening balance ₹</th>
              <th className="px-2 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            {(['ASSET', 'LIABILITY', 'EQUITY', 'EXPENSE', 'INCOME'] as const).map((kind) => {
              const mine = rows
                .filter((a) => a.kind === kind)
                .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.code.localeCompare(b.code))
              if (mine.length === 0) return null
              return (
                <Fragment key={kind}>
                  <tr data-filter-keep="1" className="bg-surface-2/60">
                    <td colSpan={4} className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-ink-3">
                      {KIND_LABEL[kind]}
                    </td>
                  </tr>
                  {mine.map((a) => {
                    const ob = openingBy.get(a.id) ?? 0
                    const fid = `ob-${a.id}`
                    return (
                      <tr key={a.id} className="even:bg-surface-2/40 hover:bg-primary-soft/40">
                        <td className="px-4 py-1 text-xs font-medium text-ink">
                          {a.name}
                          {a.archivedAt && (
                            <span className="ml-1.5 rounded bg-warning-soft px-1 text-[9px] font-medium text-warning">
                              archived
                            </span>
                          )}
                          {moneyIds.has(a.id) && (
                            <span className="ml-1.5 rounded bg-surface-2 px-1 text-[9px] font-medium text-ink-2">
                              bank / cash
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-[11px] text-ink-3">{a.code}</td>
                        <td className="px-1 py-0.5">
                          <input
                            name="openingBalance"
                            form={fid}
                            inputMode="decimal"
                            defaultValue={ob ? String(Math.round(ob)) : ''}
                            title={`Enter to save · blank clears · currently ${ob ? inr(ob) : 'not set'}`}
                            className={`${cellCls} ${ob < 0 ? 'font-medium text-success' : ''}`}
                          />
                        </td>
                        <td className="whitespace-nowrap px-2 py-0.5 text-right">
                          <form id={fid} action={saveOpeningBalanceAction} className="inline">
                            <input type="hidden" name="entityId" value={entity.id} />
                            <input type="hidden" name="accountId" value={a.id} />
                            <button
                              type="submit"
                              title="Save this opening balance"
                              className="rounded border border-line px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:bg-surface-2"
                            >
                              Save
                            </button>
                          </form>
                        </td>
                      </tr>
                    )
                  })}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        <p className="border-t border-line-2 px-4 py-2 text-[11px] text-ink-3">
          Type a figure and press Enter — blank clears it. A correction reposts as a reversal plus a new version, so a
          figure never double-counts. Bank and cash accounts already carry the opening you gave them when the account
          was added; changing it here corrects that same entry. An expense or income opening is dated before 1 April,
          so it reads as brought forward — it counts in the all-time P&amp;L, not in this year&apos;s Month by month or
          Budget vs Actual.
        </p>
      </div>
    </div>
  )
}
