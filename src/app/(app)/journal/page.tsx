import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { createEntry, editEntry, deleteEntry, undoEntry } from './actions'
import { PageHeader, buttonClass, controlClass } from '@/components/ui'

// Journal — the record-level view of the ledger (spec §5): one clean row per
// document, full history underneath, edit/delete/undo everywhere, and the
// "Recently deleted" bin.

export default async function JournalPage() {
  const user = await requireAdmin()
  const entity = await getCurrentEntity(user)
  if (!entity) {
    return (
      <p className="text-sm text-ink-2">
        Create an entity first (Admin → Entities), then post entries to its books.
      </p>
    )
  }

  const [docs, deletedDocs, accounts] = await Promise.all([
    prisma.journalDoc.findMany({
      where: { entityId: entity.id, deletedAt: null },
      include: {
        currentEntry: { include: { lines: { include: { account: true } } } },
        entries: { orderBy: { createdAt: 'asc' }, include: { lines: { include: { account: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.journalDoc.findMany({
      where: { entityId: entity.id, deletedAt: { not: null } },
      include: { entries: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { deletedAt: 'desc' },
      take: 20,
    }),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null },
      orderBy: { code: 'asc' },
    }),
  ])

  const lineTemplate = (
    <div className="grid grid-cols-[1fr_8rem_8rem_10rem] gap-2">
      <select name="accountId" className={controlClass}>
        <option value="">— account —</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} · {a.name}
          </option>
        ))}
      </select>
      <input name="debit" inputMode="decimal" placeholder="Debit ₹" className={controlClass} />
      <input name="credit" inputMode="decimal" placeholder="Credit ₹" className={controlClass} />
      <input name="memo" placeholder="Memo" className={controlClass} />
    </div>
  )

  return (
    <div className="space-y-8">
      <PageHeader
        kicker="Register"
        title={`Journal — ${entity.name} (${entity.code})`}
        subtitle="Every edit and delete posts a reversal underneath; the ledger is append-only and always balanced. History shows the full chain."
      />

      {/* Entries */}
      <div className="space-y-3">
        {docs.map((doc) => {
          const entry = doc.currentEntry
          if (!entry) return null
          const total = entry.lines.reduce((sum, l) => sum + Number(l.debit), 0)
          const wasEdited = doc.entries.some((e) => e.kind === 'REVERSAL')
          return (
            <div key={doc.id} className="rounded-2xl border border-line bg-surface p-4 shadow-card">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-ink-3">
                  {entry.date.toISOString().slice(0, 10)}
                </span>
                <span className="font-medium text-ink">{entry.narration}</span>
                {entry.reference && (
                  <span className="text-xs text-ink-3">ref {entry.reference}</span>
                )}
                {wasEdited && (
                  <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">
                    edited
                  </span>
                )}
                <span className="ml-auto text-sm font-semibold text-ink">
                  {displayINR(total)}
                </span>
              </div>
              <table className="mt-2 w-full text-sm">
                <tbody className="divide-y divide-line-2">
                  {entry.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="py-1 text-ink-2">
                        {l.account.code} · {l.account.name}
                        {l.memo && <span className="ml-2 text-xs text-ink-3">{l.memo}</span>}
                      </td>
                      <td className="w-28 py-1 text-right text-ink-2">
                        {Number(l.debit) > 0 ? displayINR(String(l.debit)) : ''}
                      </td>
                      <td className="w-28 py-1 text-right text-ink-2">
                        {Number(l.credit) > 0 ? displayINR(String(l.credit)) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {/* Edit (prefilled) */}
                <details className="w-full">
                  <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">
                    Edit
                  </summary>
                  <form action={editEntry} className="mt-2 space-y-2 rounded-lg bg-surface-2/60 p-3">
                    <input type="hidden" name="docId" value={doc.id} />
                    <div className="flex gap-2">
                      <input
                        name="date"
                        type="date"
                        defaultValue={entry.date.toISOString().slice(0, 10)}
                        required
                        className={controlClass}
                      />
                      <input
                        name="narration"
                        defaultValue={entry.narration}
                        required
                        className={`${controlClass} flex-1`}
                      />
                      <input
                        name="reference"
                        defaultValue={entry.reference ?? ''}
                        placeholder="Reference"
                        className={`${controlClass} w-32`}
                      />
                    </div>
                    {entry.lines.map((l) => (
                      <div key={l.id} className="grid grid-cols-[1fr_8rem_8rem_10rem] gap-2">
                        <select
                          name="accountId"
                          defaultValue={l.accountId}
                          className={controlClass}
                        >
                          <option value="">— account —</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} · {a.name}
                            </option>
                          ))}
                        </select>
                        <input
                          name="debit"
                          defaultValue={Number(l.debit) > 0 ? String(l.debit) : ''}
                          placeholder="Debit ₹"
                          className={controlClass}
                        />
                        <input
                          name="credit"
                          defaultValue={Number(l.credit) > 0 ? String(l.credit) : ''}
                          placeholder="Credit ₹"
                          className={controlClass}
                        />
                        <input
                          name="memo"
                          defaultValue={l.memo ?? ''}
                          placeholder="Memo"
                          className={controlClass}
                        />
                      </div>
                    ))}
                    {lineTemplate}
                    {lineTemplate}
                    <button
                      type="submit"
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-strong"
                    >
                      Save edit (posts reversal + new version)
                    </button>
                  </form>
                </details>
                <form action={deleteEntry}>
                  <input type="hidden" name="docId" value={doc.id} />
                  <button
                    type="submit"
                    className="rounded-lg border border-danger/30 px-2 py-1 text-xs text-danger hover:bg-danger-soft"
                  >
                    Delete
                  </button>
                </form>
                {doc.entries.length > 1 && (
                  <form action={undoEntry}>
                    <input type="hidden" name="docId" value={doc.id} />
                    <button
                      type="submit"
                      className="rounded-lg border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-2"
                    >
                      Undo last change
                    </button>
                  </form>
                )}
                {/* History */}
                {doc.entries.length > 1 && (
                  <details className="w-full">
                    <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">
                      History ({doc.entries.length} postings)
                    </summary>
                    <div className="mt-2 space-y-1 rounded-lg bg-surface-2/60 p-3 text-xs text-ink-2">
                      {doc.entries.map((e) => (
                        <div key={e.id} className="flex gap-2">
                          <span className="w-36 text-ink-3">
                            {e.createdAt.toISOString().replace('T', ' ').slice(0, 16)}
                          </span>
                          <span className="w-20 font-mono">{e.kind === 'REVERSAL' ? 'reversal' : `v${e.version}`}</span>
                          <span className="w-24">{e.action}</span>
                          <span>{e.narration}</span>
                          <span className="ml-auto">
                            {displayINR(e.lines.reduce((s, l) => s + Number(l.debit), 0))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </div>
          )
        })}
        {docs.length === 0 && (
          <p className="text-sm text-ink-3">No journal entries yet for these books.</p>
        )}
      </div>

      {/* Recently deleted bin (spec §5) */}
      {deletedDocs.length > 0 && (
        <div className="rounded-2xl border border-danger/30 bg-danger-soft p-4">
          <h2 className="font-medium text-ink">Recently deleted</h2>
          <div className="mt-2 space-y-2">
            {deletedDocs.map((doc) => (
              <div key={doc.id} className="flex items-center gap-3 text-sm text-ink-2">
                <span className="text-xs text-ink-3">
                  {doc.deletedAt?.toISOString().slice(0, 10)}
                </span>
                <span>{doc.entries[0]?.narration.replace(/^Reversal \(delete\): /, '')}</span>
                <form action={undoEntry}>
                  <input type="hidden" name="docId" value={doc.id} />
                  <button
                    type="submit"
                    className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-surface-2"
                  >
                    Undo delete
                  </button>
                </form>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* New entry */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
        <h2 className="font-medium text-ink">New journal entry</h2>
        <form action={createEntry} className="mt-3 space-y-2">
          <input type="hidden" name="entityId" value={entity.id} />
          <div className="flex gap-2">
            <input name="date" type="date" required className={controlClass} />
            <input name="narration" placeholder="Narration" required className={`${controlClass} flex-1`} />
            <input name="reference" placeholder="Reference (optional)" className={`${controlClass} w-40`} />
          </div>
          {lineTemplate}
          {lineTemplate}
          {lineTemplate}
          {lineTemplate}
          <p className="text-xs text-ink-3">
            Fill any number of rows — each row needs an account and an amount on
            exactly one side. Total debits must equal total credits.
          </p>
          <button
            type="submit"
            className={buttonClass('primary')}
          >
            Post entry
          </button>
        </form>
      </div>
    </div>
  )
}
