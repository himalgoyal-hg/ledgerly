import { prisma } from '@/lib/db'
import { requirePermission, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { NATURES } from '@/lib/statements/natures'
import { TagForm } from './tag-form'
import {
  tagTransaction,
  untagTransaction,
  postAll,
  retagPosted,
  deletePosted,
  undoPosted,
} from './actions'

// The tagging queue (spec §3 steps 4–6): pending rows get their 3-tier tag,
// tagged rows wait for "Post All Confirmed", posted rows carry a balanced
// journal underneath (with member edit/delete/undo when granted).

export default async function TaggingPage() {
  const user = await requirePermission('transactionTagging')
  const canEditPosted = hasPermission(user, 'transactionEditDelete')
  const entity = await getCurrentEntity(user)
  if (!entity) {
    return <p className="text-sm text-zinc-500">No books to work on yet.</p>
  }

  const [pending, tagged, posted, heads, costCentres, banks, users] = await Promise.all([
    prisma.statementTransaction.findMany({
      where: { entityId: entity.id, status: 'PENDING' },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    }),
    prisma.statementTransaction.findMany({
      where: { entityId: entity.id, status: 'TAGGED' },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    }),
    prisma.statementTransaction.findMany({
      where: { entityId: entity.id, status: 'POSTED' },
      orderBy: [{ taggedAt: 'desc' }, { date: 'desc' }],
      take: 50,
    }),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, kind: true },
    }),
    prisma.costCentre.findMany({
      where: { entityId: entity.id, archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.bankAccount.findMany({ select: { id: true, nickname: true } }),
    prisma.user.findMany({ select: { id: true, name: true } }),
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

  const rowHeader = (txn: (typeof pending)[number]) => {
    const outflow = Number(txn.debit) > 0
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-xs text-zinc-400">{txn.date.toISOString().slice(0, 10)}</span>
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          {bankName(txn.bankAccountId)}
        </span>
        <span className="max-w-md truncate text-zinc-800" title={txn.narration}>
          {txn.narration}
        </span>
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
        {tagged.length > 0 && (
          <form action={postAll} className="ml-auto">
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

      {/* Pending queue */}
      <div className="space-y-2">
        <h2 className="font-medium text-zinc-900">Pending ({pending.length})</h2>
        {pending.map((txn) => (
          <div key={txn.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            {rowHeader(txn)}
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
        ))}
        {pending.length === 0 && (
          <p className="text-sm text-zinc-400">Queue is clear — nothing waiting.</p>
        )}
      </div>

      {/* Tagged, awaiting post */}
      {tagged.length > 0 && (
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
                    defaults={txn}
                  />
                </div>
              </details>
            </div>
          ))}
        </div>
      )}

      {/* Posted */}
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
                            defaults={txn}
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
          <p className="text-sm text-zinc-400">Nothing posted yet for these books.</p>
        )}
      </div>
    </div>
  )
}
