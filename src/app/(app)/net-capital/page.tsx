import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { ConfirmButton } from '@/components/confirm-button'
import { PageHeader, tableWrapClass, theadClass } from '@/components/ui'
import {
  saveNetCapitalLineAction,
  addNetCapitalLineAction,
  deleteNetCapitalLineAction,
} from './actions'

// Net capital — the sheet's sources-and-application statement as a screen.
// Sections mirror the tab; every row edits in place (the numbers ARE the
// inputs); totals and the nets are computed live from the rows. Nothing
// posts to the books.

const cellInput =
  'w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-right text-xs tabular-nums hover:border-line focus:border-primary focus:bg-surface focus:outline-none'
const nameInput =
  'w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-xs hover:border-line focus:border-primary focus:bg-surface focus:outline-none'

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const fmt = (n: number) => (n < 0 ? `-₹${inr.format(-Math.round(n))}` : `₹${inr.format(Math.round(n))}`)

const SECTIONS: { key: string; title: string; hint?: string }[] = [
  { key: 'INCOME', title: 'Sources — income & capital' },
  { key: 'LIABILITY', title: 'Liabilities — loans taken' },
  { key: 'APPLICATION', title: 'Application — where it sits' },
  { key: 'TAXPAID', title: 'Tax-paid assets / investments currently showing' },
  { key: 'BANK', title: 'Bank balance' },
]

