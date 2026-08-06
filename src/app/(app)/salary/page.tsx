import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { suggestPaymentSource, rankForAmount } from '@/lib/automation/suggest'
import { SourceSelect } from '../source-select'
import {
  upsertPersonAction,
  createRunAction,
  updateRunLineAction,
  approveRunAction,
  payRunAction,
} from './actions'

// Salary register (spec §6.4): Salary / Consultants sub-tabs, monthly run:
// draft (HR fills variables) → approve (consolidated posting) → mark paid.

export default async function SalaryPage() {
  const admin = await requireAdmin()
  const entity = await getCurrentEntity(admin)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const [people, runs, costCentres, baseSuggestion] = await Promise.all([
    prisma.salaryPerson.findMany({
      where: { entityId: entity.id, archivedAt: null },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    }),
    prisma.salaryRun.findMany({
      where: { entityId: entity.id },
      include: { lines: true },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 6,
    }),
    prisma.costCentre.findMany({
      where: { entityId: entity.id, archivedAt: null },
      orderBy: { name: 'asc' },
    }),
    suggestPaymentSource({ entityId: entity.id, module: 'salary' }),
  ])
  const personName = (id: string) => people.find((p) => p.id === id)?.name ?? '(archived)'
  const ccName = (id: string | null) => costCentres.find((c) => c.id === id)?.name

  const personForm = (type: 'SALARY' | 'CONSULTANT') => (
    <form action={upsertPersonAction} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="entityId" value={entity.id} />
      <input type="hidden" name="type" value={type} />
      <input name="name" required placeholder="Name" className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
      <input name="team" placeholder="Team" className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
      <select name="costCentreId" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
        <option value="">— cost centre —</option>
        {costCentres.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <input name="monthlyGross" required inputMode="decimal" placeholder="Monthly gross ₹" className="w-32 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
      <input name="tdsRate" required inputMode="decimal" placeholder={type === 'SALARY' ? 'TDS % (192)' : 'TDS % (194J)'} className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
      <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700">
        Add {type === 'SALARY' ? 'employee' : 'consultant'}
      </button>
    </form>
  )

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900">
        Salary register — {entity.name} ({entity.code})
      </h1>

      {/* People: Salary / Consultants sub-tabs (spec §6.4) */}
      <div className="grid gap-4 md:grid-cols-2">
        {(['SALARY', 'CONSULTANT'] as const).map((type) => (
          <div key={type} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <h2 className="font-medium text-zinc-900">
              {type === 'SALARY' ? 'Salary (TDS u/s 192)' : 'Consultants (TDS u/s 194J)'}
            </h2>
            <div className="mt-2 space-y-1">
              {people.filter((p) => p.type === type).map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm text-zinc-700">
                  <span className="font-medium">{p.name}</span>
                  {p.team && <span className="text-xs text-zinc-400">{p.team}</span>}
                  {ccName(p.costCentreId) && <span className="text-xs text-zinc-400">{ccName(p.costCentreId)}</span>}
                  <span className="ml-auto text-xs text-zinc-500">
                    {displayINR(String(p.monthlyGross))} · TDS {String(p.tdsRate)}%
                  </span>
                </div>
              ))}
              {people.filter((p) => p.type === type).length === 0 && (
                <p className="text-sm text-zinc-400">Nobody yet.</p>
              )}
            </div>
            {personForm(type)}
          </div>
        ))}
      </div>

      {/* Monthly runs */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-medium text-zinc-900">Monthly runs</h2>
          <form action={createRunAction} className="ml-auto flex items-center gap-2">
            <input type="hidden" name="entityId" value={entity.id} />
            <input name="month" type="month" required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
            <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700">
              Draft run
            </button>
          </form>
        </div>

        <div className="mt-3 space-y-4">
          {runs.map((run) => {
            const totals = run.lines.reduce(
              (t, l) => ({
                gross: t.gross + Number(l.gross),
                tds: t.tds + Number(l.tds),
                net: t.net + Number(l.net),
              }),
              { gross: 0, tds: 0, net: 0 },
            )
            return (
              <div key={run.id} className="rounded-lg border border-zinc-100 p-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium text-zinc-900">
                    {run.year}-{String(run.month).padStart(2, '0')}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      run.status === 'DRAFT'
                        ? 'bg-amber-100 text-amber-700'
                        : run.status === 'APPROVED'
                          ? 'bg-sky-100 text-sky-700'
                          : 'bg-emerald-100 text-emerald-700'
                    }`}
                  >
                    {run.status.toLowerCase()}
                  </span>
                  <span className="ml-auto text-xs text-zinc-500">
                    gross {displayINR(totals.gross)} · TDS {displayINR(totals.tds)} · net {displayINR(totals.net)}
                  </span>
                </div>

                <table className="mt-2 w-full text-sm">
                  <tbody className="divide-y divide-zinc-50">
                    {run.lines.map((line) => (
                      <tr key={line.id}>
                        <td className="py-1 text-zinc-700">{personName(line.personId)}</td>
                        {run.status === 'DRAFT' ? (
                          <td colSpan={3} className="py-1">
                            <form action={updateRunLineAction} className="flex items-center justify-end gap-2">
                              <input type="hidden" name="lineId" value={line.id} />
                              <input name="gross" defaultValue={String(line.gross)} inputMode="decimal" className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-right text-sm" />
                              <input name="tds" defaultValue={String(line.tds)} inputMode="decimal" className="w-24 rounded-md border border-zinc-300 px-2 py-1 text-right text-sm" />
                              <span className="w-28 text-right text-zinc-500">{displayINR(String(line.net))}</span>
                              <button type="submit" className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100">
                                Save
                              </button>
                            </form>
                          </td>
                        ) : (
                          <>
                            <td className="w-28 py-1 text-right text-zinc-600">{displayINR(String(line.gross))}</td>
                            <td className="w-24 py-1 text-right text-zinc-500">− {displayINR(String(line.tds))}</td>
                            <td className="w-28 py-1 text-right font-medium text-zinc-800">{displayINR(String(line.net))}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {run.status === 'DRAFT' && (
                    <form action={approveRunAction}>
                      <input type="hidden" name="runId" value={run.id} />
                      <button type="submit" className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600">
                        Approve (posts expense, payables & TDS)
                      </button>
                    </form>
                  )}
                  {run.status === 'APPROVED' && (
                    <form action={payRunAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="runId" value={run.id} />
                      <input name="date" type="date" required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                      <SourceSelect
                        suggestion={rankForAmount(baseSuggestion.options, totals.net.toFixed(2))}
                        compact
                      />
                      <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700">
                        Mark paid
                      </button>
                    </form>
                  )}
                </div>
              </div>
            )
          })}
          {runs.length === 0 && <p className="text-sm text-zinc-400">No runs yet.</p>}
        </div>
      </div>
    </div>
  )
}
