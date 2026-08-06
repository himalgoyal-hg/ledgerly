import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { gstr1Summary, gstr3bView, tdsRegister, monthRange } from '@/lib/tax/register'
import { fileAndLockPeriod, payGstAction, depositTdsAction } from './actions'

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

  const [gstr1, gstr3b, tds, lock, banks, openTdsTasks] = await Promise.all([
    gstr1Summary(entity.id, range),
    gstr3bView(entity.id, range),
    tdsRegister(entity.id, range),
    prisma.periodLock.findUnique({
      where: { entityId_year_month: { entityId: entity.id, year, month } },
    }),
    prisma.bankAccount.findMany({
      where: { entityId: entity.id, archivedAt: null, ledgerAccountId: { not: null } },
    }),
    prisma.financeTask.findMany({
      where: { entityId: entity.id, kind: 'tds', status: 'OPEN' },
      orderBy: { dueDate: 'asc' },
    }),
  ])
  const tdsTotal = tds.reduce((sum, s) => sum + Number(s.total), 0)

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
                <select name="sourceAccountId" required className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
                  <option value="">— pay from —</option>
                  {banks.map((b) => (
                    <option key={b.id} value={b.ledgerAccountId!}>{b.nickname}</option>
                  ))}
                </select>
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

        {/* Deposit reminders (spec §7.2) */}
        {openTdsTasks.length > 0 && (
          <div className="mt-4 space-y-2 rounded-lg bg-amber-50 p-3">
            <h3 className="text-xs font-medium uppercase text-amber-700">Deposit due</h3>
            {openTdsTasks.map((task) => (
              <div key={task.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-zinc-700">{task.title}</span>
                <span className="text-xs text-zinc-500">due {task.dueDate.toISOString().slice(0, 10)}</span>
                <span className="font-medium text-zinc-900">{displayINR(String(task.amount ?? 0))}</span>
                {admin && (
                  <form action={depositTdsAction} className="ml-auto flex flex-wrap items-center gap-2">
                    <input type="hidden" name="entityId" value={entity.id} />
                    <input type="hidden" name="taskId" value={task.id} />
                    <input type="hidden" name="amount" value={String(task.amount ?? 0)} />
                    <input name="date" type="date" required className="rounded-md border border-zinc-300 px-2 py-1 text-xs" />
                    <select name="sourceAccountId" required className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs">
                      <option value="">— pay from —</option>
                      {banks.map((b) => (
                        <option key={b.id} value={b.ledgerAccountId!}>{b.nickname}</option>
                      ))}
                    </select>
                    <button type="submit" className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-700">
                      Deposit
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
