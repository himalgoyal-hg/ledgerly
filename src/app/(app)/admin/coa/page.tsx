import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { saveMasterRowAction, removeMasterRowAction } from './actions'
import { ConfirmButton } from '@/components/confirm-button'

// Accounts IS the master register now (Himal, 18 Aug 2026): every category
// with its bank mode, cost centre, budgets, frequency, day and nature —
// edited here or pulled from the sheet with ⟳, and propagated everywhere
// (plan, budgets, modes, cost centres, heads) on every save. The old chart
// tree is gone from this screen; ledgers stay reachable via the links.

export default async function CoaPage() {
  const user = await requireAdmin()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>

  const modes = await prisma.headMode.findMany()
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
  const freqLabel: Record<string, string> = {
    DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly',
    HALF_YEARLY: 'Half yearly', ANNUAL: 'Annual',
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Accounts — master register</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Every expense head with its bank mode, cost centre, budgets, frequency, day and nature — edit a cell and hit ✓,
            and the plan, budgets and reports update everywhere. All books in one list.
          </p>
        </div>
        {/* This register IS the master (Himal, 18 Aug 2026) — the Google
            Sheet sync is retired so nothing ever overwrites edits made here. */}
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full min-w-[68rem] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
              <th className="px-3 py-2">Expense Head ({modes.length})</th>
              <th className="px-2 py-2">Books</th>
              <th className="px-2 py-2">Nature</th>
              <th className="px-2 py-2">Bank mode</th>
              <th className="px-2 py-2">Cost centre</th>
              <th className="px-2 py-2 text-right">Bank budget ₹</th>
              <th className="px-2 py-2 text-right">Cash budget ₹</th>
              <th className="px-2 py-2">Frequency</th>
              <th className="px-2 py-2">Day</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {[null, ...[...modes].sort((x, y) => x.category.localeCompare(y.category))].map((m) => {
              const fid = m ? `mr-${m.id}` : 'mr-new'
              const heads = m ? (headsByName.get(m.category.toLowerCase()) ?? []) : []
              const bank = m?.bankAccountId ? bankById.get(m.bankAccountId) : null
              const cellCls =
                'w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-xs hover:border-zinc-300 focus:border-zinc-400 focus:bg-white focus:outline-none'
              return (
                <tr key={m?.id ?? 'new'} className={m ? 'hover:bg-zinc-50/60' : 'bg-emerald-50/40'}>
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
                      <input name="category" form={fid} required placeholder="＋ New expense head…" className={`${cellCls} border-dashed border-zinc-300`} />
                    )}
                  </td>
                  <td className="px-2 py-1 text-[11px]">
                    {heads.length ? (
                      <span className="text-zinc-500">{[...new Set(heads.map((h) => h.code))].join(' · ')}</span>
                    ) : (
                      <span className="text-zinc-300">—</span>
                    )}
                  </td>
                  <td className="w-24 px-1 py-0.5">
                    <select name="nature" form={fid} defaultValue={m?.nature ?? ''} className={`${cellCls} bg-white`}>
                      <option value=""></option>
                      {['Expense', 'Income', 'Liability', 'Asset', 'Contra', 'Personal'].map((n) => (
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
                  <td className="w-32 px-1 py-0.5">
                    <select name="expenseType" form={fid} defaultValue={m?.expenseType ?? ''} className={`${cellCls} bg-white`}>
                      <option value=""></option>
                      {['Compulsory', 'Optional-Lifestyle', 'Optional-growth', 'Optional-Investment'].map((t) => (
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
                      className={`${cellCls} text-right tabular-nums ${Number(m?.bankBudget) < 0 ? 'text-emerald-700' : ''}`}
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
                      {Object.entries(freqLabel).map(([v, l]) => (
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </select>
                  </td>
                  <td className="w-20 px-1 py-0.5">
                    <input name="dayNote" form={fid} defaultValue={m?.dayNote ?? ''} placeholder="27 / Fri" className={cellCls} />
                  </td>
                  <td className="whitespace-nowrap px-1 py-0.5 text-right">
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
          {['HDFC 2762', 'HDFC 4271', 'ACPL HDFC 7838', 'HG ICICI', 'Meena ICICI', 'Meena Axis', 'Cash', 'Greeshma balance'].map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
        <p className="border-t border-zinc-100 px-4 py-2 text-[11px] text-zinc-400">
          This register is the master — edit any cell and hit ✓, and the plan, budgets, modes and cost centres update
          everywhere at once. Negative budget = receipt. Click a head for its ledger, ↗ for the bank&apos;s.
        </p>
      </div>
    </div>
  )
}
