import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { accountLedger } from '@/lib/ledger/queries'
import { displayINR } from '@/lib/ledger/money'
import { ReportHeader, DateRangeFilters } from '../report-chrome'
import { tableWrapClass, theadClass } from '@/components/ui'

// Drill-down (spec §10 "drill-down to source entry"): every report line
// links here — the account's statement with a running balance, each row
// naming the document that produced it.

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Manual journal',
  opening_balance: 'Opening balance',
  statement_txn: 'Bank statement',
  reimbursement: 'Reimbursement',
  reimbursement_settlement: 'Reimbursement settlement',
  cash_entry: 'Cash entry',
  bill: 'Bill',
  bill_payment: 'Bill payment',
  salary_run: 'Salary run',
  salary_payment: 'Salary payout',
  invoice: 'Invoice',
  invoice_payment: 'Invoice payment',
  gst_payment: 'GST payment',
  tds_deposit: 'TDS deposit',
}

export default async function LedgerDrilldownPage(props: {
  searchParams: Promise<{ accountId?: string; from?: string; to?: string }>
}) {
  const user = await requireUser()
  const entity = await getCurrentEntity(user)
  if (!entity) return <p className="text-sm text-ink-2">No books selected.</p>

  const params = await props.searchParams
  if (!params.accountId) {
    return <p className="text-sm text-ink-2">Pick an account from any report to drill in.</p>
  }
  const account = await prisma.ledgerAccount.findUniqueOrThrow({
    where: { id: params.accountId },
  })
  if (account.entityId !== entity.id) {
    throw new Error('That account belongs to another entity — switch books first')
  }

  const from = params.from ? new Date(params.from) : undefined
  const to = params.to ? new Date(params.to) : undefined
  const ledger = await accountLedger(account.id, { from, to })

  // Name the source document behind each entry.
  const docs = await prisma.journalDoc.findMany({
    where: { id: { in: [...new Set(ledger.lines.map((l) => l.docId))] } },
    select: { id: true, sourceType: true, deletedAt: true },
  })
  const docById = new Map(docs.map((d) => [d.id, d]))
  const query = new URLSearchParams({
    accountId: account.id,
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
  })

  return (
    <div className="space-y-6">
      <ReportHeader
        title={`${account.code} · ${account.name}`}
        entityLabel={`${entity.name} (${entity.code})`}
        subtitle={`Opening ${displayINR(ledger.opening)} → closing ${displayINR(ledger.closing)}`}
        filters={
          <>
            <input type="hidden" name="accountId" value={account.id} />
            <DateRangeFilters from={params.from} to={params.to} />
          </>
        }
        exportHref={`/reports/export?report=ledger&${query}`}
      />

      <div className={tableWrapClass}>
        <table className="w-full text-left text-sm">
          <thead className={theadClass}>
            <tr>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">Narration</th>
              <th className="px-4 py-2">Source</th>
              <th className="px-4 py-2 text-right">Debit</th>
              <th className="px-4 py-2 text-right">Credit</th>
              <th className="px-4 py-2 text-right">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            <tr className="bg-surface-2/60 text-xs text-ink-2">
              <td className="px-4 py-1.5" colSpan={5}>
                Opening balance
              </td>
              <td className="px-4 py-1.5 text-right">{displayINR(ledger.opening)}</td>
            </tr>
            {ledger.lines.map((line, index) => {
              const doc = docById.get(line.docId)
              return (
                <tr key={`${line.entryId}-${index}`} className={line.kind === 'REVERSAL' ? 'text-ink-3' : ''}>
                  <td className="px-4 py-2 text-xs text-ink-3">
                    {line.date.toISOString().slice(0, 10)}
                  </td>
                  <td className="px-4 py-2 text-ink">
                    {line.narration}
                    {line.reference && (
                      <span className="ml-2 text-xs text-ink-3">ref {line.reference}</span>
                    )}
                    {doc?.deletedAt && (
                      <span className="ml-2 rounded bg-danger-soft px-1.5 py-0.5 text-[10px] font-medium text-danger">
                        deleted
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-ink-2">
                    {doc ? (SOURCE_LABEL[doc.sourceType] ?? doc.sourceType) : '—'}
                    {line.kind === 'REVERSAL' && (
                      <span className="ml-1 rounded bg-surface-2 px-1 py-0.5 text-[10px]">reversal</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-ink-2">
                    {Number(line.debit) > 0 ? displayINR(line.debit) : ''}
                  </td>
                  <td className="px-4 py-2 text-right text-ink-2">
                    {Number(line.credit) > 0 ? displayINR(line.credit) : ''}
                  </td>
                  <td className="px-4 py-2 text-right font-medium text-ink">
                    {displayINR(line.running)}
                  </td>
                </tr>
              )
            })}
            {ledger.lines.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-ink-3">
                  No postings in this range.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="border-t border-line font-medium text-ink">
            <tr>
              <td className="px-4 py-2" colSpan={5}>
                Closing balance
              </td>
              <td className="px-4 py-2 text-right">{displayINR(ledger.closing)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <Link href="/reports" className="text-sm text-ink-2 hover:underline print:hidden">
        ← back to reports
      </Link>
    </div>
  )
}
