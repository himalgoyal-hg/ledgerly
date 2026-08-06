import Link from 'next/link'
import { displayINR } from '@/lib/ledger/money'
import type { StatementSection } from '@/lib/reports/statements'

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
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">
          {props.title} — {props.entityLabel}
        </h1>
        {props.subtitle && <p className="mt-1 text-sm text-zinc-500">{props.subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {props.filters && (
          <form className="flex flex-wrap items-center gap-2">{props.filters}</form>
        )}
        {props.exportHref && (
          <Link
            href={props.exportHref}
            prefetch={false}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
          >
            Export CSV
          </Link>
        )}
        <PrintButton />
      </div>
    </div>
  )
}

/** Print → the browser's "Save as PDF" covers the spec's PDF requirement. */
function PrintButton() {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">
        Print / PDF
      </summary>
      <p className="absolute right-0 z-10 mt-1 w-56 rounded-md border border-zinc-200 bg-white p-2 text-xs text-zinc-500 shadow-md">
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
        className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
      />
      <span className="text-xs text-zinc-400">to</span>
      <input
        type="date"
        name="to"
        defaultValue={props.to}
        className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
      />
      <button
        type="submit"
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
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
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
          <tr>
            <th className="px-4 py-2">{props.section.title}</th>
            <th className="px-4 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {[...byGroup.entries()].map(([group, lines]) => (
            <tr key={group}>
              <td colSpan={2} className="p-0">
                <table className="w-full">
                  <tbody>
                    <tr>
                      <td className="bg-zinc-50 px-4 py-1 text-xs font-medium uppercase text-zinc-500">
                        {group}
                      </td>
                    </tr>
                    {lines.map((line) => (
                      <tr key={line.accountId} className="border-t border-zinc-50">
                        <td className="px-4 py-2">
                          <Link
                            href={`/reports/ledger?accountId=${line.accountId}${props.range}`}
                            className="text-zinc-800 hover:underline"
                          >
                            <span className="font-mono text-xs text-zinc-400">{line.code}</span>{' '}
                            {line.name}
                          </Link>
                        </td>
                        <td className="w-40 px-4 py-2 text-right text-zinc-700">
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
              <td colSpan={2} className="px-4 py-4 text-center text-sm text-zinc-400">
                Nothing in this range.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot className="border-t border-zinc-300 font-medium text-zinc-900">
          <tr>
            <td className="px-4 py-2">Total {props.section.title.toLowerCase()}</td>
            <td className="px-4 py-2 text-right">{displayINR(props.section.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
