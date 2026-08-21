import { Fragment } from 'react'
import Link from 'next/link'
import { HeadCombobox } from '@/components/head-combobox'
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

/**
 * A statement section — one table, one set of columns (Himal, 20 Aug:
 * "proper coloume made de, line ne structure"). Groups used to render as a
 * nested table each, so Opening and Balance drifted out of line from one
 * group to the next; now the group name is just a spanning row inside the
 * same grid, and every figure sits under its own ruled column.
 */
export function SectionTable(props: { section: StatementSection; range: string }) {
  const byGroup = new Map<string, typeof props.section.lines>()
  for (const line of props.section.lines) {
    byGroup.set(line.group, [...(byGroup.get(line.group) ?? []), line])
  }
  // The opening column only appears where opening balances exist at all —
  // a P&L has none, and an empty column would only take space.
  const showOpening = props.section.openingTotal !== undefined
  const cols = showOpening ? 3 : 2
  const num = 'px-4 py-2 text-right tabular-nums'

  return (
    <div className={tableWrapClass}>
      <table className="w-full table-fixed text-left text-sm">
        <colgroup>
          <col />
          {showOpening && <col className="w-32" />}
          <col className="w-36" />
        </colgroup>
        <thead className={theadClass}>
          <tr>
            <th className="px-4 py-2">{props.section.title}</th>
            {showOpening && (
              <th className={`${num} border-l border-line-2`} title="Brought forward — what this account opened at">
                Opening
              </th>
            )}
            <th className={`${num} border-l border-line-2`}>Balance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-2">
          {/* Under the Accounting Head lens the money filed under another
              head leads, highlighted (Himal, 21 Aug: the same report, with
              the changes at the start). A memo band: each figure is still
              inside the row it came out of, so it is not added again. */}
          {props.section.rePointed && props.section.rePointed.length > 0 && (
            <>
              <tr className="bg-primary-soft/60">
                <td colSpan={cols} className="px-4 py-1 text-[10px] font-bold uppercase tracking-widest text-primary">
                  Filed under a different Accounting Head
                  <span className="ml-2 font-normal normal-case tracking-normal text-primary/80">
                    already inside the rows below — shown, not added
                  </span>
                </td>
              </tr>
              {props.section.rePointed.map((m) => (
                <tr key={`${m.accountId}-${m.fromAccountId}`} className="bg-primary-soft/40">
                  <td className="px-4 py-2">
                    <Link
                      href={`/reports/ledger?accountId=${m.fromAccountId}${props.range}`}
                      className="font-medium text-primary hover:underline"
                      title={`Posted to ${m.fromName} — open that ledger`}
                    >
                      <span className="font-mono text-xs text-primary/70">{m.code}</span> {m.name}
                    </Link>
                    <span className="ml-1.5 rounded bg-primary/15 px-1 text-[9px] font-semibold uppercase tracking-wide text-primary">
                      changed
                    </span>
                    <span className="ml-2 text-xs text-ink-3">
                      from <span className="font-mono">{m.fromCode}</span> {m.fromName}
                    </span>
                  </td>
                  {showOpening && <td className="border-l border-line-2" />}
                  <td className={`${num} border-l border-line-2 font-medium text-primary`}>{displayINR(m.amount)}</td>
                </tr>
              ))}
            </>
          )}
          {[...byGroup.entries()].map(([group, lines]) => (
            <Fragment key={group}>
              <tr className="bg-surface-2/60">
                <td colSpan={cols} className="px-4 py-1 text-[10px] font-bold uppercase tracking-widest text-ink-3">
                  {group}
                </td>
              </tr>
              {lines.map((line) => (
                <tr key={line.accountId} className="hover:bg-surface-2/40">
                  <td className="px-4 py-2">
                    <Link
                      href={`/reports/ledger?accountId=${line.accountId}${props.range}`}
                      className="text-ink hover:underline"
                    >
                      <span className="font-mono text-xs text-ink-3">{line.code}</span> {line.name}
                    </Link>
                    {/* part of this row's money is in the band above; the
                        figure here is still the whole of it */}
                    {line.changed && (
                      <span
                        className="ml-1.5 rounded bg-surface-2 px-1 text-[9px] font-medium uppercase tracking-wide text-ink-3"
                        title="Some of this money is filed under a different Accounting Head — see the band at the top"
                      >
                        part re-pointed
                      </span>
                    )}
                  </td>
                  {showOpening && (
                    <td
                      className={`${num} border-l border-line-2 text-ink-3`}
                      title={line.opening ? 'Brought forward' : 'No opening balance entered'}
                    >
                      {line.opening ? displayINR(line.opening) : '—'}
                    </td>
                  )}
                  <td className={`${num} border-l border-line-2 text-ink-2`}>{displayINR(line.amount)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
          {props.section.lines.length === 0 && (
            <tr>
              <td colSpan={cols} className="px-4 py-4 text-center text-sm text-ink-3">
                Nothing in this range.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot className="border-t-2 border-line font-semibold text-ink">
          <tr>
            <td className="px-4 py-2">Total {props.section.title.toLowerCase()}</td>
            {showOpening && (
              <td className={`${num} border-l border-line-2 text-ink-3`}>
                {displayINR(props.section.openingTotal!)}
              </td>
            )}
            <td className={`${num} border-l border-line-2`}>{displayINR(props.section.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/**
 * The head lens, shared by every report whose rows ARE heads (Himal,
 * 20 Aug: "Report made avde sgl aahe hite pan asach add kar"). Two chips
 * choose what a row is — the account that was posted to, or the effective
 * Accounting Head — and a type-ahead narrows to one of them.
 *
 * Reports whose rows are money accounts (Bank balances, Cash vs bank) or
 * tax buckets (ITR summary) don't take it: there is no head to group by.
 */
export interface HeadOption {
  id: string
  code: string
  name: string
  kind: string
}

export function HeadLensFilters(props: {
  /** The report's own path, e.g. "/reports/balance-sheet". */
  base: string
  lens: 'head' | 'ah'
  /** Params to carry across a lens switch (dates, FY, and the like). */
  keep?: Record<string, string | undefined>
  /** Heads offered under each lens; the 'ah' list is usually every head. */
  headOptions: HeadOption[]
  ahOptions: HeadOption[]
  pickedHead?: string
  pickedAh?: string
  /** What the posting-head picker offers — "All accounts" on a sheet
   *  that holds more than expense heads. */
  headPlaceholder?: string
}) {
  const lensHref = (key: 'head' | 'ah') => {
    const s = new URLSearchParams()
    for (const [k, v] of Object.entries(props.keep ?? {})) if (v) s.set(k, v)
    if (key === 'ah') s.set('by', 'ah')
    const str = s.toString()
    return str ? `${props.base}?${str}` : props.base
  }
  const chip = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 text-sm font-medium ${
      active
        ? 'border-primary/40 bg-primary-soft text-primary'
        : 'border-line bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink'
    }`
  return (
    <>
      <Link href={lensHref('head')} className={chip(props.lens === 'head')}>
        Expense Head
      </Link>
      <Link href={lensHref('ah')} className={chip(props.lens === 'ah')}>
        Accounting Head
      </Link>
      {props.lens === 'head' ? (
        <HeadCombobox
          heads={props.headOptions}
          name="head"
          defaultHeadId={props.pickedHead}
          placeholder={props.headPlaceholder ?? 'All Expense Heads — type to search'}
          className={`${controlClass} w-56`}
        />
      ) : (
        <>
          <input type="hidden" name="by" value="ah" />
          <HeadCombobox
            heads={props.ahOptions}
            name="ah"
            defaultHeadId={props.pickedAh}
            placeholder="All Accounting Heads — type to search"
            className={`${controlClass} w-56`}
          />
        </>
      )}
    </>
  )
}

/** Read the lens params a report's URL carries. */
export function readHeadLens(params: { by?: string; head?: string; ah?: string }) {
  const lens: 'head' | 'ah' = params.by === 'ah' ? 'ah' : 'head'
  return {
    lens,
    headAccountId: lens === 'head' ? params.head || undefined : undefined,
    accountingHeadId: lens === 'ah' ? params.ah || undefined : undefined,
  }
}

/**
 * Hide cash / Show cash (Himal, 20 Aug: "fkt hide karaych aahe aaplyala").
 * Cash is THERE by default — the button is for taking it out when he wants
 * the bank-only picture, and putting it back.
 *
 * Statements that must tie (P&L, Balance Sheet) keep their cash regardless:
 * dropping rows out of a balance sheet would simply make it wrong.
 */
export function CashToggle(props: { base: string; showing: boolean; keep?: Record<string, string | undefined> }) {
  const href = (() => {
    const s = new URLSearchParams()
    for (const [k, v] of Object.entries(props.keep ?? {})) if (v) s.set(k, v)
    // showing → the link hides it; hidden → the link drops the param
    if (props.showing) s.set('cash', '0')
    const str = s.toString()
    return str ? `${props.base}?${str}` : props.base
  })()
  return (
    <Link
      href={href}
      title={props.showing ? 'Leave cash out of this report' : 'Bring cash back in'}
      className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
        props.showing
          ? 'border-line bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink'
          : 'border-primary/40 bg-primary-soft text-primary'
      }`}
    >
      {props.showing ? 'Hide cash' : 'Show cash'}
    </Link>
  )
}

/**
 * Reset (Himal, 20 Aug: "reset karaych option pan de"). Shown only when
 * something is actually applied — a head, a lens, hidden cash, a date
 * range — and one click puts the report back to showing everything.
 */
export function ResetFilters(props: { base: string; active: boolean }) {
  if (!props.active) return null
  return (
    <Link
      href={props.base}
      title="Back to the full report — clears heads, lens, dates and brings cash back"
      className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/15"
    >
      ↺ Reset
    </Link>
  )
}
