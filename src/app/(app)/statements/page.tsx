import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requirePermission, isAdmin, visibleEntityFilter } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { importBalanceCheck } from '@/lib/statements/import'
import { aiConfigured } from '@/lib/ai/client'
import { uploadStatements, confirmImport, discardImport, deleteImport } from './actions'
import { ConfirmButton } from '@/components/confirm-button'
import { PageHeader, buttonClass, controlClass } from '@/components/ui'

// Statements — upload → detect → confirm → import (spec §3 steps 1–3).
// The detection banner is never silent; unrecognized layouts wait for Admin.

const VIA_LABEL: Record<string, string> = {
  account_number: 'account number',
  ifsc: 'IFSC',
  mapping: 'remembered mapping',
  manual: 'manual assignment',
  unrecognized: 'unrecognized',
}

export default async function StatementsPage() {
  const user = await requirePermission('statementUpload')
  const entity = await getCurrentEntity(user)

  const visibleEntities = await prisma.entity.findMany({
    where: { archivedAt: null, ...visibleEntityFilter(user) },
    select: { id: true, code: true },
  })
  const visibleEntityIds = visibleEntities.map((e) => e.id)
  const entityCode = new Map(visibleEntities.map((e) => [e.id, e.code]))

  const [pending, confirmed, bankAccounts] = await Promise.all([
    // Awaiting confirmation: this user's visible entities + unassigned uploads.
    prisma.statementImport.findMany({
      where: {
        status: 'DETECTED',
        OR: [{ entityId: { in: visibleEntityIds } }, { entityId: null }],
      },
      include: { bankAccount: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.statementImport.findMany({
      where: { status: 'CONFIRMED', ...(entity ? { entityId: entity.id } : {}) },
      include: { bankAccount: true },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
    prisma.bankAccount.findMany({
      where: { archivedAt: null, entity: { archivedAt: null, ...visibleEntityFilter(user) } },
      include: { entity: true },
      orderBy: { nickname: 'asc' },
    }),
  ])

  const txnCounts = await prisma.statementTransaction.groupBy({
    by: ['importId', 'status'],
    where: { importId: { in: confirmed.map((i) => i.id) } },
    _count: true,
  })
  const countFor = (importId: string, status: string) =>
    txnCounts.find((c) => c.importId === importId && c.status === status)?._count ?? 0
  const aiReady = aiConfigured()

  const balanceChecks = new Map(
    await Promise.all(
      confirmed.map(async (imp) => [imp.id, await importBalanceCheck(imp)] as const),
    ),
  )

  return (
    <div className="space-y-8">
      <PageHeader
        kicker="Books"
        title="Statements"
        subtitle="Drop bank statements in any format — rows are extracted, deduplicated, auto-tagged where a rule matches, and queued for tagging otherwise."
      />

      {/* Step 1 — upload. Statements land in the current books only — if the
          books have no bank account yet there is nothing to import into, so
          say that up front instead of failing on submit. */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
        <h2 className="font-medium text-ink">Upload statements</h2>
        {entity && (
          <p className="mt-1 text-xs text-ink-2">
            Importing into <strong>{entity.name} ({entity.code})</strong> — switch books first if
            these aren&apos;t the right ones.
          </p>
        )}
        {entity && !bankAccounts.some((b) => b.entityId === entity.id) ? (
          <p className="mt-3 rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-warning">
            {entity.name} ({entity.code}) has no bank account yet, so statements cannot be
            imported into these books.{' '}
            {isAdmin(user) ? (
              <>
                Add the account in{' '}
                <Link href="/admin/banking" className="font-medium underline">
                  Admin → Banking
                </Link>{' '}
                first, then upload here.
              </>
            ) : (
              'Ask the Admin to add the bank account first.'
            )}
          </p>
        ) : (
        <form action={uploadStatements} className="mt-3 flex flex-wrap items-center gap-3">
          <input
            type="file"
            name="files"
            multiple
            required
            accept=".csv,.tsv,.txt,.xlsx,.xls,.pdf"
            className="text-sm text-ink-2 file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-primary-strong"
          />
          <button
            type="submit"
            className={buttonClass('primary')}
          >
            Upload
          </button>
          <span className="text-xs text-ink-3">
            CSV · XLSX · XLS · TSV · TXT · PDF — multiple files allowed.
            {aiReady
              ? ' PDFs (including scans) are read by AI, then confirmed by you like any other import.'
              : ' PDFs need ANTHROPIC_API_KEY in .env; without it, export CSV from netbanking.'}
          </span>
        </form>
        )}
      </div>

      {/* Step 2 — confirmation banners (never silent) */}
      {pending.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-medium text-ink">Awaiting confirmation</h2>
          {pending.map((imp) => {
            const unrecognized = imp.detectedVia === 'unrecognized'
            // Statements import into the books they were uploaded in — offer
            // only that entity's accounts (all visible ones for legacy rows).
            const eligibleAccounts = imp.entityId
              ? bankAccounts.filter((b) => b.entityId === imp.entityId)
              : bankAccounts
            return (
              <div
                key={imp.id}
                className={`rounded-2xl border p-4 shadow-card ${
                  unrecognized ? 'border-warning/30 bg-warning-soft' : 'border-primary/30 bg-primary-soft'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-ink">{imp.fileName}</span>
                  {imp.entityId && entityCode.has(imp.entityId) && (
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-2">
                      {entityCode.get(imp.entityId)} books
                    </span>
                  )}
                  <span className="text-xs text-ink-2">
                    {imp.rowsTotal} rows
                    {imp.closingBalance !== null &&
                      ` · closing balance ${displayINR(String(imp.closingBalance))}`}
                  </span>
                </div>
                <p className="mt-1 text-sm text-ink-2">
                  {unrecognized ? (
                    <>Unrecognized statement — {isAdmin(user)
                      ? 'map it to an account once; the mapping is remembered.'
                      : 'ask the Admin to map it to an account.'}</>
                  ) : (
                    <>
                      Detected: <strong>{imp.bankAccount?.nickname}</strong> via{' '}
                      {VIA_LABEL[imp.detectedVia] ?? imp.detectedVia}
                    </>
                  )}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {(!unrecognized || isAdmin(user)) && (
                    <form action={confirmImport} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="importId" value={imp.id} />
                      <select
                        name="bankAccountId"
                        defaultValue={imp.bankAccountId ?? ''}
                        required
                        className={controlClass}
                      >
                        <option value="">— account —</option>
                        {eligibleAccounts.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.nickname} ({b.entity.code})
                          </option>
                        ))}
                      </select>
                      <button
                        type="submit"
                        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-strong"
                      >
                        {unrecognized ? 'Map & import' : '✓ Confirm & import'}
                      </button>
                    </form>
                  )}
                  <form action={discardImport}>
                    <input type="hidden" name="importId" value={imp.id} />
                    <button
                      type="submit"
                      className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2"
                    >
                      Discard
                    </button>
                  </form>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Step 3 — imported, with closing-balance validation */}
      <div className="space-y-3">
        <h2 className="font-medium text-ink">
          Imports{entity ? ` — ${entity.name} (${entity.code})` : ''}
        </h2>
        {confirmed.map((imp) => {
          const balance = balanceChecks.get(imp.id) ?? null
          const posted = countFor(imp.id, 'POSTED')
          const tagged = countFor(imp.id, 'TAGGED')
          const pendingCount = countFor(imp.id, 'PENDING')
          return (
            <div key={imp.id} className="rounded-2xl border border-line bg-surface p-4 shadow-card">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium text-ink">{imp.fileName}</span>
                <span className="text-ink-2">{imp.bankAccount?.nickname}</span>
                <span className="text-xs text-ink-3">
                  {imp.createdAt.toISOString().slice(0, 10)} · via{' '}
                  {VIA_LABEL[imp.detectedVia] ?? imp.detectedVia}
                </span>
                {imp.parsedVia === 'ai' && (
                  <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    read by AI
                  </span>
                )}
                {balance &&
                  (balance.matched ? (
                    <span className="ml-auto rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-medium text-success">
                      closing balance matches ledger
                    </span>
                  ) : (
                    <span className="ml-auto rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">
                      held open — off by {displayINR(balance.difference)}
                    </span>
                  ))}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <p className="text-xs text-ink-2">
                  {imp.rowsTotal} rows · {imp.rowsDuplicate} previously imported ·{' '}
                  {pendingCount} pending tagging · {tagged} tagged · {posted} posted
                  {balance && !balance.matched && (
                    <>
                      {' '}· statement {displayINR(balance.expected)} vs ledger{' '}
                      {displayINR(balance.actual)} — resolves as rows are tagged and posted
                    </>
                  )}
                </p>
                <form action={deleteImport} className="ml-auto">
                  <input type="hidden" name="importId" value={imp.id} />
                  <ConfirmButton
                    message={
                      `Delete ${imp.fileName}? All ${imp.rowsTotal} rows are removed` +
                      (posted > 0 ? `; ${posted} posted row(s) will be reversed in the ledger` : '') +
                      '. Re-uploading the file later starts fresh.'
                    }
                    className="rounded-lg border border-danger/30 px-2 py-1 text-xs text-danger hover:bg-danger-soft"
                  >
                    Delete import
                  </ConfirmButton>
                </form>
              </div>
            </div>
          )
        })}
        {confirmed.length === 0 && (
          <p className="text-sm text-ink-3">No imports yet for these books.</p>
        )}
      </div>
    </div>
  )
}
