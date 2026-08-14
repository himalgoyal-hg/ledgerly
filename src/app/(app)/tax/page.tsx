import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { gstr1Summary, gstr3bView, tdsRegister, monthRange } from '@/lib/tax/register'
import { suggestPaymentSource, rankForAmount } from '@/lib/automation/suggest'
import { SourceSelect } from '../source-select'
import { fileAndLockPeriod, payGstAction } from './actions'

// GST & TDS registers (spec §7): GSTR-1 outward summary, GSTR-3B with the
// ITC tracker → net payable/refundable, and the TDS register by section and
// deductee. Filing a period locks that month (§7.1).

export default async function TaxPage(props: {
  searchParams: Promise<{ period?: string }>
}) {
  const user = await requireUser()
  const admin = isAdmin(user)
  if (!admin && !hasPermission(user, 'viewTaxRegisters')) {
    throw new Error('Forbidden: missing permission "viewTaxRegisters"')
  }
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const { period: periodParam } = await props.searchParams
  const now = new Date()
  const period = /^\d{4}-\d{2}$/.test(periodParam ?? '')
    ? periodParam!
    : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const [year, month] = period.split('-').map(Number)
  const range = monthRange(year, month)

  const [gstr1, gstr3b, tds, lock, gstSuggestion, entryMonths] = await Promise.all([
    gstr1Summary(entity.id, range),
    gstr3bView(entity.id, range),
    tdsRegister(entity.id, range),
    prisma.periodLock.findUnique({
      where: { entityId_year_month: { entityId: entity.id, year, month } },
    }),
    suggestPaymentSource({ entityId: entity.id, module: 'gst', taskKind: 'gst' }),
    // Which months actually hold register entries — so an empty period never
    // looks like a missing entry (it's usually just the wrong month).
    prisma.$queryRaw<{ m: string; n: number }[]>`
      SELECT to_char(date, 'YYYY-MM') AS m, COUNT(*)::int AS n
      FROM "TaxLine" WHERE "entityId" = ${entity.id}
      GROUP BY 1 ORDER BY 1 DESC
    `,
  ])
  const tdsTotal = tds.reduce((sum, s) => sum + Number(s.total), 0)

  // Every register entry of the period, transaction by transaction — with
  // the underlying narration so "which payment was this" needs no digging.
  const entries = await prisma.taxLine.findMany({
    where: { entityId: entity.id, date: { gte: range.from, lte: range.to } },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  })
  const stmtIds = entries.filter((e) => e.sourceType === 'statement_txn').map((e) => e.sourceId)
  const stmtNarrations = stmtIds.length
    ? new Map(
        (
          await prisma.statementTransaction.findMany({
            where: { id: { in: stmtIds } },
            select: { id: true, narration: true },
          })
        ).map((s) => [s.id, s.narration]),
      )
    : new Map<string, string>()
  const entryTotals = entries.reduce(
    (t, e) => ({
      taxable: t.taxable + Number(e.taxableValue),
      gst: t.gst + Number(e.gstAmount),
      tds: t.tds + Number(e.tdsAmount),
    }),
    { taxable: 0, gst: 0, tds: 0 },
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">
            GST & TDS — {entity.name} ({entity.code})
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Live over the ledger and tax register. Filing a period locks that
            month, making its returns immutable.
          </p>
        </div>
        <form className="ml-auto flex items-center gap-2">
          <input
            name="period"
            type="month"
            defaultValue={period}
            className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
          />
          <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">
            Show
          </button>
        </form>
        {lock && (
          <span className="rounded bg-zinc-900 px-2 py-1 text-[10px] font-medium uppercase text-white">
            filed & locked
          </span>
        )}
      </div>

      {/* Where the entries live — one click to the right month */}
      {entryMonths.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-xs">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Entries in
          </span>
          {entryMonths.map((row) => (
            <a
              key={row.m}
              href={`/tax?period=${row.m}`}
              className={`rounded px-1.5 py-0.5 font-medium ${
                row.m === period
                  ? 'bg-zinc-900 text-white'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
              }`}
            >
              {row.m} ({row.n})
            </a>
          ))}
          {!entryMonths.some((r) => r.m === period) && (
            <span className="text-zinc-400">— {period} has none; pick a month above</span>
          )}
        </div>
      )}

      {/* GSTR-3B with ITC tracker (spec §7.1) */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">GSTR-3B — {period}</h2>
        <div className="mt-3 flex flex-wrap gap-6">
          <div>
            <div className="text-xs text-zinc-500">Output liability</div>
            <div className="text-lg font-semibold text-zinc-900">{displayINR(gstr3b.outputLiability)}</div>
          </div>
          <div>
            <div className="text-xs text-zinc-500">Input tax credit</div>
            <div className="text-lg font-semibold text-emerald-700">− {displayINR(gstr3b.inputCredit)}</div>
          </div>
          <div className="border-l border-zinc-200 pl-6">
            <div className="text-xs text-zinc-500">
              {Number(gstr3b.refundable) > 0 ? 'Net refundable' : 'Net payable'}
            </div>
            <div className="text-lg font-semibold text-zinc-900">
              {displayINR(Number(gstr3b.refundable) > 0 ? gstr3b.refundable : gstr3b.netPayable)}
            </div>
          </div>
        </div>
        {admin && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {Number(gstr3b.netPayable) > 0 && (
              <form action={payGstAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="entityId" value={entity.id} />
                <input type="hidden" name="year" value={year} />
                <input type="hidden" name="month" value={month} />
                <input name="date" type="date" required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                <SourceSelect
                  suggestion={rankForAmount(gstSuggestion.options, gstr3b.netPayable)}
                  compact
                />
                <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700">
                  Pay net GST
                </button>
              </form>
            )}
            {!lock && (
              <form action={fileAndLockPeriod}>
                <input type="hidden" name="entityId" value={entity.id} />
                <input type="hidden" name="year" value={year} />
                <input type="hidden" name="month" value={month} />
                <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100">
                  Mark filed & lock {period}
                </button>
              </form>
            )}
          </div>
        )}
      </div>

      {/* GSTR-1 outward summary */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">GSTR-1 — outward supplies</h2>
        {gstr1.byRate.length > 0 ? (
          <>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-400">
                  <th className="pb-1 font-medium">Rate</th>
                  <th className="pb-1 text-right font-medium">Taxable value</th>
                  <th className="pb-1 text-right font-medium">GST</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {gstr1.byRate.map((r) => (
                  <tr key={r.rate}>
                    <td className="py-1 text-zinc-700">{r.rate}%</td>
                    <td className="py-1 text-right text-zinc-700">{displayINR(r.taxable)}</td>
                    <td className="py-1 text-right font-medium text-zinc-900">{displayINR(r.gst)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-800">
                Invoice-wise ({gstr1.rows.length})
              </summary>
              <table className="mt-2 w-full text-xs">
                <tbody className="divide-y divide-zinc-50">
                  {gstr1.rows.map((row) => (
                    <tr key={row.id}>
                      <td className="py-1 text-zinc-400">{row.date.toISOString().slice(0, 10)}</td>
                      <td className="py-1 text-zinc-700">{row.party}</td>
                      <td className="py-1 text-zinc-400">{row.counterpartyGstin ?? '—'}</td>
                      <td className="py-1 text-zinc-400">{row.hsn ?? '—'}</td>
                      <td className="py-1 text-zinc-400">{row.gstType}</td>
                      <td className="py-1 text-right text-zinc-600">{displayINR(String(row.taxableValue))}</td>
                      <td className="py-1 text-right text-zinc-800">{displayINR(String(row.gstAmount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        ) : (
          <p className="mt-2 text-sm text-zinc-400">No outward supplies with GST in {period}.</p>
        )}
      </div>

      {/* TDS register by section → deductee (spec §7.2) */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-medium text-zinc-900">TDS register</h2>
          {tdsTotal > 0 && (
            <span className="text-sm text-zinc-500">deducted {displayINR(tdsTotal)}</span>
          )}
        </div>
        {tds.length > 0 ? (
          <div className="mt-3 space-y-3">
            {tds.map((section) => (
              <div key={section.section}>
                <div className="flex items-center gap-2 text-sm">
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600">
                    u/s {section.section}
                  </span>
                  <span className="ml-auto font-medium text-zinc-800">{displayINR(section.total)}</span>
                </div>
                <table className="mt-1 w-full text-xs">
                  <tbody className="divide-y divide-zinc-50">
                    {section.deductees.map((d) => (
                      <tr key={d.name}>
                        <td className="py-1 text-zinc-700">{d.name}</td>
                        <td className="py-1 text-zinc-400">{d.pan ?? 'PAN —'}</td>
                        <td className="py-1 text-right text-zinc-500">on {displayINR(d.taxable)}</td>
                        <td className="py-1 text-right text-zinc-800">{displayINR(d.tds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-zinc-400">No TDS deducted in {period}.</p>
        )}

      </div>

      {/* Full transaction detail — every register entry of the period */}
      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 px-4 py-2">
          <h2 className="font-medium text-zinc-900">All entries — {period}</h2>
          <p className="text-xs text-zinc-400">
            transaction by transaction: what was taxed, at which rate, how much GST and TDS
          </p>
        </div>
        {entries.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[64rem] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-[10px] uppercase tracking-wider text-zinc-400">
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Party</th>
                  <th className="px-3 py-2">Transaction</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2 text-right">Taxable ₹</th>
                  <th className="px-3 py-2 text-right">GST</th>
                  <th className="px-3 py-2 text-right">GST ₹</th>
                  <th className="px-3 py-2">HSN</th>
                  <th className="px-3 py-2 text-right">TDS</th>
                  <th className="px-3 py-2 text-right">TDS ₹</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {entries.map((e) => (
                  <tr key={e.id} className="align-top hover:bg-zinc-50/60">
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums text-zinc-500">
                      {e.date.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-3 py-1.5 font-medium text-zinc-800">{e.party ?? '—'}</td>
                    <td className="max-w-56 px-3 py-1.5">
                      <span
                        className="block truncate text-xs text-zinc-500"
                        title={stmtNarrations.get(e.sourceId) ?? e.sourceType}
                      >
                        {stmtNarrations.get(e.sourceId) ?? e.sourceType.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          e.direction === 'output'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-sky-100 text-sky-700'
                        }`}
                      >
                        {e.direction === 'output' ? 'sale / income' : 'purchase / expense'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-zinc-900">
                      {displayINR(String(e.taxableValue))}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs text-zinc-500">
                      {e.gstRate ? `${Number(e.gstRate)}% ${e.gstType ?? ''}` : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-zinc-900">
                      {Number(e.gstAmount) > 0 ? displayINR(String(e.gstAmount)) : <span className="text-zinc-300">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-zinc-500">{e.hsn ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs text-zinc-500">
                      {e.tdsRate ? `${Number(e.tdsRate)}% u/s ${e.tdsSection}` : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-zinc-900">
                      {Number(e.tdsAmount) > 0 ? displayINR(String(e.tdsAmount)) : <span className="text-zinc-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-zinc-300 font-medium text-zinc-900">
                <tr>
                  <td className="px-3 py-2" colSpan={4}>Total ({entries.length} entries)</td>
                  <td className="px-3 py-2 text-right tabular-nums">{displayINR(entryTotals.taxable.toFixed(2))}</td>
                  <td />
                  <td className="px-3 py-2 text-right tabular-nums">{displayINR(entryTotals.gst.toFixed(2))}</td>
                  <td />
                  <td />
                  <td className="px-3 py-2 text-right tabular-nums">{displayINR(entryTotals.tds.toFixed(2))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="px-4 py-3 text-sm text-zinc-400">No tax entries in {period}.</p>
        )}
      </div>
    </div>
  )
}
