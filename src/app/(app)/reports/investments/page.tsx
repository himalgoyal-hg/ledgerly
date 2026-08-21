import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { investmentReport } from '@/lib/reports/prototype'
import { PageHeader, tableWrapClass, theadClass } from '@/components/ui'
import { HeadLensFilters, readHeadLens, ResetFilters } from '../report-chrome'

const inr = (n: number) => (n ? '₹' + Math.round(n).toLocaleString('en-IN') : '—')

export default async function InvestmentsPage(props: {
  searchParams: Promise<{ head?: string; ah?: string; by?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">Create an entity first.</p>
  const params = await props.searchParams
  // the two lenses every head report carries (Himal, 21 Aug): the same
  // grids either way, the Accounting Head one leading each with what is
  // filed under a different head
  const lens = readHeadLens(params)
  const [r, allHeads] = await Promise.all([
    investmentReport(entity.id, 12, lens),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, kind: true },
    }),
  ])
  // only the accounts this report can hold — its own income and asset
  // heads. Offering the rest would just empty the page (the Balance Sheet
  // lesson, Himal 20 Aug).
  const invHeads = await prisma.ledgerAccount.findMany({
    where: {
      entityId: entity.id,
      isGroup: false,
      archivedAt: null,
      OR: [
        { kind: 'INCOME', name: { contains: 'interest', mode: 'insensitive' } },
        { kind: 'INCOME', name: { contains: 'dividend', mode: 'insensitive' } },
        { kind: 'INCOME', name: { contains: 'investment', mode: 'insensitive' } },
        { kind: 'ASSET', name: { contains: 'invest', mode: 'insensitive' } },
        { kind: 'ASSET', name: { contains: 'shares', mode: 'insensitive' } },
        { kind: 'ASSET', name: { contains: 'mutual', mode: 'insensitive' } },
        { kind: 'ASSET', name: { contains: 'sip', mode: 'insensitive' } },
      ],
    },
    orderBy: { name: 'asc' },
    select: { id: true, code: true, name: true, kind: true },
  })
  const cellR = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap'
  const signed = (n: number) => (n < 0 ? '−' : '') + inr(Math.abs(n))
  const grid = (title: string, note: string, rows: typeof r.income, band: typeof r.incomeRePointed) => (
    <div className={tableWrapClass}>
      <div className="border-b border-line-2 px-4 py-3">
        <h2 className="font-medium text-ink">{title}</h2>
        <p className="text-xs text-ink-3">{note}</p>
      </div>
      <table className="w-full min-w-[860px] text-xs">
        <thead className={theadClass}>
          <tr><th className="px-2 py-2">Account</th>{r.months.map((k) => <th key={k.key} className={cellR}>{k.label}</th>)}<th className={cellR}>Total</th></tr>
        </thead>
        <tbody className="divide-y divide-line-2 text-sm">
          {/* the re-pointed band first — a memo, already inside the rows */}
          {band.length > 0 && (
            <>
              <tr className="bg-primary-soft/60">
                <td colSpan={14} className="px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-primary">
                  Filed under a different Accounting Head
                  <span className="ml-2 font-normal normal-case tracking-normal text-primary/80">already inside the rows below — shown, not added</span>
                </td>
              </tr>
              {band.map((x) => (
                <tr key={`${x.name}<${x.from}`} className="bg-primary-soft/40">
                  <td className="px-2 py-1.5 font-medium text-primary">
                    {x.name}
                    <span className="ml-1.5 rounded bg-primary/15 px-1 text-[9px] font-semibold uppercase tracking-wide text-primary">changed</span>
                    <span className="ml-2 text-xs font-normal text-ink-3">from {x.from}</span>
                  </td>
                  {x.cells.map((c, i) => <td key={i} className={`${cellR} text-primary`}>{c ? signed(c) : '—'}</td>)}
                  <td className={`${cellR} font-semibold text-primary`}>{signed(x.total)}</td>
                </tr>
              ))}
            </>
          )}
          {rows.map((x) => (
            <tr key={x.name} className="hover:bg-surface-2/60">
              <td className="px-2 py-1.5 text-ink">{x.name}</td>
              {x.cells.map((c, i) => <td key={i} className={`${cellR} text-ink-2`}>{inr(c)}</td>)}
              <td className={`${cellR} font-semibold`}>{inr(x.total)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={14} className="px-4 py-4 text-ink-3">Nothing matching yet — accounts named interest / dividend / capital gain / investment appear here.</td></tr>}
        </tbody>
      </table>
    </div>
  )
  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Report"
        title={<>Capital gains, dividend &amp; interest — {entity.code}</>}
        subtitle={[
          lens.lens === 'ah'
            ? 'By Accounting Head — the same grids, with what is filed under a different head shown first'
            : 'By Expense Head',
          lens.headAccountId ? `only ${allHeads.find((h) => h.id === lens.headAccountId)?.name ?? '—'}` : '',
          lens.accountingHeadId ? `only ${allHeads.find((h) => h.id === lens.accountingHeadId)?.name ?? '—'}` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <form className="flex flex-wrap items-center gap-1">
            <HeadLensFilters
              base="/reports/investments"
              lens={lens.lens}
              headOptions={invHeads}
              ahOptions={allHeads}
              pickedHead={params.head}
              pickedAh={params.ah}
              headPlaceholder="All investment heads — type to search"
            />
            <ResetFilters base="/reports/investments" active={Boolean(params.head || params.ah || params.by)} />
            <button type="submit" className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink">
              Apply
            </button>
          </form>
        }
      />
      {grid('Investment & other income received', 'interest, dividend and other receipts by month', r.income, r.incomeRePointed)}
      {grid('Amounts invested', 'SIPs, shares, deposits — money moved into investment accounts', r.invested, r.investedRePointed)}
    </div>
  )
}
