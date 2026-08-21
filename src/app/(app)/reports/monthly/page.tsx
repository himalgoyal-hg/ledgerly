import { Fragment } from 'react'
import { requireUser, isAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getCurrentEntity } from '@/lib/entity-context'
import { expenseMatrixFy } from '@/lib/reports/prototype'
import { HeadCombobox } from '@/components/head-combobox'
import { setFyBudgetAction } from './actions'
import { BudgetCells } from './budget-cells'
import { LiveFilter } from '@/components/live-filter'
import { HeadLensFilters, readHeadLens } from '../report-chrome'
import { PageHeader, buttonClass, controlClass, tableWrapClass, theadClass } from '@/components/ui'

// Expenses M/M — the sheet's tab, computed instead of typed: heads × FY
// months straight from tagged entries, budget columns from Budget vs
// Actual. Tag a statement row and it lands here on refresh; nothing is
// entered by hand.

const inr = (n: number) => (Math.round(n) ? '₹' + Math.round(n).toLocaleString('en-IN') : '—')
const signed = (n: number) => {
  const v = Math.round(n)
  if (!v) return '—'
  return v < 0 ? `-₹${(-v).toLocaleString('en-IN')}` : `₹${v.toLocaleString('en-IN')}`
}

export default async function MonthlyMatrixPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string; by?: string; head?: string; ah?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>

  // FY starts April: Aug 2026 sits in FY 2026-27
  const now = new Date()
  const currentFy = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
  const params = await searchParams
  const fy = Number(params.fy) || currentFy

  const view = readHeadLens(params)
  const m = await expenseMatrixFy(entity.id, fy, view)
  const admin = isAdmin(user)
  const lensHeads = await prisma.ledgerAccount.findMany({
    where: { entityId: entity.id, isGroup: false, archivedAt: null },
    orderBy: { name: 'asc' },
    select: { id: true, code: true, name: true, kind: true },
  })
  const expenseHeads = admin
    ? await prisma.ledgerAccount.findMany({
        where: { entityId: entity.id, isGroup: false, kind: 'EXPENSE', archivedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, code: true, name: true, kind: true },
      })
    : []
  const cellR = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap'

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Report"
        title={`Month by month — ${entity.code}`}
        subtitle={`${view.lens === 'ah' ? 'By Accounting Head' : 'By Expense Head'} — every head that carries a purpose, grouped by nature. Spent this FY: ${inr(m.spent)}. Bank and cash accounts stay out; they are the source, not the purpose.`}
        actions={
          <form className="flex flex-wrap items-center gap-1 text-sm">
            <HeadLensFilters
              base="/reports/monthly"
              lens={view.lens}
              keep={{ fy: params.fy }}
              headOptions={lensHeads}
              ahOptions={lensHeads}
              pickedHead={params.head}
              pickedAh={params.ah}
            />
            <label className="text-xs text-ink-3">FY</label>
            <select
              name="fy"
              defaultValue={fy}
              className={controlClass}
            >
              {[currentFy - 2, currentFy - 1, currentFy].map((y) => (
                <option key={y} value={y}>
                  {y}-{String(y + 1).slice(2)}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded-lg border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink">
              Go
            </button>
          </form>
        }
      />

      {/* New budget line — pick a head or type a new one, give ₹/month or ₹/year */}
      {admin && (
        <details className="rounded-2xl border border-line bg-surface shadow-card">
          <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-ink hover:bg-surface-2/60">
            ＋ Add budget (type a new head to create it right here)
          </summary>
          <form action={setFyBudgetAction} className="flex flex-wrap items-end gap-3 border-t border-line-2 p-4">
            <input type="hidden" name="entityId" value={entity.id} />
            <input type="hidden" name="fy" value={fy} />
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Expense head *</span>
              <HeadCombobox
                heads={expenseHeads}
                name="accountId"
                createName="headText"
                required
                placeholder="Type to search — or create new"
                className={`${controlClass} mt-1 w-64`}
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Amount ₹ *</span>
              <input name="amount" required inputMode="decimal" placeholder="5000" className={`${controlClass} mt-1 w-28 text-right`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Per</span>
              <select name="kind" className={`${controlClass} mt-1`}>
                <option value="monthly">month (× 12 = year)</option>
                <option value="year">year (÷ 12 = monthly)</option>
              </select>
            </label>
            <button type="submit" className={buttonClass('primary')}>
              Add budget
            </button>
          </form>
        </details>
      )}

      <div className="flex justify-end print:hidden"><LiveFilter selector="[data-live-filter='mm']" placeholder="Search expense heads…" /></div>
      <div className={tableWrapClass}>
        <table data-live-filter="mm" className="w-full min-w-[1100px] text-xs">
          <thead className={theadClass}>
            <tr className="text-[9px]">
              <th colSpan={2}></th>
              <th colSpan={12}></th>
              <th colSpan={2} className="px-2 pt-1.5 text-center font-medium normal-case">
                Recent month vs Budget
              </th>
              <th colSpan={2} className="px-2 pt-1.5 text-center font-medium normal-case">
                Full year
              </th>
            </tr>
            <tr>
              <th className={cellR}>Total</th>
              <th className="px-2 py-2">Head</th>
              {m.months.map((k, i) => (
                <th key={k.key} className={`${cellR} ${i === m.recentIdx ? 'text-ink' : ''}`}>
                  {k.label}
                </th>
              ))}
              <th className={cellR}>Monthly budget</th>
              <th className={cellR}>Variance</th>
              <th className={cellR}>Year budget</th>
              <th className={cellR}>Variance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2 text-sm">
            {m.rows.map((r, idx) => (
              <Fragment key={r.name}>
                {/* a band whenever the nature changes — Expenses, then EMIs,
                    assets and income, each with its own subtotal */}
                {(idx === 0 || m.rows[idx - 1].section !== r.section) &&
                  (() => {
                    const sec = m.sections.find((x) => x.label === r.section)!
                    return (
                      <tr data-filter-keep="1" className="border-t border-line bg-surface-2/70">
                        <td className={`${cellR} font-semibold text-ink`}>{signed(sec.total)}</td>
                        <td className="px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-ink-3">
                          {sec.label}
                        </td>
                        {sec.cells.map((c, i) => (
                          <td key={i} className={`${cellR} text-ink-3`}>{signed(c)}</td>
                        ))}
                        <td className={cellR} />
                        <td className={cellR} />
                        <td className={`${cellR} text-ink-3`}>{inr(sec.yearBudget)}</td>
                        <td className={cellR} />
                      </tr>
                    )
                  })()}
              <tr className="hover:bg-surface-2/60">
                <td className={`${cellR} font-semibold`}>{signed(r.total)}</td>
                <td className="px-2 py-1.5 text-ink">{r.name}</td>
                {r.cells.map((c, i) => (
                  <td key={i} className={`${cellR} ${i === m.recentIdx ? 'bg-warning-soft/60 text-ink-2' : 'text-ink-2'}`}>
                    {signed(c)}
                  </td>
                ))}
                {admin && r.accountId ? (
                  <BudgetCells
                    entityId={entity.id}
                    accountId={r.accountId}
                    fy={fy}
                    monthly={r.monthlyBudget}
                    year={r.yearBudget}
                    recentVariance={r.recentVariance}
                    yearVariance={r.yearVariance}
                    save={setFyBudgetAction}
                  />
                ) : (
                  <>
                    <td className={`${cellR} text-ink-2`}>{inr(r.monthlyBudget)}</td>
                    <td className={`${cellR} ${r.recentVariance < 0 ? 'text-danger' : 'text-ink-2'}`}>{signed(r.recentVariance)}</td>
                    <td className={`${cellR} text-ink-2`}>{inr(r.yearBudget)}</td>
                    <td className={`${cellR} ${r.yearVariance < 0 ? 'text-danger' : 'text-ink-2'}`}>{signed(r.yearVariance)}</td>
                  </>
                )}
              </tr>
              </Fragment>
            ))}
            <tr data-filter-keep="1" className="bg-surface-2/60 font-semibold">
              <td className={cellR}>{signed(m.grand)}</td>
              <td className="px-2 py-1.5">Net movement</td>
              {m.colTotals.map((c, i) => (
                <td key={i} className={cellR}>{signed(c)}</td>
              ))}
              <td className={cellR}>{inr(m.budgetGrand / 12)}</td>
              <td className={cellR}></td>
              <td className={cellR}>{inr(m.budgetGrand)}</td>
              <td className={`${cellR} ${m.budgetGrand - m.grand < 0 ? 'text-danger' : ''}`}>{signed(m.budgetGrand - m.grand)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {m.rows.length === 0 && (
        <p className="text-sm text-ink-3">Nothing tagged or budgeted in FY {fy}-{String(fy + 1).slice(2)} yet.</p>
      )}
    </div>
  )
}
