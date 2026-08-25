import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { saveMasterRowAction, removeMasterRowAction } from './actions'
import { LiveFilter } from '@/components/live-filter'
import { ConfirmButton } from '@/components/confirm-button'
import { Fragment } from 'react'
import { SmartCombobox } from '@/components/smart-combobox'
import { NEW_HEAD_SECTION } from '@/lib/ops/heads'
import { PageHeader } from '@/components/ui'
import { stripCcType, CC_TYPE_ALIAS } from '@/lib/budget/nature'

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
// Himal's cost-centre vocabulary (20 Aug 2026) — exactly these seven, his
// spellings ("Invesment" included), the SAME in every books since the
// 20 Aug unification renamed the old per-book variants in place. They seed
// the dropdown first; any centre added later in any books joins the list
// below, and stripCcType still bridges legacy spellings wherever stored.
const CC_TYPES = ['Company Essentials', 'Company Growth', 'Compulsory', 'Growth', 'Invesment', 'Lifestyle', 'Optional']
const FREQ_LABEL: Record<string, string> = {
  DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly',
  HALF_YEARLY: 'Half yearly', ANNUAL: 'Annual',
}
export default async function CoaPage() {
  const user = await requireAdmin()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>

  const modes = await prisma.headMode.findMany({ orderBy: [{ sortOrder: 'asc' }, { category: 'asc' }] })
  const sections = [...new Set(modes.map((m) => m.section).filter((x): x is string => !!x))]

  // Cost centre options: the canonical four + every live centre from every
  // books + any value already stored on a row — deduped by stripped type so
  // HG's "Growth" and ACPL's "Optional-growth" stay ONE entry. Typing a new
  // name creates it per book on save (applyMasterRow's find-or-create).
  const ccRows = await prisma.costCentre.findMany({ where: { archivedAt: null }, select: { name: true } })
  const canonKey = (s: string) => {
    const w = stripCcType(s)
    return CC_TYPE_ALIAS[w] ?? w
  }
  const ccSeen = new Map<string, string>()
  for (const t of CC_TYPES) ccSeen.set(canonKey(t), t)
  for (const c of ccRows) if (!ccSeen.has(canonKey(c.name))) ccSeen.set(canonKey(c.name), c.name)
  for (const m of modes)
    if (m.expenseType && !ccSeen.has(canonKey(m.expenseType))) ccSeen.set(canonKey(m.expenseType), m.expenseType)
  const ccOptions = [...ccSeen.values()].sort((a, b) => a.localeCompare(b))
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
    'w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-xs hover:border-line focus:border-primary focus:bg-surface focus:outline-none'

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Setup & masters"
        title="Accounts — master register"
        subtitle="The single source of the plan. Edit a cell, hit ✓ — cash flow, budgets, reports and tagging follow."
        actions={
          <>
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-ink">Expense Heads</h2>
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium tabular-nums text-ink-2">
                {modes.length}
              </span>
            </div>
            <LiveFilter selector="[data-live-filter='master']" placeholder="Type to search heads…" />
          </>
        }
      />

      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="overflow-x-auto">
        <table data-live-filter="master" className="w-full min-w-[88rem] table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[17%]" />
            <col className="w-[8%]" />
            <col className="w-[11%]" />
            <col className="w-[11%]" />
            <col className="w-[12%]" />
            <col className="w-[8%]" />
            <col className="w-[8%]" />
            <col className="w-[8%]" />
            <col className="w-[8%]" />
            <col className="w-[9%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-line bg-surface text-[10px] uppercase tracking-wider text-ink-3">
              <th className="px-4 py-2.5 font-semibold">Expense Head</th>
              <th className="px-2 py-2.5 font-semibold">Nature</th>
              <th className="px-2 py-2.5 font-semibold">Bank mode</th>
              <th className="px-2 py-2.5 font-semibold">Cost centre</th>
              <th className="px-2 py-2.5 font-semibold" title="Defaults to the Expense Head itself. Pick a different head to send every entry of this category into the Accounting Head report under that name — Reports → By → Accounting Head. A pick made while tagging still wins per entry.">
                Accounting Head
              </th>
              <th className="px-2 py-2.5 text-right font-semibold">Bank budget ₹</th>
              <th className="px-2 py-2.5 text-right font-semibold">Cash budget ₹</th>
              <th className="px-2 py-2.5 font-semibold">Frequency</th>
              <th className="px-2 py-2.5 font-semibold">Day</th>
              <th className="px-2 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2">
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
                  <tr data-filter-keep="1" className="border-t border-line bg-surface-2/60">
                    <td colSpan={10} className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-ink-3">
                      {sectionHeader}
                    </td>
                  </tr>
                )}
                <tr
                  data-filter-keep={m ? undefined : '1'}
                  className={
                    m
                      ? 'even:bg-surface-2/40 hover:bg-primary-soft/40'
                      : 'border-l-2 border-success bg-surface-2/60'
                  }
                >
                  <td className="px-4 py-1 text-xs font-medium text-ink">
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
                        {/* A head born while tagging waits in New Added; pick
                            its real section here and Save moves it to that
                            section's end (Himal, 21 Aug: "Section made
                            halvta aal pahije"). Left alone, it keeps sitting
                            in New Added — the picker's default. */}
                        {m.section === NEW_HEAD_SECTION && (
                          <SmartCombobox
                            options={sections.map((sec) => ({ id: sec, label: sec }))}
                            name="section"
                            createName="sectionNew"
                            defaultId={NEW_HEAD_SECTION}
                            formId={fid}
                            placeholder="Move to section…"
                            className={`${cellCls} mt-0.5 w-44 border-dashed border-primary/40 bg-surface text-[11px]`}
                          />
                        )}
                      </>
                    ) : (
                      <div className="flex gap-1">
                        <input name="category" form={fid} required placeholder="＋ New expense head…" className={`${cellCls} border-dashed border-success/40`} />
                        <SmartCombobox
                          options={sections.map((sec) => ({ id: sec, label: sec }))}
                          name="section"
                          createName="sectionNew"
                          formId={fid}
                          placeholder="Section — pick or type a new one"
                          className={`${cellCls} w-44 border-dashed border-success/30 bg-surface`}
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
                      className={`${cellCls} bg-surface`}
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <div className="flex items-center gap-1">
                      <input name="bankMode" form={fid} list="bank-mode-options" defaultValue={m?.modeBank ?? ''} placeholder="HDFC 2762 / Cash" className={cellCls} />
                      {bank?.ledgerAccountId && (
                        <Link href={`/admin/ledgers?accountId=${bank.ledgerAccountId}`} title={`Linked to ${bank.nickname}`} className="text-primary hover:text-primary-strong">
                          ↗
                        </Link>
                      )}
                    </div>
                  </td>
                  <td className="px-1 py-0.5">
                    <SmartCombobox
                      options={[
                        ...(m?.expenseType && !ccOptions.includes(m.expenseType)
                          ? [{ id: m.expenseType, label: m.expenseType }]
                          : []),
                        ...ccOptions.map((t) => ({ id: t, label: t })),
                      ]}
                      name="expenseType"
                      createName="expenseTypeNew"
                      defaultId={m?.expenseType ?? ''}
                      formId={fid}
                      placeholder="Cost centre"
                      className={`${cellCls} bg-surface`}
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    {/* the category's Accounting Head — shows the category
                        itself by default ("je aahe te"); a different pick
                        (highlighted) reroutes the whole category's entries
                        in the Accounting Head report, live */}
                    <SmartCombobox
                      options={[
                        ...(m?.accountingHead && !modes.some((x) => x.category === m.accountingHead)
                          ? [{ id: m.accountingHead, label: m.accountingHead }]
                          : []),
                        ...modes.map((x) => ({ id: x.category, label: x.category })),
                      ]}
                      name="accountingHead"
                      createName="accountingHeadNew"
                      defaultId={m ? (m.accountingHead ?? m.category) : ''}
                      formId={fid}
                      placeholder="= Expense Head"
                      className={`${cellCls} bg-surface ${m?.accountingHead ? 'font-medium text-primary' : ''}`}
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <input
                      name="bankBudget"
                      form={fid}
                      inputMode="decimal"
                      defaultValue={m?.bankBudget == null ? '' : String(Math.round(Number(m.bankBudget)))}
                      title="− = receipt"
                      className={`${cellCls} text-right tabular-nums ${Number(m?.bankBudget) < 0 ? 'font-medium text-success' : ''}`}
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
                      className={`${cellCls} bg-surface`}
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
                      className={`${cellCls} bg-surface`}
                    />
                  </td>
                  <td className="whitespace-nowrap px-2 py-0.5 text-right">
                    <form id={fid} action={saveMasterRowAction} className="inline">
                      <button
                        type="submit"
                        title="Save — updates plan, budgets, modes and cost centres everywhere"
                        className={`rounded px-2 py-0.5 text-[11px] font-medium ${m ? 'border border-line text-ink-2 hover:bg-surface-2' : 'bg-success text-white hover:opacity-90'}`}
                      >
                        {m ? 'Save' : 'Add'}
                      </button>
                    </form>
                    {m && (
                      <form action={removeMasterRowAction} className="ml-1 inline">
                        <input type="hidden" name="category" value={m.category} />
                        <ConfirmButton
                          message={`Remove "${m.category}" from the master? Its plan lines and FY budgets clear; the head and its postings stay.`}
                          className="rounded border border-danger/30 px-1.5 py-0.5 text-[11px] text-danger/70 hover:bg-danger-soft hover:text-danger"
                        >
                          Remove
                        </ConfirmButton>
                      </form>
                    )}
                  </td>
                </tr>
                {sectionEnds && (
                  <tr data-filter-keep="1" className="bg-surface-2/60">
                    <td className="px-4 py-0.5" colSpan={9}>
                      <input
                        name="category"
                        form={`mr-sec-${sectionEnds.replace(/[^a-zA-Z0-9]/g, '_')}`}
                        required
                        placeholder={`＋ Add in ${sectionEnds}…`}
                        className={`${cellCls} border-dashed border-success/30`}
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
                          className="rounded bg-success px-2 py-0.5 text-[11px] font-medium text-white hover:opacity-90"
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
        <datalist id="bank-mode-options">
          {BANK_MODES.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
        <p className="border-t border-line-2 px-4 py-2 text-[11px] text-ink-3">
          This register is the master — ✓ saves a row and updates the plan, budgets, modes and cost centres everywhere.
          Books says whose books (or the cash pool) the plan sits in. Negative budget = receipt. The ↗ next to a bank
          mode means it is linked to a real bank account — click it to open that account&apos;s statement ledger.
          Opening balances live on their own screen now — Setup &amp; masters → Opening balances. Accounting Head
          defaults to the Expense Head itself; pick a different one to send the whole category into
          the Accounting Head report (Reports → By) under that name — live, without touching what posts in the books.
          While tagging, each entry&apos;s own Accounting Head pick still wins over the master&apos;s.
        </p>
      </div>
    </div>
  )
}
