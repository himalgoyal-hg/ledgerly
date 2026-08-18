import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { SmartCombobox } from '@/components/smart-combobox'
import {
  createAccount,
  archiveAccount,
  restoreAccount,
  renameAccount,
  setDefaultCostCentre,
  syncMasterSheetAction,
} from './actions'

export default async function CoaPage() {
  const user = await requireAdmin()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-zinc-500">Create an entity first.</p>

  const [accounts, costCentres, modes, planLines] = await Promise.all([
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id },
      include: { _count: { select: { lines: true } } },
      orderBy: { code: 'asc' },
    }),
    prisma.costCentre.findMany({
      where: { entityId: entity.id, archivedAt: null },
      orderBy: { name: 'asc' },
    }),
    prisma.headMode.findMany(),
    prisma.budgetLine.findMany({ where: { archivedAt: null, frequency: { not: 'ONCE' } } }),
  ])
  // bank modes resolved to real accounts link straight to that bank's ledger
  const banks = await prisma.bankAccount.findMany({
    select: { id: true, nickname: true, ledgerAccountId: true },
  })
  const bankById = new Map(banks.map((b) => [b.id, b]))
  // the whole master, plus where each category's head actually lives
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
  const groups = accounts.filter((a) => a.isGroup)
  const depth = (code: string) => (code.endsWith('000') ? 0 : code.endsWith('00') ? 1 : code.endsWith('0') ? 2 : 2)

  // The master sheet's word on each head: planned bank/CC mode, expense
  // type, and the plan line (budget × frequency, due day) — shown right in
  // the chart so one look answers "how is this head supposed to behave?"
  const modeByName = new Map(modes.map((m) => [m.category.toLowerCase(), m]))
  const planByName = new Map<string, (typeof planLines)[number][]>()
  for (const l of planLines) {
    const key = l.label.toLowerCase()
    planByName.set(key, [...(planByName.get(key) ?? []), l])
  }
  const freqShort: Record<string, string> = {
    DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', QUARTERLY: 'quarterly',
    HALF_YEARLY: 'half-yearly', ANNUAL: 'annual',
  }
  const inrFmt = (n: number) => '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">
            Chart of Accounts — {entity.name} ({entity.code})
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Seeded automatically on entity creation. Group heads structure the
            tree; postings go to leaf accounts only.
          </p>
        </div>
        {/* the whole app reads the master sheet; this button pulls it fresh */}
        <form action={syncMasterSheetAction}>
          <button
            type="submit"
            title="Fetches 'New Finance setup HG' from the Google Sheet and updates plan lines, heads, modes, cost centres and budgets everywhere"
            className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
          >
            ⟳ Sync from master sheet
          </button>
        </form>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Account</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Plan (master sheet)</th>
              <th className="px-4 py-3">Default cost centre</th>
              <th className="px-4 py-3 text-right">Postings</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {accounts.map((a) => (
              <tr key={a.id} className={a.archivedAt ? 'opacity-40' : undefined}>
                <td className="px-4 py-1.5 font-mono text-xs text-zinc-500">{a.code}</td>
                <td className="px-4 py-1.5">
                  <span style={{ paddingLeft: `${depth(a.code) * 1.25}rem` }}>
                    {a.isGroup ? (
                      <span className="font-medium text-zinc-800">{a.name}</span>
                    ) : (
                      <Link href={`/admin/ledgers?accountId=${a.id}`} className="text-zinc-700 hover:underline">
                        {a.name}
                      </Link>
                    )}
                    {a.system && <span className="ml-2 text-[10px] uppercase text-zinc-300">system</span>}
                    {a.archivedAt && <span className="ml-2 text-[10px] text-zinc-400">archived</span>}
                  </span>
                </td>
                <td className="px-4 py-1.5 text-xs text-zinc-500">{a.kind}</td>
                <td className="px-4 py-1.5 text-xs">
                  {!a.isGroup &&
                    (() => {
                      const mode = modeByName.get(a.name.toLowerCase())
                      const lines = planByName.get(a.name.toLowerCase()) ?? []
                      if (!mode && lines.length === 0) return <span className="text-zinc-300">—</span>
                      return (
                        <div className="flex flex-wrap items-center gap-1">
                          {mode?.modeBank &&
                            (() => {
                              const bank = mode.bankAccountId ? bankById.get(mode.bankAccountId) : null
                              const chip = (
                                <span
                                  className={`rounded-full border px-2 py-0.5 ${bank ? 'border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100' : 'border-sky-200 bg-sky-50 text-sky-800'}`}
                                  title={bank ? `Planned bank mode — linked to ${bank.nickname}; click for its ledger` : 'Planned bank mode'}
                                >
                                  {mode.modeBank}
                                  {bank ? ' ↗' : ''}
                                </span>
                              )
                              return bank?.ledgerAccountId ? (
                                <Link href={`/admin/ledgers?accountId=${bank.ledgerAccountId}`}>{chip}</Link>
                              ) : (
                                chip
                              )
                            })()}
                          {mode?.modeCc && (
                            <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-violet-800" title="Planned credit card">
                              {mode.modeCc}
                            </span>
                          )}
                          {mode?.expenseType && (
                            <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-zinc-600" title="Expense type">
                              {mode.expenseType}
                            </span>
                          )}
                          {lines.map((l) => (
                            <span
                              key={l.id}
                              className={`rounded-full border px-2 py-0.5 ${Number(l.amount) < 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50/70 text-amber-800'}`}
                              title={`Plan: ${Number(l.amount) < 0 ? 'receipt' : 'payment'} from ${l.source}${l.dayNote ? ` — day ${l.dayNote}` : ''}`}
                            >
                              {inrFmt(Number(l.amount))} {freqShort[l.frequency] ?? l.frequency}
                              {Number(l.amount) < 0 ? ' in' : ''}
                              {l.dayNote ? ` · ${l.dayNote}` : ''}
                            </span>
                          ))}
                        </div>
                      )
                    })()}
                </td>
                <td className="px-4 py-1.5">
                  {/* v2 prototype: this default auto-fills tagging & cash forms */}
                  {!a.isGroup ? (
                    <form action={setDefaultCostCentre} className="flex items-center gap-1">
                      <input type="hidden" name="id" value={a.id} />
                      <SmartCombobox
                        options={costCentres.map((c) => ({ id: c.id, label: c.name }))}
                        name="costCentreId"
                        createName="costCentreText"
                        defaultId={a.defaultCostCentreId}
                        placeholder="—"
                        className="w-40 rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-600"
                      />
                      <button type="submit" className="text-[10px] text-zinc-400 hover:text-zinc-700">
                        set
                      </button>
                    </form>
                  ) : (
                    <span className="text-xs text-zinc-300">—</span>
                  )}
                </td>
                <td className="px-4 py-1.5 text-right text-xs text-zinc-500">
                  {a.isGroup ? '—' : a._count.lines}
                </td>
                <td className="px-4 py-1.5 text-right">
                  {!a.isGroup && (
                    <details className="relative inline-block text-left">
                      <summary className="cursor-pointer list-none text-xs text-zinc-400 hover:text-zinc-700">rename</summary>
                      <form
                        action={renameAccount}
                        className="absolute right-0 z-10 mt-1 flex w-64 gap-2 rounded-lg border border-zinc-200 bg-white p-2 shadow-md"
                      >
                        <input type="hidden" name="id" value={a.id} />
                        <input name="name" defaultValue={a.name} required className="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm" />
                        <button type="submit" className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-700">
                          Save
                        </button>
                      </form>
                    </details>
                  )}
                  {!a.isGroup && !a.system && (
                    <form action={a.archivedAt ? restoreAccount : archiveAccount} className="ml-3 inline">
                      <input type="hidden" name="id" value={a.id} />
                      <button type="submit" className="text-xs text-zinc-400 hover:text-zinc-700">
                        {a.archivedAt ? 'restore' : 'archive'}
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">Add account head</h2>
        <form action={createAccount} className="mt-3 flex flex-wrap gap-2">
          <input type="hidden" name="entityId" value={entity.id} />
          <select name="parentId" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm">
            <option value="">Under group…</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.code} · {g.name}
              </option>
            ))}
          </select>
          <input
            name="name"
            placeholder="Account name (e.g. ACPL Hyrox)"
            required
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700">
            Add account
          </button>
        </form>
      </div>

      {/* The whole master sheet, mirrored — every category across ALL books,
          zero-budget rows included, exactly as the sheet holds them */}
      <details className="rounded-xl border border-zinc-200 bg-white shadow-sm" open>
        <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50">
          Master sheet — every category ({modes.length})
        </summary>
        <div className="overflow-x-auto border-t border-zinc-100">
          <table className="w-full min-w-[64rem] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
                <th className="px-3 py-2">Category</th>
                <th className="px-2 py-2">Books</th>
                <th className="px-2 py-2">Nature</th>
                <th className="px-2 py-2">Bank mode</th>
                <th className="px-2 py-2">Cost centre</th>
                <th className="px-2 py-2 text-right">Bank budget ₹</th>
                <th className="px-2 py-2 text-right">Cash budget ₹</th>
                <th className="px-2 py-2">Frequency</th>
                <th className="px-2 py-2">Day</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {[...modes]
                .sort((x, y) => x.category.localeCompare(y.category))
                .map((m) => {
                  const heads = headsByName.get(m.category.toLowerCase()) ?? []
                  const bank = m.bankAccountId ? bankById.get(m.bankAccountId) : null
                  const budget = (v: unknown) =>
                    v == null ? '' : (Number(v) < 0 ? '-₹' : '₹') + Math.abs(Number(v)).toLocaleString('en-IN')
                  return (
                    <tr key={m.id} className="hover:bg-zinc-50/60">
                      <td className="px-3 py-1 text-xs font-medium text-zinc-800">
                        {heads.length > 0 ? (
                          <Link href={`/admin/ledgers?accountId=${heads[0].id}`} className="hover:underline">
                            {m.category}
                          </Link>
                        ) : (
                          <span title="No head in any books yet">{m.category}</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-[11px]">
                        {heads.length ? (
                          <span className="text-zinc-500">{[...new Set(heads.map((h) => h.code))].join(' · ')}</span>
                        ) : (
                          <span className="text-zinc-300">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-[11px] text-zinc-500">{m.nature ?? ''}</td>
                      <td className="px-2 py-1 text-[11px]">
                        {m.modeBank ? (
                          bank?.ledgerAccountId ? (
                            <Link
                              href={`/admin/ledgers?accountId=${bank.ledgerAccountId}`}
                              className="text-sky-700 hover:underline"
                              title={`Linked to ${bank.nickname}`}
                            >
                              {m.modeBank} ↗
                            </Link>
                          ) : (
                            <span className="text-zinc-600">{m.modeBank}</span>
                          )
                        ) : (
                          ''
                        )}
                      </td>
                      <td className="px-2 py-1 text-[11px] text-zinc-500">{m.expenseType ?? ''}</td>
                      <td className={`px-2 py-1 text-right text-xs tabular-nums ${Number(m.bankBudget) < 0 ? 'text-emerald-700' : 'text-zinc-600'}`}>
                        {budget(m.bankBudget)}
                      </td>
                      <td className="px-2 py-1 text-right text-xs tabular-nums text-zinc-600">{budget(m.cashBudget)}</td>
                      <td className="px-2 py-1 text-[11px] text-zinc-500">{m.frequency ? freqLabel[m.frequency] ?? m.frequency : ''}</td>
                      <td className="px-2 py-1 text-[11px] text-zinc-500">{m.dayNote ?? ''}</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-2 text-[11px] text-zinc-400">
          Mirrored from &quot;New Finance setup HG&quot; on every ⟳ sync — negative budgets are receipts; click a category for its ledger, a bank mode for the account&apos;s.
        </p>
      </details>
    </div>
  )
}
