import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { suggestPaymentSource, rankForAmount } from '@/lib/automation/suggest'
import { SmartCombobox } from '@/components/smart-combobox'
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

  const personForm = (type: 'SALARY' | 'CONSULTANT', person?: (typeof people)[number]) => (
    <form action={upsertPersonAction} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="entityId" value={entity.id} />
      <input type="hidden" name="type" value={type} />
      {person && <input type="hidden" name="id" value={person.id} />}
      <input name="name" required placeholder="Name" defaultValue={person?.name} className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
      <input name="team" placeholder="Team" defaultValue={person?.team ?? ''} className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
      <SmartCombobox
        options={costCentres.map((c) => ({ id: c.id, label: c.name }))}
        name="costCentreId"
        createName="costCentreText"
        defaultId={person?.costCentreId}
        placeholder="Cost centre — type or add"
        className="w-56 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
      />
      <input name="monthlyGross" required inputMode="decimal" placeholder="Monthly gross ₹" defaultValue={person ? String(person.monthlyGross) : undefined} className="w-32 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
      {/* TDS removed from the salary flow per Himal (13 Aug 2026) — the
          machinery stays; people simply carry 0%. */}
      <input type="hidden" name="tdsRate" value={person ? String(person.tdsRate) : '0'} />
      <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700">
        {person ? 'Save' : `Add ${type === 'SALARY' ? 'employee' : 'consultant'}`}
      </button>
    </form>
  )

  // The register itself: monthly TDS/net and annual cost per person, then
  // budgeting rollups by team and by cost centre.
  const enriched = people.map((p) => {
    const gross = Number(p.monthlyGross)
    const tds = (gross * Number(p.tdsRate)) / 100
    return { p, gross, tds, net: gross - tds, annual: gross * 12 }
  })
  const totals = enriched.reduce(
    (t, r) => ({ gross: t.gross + r.gross, tds: t.tds + r.tds, net: t.net + r.net, annual: t.annual + r.annual }),
    { gross: 0, tds: 0, net: 0, annual: 0 },
  )
  const rollup = (label: (r: (typeof enriched)[number]) => string) => {
    const map = new Map<string, { count: number; gross: number }>()
    for (const r of enriched) {
      const key = label(r)
      const row = map.get(key) ?? { count: 0, gross: 0 }
      row.count++
      row.gross += r.gross
      map.set(key, row)
    }
    return [...map.entries()].sort((a, b) => b[1].gross - a[1].gross)
  }
  const byTeam = rollup((r) => r.p.team?.trim() || '— no team —')
  const byCc = rollup((r) => ccName(r.p.costCentreId) ?? '— no cost centre —')

  const rollupTable = (title: string, rows: [string, { count: number; gross: number }][]) => (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-200 px-4 py-2">
        <h2 className="text-sm font-medium text-zinc-900">{title}</h2>
        <p className="text-xs text-zinc-400">for cost budgeting — monthly and yearly run rate</p>
      </div>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-100 text-[10px] uppercase tracking-wider text-zinc-400">
            <th className="px-4 py-1.5">&nbsp;</th>
            <th className="px-4 py-1.5 text-right">People</th>
            <th className="px-4 py-1.5 text-right">₹ / month</th>
            <th className="px-4 py-1.5 text-right">₹ / year</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map(([label, r]) => (
            <tr key={label}>
              <td className="px-4 py-1.5 text-zinc-800">{label}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-zinc-600">{r.count}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-zinc-900">{displayINR(r.gross.toFixed(2))}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-zinc-900">{displayINR((r.gross * 12).toFixed(2))}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={4} className="px-4 py-3 text-center text-sm text-zinc-400">Nobody yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900">
        Salary register — {entity.name} ({entity.code})
      </h1>

      {/* The register (spec §6.4): every person with team, cost centre and
          the money columns budgeting needs; edit inline. */}
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Team</th>
              <th className="px-3 py-2">Cost centre</th>
              <th className="px-3 py-2 text-right">Gross / mo</th>
              <th className="px-3 py-2 text-right">Annual gross</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {enriched.map(({ p, gross, annual }) => (
              <tr key={p.id} className="align-top hover:bg-zinc-50/60">
                <td className="px-3 py-1.5 font-medium text-zinc-800">{p.name}</td>
                <td className="px-3 py-1.5">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    p.type === 'SALARY' ? 'bg-sky-100 text-sky-700' : 'bg-violet-100 text-violet-700'
                  }`}>
                    {p.type === 'SALARY' ? 'employee' : 'consultant'}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-zinc-600">{p.team || <span className="text-zinc-300">—</span>}</td>
                <td className="px-3 py-1.5 text-zinc-600">{ccName(p.costCentreId) ?? <span className="text-zinc-300">—</span>}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-900">{displayINR(gross.toFixed(2))}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium text-zinc-900">{displayINR(annual.toFixed(2))}</td>
                <td className="px-3 py-1.5 text-right">
                  <details>
                    <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-700">edit</summary>
                    <div className="py-1 text-left">{personForm(p.type, p)}</div>
                  </details>
                </td>
              </tr>
            ))}
            {enriched.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-4 text-center text-sm text-zinc-400">Nobody yet — add people below.</td></tr>
            )}
          </tbody>
          {enriched.length > 0 && (
            <tfoot className="border-t border-zinc-300 font-medium text-zinc-900">
              <tr>
                <td className="px-3 py-2" colSpan={4}>Total ({enriched.length} people)</td>
                <td className="px-3 py-2 text-right tabular-nums">{displayINR(totals.gross.toFixed(2))}</td>
                <td className="px-3 py-2 text-right tabular-nums">{displayINR(totals.annual.toFixed(2))}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Add people */}
      <div className="grid gap-4 md:grid-cols-2">
        {(['SALARY', 'CONSULTANT'] as const).map((type) => (
          <div key={type} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <h2 className="font-medium text-zinc-900">
              {type === 'SALARY' ? 'Add employee' : 'Add consultant'}
            </h2>
            {personForm(type)}
          </div>
        ))}
      </div>

      {/* Budget rollups */}
      <div className="grid gap-4 lg:grid-cols-2">
        {rollupTable('Cost by team', byTeam)}
        {rollupTable('Cost by cost centre', byCc)}
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
                    total {displayINR(totals.gross)}
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
                              <input type="hidden" name="tds" value={String(line.tds)} />
                              <input name="gross" defaultValue={String(line.gross)} inputMode="decimal" className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-right text-sm" />
                              <button type="submit" className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100">
                                Save
                              </button>
                            </form>
                          </td>
                        ) : (
                          <td className="w-28 py-1 text-right font-medium text-zinc-800" colSpan={3}>
                            {displayINR(String(line.net))}
                          </td>
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
                        Approve (posts expense & payables)
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
