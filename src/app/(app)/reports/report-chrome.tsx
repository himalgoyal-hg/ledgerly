import Link from 'next/link'
import { displayINR } from '@/lib/ledger/money'
import type { StatementSection } from '@/lib/reports/statements'
import { PageHeader, controlClass, tableWrapClass, theadClass } from '@/components/ui'

// Shared report furniture: the header with date filters, export and print,
// and the section table used by P&L / Balance Sheet.

export function ReportHeader(props: {
  title: string
  subtitle?: string
  entityLabel: string
  /** Rendered inside the filter form — date inputs, month pickers, etc. */
  filters?: React.ReactNode
  exportHref?: string
}) {
  return (
    <PageHeader
      title={`${props.title} — ${props.entityLabel}`}
      subtitle={props.subtitle}
      actions={
        <>
          {props.filters && (
            <form className="flex flex-wrap items-center gap-2">{props.filters}</form>
          )}
          {props.exportHref && (
            <Link
              href={props.exportHref}
              prefetch={false}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              Export CSV
            </Link>
          )}
          <PrintButton />
        </>
      }
    />
  )
}

/** Print → the browser's "Save as PDF" covers the spec's PDF requirement. */
function PrintButton() {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink">
        Print / PDF
      </summary>
      <p className="absolute right-0 z-10 mt-1 w-56 rounded-lg border border-line bg-surface p-2 text-xs text-ink-2 shadow-md">
        Use your browser&apos;s Print (⌘P) and choose &quot;Save as PDF&quot;. Filters,
        navigation and buttons are hidden in print.
      </p>
    </details>
  )
}

export function DateRangeFilters(props: { from?: string; to?: string }) {
  return (
    <>
      <input
        type="date"
        name="from"
        defaultValue={props.from}
        className={controlClass}
      />
      <span className="text-xs text-ink-3">to</span>
      <input
        type="date"
        name="to"
        defaultValue={props.to}
        className={controlClass}
      />
      <button
        type="submit"
        className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink"
      >
        Apply
      </button>
    </>
  )
}

/** A statement section, grouped by CoA parent, each line drillable. */
export function SectionTable(props: { section: StatementSection; range: string }) {
  const byGroup = new Map<string, typeof props.section.lines>()
  for (const line of props.section.lines) {
    byGroup.set(line.group, [...(byGroup.get(line.group) ?? []), line])
  }

  return (
    <div className={tableWrapClass}>
      <table className="w-full text-left text-sm">
        <thead className={theadClass}>
          <tr>
            <th className="px-4 py-2">{props.section.title}</th>
            <th className="px-4 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-2">
          {[...byGroup.entries()].map(([group, lines]) => (
            <tr key={group}>
              <td colSpan={2} className="p-0">
                <table className="w-full">
                  <tbody>
                    <tr>
                      <td className="bg-surface-2/60 px-4 py-1 text-xs font-medium uppercase text-ink-2">
                        {group}
                      </td>
                    </tr>
                    {lines.map((line) => (
                      <tr key={line.accountId} className="border-t border-line-2">
                        <td className="px-4 py-2">
                          <Link
                            href={`/reports/ledger?accountId=${line.accountId}${props.range}`}
                            className="text-ink hover:underline"
                          >
                            <span className="font-mono text-xs text-ink-3">{line.code}</span>{' '}
                            {line.name}
                          </Link>
                        </td>
                        <td className="w-40 px-4 py-2 text-right text-ink-2">
                          {displayINR(line.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </td>
            </tr>
          ))}
          {props.section.lines.length === 0 && (
            <tr>
              <td colSpan={2} className="px-4 py-4 text-center text-sm text-ink-3">
                Nothing in this range.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot className="border-t border-line font-medium text-ink">
          <tr>
            <td className="px-4 py-2">Total {props.section.title.toLowerCase()}</td>
            <td className="px-4 py-2 text-right">{displayINR(props.section.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
