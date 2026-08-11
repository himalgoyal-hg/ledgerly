import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requirePermission, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { NATURES } from '@/lib/statements/natures'
import { describeNarration } from '@/lib/statements/rules'
import { aiConfigured } from '@/lib/ai/client'
import { TagForm } from './tag-form'
import { SelectAll } from './select-all'
import { HeadCombobox } from '@/components/head-combobox'
import {
  tagTransaction,
  untagTransaction,
  postAll,
  retagPosted,
  deletePosted,
  undoPosted,
  requestAiSuggestions,
  acceptAiSuggestion,
  dismissAiSuggestion,
  bulkTag,
  acceptAllSuggestions,
} from './actions'

// The tagging queue (spec §3 steps 4–6): pending rows get their 3-tier tag,
// tagged rows wait for "Post All Confirmed", posted rows carry a balanced
// journal underneath (with member edit/delete/undo when granted).
// Search, bank/month/status filters, KPIs, bulk tagging and pagination come
// from the v2 prototype's Tagging screen.

const PER_PAGE = 60

export default async function TaggingPage(props: {
  searchParams: Promise<{ q?: string; bank?: string; month?: string; view?: string; page?: string }>
}) {
  const user = await requirePermission('transactionTagging')
  const canEditPosted = hasPermission(user, 'transactionEditDelete')
  const entity = await getCurrentEntity(user)
  if (!entity) {
    return <p className="text-sm text-zinc-500">No books to work on yet.</p>
  }

  const sp = await props.searchParams
  const q = (sp.q ?? '').trim()
  const bank = sp.bank ?? ''
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? '') ? sp.month! : ''
  const view = ['pending', 'tagged', 'posted'].includes(sp.view ?? '') ? sp.view! : 'all'
  const pageNo = Math.max(1, Number(sp.page) || 1)

  const monthFrom = month ? new Date(`${month}-01T00:00:00Z`) : null
  const monthTo = monthFrom
    ? new Date(Date.UTC(monthFrom.getUTCFullYear(), monthFrom.getUTCMonth() + 1, 1))
    : null
  // One filter, three status lists — mirrors the prototype's single filtered
  // table split into our Pending / Tagged / Posted sections.
  const filter = {
    entityId: entity.id,
    ...(bank ? { bankAccountId: bank } : {}),
    ...(q
      ? {
          OR: [
            { narration: { contains: q, mode: 'insensitive' as const } },
            { reference: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(monthFrom && monthTo ? { date: { gte: monthFrom, lt: monthTo } } : {}),
  }

  const [pending, tagged, posted, heads, costCentres, banks, users, totalEntries, sums, monthRows] =
    await Promise.all([
      prisma.statementTransaction.findMany({
        where: { ...filter, status: 'PENDING' },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
      }),
      prisma.statementTransaction.findMany({
        where: { ...filter, status: 'TAGGED' },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
      }),
      prisma.statementTransaction.findMany({
        where: { ...filter, status: 'POSTED' },
        orderBy: [{ taggedAt: 'desc' }, { date: 'desc' }],
        take: 50,
      }),
      prisma.ledgerAccount.findMany({
        where: { entityId: entity.id, isGroup: false, archivedAt: null },
        orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true, kind: true, defaultCostCentreId: true },
      }),
      prisma.costCentre.findMany({
        where: { entityId: entity.id, archivedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      prisma.bankAccount.findMany({ select: { id: true, nickname: true, entityId: true } }),
      prisma.user.findMany({ select: { id: true, name: true } }),
      prisma.statementTransaction.count({
        where: { entityId: entity.id, status: { not: 'DUPLICATE' } },
      }),
      prisma.statementTransaction.aggregate({
        where: { ...filter, status: { not: 'DUPLICATE' } },
        _sum: { debit: true, credit: true },
      }),
      prisma.$queryRaw<{ m: string }[]>`
        SELECT DISTINCT to_char(date, 'YYYY-MM') AS m
        FROM "StatementTransaction" WHERE "entityId" = ${entity.id} ORDER BY 1 DESC
      `,
    ])

  const docs = await prisma.journalDoc.findMany({
    where: { id: { in: posted.map((t) => t.docId).filter((d): d is string => d !== null) } },
    select: { id: true, deletedAt: true, _count: { select: { entries: true } } },
  })
  const docById = new Map(docs.map((d) => [d.id, d]))
  const headName = (id: string | null) => {
    const h = heads.find((a) => a.id === id)
    return h ? `${h.code} · ${h.name}` : '—'
  }
  const bankName = (id: string) => banks.find((b) => b.id === id)?.nickname ?? '?'
  const userName = (id: string | null) => users.find((u) => u.id === id)?.name ?? 'System'
  const natureLabel = (v: string | null) => NATURES.find((n) => n.value === v)?.label ?? v ?? '—'
  const ccName = (id: string | null) => costCentres.find((c) => c.id === id)?.name
  const aiReady = aiConfigured()
  const awaitingSuggestion = pending.filter((t) => t.aiSuggestedAt === null).length

  // v2-prototype chrome: KPIs, filter summary, pagination.
  const entityBanks = banks.filter((b) => b.entityId === entity.id)
  const suggestionCount = pending.filter((t) => t.aiHeadAccountId && t.aiNature).length
  const inView = pending.length + tagged.length + posted.length
  const net = Number(sums._sum.debit ?? 0) - Number(sums._sum.credit ?? 0)
  const pages = Math.max(1, Math.ceil(pending.length / PER_PAGE))
  const page = Math.min(pageNo, pages)
  const pendingSlice = pending.slice((page - 1) * PER_PAGE, page * PER_PAGE)
  const hrefFor = (p: number) => {
    const s = new URLSearchParams()
    if (q) s.set('q', q)
    if (bank) s.set('bank', bank)
    if (month) s.set('month', month)
    if (view !== 'all') s.set('view', view)
    if (p > 1) s.set('page', String(p))
    const str = s.toString()
    return str ? `/tagging?${str}` : '/tagging'
  }
  const monthLabel = (m: string) => {
    const L = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${L[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`
  }
  const showPending = view === 'all' || view === 'pending'
  const showTagged = view === 'all' || view === 'tagged'
  const showPosted = view === 'all' || view === 'posted'
  const filtered = Boolean(q || bank || month)

  const kpiTiles: [string, string, string, string][] = [
    ['Entries in view', String(inView), bank ? (bankName(bank) ?? '') : 'all accounts', 'border-zinc-800'],
    ['Untagged', String(pending.length), `${suggestionCount} have a suggestion`, 'border-blue-600'],
    [
      'Net movement',
      displayINR(Math.abs(net).toFixed(2)),
      net > 0 ? 'net outflow' : 'net inflow',
      'border-zinc-400',
    ],
    ['Awaiting post', String(tagged.length), 'tagged, not yet posted', 'border-teal-600'],
  ]

  const rowHeader = (txn: (typeof pending)[number], selectable = false) => {
    const outflow = Number(txn.debit) > 0
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {selectable && (
          <input
            type="checkbox"
            name="ids"
            value={txn.id}
            form="bulk-tag"
            className="accent-zinc-900"
            aria-label="Select for bulk tagging"
          />
        )}
        <span className="text-xs text-zinc-400">{txn.date.toISOString().slice(0, 10)}</span>
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          {bankName(txn.bankAccountId)}
        </span>
        {(() => {
          const desc = describeNarration(txn.narration)
          return (
            <span className="flex min-w-0 max-w-md flex-col">
              <span className="flex items-center gap-2">
                <span className="truncate font-medium text-zinc-800">{desc.title}</span>
                {desc.kind && (
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                    {desc.kind}
                  </span>
                )}
              </span>
              <span className="truncate text-xs text-zinc-400" title={txn.narration}>
                {txn.narration}
              </span>
            </span>
          )
        })()}
        {txn.reference && <span className="text-xs text-zinc-400">ref {txn.reference}</span>}
        <span
          className={`ml-auto font-semibold ${outflow ? 'text-red-600' : 'text-emerald-600'}`}
        >
          {outflow ? 'Out' : 'In'} {displayINR(String(outflow ? txn.debit : txn.credit))}
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">
            Tagging queue — {entity.name} ({entity.code})
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Pick head, nature and cost centre — the engine posts the books
            underneath. Every manual tag teaches the auto-verifier.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {aiReady && awaitingSuggestion > 0 && (
            <form action={requestAiSuggestions}>
              <input type="hidden" name="entityId" value={entity.id} />
              <button
                type="submit"
                className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm font-medium text-sky-800 hover:bg-sky-100"
              >
                Suggest tags with AI ({Math.min(awaitingSuggestion, 25)})
              </button>
            </form>
          )}
          {tagged.length > 0 && (
            <form action={postAll}>
              <input type="hidden" name="entityId" value={entity.id} />
              <button
                type="submit"
                className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
              >
                Post All Confirmed ({tagged.length})
              </button>
            </form>
          )}
        </div>
      </div>

      {/* KPIs (v2 prototype) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpiTiles.map(([label, value, sub, accent]) => (
          <div
            key={label}
            className={`rounded-xl border border-zinc-200 border-t-[3px] bg-white p-4 shadow-sm ${accent}`}
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">{label}</p>
            <p className="mt-1.5 text-2xl font-semibold tabular-nums text-zinc-900">{value}</p>
            <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>
          </div>
        ))}
      </div>

      {/* Search & filters (v2 prototype) */}
      <form className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search narration…"
          className="w-60 rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
        />
        <select name="bank" defaultValue={bank} className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
          <option value="">All accounts</option>
          {entityBanks.map((b) => (
            <option key={b.id} value={b.id}>{b.nickname}</option>
          ))}
        </select>
        <select name="month" defaultValue={month} className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
          <option value="">All months</option>
          {monthRows.map((r) => (
            <option key={r.m} value={r.m}>{monthLabel(r.m)}</option>
          ))}
        </select>
        <select name="view" defaultValue={view} className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
          <option value="all">All entries</option>
          <option value="pending">Untagged only</option>
          <option value="tagged">Tagged only</option>
          <option value="posted">Posted only</option>
        </select>
        <button
          type="submit"
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
        >
          Apply
        </button>
        {filtered && (
          <Link href="/tagging" className="text-xs text-zinc-400 hover:text-zinc-700">
            reset
          </Link>
        )}
        <span className="ml-auto text-xs text-zinc-500">
          {inView} of {totalEntries} entries · {pending.length} untagged
        </span>
      </form>

      {/* Bulk tagging (v2 prototype): tick rows below, apply one tag to all */}
      {showPending && pendingSlice.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-teal-200 bg-teal-50/60 p-3">
          <form id="bulk-tag" action={bulkTag} className="flex flex-wrap items-center gap-2">
            <SelectAll />
            <HeadCombobox heads={heads} required placeholder="Bulk head — type to search" />
            <select name="nature" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
              <option value="">nature — auto by direction</option>
              {NATURES.map((n) => (
                <option key={n.value} value={n.value}>{n.label}</option>
              ))}
            </select>
            <select name="costCentreId" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
              <option value="">— cost centre —</option>
              {costCentres.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700"
            >
              Apply to selected
            </button>
          </form>
          {suggestionCount > 0 && (
            <form action={acceptAllSuggestions}>
              <input type="hidden" name="entityId" value={entity.id} />
              <button
                type="submit"
                className="rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-800 hover:bg-sky-100"
              >
                Accept {suggestionCount} suggestions
              </button>
            </form>
          )}
        </div>
      )}

      {/* Pending queue */}
      {showPending && (
      <div className="space-y-2">
        <h2 className="font-medium text-zinc-900">
          Pending ({pending.length}){pages > 1 && (
            <span className="ml-2 text-xs font-normal text-zinc-400">Page {page} of {pages}</span>
          )}
        </h2>
        {pendingSlice.map((txn) => {
          const confidence = txn.aiConfidence === null ? null : Number(txn.aiConfidence)
          const hasSuggestion = Boolean(txn.aiHeadAccountId && txn.aiNature)
          return (
            <div key={txn.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              {rowHeader(txn, true)}

              {/* AI suggestion — advisory: accept it or ignore it (spec §12.8) */}
              {hasSuggestion && (
                <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="rounded bg-sky-200 px-1.5 py-0.5 text-[10px] font-medium uppercase text-sky-800">
                      AI suggests
                    </span>
                    <span className="font-medium text-zinc-800">
                      {headName(txn.aiHeadAccountId)}
                    </span>
                    <span className="text-zinc-400">·</span>
                    <span className="text-zinc-700">{natureLabel(txn.aiNature)}</span>
                    {ccName(txn.aiCostCentreId) && (
                      <>
                        <span className="text-zinc-400">·</span>
                        <span className="text-zinc-700">{ccName(txn.aiCostCentreId)}</span>
                      </>
                    )}
                    {confidence !== null && (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          confidence >= 0.8
                            ? 'bg-emerald-100 text-emerald-700'
                            : confidence >= 0.5
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-zinc-200 text-zinc-600'
                        }`}
                      >
                        {Math.round(confidence * 100)}% confident
                      </span>
                    )}
                  </div>
                  {txn.aiReason && (
                    <p className="mt-1 text-xs text-zinc-600">{txn.aiReason}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <form action={acceptAiSuggestion}>
                      <input type="hidden" name="txnId" value={txn.id} />
                      <button
                        type="submit"
                        className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600"
                      >
                        Accept & teach the rule
                      </button>
                    </form>
                    <form action={dismissAiSuggestion}>
                      <input type="hidden" name="txnId" value={txn.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                      >
                        Dismiss
                      </button>
                    </form>
                    <span className="text-[10px] text-zinc-500">
                      Accepting tags the row and teaches the rule engine, so this party
                      is matched without AI next time.
                    </span>
                  </div>
                </div>
              )}
              {!hasSuggestion && txn.aiSuggestedAt !== null && txn.aiReason && (
                <p className="mt-2 text-xs text-zinc-400">AI: {txn.aiReason}</p>
              )}

              <div className="mt-3">
                <TagForm
                  txnId={txn.id}
                  isOutflow={Number(txn.debit) > 0}
                  heads={heads}
                  costCentres={costCentres}
                  action={tagTransaction}
                  submitLabel="Tag"
                />
              </div>
            </div>
          )
        })}
        {pending.length === 0 && (
          <p className="text-sm text-zinc-400">
            {filtered ? 'No pending entries match these filters.' : 'Queue is clear — nothing waiting.'}
          </p>
        )}
        {pages > 1 && (
          <div className="flex items-center gap-3 pt-1 text-sm">
            {page > 1 && (
              <Link href={hrefFor(page - 1)} className="rounded-md border border-zinc-300 px-3 py-1.5 text-zinc-600 hover:bg-zinc-100">
                ← Previous
              </Link>
            )}
            <span className="text-xs text-zinc-400">Page {page} of {pages}</span>
            {page < pages && (
              <Link href={hrefFor(page + 1)} className="rounded-md border border-zinc-300 px-3 py-1.5 text-zinc-600 hover:bg-zinc-100">
                Next →
              </Link>
            )}
          </div>
        )}
      </div>
      )}

      {/* Tagged, awaiting post */}
      {showTagged && tagged.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-medium text-zinc-900">Tagged — awaiting post ({tagged.length})</h2>
          {tagged.map((txn) => (
            <div key={txn.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              {rowHeader(txn)}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-600">
                <span>{headName(txn.headAccountId)}</span>
                <span className="text-zinc-300">·</span>
                <span>{natureLabel(txn.nature)}</span>
                {ccName(txn.costCentreId) && (
                  <>
                    <span className="text-zinc-300">·</span>
                    <span>{ccName(txn.costCentreId)}</span>
                  </>
                )}
                {txn.autoTagged ? (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                    Verified by System
                  </span>
                ) : txn.tagSource === 'ai' ? (
                  <span className="text-zinc-400">
                    AI suggestion accepted by {userName(txn.taggedById)}
                  </span>
                ) : (
                  <span className="text-zinc-400">tagged by {userName(txn.taggedById)}</span>
                )}
                <form action={untagTransaction} className="ml-auto">
                  <input type="hidden" name="txnId" value={txn.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                  >
                    Untag
                  </button>
                </form>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-800">
                  Change tag
                </summary>
                <div className="mt-2">
                  <TagForm
                    txnId={txn.id}
                    isOutflow={Number(txn.debit) > 0}
                    heads={heads}
                    costCentres={costCentres}
                    action={tagTransaction}
                    submitLabel="Save tag"
                    defaults={{ headAccountId: txn.headAccountId, nature: txn.nature, costCentreId: txn.costCentreId }}
                  />
                </div>
              </details>
            </div>
          ))}
        </div>
      )}

      {/* Posted */}
      {showPosted && (
      <div className="space-y-2">
        <h2 className="font-medium text-zinc-900">Recently posted</h2>
        {posted.map((txn) => {
          const doc = txn.docId ? docById.get(txn.docId) : undefined
          const deleted = Boolean(doc?.deletedAt)
          return (
            <div
              key={txn.id}
              className={`rounded-xl border p-4 shadow-sm ${
                deleted ? 'border-red-100 bg-red-50/40' : 'border-zinc-200 bg-white'
              }`}
            >
              <div className={deleted ? 'opacity-60' : undefined}>{rowHeader(txn)}</div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-600">
                <span>{headName(txn.headAccountId)}</span>
                <span className="text-zinc-300">·</span>
                <span>{natureLabel(txn.nature)}</span>
                {ccName(txn.costCentreId) && (
                  <>
                    <span className="text-zinc-300">·</span>
                    <span>{ccName(txn.costCentreId)}</span>
                  </>
                )}
                {txn.autoTagged && (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                    Verified by System
                  </span>
                )}
                {!txn.docId && (
                  <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                    mirror of own-account transfer
                  </span>
                )}
                {deleted && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                    deleted
                  </span>
                )}
              </div>
              {canEditPosted && txn.docId && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {!deleted && (
                    <>
                      <details>
                        <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-800">
                          Retag
                        </summary>
                        <div className="mt-2">
                          <TagForm
                            txnId={txn.id}
                            isOutflow={Number(txn.debit) > 0}
                            heads={heads}
                            costCentres={costCentres}
                            action={retagPosted}
                            submitLabel="Save (posts reversal + new version)"
                            defaults={{ headAccountId: txn.headAccountId, nature: txn.nature, costCentreId: txn.costCentreId }}
                          />
                        </div>
                      </details>
                      <form action={deletePosted}>
                        <input type="hidden" name="txnId" value={txn.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </form>
                    </>
                  )}
                  {(deleted || (doc?._count.entries ?? 0) > 1) && (
                    <form action={undoPosted}>
                      <input type="hidden" name="txnId" value={txn.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                      >
                        {deleted ? 'Undo delete' : 'Undo last change'}
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {posted.length === 0 && (
          <p className="text-sm text-zinc-400">
            {filtered ? 'No posted entries match these filters.' : 'Nothing posted yet for these books.'}
          </p>
        )}
      </div>
      )}
    </div>
  )
}
