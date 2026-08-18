import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { saveMasterRowAction, removeMasterRowAction } from './actions'
import { ConfirmButton } from '@/components/confirm-button'

// Accounts IS the master register (Himal, 18 Aug 2026): every category with
// its books, bank mode, cost centre, budgets, frequency, day and nature —
// edited here, propagated everywhere on every ✓. The Google-Sheet sync is
// retired; this screen is the single source of truth.

const BOOKS = ['HG', 'ACPL', 'MG', 'PG'] as const
const BANK_MODES = [
  'HDFC 2762', 'HDFC 4271', 'ACPL HDFC 7838', 'HG ICICI',
  'Meena ICICI', 'Meena Axis', 'Cash', 'Greeshma balance', 'Reimbursements',
]
const NATURES = ['Expense', 'Income', 'Liability', 'Asset', 'Contra', 'Personal']
const CC_TYPES = ['Compulsory', 'Optional-Lifestyle', 'Optional-growth', 'Optional-Investment']
const FREQ_LABEL: Record<string, string> = {
  DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly',
  HALF_YEARLY: 'Half yearly', ANNUAL: 'Annual',
}
const BOOK_CHIP: Record<string, string> = {
  HG: 'bg-sky-50 text-sky-700 border-sky-200',
  ACPL: 'bg-violet-50 text-violet-700 border-violet-200',
  MG: 'bg-rose-50 text-rose-700 border-rose-200',
  PG: 'bg-amber-50 text-amber-700 border-amber-200',
}

// same derivation the save uses, for the "auto" hint
const derivedBooks = (bankMode: string | null): string => {
  if (!bankMode) return 'HG'
  const m = bankMode.toLowerCase()
  if (m === 'cash') return 'HG'
  if (m.includes('7838') || m.startsWith('acpl')) return 'ACPL'
  if (m.includes('meena')) return 'MG'
  return 'HG'
}

