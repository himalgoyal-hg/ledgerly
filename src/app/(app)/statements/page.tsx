import { prisma } from '@/lib/db'
import { requirePermission, isAdmin, visibleEntityFilter } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { importBalanceCheck } from '@/lib/statements/import'
import { aiConfigured } from '@/lib/ai/client'
import { uploadStatements, confirmImport, discardImport } from './actions'

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

  const visibleEntityIds = (
    await prisma.entity.findMany({
      where: { archivedAt: null, ...visibleEntityFilter(user) },
      select: { id: true },
    })
  ).map((e) => e.id)

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
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Statements</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Drop bank statements in any format — rows are extracted, deduplicated,
          auto-tagged where a rule matches, and queued for tagging otherwise.
        </p>
      </div>

      {/* Step 1 — upload */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">Upload statements</h2>
        <form action={uploadStatements} className="mt-3 flex flex-wrap items-center gap-3">
          <input
            type="file"
            name="files"
            multiple
            required
            accept=".csv,.tsv,.txt,.xlsx,.xls,.pdf"
            className="text-sm text-zinc-600 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-700"
          />
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Upload
          </button>
          <span className="text-xs text-zinc-400">
            CSV · XLSX · XLS · TSV · TXT · PDF — multiple files allowed.
            {aiReady
              ? ' PDFs (including scans) are read by AI, then confirmed by you like any other import.'
              : ' PDFs need ANTHROPIC_API_KEY in .env; without it, export CSV from netbanking.'}
          </span>
        </form>
      </div>

      {/* Step 2 — confirmation banners (never silent) */}
      {pending.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-medium text-zinc-900">Awaiting confirmation</h2>
          {pending.map((imp) => {
            const unrecognized = imp.detectedVia === 'unrecognized'
            return (
              <div
                key={imp.id}
                className={`rounded-xl border p-4 shadow-sm ${
                  unrecognized ? 'border-amber-200 bg-amber-50/60' : 'border-sky-200 bg-sky-50/60'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-zinc-900">{imp.fileName}</span>
                  <span className="text-xs text-zinc-500">
                    {imp.rowsTotal} rows
                    {imp.closingBalance !== null &&
                      ` · closing balance ${displayINR(String(imp.closingBalance))}`}
                  </span>
                </div>
                <p className="mt-1 text-sm text-zinc-700">
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
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                      >
                        <option value="">— account —</option>
                        {bankAccounts.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.nickname} ({b.entity.code})
                          </option>
                        ))}
                      </select>
                      <button
                        type="submit"
                        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
                      >
                        {unrecognized ? 'Map & import' : '✓ Confirm & import'}
                      </button>
                    </form>
                  )}
                  <form action={discardImport}>
                    <input type="hidden" name="importId" value={imp.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
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
        <h2 className="font-medium text-zinc-900">
          Imports{entity ? ` — ${entity.name} (${entity.code})` : ''}
        </h2>
        {confirmed.map((imp) => {
          const balance = balanceChecks.get(imp.id) ?? null
          const posted = countFor(imp.id, 'POSTED')
          const tagged = countFor(imp.id, 'TAGGED')
          const pendingCount = countFor(imp.id, 'PENDING')
          return (
            <div key={imp.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium text-zinc-900">{imp.fileName}</span>
                <span className="text-zinc-500">{imp.bankAccount?.nickname}</span>
                <span className="text-xs text-zinc-400">
                  {imp.createdAt.toISOString().slice(0, 10)} · via{' '}
                  {VIA_LABEL[imp.detectedVia] ?? imp.detectedVia}
                </span>
                {imp.parsedVia === 'ai' && (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                    read by AI
                  </span>
                )}
                {balance &&
                  (balance.matched ? (
                    <span className="ml-auto rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                      closing balance matches ledger
                    </span>
                  ) : (
                    <span className="ml-auto rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      held open — off by {displayINR(balance.difference)}
                    </span>
                  ))}
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {imp.rowsTotal} rows · {imp.rowsDuplicate} previously imported ·{' '}
                {pendingCount} pending tagging · {tagged} tagged · {posted} posted
                {balance && !balance.matched && (
                  <>
                    {' '}· statement {displayINR(balance.expected)} vs ledger{' '}
                    {displayINR(balance.actual)} — resolves as rows are tagged and posted
                  </>
                )}
              </p>
            </div>
          )
        })}
        {confirmed.length === 0 && (
          <p className="text-sm text-zinc-400">No imports yet for these books.</p>
        )}
      </div>
    </div>
  )
}
