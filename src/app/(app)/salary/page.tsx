import { prisma } from '@/lib/db'
import { LiveFilter } from '@/components/live-filter'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { suggestPaymentSource, rankForAmount } from '@/lib/automation/suggest'
import { SmartCombobox } from '@/components/smart-combobox'
import { SourceSelect } from '../source-select'
import { PageHeader, controlClass, tableWrapClass, theadClass } from '@/components/ui'
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
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>

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
      <input name="name" required placeholder="Name" defaultValue={person?.name} className={controlClass} />
      <input name="team" placeholder="Team" defaultValue={person?.team ?? ''} className={`${controlClass} w-28`} />
      <SmartCombobox
        options={costCentres.map((c) => ({ id: c.id, label: c.name }))}
        name="costCentreId"
        createName="costCentreText"
        defaultId={person?.costCentreId}
        placeholder="Cost centre — type or add"
        className={`${controlClass} w-56`}
      />
      <input name="monthlyGross" required inputMode="decimal" placeholder="Monthly gross ₹" defaultValue={person ? String(person.monthlyGross) : undefined} className={`${controlClass} w-32`} />
      {/* TDS removed from the salary flow per Himal (13 Aug 2026) — the
          machinery stays; people simply carry 0%. */}
      <input type="hidden" name="tdsRate" value={person ? String(person.tdsRate) : '0'} />
      <button type="submit" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-strong">
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
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        <p className="text-xs text-ink-3">for cost budgeting — monthly and yearly run rate</p>
      </div>
      <table data-live-filter="salary" className="w-full text-left text-sm">
        <thead className={theadClass}>
          <tr>
            <th className="px-4 py-1.5">&nbsp;</th>
            <th className="px-4 py-1.5 text-right">People</th>
            <th className="px-4 py-1.5 text-right">₹ / month</th>
            <th className="px-4 py-1.5 text-right">₹ / year</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-2">
          {rows.map(([label, r]) => (
            <tr key={label}>
              <td className="px-4 py-1.5 text-ink">{label}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-ink-2">{r.count}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-ink">{displayINR(r.gross.toFixed(2))}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-ink">{displayINR((r.gross * 12).toFixed(2))}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={4} className="px-4 py-3 text-center text-sm text-ink-3">Nobody yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Operations"
        title={`Salary register — ${entity.name} (${entity.code})`}
        actions={
          <LiveFilter selector="[data-live-filter='salary']" placeholder="Search people / team…" className={`${controlClass} w-52`} />
        }
      />

      {/* The register (spec §6.4): every person with team, cost centre and
          the money columns budgeting needs; edit inline. */}
      <div className={tableWrapClass}>
        <table className="w-full min-w-[56rem] text-left text-sm">
          <thead className={theadClass}>
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Team</th>
              <th className="px-3 py-2">Cost centre</th>
              <th className="px-3 py-2 text-right">Gross / mo</th>
              <th className="px-3 py-2 text-right">Annual gross</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            {enriched.map(({ p, gross, annual }) => (
              <tr key={p.id} className="align-top hover:bg-surface-2/60">
                <td className="px-3 py-1.5 font-medium text-ink">{p.name}</td>
                <td className="px-3 py-1.5">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    p.type === 'SALARY' ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-ink-2'
                  }`}>
                    {p.type === 'SALARY' ? 'employee' : 'consultant'}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-ink-2">{p.team || <span className="text-ink-3">—</span>}</td>
                <td className="px-3 py-1.5 text-ink-2">{ccName(p.costCentreId) ?? <span className="text-ink-3">—</span>}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink">{displayINR(gross.toFixed(2))}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium text-ink">{displayINR(annual.toFixed(2))}</td>
                <td className="px-3 py-1.5 text-right">
                  <details>
                    <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink-2">edit</summary>
                    <div className="py-1 text-left">{personForm(p.type, p)}</div>
                  </details>
                </td>
              </tr>
            ))}
            {enriched.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-4 text-center text-sm text-ink-3">Nobody yet — add people below.</td></tr>
            )}
          </tbody>
          {enriched.length > 0 && (
            <tfoot className="border-t border-line font-medium text-ink">
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
          <div key={type} className="rounded-2xl border border-line bg-surface p-4 shadow-card">
            <h2 className="font-medium text-ink">
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
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-medium text-ink">Monthly runs</h2>
          <form action={createRunAction} className="ml-auto flex items-center gap-2">
            <input type="hidden" name="entityId" value={entity.id} />
            <input name="month" type="month" required className={controlClass} />
            <button type="submit" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-strong">
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
              <div key={run.id} className="rounded-lg border border-line-2 p-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium text-ink">
                    {run.year}-{String(run.month).padStart(2, '0')}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      run.status === 'DRAFT'
                        ? 'bg-warning-soft text-warning'
                        : run.status === 'APPROVED'
                          ? 'bg-primary-soft text-primary'
                          : 'bg-success-soft text-success'
                    }`}
                  >
                    {run.status.toLowerCase()}
                  </span>
                  <span className="ml-auto text-xs text-ink-2">
                    total {displayINR(totals.gross)}
                  </span>
                </div>

                <table className="mt-2 w-full text-sm">
                  <tbody className="divide-y divide-line-2">
                    {run.lines.map((line) => (
                      <tr key={line.id}>
                        <td className="py-1 text-ink-2">{personName(line.personId)}</td>
                        {run.status === 'DRAFT' ? (
                          <td colSpan={3} className="py-1">
                            <form action={updateRunLineAction} className="flex items-center justify-end gap-2">
                              <input type="hidden" name="lineId" value={line.id} />
                              <input type="hidden" name="tds" value={String(line.tds)} />
                              <input name="gross" defaultValue={String(line.gross)} inputMode="decimal" className="w-28 rounded-lg border border-line bg-surface px-2 py-1 text-right text-sm text-ink focus:border-primary focus:outline-none" />
                              <button type="submit" className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-surface-2">
                                Save
                              </button>
                            </form>
                          </td>
                        ) : (
                          <td className="w-28 py-1 text-right font-medium text-ink" colSpan={3}>
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
                      <button type="submit" className="rounded-lg bg-success px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
                        Approve (posts expense & payables)
                      </button>
                    </form>
                  )}
                  {run.status === 'APPROVED' && (
                    <form action={payRunAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="runId" value={run.id} />
                      <input name="date" type="date" required className={controlClass} />
                      <SourceSelect
                        suggestion={rankForAmount(baseSuggestion.options, totals.net.toFixed(2))}
                        compact
                      />
                      <button type="submit" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-strong">
                        Mark paid
                      </button>
                    </form>
                  )}
                </div>
              </div>
            )
          })}
          {runs.length === 0 && <p className="text-sm text-ink-3">No runs yet.</p>}
        </div>
      </div>
    </div>
  )
}
