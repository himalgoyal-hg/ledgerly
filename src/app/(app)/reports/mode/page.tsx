import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import Link from 'next/link'

// Actual vs Plan Mode — the Finance-setup sheet's promise, checked against
// the books: each category says which bank account (and credit card) its
// payments are SUPPOSED to move on; every tagged statement/cash entry says
// where the money ACTUALLY moved. Same account → ✓, different → ⚠ with the
// stray account named. Cross-books, admin only. Nothing is typed by hand:
// upload the statement, tag the rows, and this report knows.

const inr = (n: number) => '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN')

// "Meena ICICI" on the sheet is "MG ICICI" in the app, etc.
const norm = (s: string) => s.toLowerCase().replace(/meena/g, 'mg').replace(/himal/g, 'hg')

function modeMatches(planned: string, actual: string, isCash: boolean): boolean {
  const p = norm(planned)
  const a = norm(actual)
  if (p === 'cash') return isCash
  const digits = p.match(/\d{3,}/g) ?? []
  if (digits.length) return digits.some((d) => a.includes(d))
  const tokens = p.split(/[^a-z0-9]+/).filter((t) => t && !['bank', 'account', 'balance'].includes(t))
  return tokens.length > 0 && tokens.every((t) => a.includes(t))
}

export default async function ActualVsPlanModePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  await requireAdmin()
  const params = await searchParams
  const nowKey = new Date().toISOString().slice(0, 7)
  const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? (params.month as string) : nowKey
  const from = new Date(`${month}-01T00:00:00Z`)
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1))

  // months that actually have tagged movement, for the chips
  const monthRows = await prisma.$queryRaw<{ m: string }[]>`
    SELECT DISTINCT to_char(date_trunc('month', e.date), 'YYYY-MM') AS m
    FROM "JournalEntry" e ORDER BY 1 DESC LIMIT 12
  `

  // head × paying-account pairs from the ledger: the head line of an entry
  // paired with its bank/cash counter-line (reversals net out in the SUM)
  const pairs = await prisma.$queryRaw<
    { head: string; acct: string; acct_no: string | null; is_cash: boolean; amt: string }[]
  >`
    SELECT ha.name AS head, COALESCE(b.nickname, cl.name) AS acct,
           b."accountNumber" AS acct_no,
           (cl.id IS NOT NULL) AS is_cash,
           SUM(hl.debit - hl.credit)::text AS amt
    FROM "JournalLine" hl
    JOIN "JournalEntry" e ON e.id = hl."entryId"
    JOIN "LedgerAccount" ha ON ha.id = hl."accountId"
    JOIN "JournalLine" ml ON ml."entryId" = e.id AND ml.id <> hl.id
    JOIN "LedgerAccount" ma ON ma.id = ml."accountId"
    LEFT JOIN "BankAccount" b ON b."ledgerAccountId" = ma.id
    LEFT JOIN "CashLocation" cl ON cl."ledgerAccountId" = ma.id
    WHERE ha.kind IN ('EXPENSE', 'INCOME')
      AND (b.id IS NOT NULL OR cl.id IS NOT NULL)
      AND e.date >= ${from} AND e.date < ${to}
    GROUP BY 1, 2, 3, 4
    HAVING SUM(hl.debit - hl.credit) <> 0
    ORDER BY 1
  `

  const modes = await prisma.headMode.findMany()
  const modeByCat = new Map(modes.map((m) => [m.category.toLowerCase(), m]))

  // group pairs by head; matching sees nickname + account number, since
  // nicknames like "HG HDFC" carry the digits only in the number
  const byHead = new Map<string, { acct: string; matchKey: string; isCash: boolean; amt: number }[]>()
  for (const p of pairs) {
    const list = byHead.get(p.head) ?? []
    list.push({ acct: p.acct, matchKey: `${p.acct} ${p.acct_no ?? ''}`, isCash: p.is_cash, amt: Number(p.amt) })
    byHead.set(p.head, list)
  }

  const rows = [...byHead.entries()]
    .map(([head, accts]) => {
      const mode = modeByCat.get(head.toLowerCase()) ?? null
      const planned = mode?.modeBank ?? null
      const checked = accts.map((a) => ({
        ...a,
        ok: planned
          ? modeMatches(planned, a.matchKey, a.isCash) ||
            (mode?.modeCc ? modeMatches(mode.modeCc, a.matchKey, a.isCash) : false)
          : null,
      }))
      const total = accts.reduce((t, a) => t + Math.abs(a.amt), 0)
      const status: 'ok' | 'off' | 'none' = !planned
        ? 'none'
        : checked.every((a) => a.ok)
          ? 'ok'
          : 'off'
      return { head, mode, planned, checked, total, status }
    })
    .sort((a, b) => (a.status === 'off' ? 0 : a.status === 'ok' ? 1 : 2) - (b.status === 'off' ? 0 : b.status === 'ok' ? 1 : 2) || b.total - a.total)

  const offCount = rows.filter((r) => r.status === 'off').length
  const monthLabel = (k: string) =>
    new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' })

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Actual vs Plan Mode</h1>
        <p className="mt-1 text-sm text-zinc-500">
          The Finance-setup sheet says which account each category should move on; the tagged entries say where the money
          actually moved. ⚠ means a payment came from a different account than planned.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Entries in</span>
        {monthRows.map((r) => (
          <Link
            key={r.m}
            href={`/reports/mode?month=${r.m}`}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${
              r.m === month
                ? 'border-zinc-900 bg-zinc-900 text-white'
                : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100'
            }`}
          >
            {monthLabel(r.m)}
          </Link>
        ))}
        <span className="ml-auto text-xs text-zinc-500">
          {rows.length ? (offCount ? `⚠ ${offCount} categor${offCount > 1 ? 'ies' : 'y'} off-plan` : 'all on plan ✓') : ''}
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
              <th className="px-2 py-2">Category</th>
              <th className="px-2 py-2">Expense type</th>
              <th className="px-2 py-2">Planned mode (Bank · CC)</th>
              <th className="px-2 py-2">Actually moved on</th>
              <th className="px-2 py-2 text-right">₹ this month</th>
              <th className="px-2 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.map((r) => (
              <tr key={r.head} className={r.status === 'off' ? 'bg-amber-50/50' : 'hover:bg-zinc-50/60'}>
                <td className="px-2 py-1.5 font-medium text-zinc-800">{r.head}</td>
                <td className="px-2 py-1.5 text-xs text-zinc-500">{r.mode?.expenseType ?? '—'}</td>
                <td className="px-2 py-1.5 text-xs text-zinc-600">
                  {r.planned ?? '—'}
                  {r.mode?.modeCc ? <span className="text-zinc-400"> · {r.mode.modeCc}</span> : null}
                </td>
                <td className="px-2 py-1.5 text-xs">
                  <div className="flex flex-wrap gap-1">
                    {r.checked.map((a) => (
                      <span
                        key={a.acct}
                        className={`rounded-full border px-2 py-0.5 ${
                          a.ok === false
                            ? 'border-amber-300 bg-amber-50 text-amber-800'
                            : a.ok === true
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                              : 'border-zinc-200 bg-zinc-50 text-zinc-600'
                        }`}
                        title={a.ok === false ? `Planned: ${r.planned}` : undefined}
                      >
                        {a.acct} {inr(a.amt)}
                        {a.amt < 0 ? ' in' : ''}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-zinc-700">{inr(r.total)}</td>
                <td className="px-2 py-1.5 text-xs">
                  {r.status === 'ok' && <span className="text-emerald-700">✓ as planned</span>}
                  {r.status === 'off' && <span className="font-medium text-amber-700">⚠ different account</span>}
                  {r.status === 'none' && <span className="text-zinc-400">no planned mode</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-zinc-400">
                  No tagged movement in {monthLabel(month)} — upload and tag that month&apos;s statements first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-zinc-400">
        Planned modes come from the Finance-setup sheet (81 categories). Matching is by account number and name — Meena =
        MG, Cash = any cash location.
      </p>
    </div>
  )
}
