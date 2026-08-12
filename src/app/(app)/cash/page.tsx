import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { cashBalances } from '@/lib/ops/cash'
import { HeadCombobox } from '@/components/head-combobox'
import { SmartCombobox } from '@/components/smart-combobox'
import { createCashEntryAction, deleteCashEntryAction, undoCashEntryAction } from './actions'

// Cash (spec §6.2): "where is cash" live view + the entry form
// (receipt / payment / transfer / adjustment-with-reason).

export default async function CashPage() {
  const user = await requireUser()
  const canEnter = hasPermission(user, 'cashEntries')
  const canView = canEnter || hasPermission(user, 'viewCashReports') || isAdmin(user)
  if (!canView) throw new Error('Forbidden: missing cash permissions')
  const canEditPosted = hasPermission(user, 'transactionEditDelete')
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const [balances, locations, heads, costCentres, entries] = await Promise.all([
    cashBalances(entity.id),
    prisma.cashLocation.findMany({
      where: { entityId: entity.id, archivedAt: null, ledgerAccountId: { not: null } },
      orderBy: { name: 'asc' },
    }),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null },
      orderBy: { code: 'asc' },
    }),
    prisma.costCentre.findMany({
      where: { entityId: entity.id, archivedAt: null },
      orderBy: { name: 'asc' },
    }),
    prisma.cashEntry.findMany({
      where: { entityId: entity.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
  ])
  const docs = await prisma.journalDoc.findMany({
    where: { id: { in: entries.map((e) => e.docId).filter((d): d is string => d !== null) } },
    select: { id: true, deletedAt: true },
  })
  const docById = new Map(docs.map((d) => [d.id, d]))
  const locationName = (id: string | null) => locations.find((l) => l.id === id)?.name ?? '?'
  const headName = (id: string | null) => {
    const h = heads.find((a) => a.id === id)
    return h ? `${h.code} · ${h.name}` : null
  }

  const selects = {
    location: (name: string) => (
      <select name={name} required className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
        <option value="">— location —</option>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
    ),
    head: (label: string) => (
      <HeadCombobox
        heads={heads.map((h) => ({
          id: h.id,
          code: h.code,
          name: h.name,
          kind: h.kind,
          defaultCostCentreId: h.defaultCostCentreId,
        }))}
        required
        placeholder={label}
      />
    ),
    costCentre: (
      <SmartCombobox
        options={costCentres.map((c) => ({ id: c.id, label: c.name }))}
        name="costCentreId"
        createName="costCentreText"
        placeholder="cost centre — new name adds it"
        className="w-56 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
      />
    ),
  }
  const common = (
    <>
      <input name="entityId" type="hidden" value={entity.id} />
      <input name="date" type="date" required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
      <input name="amount" required inputMode="decimal" placeholder="Amount ₹" className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
    </>
  )
  const submit = (label: string) => (
    <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700">
      {label}
    </button>
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">
          Cash — {entity.name} ({entity.code})
        </h1>
      </div>

      {/* Where is cash (spec §6.2) */}
      <div className="flex flex-wrap gap-3">
        {balances.perLocation
          .filter((b) => !b.archived || b.balance !== '0.00')
          .map((b) => (
            <div key={b.locationId} className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
              <div className="text-xs text-zinc-500">{b.name}{b.archived ? ' (archived)' : ''}</div>
              <div className="text-lg font-semibold text-zinc-900">{displayINR(b.balance)}</div>
            </div>
          ))}
        <div className="rounded-xl border border-zinc-300 bg-zinc-900 px-4 py-3 shadow-sm">
          <div className="text-xs text-zinc-400">Total cash</div>
          <div className="text-lg font-semibold text-white">{displayINR(balances.total)}</div>
        </div>
      </div>

      {/* Entry forms (permission-gated) */}
      {canEnter && locations.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="font-medium text-zinc-900">New cash entry</h2>
          <div className="mt-3 space-y-3">
            <details open>
              <summary className="cursor-pointer text-sm font-medium text-zinc-700">Receipt (cash in)</summary>
              <form action={createCashEntryAction} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="kind" value="RECEIPT" />
                {common}
                {selects.location('locationId')}
                {selects.head('— received from (head) —')}
                {selects.costCentre}
                <input name="remarks" placeholder="Received from — name / note" className="w-56 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                {submit('Add receipt')}
              </form>
            </details>
            <details>
              <summary className="cursor-pointer text-sm font-medium text-zinc-700">Payment (cash out)</summary>
              <form action={createCashEntryAction} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="kind" value="PAYMENT" />
                {common}
                {selects.location('locationId')}
                {selects.head('— paid for (head) —')}
                {selects.costCentre}
                <input name="remarks" placeholder="Paid to — name / note" className="w-56 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                {submit('Add payment')}
              </form>
            </details>
            <details>
              <summary className="cursor-pointer text-sm font-medium text-zinc-700">Transfer between locations</summary>
              <form action={createCashEntryAction} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="kind" value="TRANSFER" />
                {common}
                {selects.location('locationId')}
                <span className="text-xs text-zinc-400">→</span>
                {selects.location('toLocationId')}
                <input name="remarks" placeholder="Remarks" className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                {submit('Transfer')}
              </form>
            </details>
            <details>
              <summary className="cursor-pointer text-sm font-medium text-zinc-700">Adjustment (mandatory reason)</summary>
              <form action={createCashEntryAction} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="kind" value="ADJUSTMENT" />
                {common}
                {selects.location('locationId')}
                <select name="inflow" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
                  <option value="false">Cash short (remove)</option>
                  <option value="true">Cash excess (add)</option>
                </select>
                {selects.head('— against head —')}
                <input name="reason" required placeholder="Reason (required)" className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                {submit('Adjust')}
              </form>
            </details>
          </div>
        </div>
      )}

      {/* Recent entries */}
      <div className="space-y-2">
        <h2 className="font-medium text-zinc-900">Recent entries</h2>
        {entries.map((entry) => {
          const doc = entry.docId ? docById.get(entry.docId) : undefined
          const deleted = Boolean(doc?.deletedAt)
          return (
            <div
              key={entry.id}
              className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 text-sm shadow-sm ${
                deleted ? 'border-red-100 bg-red-50/40 opacity-70' : 'border-zinc-200 bg-white'
              }`}
            >
              <span className="text-xs text-zinc-400">{entry.date.toISOString().slice(0, 10)}</span>
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-500">
                {entry.kind.toLowerCase()}
              </span>
              <span className="text-zinc-800">
                {entry.kind === 'TRANSFER'
                  ? `${locationName(entry.locationId)} → ${locationName(entry.toLocationId)}`
                  : locationName(entry.locationId)}
              </span>
              {headName(entry.headAccountId) && (
                <span className="text-xs text-zinc-500">{headName(entry.headAccountId)}</span>
              )}
              {entry.reason && <span className="text-xs text-amber-600">reason: {entry.reason}</span>}
              {entry.remarks && <span className="text-xs text-zinc-400">{entry.remarks}</span>}
              {deleted && (
                <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">deleted</span>
              )}
              <span className="ml-auto font-semibold text-zinc-900">{displayINR(String(entry.amount))}</span>
              {canEditPosted && entry.docId && (
                deleted ? (
                  <form action={undoCashEntryAction}>
                    <input type="hidden" name="entryId" value={entry.id} />
                    <button type="submit" className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100">
                      Undo delete
                    </button>
                  </form>
                ) : (
                  <form action={deleteCashEntryAction}>
                    <input type="hidden" name="entryId" value={entry.id} />
                    <button type="submit" className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">
                      Delete
                    </button>
                  </form>
                )
              )}
            </div>
          )
        })}
        {entries.length === 0 && <p className="text-sm text-zinc-400">No cash entries yet.</p>}
      </div>
    </div>
  )
}