export default async function NetCapitalPage() {
  await requireAdmin()

  const lines = await prisma.netCapitalLine.findMany({
    where: { archivedAt: null },
    orderBy: { sortOrder: 'asc' },
  })
  const bySection = (key: string) => lines.filter((l) => l.section === key)
  const num = (v: unknown) => (v == null ? 0 : Number(v))
  const sum = (key: string, col: 'amountNew' | 'amountTotal' | 'synergy') =>
    bySection(key).reduce((a, l) => a + num(l[col]), 0)

  // the sheet's computed figures, live from the rows
  const srcNew = sum('INCOME', 'amountNew') + sum('LIABILITY', 'amountNew')
  const srcTotal = sum('INCOME', 'amountTotal') + sum('LIABILITY', 'amountTotal')
  const srcSyn = sum('INCOME', 'synergy') + sum('LIABILITY', 'synergy')
  const appNew = sum('APPLICATION', 'amountNew')
  const appTotal = sum('APPLICATION', 'amountTotal')
  const appSyn = sum('APPLICATION', 'synergy')
  const ownCapital = sum('INCOME', 'amountNew') // own money, loans excluded
  const taxpaid = sum('TAXPAID', 'amountNew')
  const netAvailable = ownCapital - taxpaid
  const bank = sum('BANK', 'amountNew')

  const totalsFor = (key: string): [number, number, number] => [
    sum(key, 'amountNew'),
    sum(key, 'amountTotal'),
    sum(key, 'synergy'),
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Statement"
        title="Net capital — Books of Himal"
        subtitle="Sources vs application of capital. Edit any figure in its row — totals and the nets recompute. Nothing posts to the books."
      />

      {/* The sheet's bottom lines, always in view */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { label: 'Own capital (New)', value: ownCapital, note: 'income sources, loans excluded' },
          { label: 'Net capital remaining (New)', value: srcNew - appNew, note: 'sources − application' },
          { label: 'Net capital remaining (Total)', value: srcTotal - appTotal, note: 'sources − application' },
          { label: 'Net available', value: netAvailable, note: 'own capital − tax-paid assets showing' },
          { label: 'Bank balance', value: bank, note: 'HG + MG' },
        ].map((t) => (
          <div key={t.label} className="rounded-2xl border border-line bg-surface p-3 shadow-card">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{t.label}</div>
            <div className={`mt-1 text-lg font-semibold tabular-nums ${t.value < 0 ? 'text-danger' : 'text-ink'}`}>
              {fmt(t.value)}
            </div>
            <div className="text-[10px] text-ink-3">{t.note}</div>
          </div>
        ))}
      </div>

      {SECTIONS.map((s) => {
        const rows = bySection(s.key)
        const [tNew, tTotal, tSyn] = totalsFor(s.key)
        return (
          <div key={s.key} className={tableWrapClass}>
            <table className="w-full min-w-[64rem] text-left text-sm">
              <thead className={theadClass}>
                <tr>
                  <th className="px-2 py-2" colSpan={2}>
                    <span className="text-xs font-semibold normal-case tracking-normal text-ink">{s.title}</span>
                  </th>
                  <th className="px-1.5 py-2 text-right">New ₹</th>
                  <th className="px-1.5 py-2 text-right">Total ₹</th>
                  <th className="px-1.5 py-2 text-right">Synergy ₹</th>
                  <th className="px-1.5 py-2 text-right">Books ₹</th>
                  <th className="px-1.5 py-2 text-right">Remaining ₹</th>
                  <th className="px-1.5 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const fid = `ln-${l.id}`
                  return (
                    <tr key={l.id} className="border-b border-line-2 hover:bg-surface-2/60">
                      <td className="w-64 px-0.5 py-0.5">
                        <form id={fid} action={saveNetCapitalLineAction}>
                          <input type="hidden" name="lineId" value={l.id} />
                        </form>
                        <input name="name" form={fid} defaultValue={l.name} required className={nameInput} />
                      </td>
                      <td className="w-24 px-0.5 py-0.5">
                        <input name="taxStatus" form={fid} defaultValue={l.taxStatus ?? ''} placeholder="Tax status" className={`${nameInput} text-[11px] text-ink-2`} />
                      </td>
                      {(['amountNew', 'amountTotal', 'synergy', 'fyFigure', 'remaining'] as const).map((col) => (
                        <td key={col} className="w-28 px-0.5 py-0.5">
                          <input
                            name={col}
                            form={fid}
                            inputMode="decimal"
                            defaultValue={l[col] == null ? '' : inr.format(Number(l[col]))}
                            className={cellInput}
                          />
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-1 py-0.5 text-right">
                        <button type="submit" form={fid} title="Save row" className="rounded border border-line px-1.5 text-[10px] text-ink-3 hover:bg-surface-2 hover:text-ink-2">
                          ✓
                        </button>
                        <form action={deleteNetCapitalLineAction} className="ml-1 inline">
                          <input type="hidden" name="lineId" value={l.id} />
                          <ConfirmButton
                            message={`Remove "${l.name}" from the statement?`}
                            className="rounded border border-danger/30 px-1.5 text-[10px] text-danger/70 hover:bg-danger-soft hover:text-danger"
                          >
                            ✕
                          </ConfirmButton>
                        </form>
                      </td>
                    </tr>
                  )
                })}
                <tr className="border-b border-line-2 bg-surface-2/60 text-xs font-semibold text-ink">
                  <td className="px-2 py-1.5" colSpan={2}>Total</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{tNew ? fmt(tNew) : ''}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{tTotal ? fmt(tTotal) : ''}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{tSyn ? fmt(tSyn) : ''}</td>
                  <td colSpan={3}></td>
                </tr>
                {/* fill-what-you-know add row */}
                <tr>
                  <td className="px-0.5 py-1" colSpan={8}>
                    <form action={addNetCapitalLineAction} className="flex flex-wrap items-center gap-1.5 px-1">
                      <input type="hidden" name="section" value={s.key} />
                      <input name="name" required placeholder="＋ Add line…" className="w-56 rounded-lg border border-dashed border-line px-2 py-1 text-xs focus:border-primary focus:outline-none" />
                      <input name="taxStatus" placeholder="Tax status" className="w-24 rounded-lg border border-line px-2 py-1 text-xs" />
                      <input name="amountNew" inputMode="decimal" placeholder="New ₹" className="w-28 rounded-lg border border-line px-2 py-1 text-right text-xs" />
                      <input name="amountTotal" inputMode="decimal" placeholder="Total ₹" className="w-28 rounded-lg border border-line px-2 py-1 text-right text-xs" />
                      <input name="synergy" inputMode="decimal" placeholder="Synergy ₹" className="w-28 rounded-lg border border-line px-2 py-1 text-right text-xs" />
                      <button type="submit" className="rounded-lg bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary-strong">
                        Add
                      </button>
                      <span className="text-[10px] text-ink-3">fill what you have — name is enough</span>
                    </form>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      })}

      {/* the sheet's closing arithmetic, spelled out */}
      <div className="rounded-2xl border border-line bg-surface p-3 text-xs text-ink-2 shadow-card">
        <div className="grid gap-1 md:grid-cols-2">
          <div>
            Sources {fmt(srcNew)} − Application {fmt(appNew)} = <b className="text-ink">Net capital remaining {fmt(srcNew - appNew)}</b> (New)
          </div>
          <div>
            Sources {fmt(srcTotal)} − Application {fmt(appTotal)} = <b className="text-ink">{fmt(srcTotal - appTotal)}</b> (Total)
            <span className="ml-2 text-ink-3">Synergy: {fmt(srcSyn)} − {fmt(appSyn)} = {fmt(srcSyn - appSyn)}</span>
          </div>
          <div>
            Own capital {fmt(ownCapital)} − Tax-paid assets showing {fmt(taxpaid)} ={' '}
            <b className={netAvailable < 0 ? 'text-danger' : 'text-ink'}>Net available {fmt(netAvailable)}</b>
          </div>
          <div>Type in any cell and hit ✓ (or Enter) to save the row; ✕ removes it.</div>
        </div>
      </div>
    </div>
  )
}
