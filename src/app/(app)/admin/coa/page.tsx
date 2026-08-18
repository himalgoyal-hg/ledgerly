import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { saveMasterRowAction, removeMasterRowAction } from './actions'
import { LiveFilter } from '@/components/live-filter'
import { ConfirmButton } from '@/components/confirm-button'
import { Fragment } from 'react'
import { SmartCombobox } from '@/components/smart-combobox'

// Accounts IS the master register (Himal, 18 Aug 2026): every category with
// its books, bank mode, cost centre, budgets, frequency, day and nature —
// edited here, propagated everywhere on every ✓. The Google-Sheet sync is
// retired; this screen is the single source of truth.

const BANK_MODES = [
  'HDFC 2762', 'HDFC 4271', 'ACPL HDFC 7838', 'HG ICICI',
  'Meena ICICI', 'Meena Axis', 'Cash', 'Greeshma balance', 'Reimbursements',
]
const NATURES = ['Expense', 'Income', 'Liability', 'Asset', 'Contra', 'Personal']
// the Day dropdown: dates first, then weekdays and period-ends
const DAY_OPTIONS = [
  ...Array.from({ length: 31 }, (_, i) => String(i + 1)),
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'End of month', 'End of quarter',
]
const CC_TYPES = ['Compulsory', 'Optional-Lifestyle', 'Optional-growth', 'Optional-Investment']
const FREQ_LABEL: Record<string, string> = {
  DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly',
  HALF_YEARLY: 'Half yearly', ANNUAL: 'Annual',
}
export default async function CoaPage() {
  const user = await requireAdmin()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>

  const modes = await prisma.headMode.findMany({ orderBy: [{ sortOrder: 'asc' }, { category: 'asc' }] })
  const sections = [...new Set(modes.map((m) => m.section).filter((x): x is string => !!x))]
  const banks = await prisma.bankAccount.findMany({
    select: { id: true, nickname: true, ledgerAccountId: true },
  })
  const bankById = new Map(banks.map((b) => [b.id, b]))
  const allHeads = await prisma.ledgerAccount.findMany({
    where: { isGroup: false, archivedAt: null },
    select: { id: true, name: true, entity: { select: { code: true } } },
  })
  const headsByName = new Map<string, { id: string; code: string }[]>()
  for (const h of allHeads) {
    const key = h.name.toLowerCase()
    headsByName.set(key, [...(headsByName.get(key) ?? []), { id: h.id, code: h.entity.code }])
  }

  const cellCls =
    'w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-xs hover:border-zinc-300 focus:border-zinc-400 focus:bg-white focus:outline-none'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Accounts — master register</h1>
          <p className="mt-1 text-sm text-zinc-500">
            The single source of the plan. Edit a cell, hit ✓ — cash flow, budgets, reports and tagging follow.
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
        {/* toolbar: what this is, how many, and the live search — one bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50/60 px-4 py-2.5">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-zinc-800">Expense Heads</h2>
            <span className="rounded-full bg-zinc-200/70 px-2 py-0.5 text-[11px] font-medium tabular-nums text-zinc-600">
              {modes.length}
            </span>
          </div>
          <LiveFilter selector="[data-live-filter='master']" placeholder="Type to search heads…" />
        </div>
        <div className="overflow-x-auto">
        <table data-live-filter="master" className="w-full min-w-[76rem] table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[21%]" />
            <col className="w-[9%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[9%]" />
            <col className="w-[8%]" />
            <col className="w-[10%]" />
            <col className="w-[9%]" />
            <col className="w-[8%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-zinc-200 bg-white text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2.5 font-semibold">Expense Head</th>
              <th className="px-2 py-2.5 font-semibold">Nature</th>
              <th className="px-2 py-2.5 font-semibold">Bank mode</th>
              <th className="px-2 py-2.5 font-semibold">Cost centre</th>
              <th className="px-2 py-2.5 text-right font-semibold">Bank budget ₹</th>
              <th className="px-2 py-2.5 text-right font-semibold">Cash budget ₹</th>
              <th className="px-2 py-2.5 font-semibold">Frequency</th>
              <th className="px-2 py-2.5 font-semibold">Day</th>
              <th className="px-2 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {[null, ...modes].map((m, idx, arr) => {
              const prev = idx > 1 ? (arr[idx - 1] as (typeof modes)[number] | null) : null
              const sectionHeader =
                m && m.section && m.section !== (prev?.section ?? null) ? m.section : null
              const next = idx < arr.length - 1 ? (arr[idx + 1] as (typeof modes)[number] | null) : null
              // last row of its section → an add-right-here row follows
              const sectionEnds =
                m && m.section && (next == null || (next.section ?? null) !== m.section) ? m.section : null
              const fid = m ? `mr-${m.id}` : 'mr-new'
              const heads = m ? (headsByName.get(m.category.toLowerCase()) ?? []) : []
              const bank = m?.bankAccountId ? bankById.get(m.bankAccountId) : null
              return (
                <Fragment key={m?.id ?? 'new'}>
                {sectionHeader && (
                  <tr data-filter-keep="1" className="border-t border-zinc-200 bg-zinc-100/70">
                    <td colSpan={9} className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                      {sectionHeader}
                    </td>
                  </tr>
                )}
                <tr
                  data-filter-keep={m ? undefined : '1'}
                  className={
                    m
                      ? 'even:bg-zinc-50/40 hover:bg-sky-50/40'
                      : 'border-l-2 border-emerald-500 bg-emerald-50/50'
                  }
                >
                  <td className="px-4 py-1 text-xs font-medium text-zinc-800">
                    {m ? (
                      <>
                        <input type="hidden" name="category" form={fid} value={m.category} />
                        {/* the system already knows whose account this is */}
                        <input type="hidden" name="books" form={fid} value={m.books ?? ''} />
                        {heads.length > 0 ? (
                          <Link href={`/admin/ledgers?accountId=${heads[0].id}`} className="hover:underline">
                            {m.category}
                          </Link>
                        ) : (
                          <span title="No head in any books yet — appears when a budget/plan needs it">{m.category}</span>
                        )}
                      </>
                    ) : (
                      <div className="flex gap-1">
                        <input name="category" form={fid} required placeholder="＋ New expense head…" className={`${cellCls} border-dashed border-emerald-400`} />
                        <input
                          name="section"
                          form={fid}
                          list="section-options"
                          placeholder="Section (or a new one)"
                          className={`${cellCls} w-40 border-dashed border-emerald-300`}
                        />
                      </div>
                    )}
                  </td>
                  <td className="px-1 py-0.5">
                    <SmartCombobox
                      options={NATURES.map((n) => ({ id: n, label: n }))}
                      name="nature"
                      defaultId={m?.nature ?? ''}
                      formId={fid}
                      placeholder="Nature"
                      className={`${cellCls} bg-white`}
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <div className="flex items-center gap-1">
                      <input name="bankMode" form={fid} list="bank-mode-options" defaultValue={m?.modeBank ?? ''} placeholder="HDFC 2762 / Cash" className={cellCls} />
                      {bank?.ledgerAccountId && (
                        <Link href={`/admin/ledgers?accountId=${bank.ledgerAccountId}`} title={`Linked to ${bank.nickname}`} className="text-sky-600 hover:text-sky-800">
                          ↗
                        </Link>
                      )}
                    </div>
                  </td>
                  <td className="px-1 py-0.5">
                    <SmartCombobox
                      options={CC_TYPES.map((t) => ({ id: t, label: t }))}
                      name="expenseType"
                      defaultId={m?.expenseType ?? ''}
                      formId={fid}
                      placeholder="Cost centre"
                      className={`${cellCls} bg-white`}
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <input
                      name="bankBudget"
                      form={fid}
                      inputMode="decimal"
                      defaultValue={m?.bankBudget == null ? '' : String(Math.round(Number(m.bankBudget)))}
                      title="− = receipt"
                      className={`${cellCls} text-right tabular-nums ${Number(m?.bankBudget) < 0 ? 'font-medium text-emerald-700' : ''}`}
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <input
                      name="cashBudget"
                      form={fid}
                      inputMode="decimal"
                      defaultValue={m?.cashBudget == null ? '' : String(Math.round(Number(m.cashBudget)))}
                      className={`${cellCls} text-right tabular-nums`}
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <SmartCombobox
                      options={Object.entries(FREQ_LABEL).map(([v, l]) => ({ id: v, label: l }))}
                      name="frequency"
                      defaultId={m?.frequency ?? ''}
                      formId={fid}
                      placeholder="Frequency"
                      className={`${cellCls} bg-white`}
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <SmartCombobox
                      options={[
                        ...(m?.dayNote && !DAY_OPTIONS.includes(m.dayNote) ? [{ id: m.dayNote, label: m.dayNote }] : []),
                        ...DAY_OPTIONS.map((d) => ({ id: d, label: d })),
                      ]}
                      name="dayNote"
                      defaultId={m?.dayNote ?? ''}
                      formId={fid}
                      placeholder="Day"
                      className={`${cellCls} bg-white`}
                    />
                  </td>
                  <td className="whitespace-nowrap px-2 py-0.5 text-right">
                    <form id={fid} action={saveMasterRowAction} className="inline">
                      <button
                        type="submit"
                        title="Save — updates plan, budgets, modes and cost centres everywhere"
                        className={`rounded px-2 py-0.5 text-[11px] font-medium ${m ? 'border border-zinc-300 text-zinc-600 hover:bg-zinc-100' : 'bg-emerald-700 text-white hover:bg-emerald-600'}`}
                      >
                        {m ? '✓' : 'Add'}
                      </button>
                    </form>
                    {m && (
                      <form action={removeMasterRowAction} className="ml-1 inline">
                        <input type="hidden" name="category" value={m.category} />
                        <ConfirmButton
                          message={`Remove "${m.category}" from the master? Its plan lines and FY budgets clear; the head and its postings stay.`}
                          className="rounded border border-red-100 px-1.5 py-0.5 text-[11px] text-red-400 hover:bg-red-50 hover:text-red-600"
                        >
                          ✕
                        </ConfirmButton>
                      </form>
                    )}
                  </td>
                </tr>
                {sectionEnds && (
                  <tr data-filter-keep="1" className="bg-emerald-50/30">
                    <td className="px-4 py-0.5" colSpan={8}>
                      <input
                        name="category"
                        form={`mr-sec-${sectionEnds.replace(/[^a-zA-Z0-9]/g, '_')}`}
                        required
                        placeholder={`＋ Add in ${sectionEnds}…`}
                        className={`${cellCls} border-dashed border-emerald-300`}
                      />
                    </td>
                    <td className="px-2 py-0.5 text-right">
                      <form id={`mr-sec-${sectionEnds.replace(/[^a-zA-Z0-9]/g, '_')}`} action={saveMasterRowAction} className="inline">
                        <input type="hidden" name="section" value={sectionEnds} />
                        <input type="hidden" name="bankMode" value="" />
                        <input type="hidden" name="expenseType" value="" />
                        <input type="hidden" name="bankBudget" value="" />
                        <input type="hidden" name="cashBudget" value="" />
                        <input type="hidden" name="frequency" value="" />
                        <input type="hidden" name="dayNote" value="" />
                        <input type="hidden" name="nature" value="" />
                        <button
                          type="submit"
                          title="Adds at the end of this section — fill its columns after"
                          className="rounded bg-emerald-700 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-600"
                        >
                          Add
                        </button>
                      </form>
                    </td>
                  </tr>
                )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        </div>
        <datalist id="section-options">
          {sections.map((sec) => (
            <option key={sec} value={sec} />
          ))}
        </datalist>
        <datalist id="bank-mode-options">
          {BANK_MODES.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
        <p className="border-t border-zinc-100 px-4 py-2 text-[11px] text-zinc-400">
          This register is the master — ✓ saves a row and updates the plan, budgets, modes and cost centres everywhere.
          Books says whose books (or the cash pool) the plan sits in. Negative budget = receipt. The ↗ next to a bank
          mode means it is linked to a real bank account — click it to open that account&apos;s statement ledger.
        </p>
      </div>
    </div>
  )
}
