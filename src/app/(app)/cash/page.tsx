import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission, visibleEntityFilter } from '@/lib/auth'
import { displayINR } from '@/lib/ledger/money'
import { cashBalances } from '@/lib/ops/cash'
import { projectPools } from '@/lib/budget/plan'
import type { HeadOpt } from '@/components/head-combobox'
import { CashQuickRow, type QuickLocation, type CcOption } from './quick-row'
import { ConfirmButton } from '@/components/confirm-button'
import { PageHeader, controlClass, tableWrapClass, theadClass } from '@/components/ui'
import {
  createCashEntryAction,
  quickCashEntryAction,
  purgeCashEntryAction,
  deleteCashEntryAction,
  undoCashEntryAction,
  saveCashPlanAction,
  archiveCashPlanAction,
} from './actions'

// Cash (spec §6.2) — ONE physical pool across all books, never split by the
// "Books of" switcher: every location of every visible books shows here,
// and each entry posts double-entry in its own location's books. The screen
// is the Excel cash book: a quick signed-amount entry row on top, a
// passbook table with a running balance underneath.

export default async function CashPage(props: {
  searchParams: Promise<{ loc?: string; month?: string }>
}) {
  const user = await requireUser()
  const canEnter = isAdmin(user) || hasPermission(user, 'cashEntries')
  const canView = canEnter || hasPermission(user, 'viewCashReports')
  if (!canView) throw new Error('Forbidden: missing cash permissions')
  const canEditPosted = hasPermission(user, 'transactionEditDelete')

  const entities = await prisma.entity.findMany({
    where: { archivedAt: null, ...visibleEntityFilter(user) },
    orderBy: { code: 'asc' },
  })
  const entityCode = new Map(entities.map((e) => [e.id, e.code]))
  const entityIds = entities.map((e) => e.id)

  const sp = await props.searchParams
  const loc = sp.loc ?? ''
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? '') ? sp.month! : ''

  const [locations, headRows, entries] = await Promise.all([
    prisma.cashLocation.findMany({
      where: { entityId: { in: entityIds }, archivedAt: null, ledgerAccountId: { not: null } },
      orderBy: [{ entityId: 'asc' }, { name: 'asc' }],
    }),
    prisma.ledgerAccount.findMany({
      where: { entityId: { in: entityIds }, isGroup: false, archivedAt: null },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, kind: true, defaultCostCentreId: true, entityId: true },
    }),
    prisma.cashEntry.findMany({
      where: { entityId: { in: entityIds } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    }),
  ])
  const docs = await prisma.journalDoc.findMany({
    where: { id: { in: entries.map((e) => e.docId).filter((d): d is string => d !== null) } },
    select: { id: true, deletedAt: true },
  })
  const deletedDoc = new Set(docs.filter((d) => d.deletedAt).map((d) => d.id))

  // Balances: per location across every books, plus the one grand total.
  const perEntity = await Promise.all(entityIds.map((id) => cashBalances(id)))
  const balanceRows = perEntity.flatMap((b, i) =>
    b.perLocation
      .filter((r) => !r.archived || r.balance !== '0.00')
      .map((r) => ({ ...r, entityCode: entities[i].code })),
  )
  const total = perEntity
    .reduce((t, b) => t + Number(b.total), 0)
    .toFixed(2)

  const headsByEntity: Record<string, HeadOpt[]> = {}
  for (const h of headRows) {
    ;(headsByEntity[h.entityId] ??= []).push({
      id: h.id, code: h.code, name: h.name, kind: h.kind, defaultCostCentreId: h.defaultCostCentreId,
    })
  }
  const headName = (id: string | null) => {
    const h = headRows.find((a) => a.id === id)
    return h ? h.name : null
  }
  const locationById = new Map(locations.map((l) => [l.id, l]))
  const locationName = (id: string | null) => (id ? locationById.get(id)?.name ?? '(archived)' : '?')

  const quickLocations: QuickLocation[] = locations.map((l) => ({
    id: l.id, name: l.name, entityId: l.entityId, entityCode: entityCode.get(l.entityId) ?? '?',
  }))
  // cost centres per books, for the quick row's second classification tier
  const allCcs = await prisma.costCentre.findMany({ where: { archivedAt: null }, orderBy: { name: 'asc' } })
  const costCentresByEntity: Record<string, CcOption[]> = {}
  for (const c of allCcs) (costCentresByEntity[c.entityId] ??= []).push({ id: c.id, label: c.name })

  // --- Passbook (running balance) ---
  // Scope = one location or the whole pool; walk backwards from the live
  // ledger balance so opening balances fold in without replaying them.
  const scoped = loc
    ? entries.filter((e) => e.locationId === loc || e.toLocationId === loc)
    : entries
  const scopeBalanceNow = loc
    ? Number(balanceRows.find((b) => b.locationId === loc)?.balance ?? 0)
    : Number(total)
  const effect = (e: (typeof entries)[number]) => {
    if (e.docId && deletedDoc.has(e.docId)) return 0
    const a = Number(e.amount)
    if (e.kind === 'TRANSFER') {
      if (!loc) return 0
      return e.toLocationId === loc ? a : e.locationId === loc ? -a : 0
    }
    if (e.kind === 'RECEIPT') return a
    if (e.kind === 'PAYMENT') return -a
    return e.inflow ? a : -a // ADJUSTMENT
  }
  const balanceAfter = new Array<number>(scoped.length)
  let bal = scopeBalanceNow
  for (let i = scoped.length - 1; i >= 0; i--) {
    balanceAfter[i] = bal
    bal -= effect(scoped[i])
  }
  const allRows = scoped
    .map((e, i) => ({ entry: e, balance: balanceAfter[i] }))
    .filter((r) => !month || r.entry.date.toISOString().slice(0, 7) === month)
  // deleted entries leave the passbook and wait in the recycle bin below
  const rows = allRows.filter((r) => !(r.entry.docId && deletedDoc.has(r.entry.docId)))
  const binRows = allRows.filter((r) => r.entry.docId && deletedDoc.has(r.entry.docId))

  const flows = rows.reduce(
    (t, r) => {
      const eff = effect(r.entry)
      if (eff > 0) t.in += eff
      if (eff < 0) t.out -= eff
      return t
    },
    { in: 0, out: 0 },
  )
  // The passbook's book-ends: opening = balance before the first shown
  // entry, closing = after the last — exactly like a bank passbook page.
  const openingBalance = rows.length > 0 ? rows[0].balance - effect(rows[0].entry) : scopeBalanceNow
  const closingBalance = rows.length > 0 ? rows[rows.length - 1].balance : scopeBalanceNow

  const months = [...new Set(entries.map((e) => e.date.toISOString().slice(0, 7)))].sort().reverse()
  const monthLabel = (m: string) => {
    const L = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${L[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`
  }

  // The physical pool's own cash flow: live balance rolled forward with the
  // planned CASH lines (current month netted by actuals), plus the one-off
  // future needs as visible chips. The combined bank+cash view lives on the
  // Cash flow report's "Cash ahead" tab.
  const cashPool = isAdmin(user)
    ? (await projectPools(new Date(), 6)).find((p) => p.pool === 'CASH')
    : null
  const upcoming = isAdmin(user)
    ? await prisma.budgetLine.findMany({
        where: { source: 'CASH', frequency: 'ONCE', archivedAt: null, onMonth: { not: null } },
        orderBy: { onMonth: 'asc' },
      })
    : []
  const shortMonth = (m: string) =>
    `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`

  const signedAmount = (e: (typeof entries)[number]) => {
    const a = Number(e.amount)
    if (e.kind === 'TRANSFER') {
      if (!loc) return { text: displayINR(String(e.amount)), cls: 'text-ink-2' }
      const inbound = e.toLocationId === loc
      return {
        text: `${inbound ? '+' : '−'}${displayINR(String(e.amount))}`,
        cls: inbound ? 'text-success' : 'text-danger',
      }
    }
    const positive = e.kind === 'RECEIPT' || (e.kind === 'ADJUSTMENT' && e.inflow)
    return {
      text: `${positive ? '+' : '−'}${displayINR(String(Math.abs(a).toFixed(2)))}`,
      cls: positive ? 'text-success' : 'text-danger',
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Books"
        title="Cash — all books, one pool"
        subtitle={<>Every location from every books in one place; an entry posts in its own location&apos;s books.</>}
      />

      {/* Where is cash — slim strip */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-2xl border border-line bg-surface px-3 py-1.5 shadow-card">
        {balanceRows.map((b) => (
          <Link
            key={b.locationId}
            href={loc === b.locationId ? '/cash' : `/cash?loc=${b.locationId}${month ? `&month=${month}` : ''}`}
            className={`flex items-baseline gap-1.5 border-l-2 pl-2 hover:opacity-70 ${
              loc === b.locationId ? 'border-primary' : 'border-line'
            }`}
          >
            <span className="rounded bg-surface-2 px-1 text-[10px] font-medium text-ink-2">{b.entityCode}</span>
            <span className="text-[11px] text-ink-2">{b.name}{b.archived ? ' (archived)' : ''}</span>
            <span className="text-sm font-semibold tabular-nums text-ink">{displayINR(b.balance)}</span>
          </Link>
        ))}
        <div className="ml-auto flex items-baseline gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Total</span>
          <span className="text-sm font-semibold tabular-nums text-ink">{displayINR(total)}</span>
        </div>
      </div>

      {/* Cash flow — the pool projected, future needs added & visible here */}
      {cashPool && (
        <div className="rounded-2xl border border-line bg-surface shadow-card">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-1.5 text-xs">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              Cash flow
            </span>
            {cashPool.months.map((m) => (
              <span
                key={m.month}
                className="flex items-baseline gap-1"
                title={`in ${displayINR(m.inflow.toFixed(0))} · out ${displayINR(m.outflow.toFixed(0))}`}
              >
                <span className="text-ink-3">{shortMonth(m.month)}</span>
                <span className={`font-semibold tabular-nums ${m.closing < 0 ? 'text-danger' : 'text-ink'}`}>
                  {displayINR(m.closing.toFixed(2))}
                </span>
              </span>
            ))}
            <form action={saveCashPlanAction} className="ml-auto flex items-center gap-1">
              <input type="hidden" name="frequency" value="ONCE" />
              <input type="hidden" name="source" value="CASH" />
              <input
                name="label"
                required
                placeholder="Cash needed — what for"
                className="w-40 rounded-lg border border-line px-1.5 py-1 text-xs placeholder:text-ink-3"
              />
              <input
                name="amount"
                required
                inputMode="decimal"
                placeholder="₹"
                title="Positive = cash needed (out), negative = coming in"
                className="w-20 rounded-lg border border-line px-1.5 py-1 text-right text-xs placeholder:text-ink-3"
              />
              <input name="onMonth" type="month" required className="rounded-lg border border-line px-1.5 py-1 text-xs" />
              <button
                type="submit"
                className="whitespace-nowrap rounded-lg bg-success px-2 py-1 text-[11px] font-medium text-white hover:opacity-90"
              >
                + Add
              </button>
            </form>
          </div>
          {upcoming.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line-2 px-3 py-1.5 text-xs">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                Upcoming
              </span>
              {upcoming.map((l) => (
                <span
                  key={l.id}
                  className={`flex items-center gap-1 rounded-full px-2 py-0.5 ${
                    Number(l.amount) < 0 ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'
                  }`}
                >
                  <span className="font-medium">{l.label}</span>
                  <span className="tabular-nums">
                    {Number(l.amount) < 0 ? '+' : ''}{displayINR(Math.abs(Number(l.amount)).toFixed(0))}
                  </span>
                  <span className="text-[10px] opacity-70">({shortMonth(l.onMonth!)})</span>
                  <form action={archiveCashPlanAction} className="flex">
                    <input type="hidden" name="id" value={l.id} />
                    <button type="submit" title="Remove" className="ml-0.5 text-[10px] opacity-50 hover:opacity-100">
                      ✕
                    </button>
                  </form>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Quick entry — the Excel row */}
      {canEnter && locations.length > 0 && (
        <div className="space-y-2 rounded-2xl border border-line bg-surface p-2 shadow-card">
          <CashQuickRow
            locations={quickLocations}
            headsByEntity={headsByEntity}
            costCentresByEntity={costCentresByEntity}
            action={quickCashEntryAction}
          />
          <div className="flex flex-wrap gap-4">
            <details>
              <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">
                Transfer between locations (same books)
              </summary>
              <form action={createCashEntryAction} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="kind" value="TRANSFER" />
                <input name="date" type="date" required className={controlClass} />
                <input name="amount" required inputMode="decimal" placeholder="Amount ₹" className={`${controlClass} w-28`} />
                <select name="locationId" required className={controlClass}>
                  {quickLocations.map((l) => (
                    <option key={l.id} value={l.id}>{l.entityCode} · {l.name}</option>
                  ))}
                </select>
                <span className="text-xs text-ink-3">→</span>
                <select name="toLocationId" required className={controlClass}>
                  {quickLocations.map((l) => (
                    <option key={l.id} value={l.id}>{l.entityCode} · {l.name}</option>
                  ))}
                </select>
                <input name="remarks" placeholder="Remarks" className={controlClass} />
                <button type="submit" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-strong">
                  Transfer
                </button>
              </form>
            </details>
            <details>
              <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">
                Adjustment (mandatory reason)
              </summary>
              <form action={createCashEntryAction} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="kind" value="ADJUSTMENT" />
                <input name="date" type="date" required className={controlClass} />
                <input name="amount" required inputMode="decimal" placeholder="Amount ₹" className={`${controlClass} w-28`} />
                <select name="locationId" required className={controlClass}>
                  {quickLocations.map((l) => (
                    <option key={l.id} value={l.id}>{l.entityCode} · {l.name}</option>
                  ))}
                </select>
                <select name="inflow" className={controlClass}>
                  <option value="false">Cash short (remove)</option>
                  <option value="true">Cash excess (add)</option>
                </select>
                <select name="headAccountId" required className={controlClass}>
                  <option value="">— against head (same books) —</option>
                  {entities.map((e) => (
                    <optgroup key={e.id} label={e.code}>
                      {(headsByEntity[e.id] ?? []).map((h) => (
                        <option key={h.id} value={h.id}>{h.code} · {h.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <input name="reason" required placeholder="Reason (required)" className={controlClass} />
                <button type="submit" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-strong">
                  Adjust
                </button>
              </form>
            </details>
          </div>
        </div>
      )}

      {/* Passbook */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-medium text-ink">
            Cash book{loc ? ` — ${locationName(loc)}` : ''}
          </h2>
          <form className="ml-auto flex flex-wrap items-center gap-2">
            {loc && <input type="hidden" name="loc" value={loc} />}
            <select name="month" defaultValue={month} className="rounded-lg border border-line bg-surface px-2 py-1 text-xs">
              <option value="">All months</option>
              {months.map((m) => (
                <option key={m} value={m}>{monthLabel(m)}</option>
              ))}
            </select>
            <button type="submit" className="rounded-lg border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-2">
              Apply
            </button>
            {(loc || month) && (
              <Link href="/cash" className="text-xs text-ink-3 hover:text-ink-2">reset</Link>
            )}
          </form>
          <span className="w-full text-xs text-ink-2 sm:w-auto">
            Opening {displayINR(openingBalance.toFixed(2))} · In {displayINR(flows.in.toFixed(2))} · Out{' '}
            {displayINR(flows.out.toFixed(2))} · Closing{' '}
            <span className="font-semibold text-ink">{displayINR(closingBalance.toFixed(2))}</span>
          </span>
        </div>

        {rows.length > 0 ? (
          <div className={tableWrapClass}>
            <table className="w-full min-w-[56rem] text-left text-sm">
              <thead className={theadClass}>
                <tr>
                  <th className="px-2 py-2">Date</th>
                  <th className="px-2 py-2">Details</th>
                  <th className="px-2 py-2">Location</th>
                  <th className="px-2 py-2">Head</th>
                  <th className="px-2 py-2 text-right">Amount</th>
                  <th className="px-2 py-2">Comments</th>
                  <th className="px-2 py-2 text-right">Balance</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2">
                {/* passbook's first line: where the money stood before these entries */}
                <tr className="bg-surface-2/60 text-xs">
                  <td className="px-2 py-1.5 text-ink-3">{month ? monthLabel(month) : 'Start'}</td>
                  <td className="px-2 py-1.5 font-medium text-ink-2" colSpan={5}>
                    Opening balance
                  </td>
                  <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-ink">
                    {displayINR(openingBalance.toFixed(2))}
                  </td>
                  <td />
                </tr>
                {rows.map(({ entry, balance }) => {
                  const amt = signedAmount(entry)
                  return (
                    <tr key={entry.id} className="hover:bg-surface-2/60">
                      <td className="whitespace-nowrap px-2 py-1.5 text-xs tabular-nums text-ink-2">
                        {entry.date.toISOString().slice(0, 10)}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="block max-w-[18rem] truncate font-medium text-ink" title={entry.remarks ?? ''}>
                          {entry.remarks ?? <span className="font-normal text-ink-3">—</span>}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <span className="rounded bg-surface-2 px-1 text-[10px] font-medium text-ink-2">
                          {entityCode.get(entry.entityId)}
                        </span>{' '}
                        <span className="text-xs text-ink-2">
                          {entry.kind === 'TRANSFER'
                            ? `${locationName(entry.locationId)} → ${locationName(entry.toLocationId)}`
                            : locationName(entry.locationId)}
                        </span>
                      </td>
                      <td className="max-w-40 truncate px-2 py-1.5 text-xs text-ink-2" title={headName(entry.headAccountId) ?? ''}>
                        {headName(entry.headAccountId) ?? <span className="text-ink-3">transfer</span>}
                      </td>
                      <td className={`whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums ${amt.cls}`}>
                        {amt.text}
                      </td>
                      <td className="max-w-48 truncate px-2 py-1.5 text-xs text-ink-2" title={entry.comments ?? entry.reason ?? ''}>
                        {entry.reason ? <span className="text-warning">reason: {entry.reason}</span> : entry.comments}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-ink">
                        {displayINR(balance.toFixed(2))}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {canEditPosted && entry.docId && (
                          <form action={deleteCashEntryAction}>
                            <input type="hidden" name="entryId" value={entry.id} />
                            <button
                              type="submit"
                              title="Moves to the recycle bin below — balance reverses, restore anytime"
                              className="whitespace-nowrap rounded-lg border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:bg-surface-2"
                            >
                              Delete
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-ink-3">
            {month || loc ? 'No entries match these filters.' : 'No cash entries yet.'}
          </p>
        )}

        {/* deleted entries live in the ONE recycle bin, not on this page */}
        {binRows.length > 0 && (
          <p className="text-xs text-ink-3">
            {binRows.length} deleted entr{binRows.length > 1 ? 'ies' : 'y'} in the{' '}
            <Link href="/recycle-bin" className="text-ink-2 underline hover:text-ink">
              🗑 Recycle bin
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}
