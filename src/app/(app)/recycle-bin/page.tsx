import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { displayINR } from '@/lib/ledger/money'
import { ConfirmButton } from '@/components/confirm-button'
import {
  restoreDocAction,
  purgeBinnedCashAction,
  restorePlanLineAction,
  restoreTaskColumnAction,
} from './actions'

// 🗑 The one recycle bin. Delete anything anywhere — a cash entry, a tagged
// posting, a plan line, a finance-task column — and it waits here, out of
// every register, until it is restored or removed for good. The ledger
// underneath stays append-only: deletes were reversals, restores un-reverse.

const SOURCE_LABEL: Record<string, string> = {
  cash_entry: 'Cash entry',
  statement_txn: 'Tagged statement row',
  invoice: 'Invoice posting',
  manual: 'Journal entry',
  opening_balance: 'Opening balance',
  salary_run: 'Salary posting',
  reimbursement: 'Reimbursement',
}

export default async function RecycleBinPage() {
  await requireAdmin()

  const [docs, planLines, taskColumns, entities] = await Promise.all([
    prisma.journalDoc.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: {
        entries: {
          where: { version: 1 },
          take: 1,
          include: { lines: { select: { debit: true } } },
        },
      },
    }),
    prisma.budgetLine.findMany({ where: { archivedAt: { not: null } }, orderBy: { updatedAt: 'desc' } }),
    prisma.financeTask.findMany({ where: { archivedAt: { not: null } }, orderBy: { updatedAt: 'desc' } }),
    prisma.entity.findMany({ select: { id: true, code: true } }),
  ])
  const code = new Map(entities.map((e) => [e.id, e.code]))
  const cashRows = await prisma.cashEntry.findMany({
    where: { docId: { in: docs.map((d) => d.id) } },
    select: { docId: true, remarks: true },
  })
  const cashEntryDocs = new Set(cashRows.map((c) => c.docId as string))
  // a cash entry shows the "Details" its owner typed, not the posting narration
  const cashRemarks = new Map(cashRows.map((c) => [c.docId as string, c.remarks]))

  const total = docs.length + planLines.length + taskColumns.length

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">🗑 Recycle bin</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Everything deleted anywhere waits here — restore it, or remove it for good. Balances already reversed when the
          delete happened; the ledger keeps every original and reversal.
        </p>
      </div>

      {total === 0 && (
        <p className="rounded-xl border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-400 shadow-sm">
          The bin is empty — nothing deleted anywhere.
        </p>
      )}

      {docs.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
                <th className="px-3 py-2">Deleted postings ({docs.length})</th>
                <th className="px-2 py-2">Books</th>
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">What</th>
                <th className="px-2 py-2 text-right">₹</th>
                <th className="px-2 py-2">Deleted on</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {docs.map((d) => {
                const first = d.entries[0]
                const amount = first ? first.lines.reduce((t, l) => t + Number(l.debit), 0) : 0
                return (
                  <tr key={d.id} className="text-xs hover:bg-zinc-50/60">
                    <td className="max-w-[20rem] truncate px-3 py-1.5 font-medium text-zinc-700" title={first?.narration}>
                      {cashRemarks.get(d.id) || first?.narration || '(no narration)'}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="rounded bg-zinc-100 px-1.5 text-[10px] font-medium text-zinc-500">
                        {code.get(d.entityId)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-zinc-500">
                      {first?.date.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-2 py-1.5 text-zinc-500">{SOURCE_LABEL[d.sourceType] ?? d.sourceType}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-zinc-700">
                      {displayINR(amount.toFixed(2))}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-zinc-400">
                      {d.deletedAt?.toISOString().slice(0, 10)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                      <form action={restoreDocAction} className="inline">
                        <input type="hidden" name="docId" value={d.id} />
                        <button type="submit" className="rounded border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100">
                          Restore
                        </button>
                      </form>
                      {cashEntryDocs.has(d.id) && (
                        <form action={purgeBinnedCashAction} className="ml-1 inline">
                          <input type="hidden" name="docId" value={d.id} />
                          <ConfirmButton
                            message={`Remove "${first?.narration ?? 'this entry'}" forever? The ledger's reversal stays; this cannot be undone.`}
                            className="rounded border border-red-200 px-2 py-0.5 text-[11px] text-red-500 hover:bg-red-50"
                          >
                            Remove forever
                          </ConfirmButton>
                        </form>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {planLines.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
                <th className="px-3 py-2">Removed plan lines ({planLines.length})</th>
                <th className="px-2 py-2">Pool</th>
                <th className="px-2 py-2">Frequency</th>
                <th className="px-2 py-2 text-right">₹</th>
                <th className="px-2 py-2">Removed on</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {planLines.map((l) => (
                <tr key={l.id} className="text-xs hover:bg-zinc-50/60">
                  <td className="px-3 py-1.5 font-medium text-zinc-700">{l.label}</td>
                  <td className="px-2 py-1.5 text-zinc-500">{l.source}</td>
                  <td className="px-2 py-1.5 text-zinc-500">{l.frequency.toLowerCase()}{l.onMonth ? ` (${l.onMonth})` : ''}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-zinc-700">
                    {displayINR(String(l.amount))}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-zinc-400">
                    {l.archivedAt?.toISOString().slice(0, 10)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <form action={restorePlanLineAction} className="inline">
                      <input type="hidden" name="id" value={l.id} />
                      <button type="submit" className="rounded border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100">
                        Restore
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {taskColumns.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
                <th className="px-3 py-2">Removed finance-task columns ({taskColumns.length})</th>
                <th className="px-2 py-2">Paid from</th>
                <th className="px-2 py-2">Due day</th>
                <th className="px-2 py-2">Removed on</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {taskColumns.map((t) => (
                <tr key={t.id} className="text-xs hover:bg-zinc-50/60">
                  <td className="px-3 py-1.5 font-medium text-zinc-700">{t.name}</td>
                  <td className="px-2 py-1.5 text-zinc-500">{t.account ?? '—'}</td>
                  <td className="px-2 py-1.5 text-zinc-500">{t.dueDay ?? '—'}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-zinc-400">
                    {t.archivedAt?.toISOString().slice(0, 10)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <form action={restoreTaskColumnAction} className="inline">
                      <input type="hidden" name="id" value={t.id} />
                      <button type="submit" className="rounded border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100">
                        Restore
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