export default async function CoaPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const user = await requireAdmin()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>

  const params = await searchParams
  const q = (params.q ?? '').trim()

  const modes = await prisma.headMode.findMany({
    where: q ? { category: { contains: q, mode: 'insensitive' } } : undefined,
    orderBy: { category: 'asc' },
  })
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
        <form className="flex items-center gap-1.5">
          <input
            name="q"
            defaultValue={q}
            placeholder="Search heads…"
            className="w-44 rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
          />
          <button type="submit" className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">
            Go
          </button>
          {q && (
            <Link href="/admin/coa" className="text-xs text-zinc-400 hover:text-zinc-700">
              clear
            </Link>
          )}
        </form>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full min-w-[74rem] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50/80 text-[9px] uppercase tracking-wider text-zinc-400">
              <th colSpan={3} className="px-3 pt-2 pb-0.5 font-medium">What it is</th>
              <th colSpan={3} className="px-2 pt-2 pb-0.5 font-medium">Where it moves</th>
              <th colSpan={4} className="px-2 pt-2 pb-0.5 font-medium">Budget &amp; rhythm</th>
              <th className="bg-zinc-50/80" />
            </tr>
            <tr className="border-b border-zinc-200 bg-zinc-50/80 text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-3 py-1.5">Expense Head {q ? `(${modes.length} of search)` : `(${modes.length})`}</th>
              <th className="px-2 py-1.5">Books</th>
              <th className="px-2 py-1.5">Nature</th>
              <th className="px-2 py-1.5">Bank mode</th>
              <th className="px-2 py-1.5">Head lives in</th>
              <th className="px-2 py-1.5">Cost centre</th>
              <th className="px-2 py-1.5 text-right">Bank ₹</th>
              <th className="px-2 py-1.5 text-right">Cash ₹</th>
              <th className="px-2 py-1.5">Frequency</th>
              <th className="px-2 py-1.5">Day</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {[null, ...modes].map((m) => {
              const fid = m ? `mr-${m.id}` : 'mr-new'
              const heads = m ? (headsByName.get(m.category.toLowerCase()) ?? []) : []
              const bank = m?.bankAccountId ? bankById.get(m.bankAccountId) : null
              const auto = derivedBooks(m?.modeBank ?? null)
              return (
                <tr
                  key={m?.id ?? 'new'}
                  className={m ? 'even:bg-zinc-50/40 hover:bg-sky-50/40' : 'bg-emerald-50/50'}
                >
                  <td className="px-3 py-1 text-xs font-medium text-zinc-800">
                    {m ? (
                      <>
                        <input type="hidden" name="category" form={fid} value={m.category} />
                        {heads.length > 0 ? (
                          <Link href={`/admin/ledgers?accountId=${heads[0].id}`} className="hover:underline">
                            {m.category}
                          </Link>
                        ) : (
                          <span title="No head in any books yet — appears when a budget/plan needs it">{m.category}</span>
                        )}
                      </>
                    ) : (
                      <input name="category" form={fid} required placeholder="＋ New expense head…" className={`${cellCls} border-dashed border-emerald-400`} />
                    )}
                  </td>
                  <td className="w-24 px-1 py-0.5">
                    <select
                      name="books"
                      form={fid}
                      defaultValue={m?.books ?? ''}
                      title="Which books this plan/head belongs to — auto follows the bank mode"
                      className={`${cellCls} bg-white`}
                    >
                      <option value="">auto ({auto})</option>
                      {BOOKS.map((b) => (
                        <option key={b}>{b}</option>
                      ))}
                    </select>
                  </td>
                  <td className="w-24 px-1 py-0.5">
                    <select name="nature" form={fid} defaultValue={m?.nature ?? ''} className={`${cellCls} bg-white`}>
                      <option value=""></option>
                      {NATURES.map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </td>
                  <td className="w-32 px-1 py-0.5">
                    <div className="flex items-center gap-1">
                      <input name="bankMode" form={fid} list="bank-mode-options" defaultValue={m?.modeBank ?? ''} placeholder="HDFC 2762 / Cash" className={cellCls} />
                      {bank?.ledgerAccountId && (
                        <Link href={`/admin/ledgers?accountId=${bank.ledgerAccountId}`} title={`Linked to ${bank.nickname}`} className="text-sky-600 hover:text-sky-800">
                          ↗
                        </Link>
                      )}
                    </div>
                  </td>
                  <td className="w-20 px-2 py-1">
                    <div className="flex flex-wrap gap-0.5">
                      {[...new Set(heads.map((h) => h.code))].map((c) => (
                        <span key={c} className={`rounded-full border px-1.5 text-[10px] ${BOOK_CHIP[c] ?? 'border-zinc-200 bg-zinc-50 text-zinc-500'}`}>
                          {c}
                        </span>
                      ))}
                      {m && heads.length === 0 && <span className="text-[10px] text-zinc-300">—</span>}
                    </div>
                  </td>
                  <td className="w-32 px-1 py-0.5">
                    <select name="expenseType" form={fid} defaultValue={m?.expenseType ?? ''} className={`${cellCls} bg-white`}>
                      <option value=""></option>
                      {CC_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </td>
                  <td className="w-24 px-1 py-0.5">
                    <input
                      name="bankBudget"
                      form={fid}
                      inputMode="decimal"
                      defaultValue={m?.bankBudget == null ? '' : String(Math.round(Number(m.bankBudget)))}
                      title="− = receipt"
                      className={`${cellCls} text-right tabular-nums ${Number(m?.bankBudget) < 0 ? 'font-medium text-emerald-700' : ''}`}
                    />
                  </td>
                  <td className="w-20 px-1 py-0.5">
                    <input
                      name="cashBudget"
                      form={fid}
                      inputMode="decimal"
                      defaultValue={m?.cashBudget == null ? '' : String(Math.round(Number(m.cashBudget)))}
                      className={`${cellCls} text-right tabular-nums`}
                    />
                  </td>
                  <td className="w-28 px-1 py-0.5">
                    <select name="frequency" form={fid} defaultValue={m?.frequency ?? ''} className={`${cellCls} bg-white`}>
                      <option value=""></option>
                      {Object.entries(FREQ_LABEL).map(([v, l]) => (
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </select>
                  </td>
                  <td className="w-20 px-1 py-0.5">
                    <input name="dayNote" form={fid} defaultValue={m?.dayNote ?? ''} placeholder="27 / Fri" className={cellCls} />
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
              )
            })}
          </tbody>
        </table>
        <datalist id="bank-mode-options">
          {BANK_MODES.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
        <p className="border-t border-zinc-100 px-4 py-2 text-[11px] text-zinc-400">
          This register is the master — ✓ saves a row and updates the plan, budgets, modes and cost centres everywhere.
          Books &quot;auto&quot; follows the bank mode; pick one to pin it. Negative budget = receipt. Click a head for its
          ledger, ↗ for the bank&apos;s.
        </p>
      </div>
    </div>
  )
}
