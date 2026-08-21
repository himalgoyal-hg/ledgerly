import { Fragment } from 'react'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { LiveFilter } from '@/components/live-filter'
import { PageHeader, Badge, tableWrapClass, theadClass } from '@/components/ui'
import { openingDateFor } from '@/lib/ledger/opening'
import { saveOpeningBalanceAction } from './actions'

// Opening balances, all of them on one screen (Himal, 20 Aug: "add opening
// balance for all account"). The balance-sheet heads — assets,
// liabilities, capital — which is what an opening balance is; the expense
// and income heads were here for a day and came out again (Himal, 21 Aug:
// "Income and Expenses remove karo"), since a P&L head opens at nothing.
//
// Nothing new is stored: each figure IS a journal document dated 31 Mar,
// posted against Opening Balances — so this screen and the ledger can
// never disagree.

const inr = (n: number) => (n < 0 ? '−' : '') + '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN')

const KINDS = ['ASSET', 'LIABILITY', 'EQUITY'] as const

const KIND_SHORT: Record<string, string> = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Capital',
}

const KIND_LABEL: Record<string, string> = {
  ASSET: 'Assets — what you own or are owed',
  LIABILITY: 'Liabilities — what you owe',
  EQUITY: 'Capital',
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
        kind: { in: ['ASSET', 'LIABILITY', 'EQUITY'] },
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
  const editable = rows.filter((a) => !a.archivedAt)
  const done = editable.filter((a) => openingBy.has(a.id)).length
  const asAt = openingDateFor().toISOString().slice(0, 10)
  const netOpening = rows.reduce((s, a) => s + (openingBy.get(a.id) ?? 0), 0)
  const num = 'px-4 py-2 text-right tabular-nums'

  const cellCls =
    'w-full rounded border border-transparent bg-transparent px-2.5 py-1 text-right tabular-nums hover:border-line focus:border-primary focus:bg-surface focus:outline-none'

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Setup & masters"
        title={`Opening balances — ${entity.code}`}
        subtitle={`As at ${asAt}, the day before this financial year. Positive = you own it or are owed it; negative = you owe it. Each figure posts against Opening Balances, so the books stay balanced.`}
        actions={
          <>
            <Badge tone={done === rows.length ? 'success' : 'warning'}>
              {done} of {editable.length} set
            </Badge>
            <LiveFilter selector="[data-live-filter='ob']" placeholder="Type to search accounts…" />
          </>
        }
      />

      {/* One ruled grid, the same structure as the Balance Sheet (Himal,
          21 Aug: "proper structure made banav, type nako dakvu"): the
          account, then its opening in a ruled column, then Save. Each
          nature is a band with its own subtotal, and the foot shows the
          net figure — which is exactly what sits on Opening Balances. */}
      <div className={tableWrapClass}>
        <table data-live-filter="ob" className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col />
            <col className="w-40" />
            <col className="w-28" />
          </colgroup>
          <thead className={theadClass}>
            <tr>
              <th className="px-4 py-2">Account</th>
              <th className={`${num} border-l border-line-2`} title="As at the day before this financial year">
                Opening balance
              </th>
              <th className="border-l border-line-2 px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            {KINDS.map((kind) => {
              const mine = rows
                .filter((a) => a.kind === kind)
                .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.code.localeCompare(b.code))
              if (mine.length === 0) return null
              const subtotal = mine.reduce((s, a) => s + (openingBy.get(a.id) ?? 0), 0)
              const set = mine.filter((a) => openingBy.has(a.id)).length
              return (
                <Fragment key={kind}>
                  <tr data-filter-keep="1" className="bg-surface-2/60">
                    <td colSpan={3} className="px-4 py-1 text-[10px] font-bold uppercase tracking-widest text-ink-3">
                      {KIND_LABEL[kind]}
                    </td>
                  </tr>
                  {mine.map((a) => {
                    const ob = openingBy.get(a.id) ?? 0
                    const fid = `ob-${a.id}`
                    return (
                      <tr key={a.id} className="hover:bg-surface-2/40">
                        <td className="truncate px-4 py-1.5 text-ink">
                          <span className="font-mono text-xs text-ink-3">{a.code}</span> {a.name}
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
                        {/* An archived account cannot take a posting — the
                            ledger refuses one — so it is shown, not edited.
                            Restore it first if it needs an opening. */}
                        <td className="border-l border-line-2 px-1.5 py-0.5">
                          {a.archivedAt ? (
                            <span
                              className={`block px-2.5 py-1 text-right tabular-nums ${ob ? 'text-ink-3' : 'text-ink-3/60'}`}
                              title="Archived — restore the account to set an opening balance"
                            >
                              {ob ? inr(ob) : '—'}
                            </span>
                          ) : (
                            <input
                              name="openingBalance"
                              form={fid}
                              inputMode="decimal"
                              defaultValue={ob ? String(Math.round(ob)) : ''}
                              placeholder="—"
                              title={`Enter to save · blank clears · currently ${ob ? inr(ob) : 'not set'}`}
                              className={`${cellCls} ${ob < 0 ? 'font-medium text-success' : ''}`}
                            />
                          )}
                        </td>
                        <td className="whitespace-nowrap border-l border-line-2 px-3 py-0.5 text-right">
                          {a.archivedAt ? (
                            <span className="text-[10px] text-ink-3">restore to edit</span>
                          ) : (
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
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="bg-surface-2/30 font-medium text-ink">
                    <td className="px-4 py-1.5 text-xs">
                      Total {KIND_SHORT[kind].toLowerCase()}
                      <span className="ml-2 font-normal text-ink-3">
                        {set} of {mine.length} set
                      </span>
                    </td>
                    <td className={`${num} border-l border-line-2`}>{subtotal ? inr(subtotal) : '—'}</td>
                    <td className="border-l border-line-2" />
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
          <tfoot className="border-t-2 border-line font-semibold text-ink">
            <tr data-filter-keep="1">
              <td className="px-4 py-2">
                Net opening
                <span className="ml-2 text-xs font-normal text-ink-3">
                  debits less credits — the figure carried on Opening Balances
                </span>
              </td>
              <td className={`${num} border-l border-line-2`}>{netOpening ? inr(netOpening) : '—'}</td>
              <td className="border-l border-line-2" />
            </tr>
          </tfoot>
        </table>
        <p className="border-t border-line-2 px-4 py-2 text-[11px] text-ink-3">
          Type a figure and press Enter — blank clears it. A correction reposts as a reversal plus a new version, so a
          figure never double-counts. Bank and cash accounts already carry the opening you gave them when the account
          was added; changing it here corrects that same entry. Archived accounts are listed for completeness but
          cannot take one — the ledger refuses a posting to an archived account; restore it first.
        </p>
      </div>
    </div>
  )
}
