'use client'

import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { Badge, type BadgeTone } from './ui'

// Declarative data table: sticky header, sort, text filter, pagination,
// status chips, row hover. Columns are data, not render functions, so server
// pages can pass everything across the RSC boundary.

export interface TableColumn {
  key: string
  label: string
  /** 'money' right-aligns with tabular figures; 'badge' renders a status chip. */
  kind?: 'text' | 'money' | 'date' | 'badge'
  sortable?: boolean
}

export type TableCell = string | number | null
export type TableRow = {
  /** Cell values by column key; for 'badge' columns use "tone:label", e.g. "success:Paid". */
  [key: string]: TableCell
} & { href?: string | null }

export function DataTable(props: {
  columns: TableColumn[]
  rows: TableRow[]
  pageSize?: number
  searchable?: boolean
  emptyLabel?: string
}) {
  const pageSize = props.pageSize ?? 10
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const [page, setPage] = useState(0)

  const rows = useMemo(() => {
    let out = props.rows
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      out = out.filter((r) =>
        props.columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(q)),
      )
    }
    if (sort) {
      const { key, dir } = sort
      out = [...out].sort((a, b) => {
        const av = a[key]
        const bv = b[key]
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir
      })
    }
    return out
  }, [props.rows, props.columns, query, sort])

  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const current = Math.min(page, pages - 1)
  const slice = rows.slice(current * pageSize, current * pageSize + pageSize)

  const money = (v: TableCell) =>
    typeof v === 'number'
      ? v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : v

  return (
    <div className="flex flex-col">
      {props.searchable !== false && (
        <div className="flex items-center gap-2 px-5 pb-3 sm:px-6">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(0)
              }}
              placeholder="Filter rows…"
              className="w-full rounded-xl border border-line bg-surface py-1.5 pl-9 pr-3 text-sm text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none"
            />
          </div>
          <span className="ml-auto text-xs text-ink-3">
            {rows.length} row{rows.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      <div className="max-h-[28rem] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface shadow-[inset_0_-1px_0_var(--line)]">
            <tr>
              {props.columns.map((c) => (
                <th
                  key={c.key}
                  className={`px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3 sm:px-6 ${
                    c.kind === 'money' ? 'text-right' : 'text-left'
                  }`}
                >
                  {c.sortable !== false ? (
                    <button
                      type="button"
                      onClick={() =>
                        setSort((s) =>
                          s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 },
                        )
                      }
                      className="inline-flex items-center gap-1 hover:text-ink"
                    >
                      {c.label}
                      {sort?.key === c.key &&
                        (sort.dir === 1 ? (
                          <ArrowUp className="size-3" aria-hidden />
                        ) : (
                          <ArrowDown className="size-3" aria-hidden />
                        ))}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            {slice.map((r, i) => (
              <tr key={i} className="transition-colors hover:bg-surface-2/60">
                {props.columns.map((c) => {
                  const v = r[c.key]
                  return (
                    <td
                      key={c.key}
                      className={`px-5 py-3 sm:px-6 ${
                        c.kind === 'money'
                          ? 'text-right font-medium text-ink'
                          : c.kind === 'date'
                            ? 'whitespace-nowrap text-ink-3'
                            : 'text-ink-2'
                      }`}
                    >
                      {c.kind === 'badge' && typeof v === 'string' && v.includes(':') ? (
                        <Badge tone={v.split(':')[0] as BadgeTone}>{v.split(':')[1]}</Badge>
                      ) : c.kind === 'money' ? (
                        money(v)
                      ) : (
                        v
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
            {slice.length === 0 && (
              <tr>
                <td colSpan={props.columns.length} className="px-6 py-10 text-center text-sm text-ink-3">
                  {props.emptyLabel ?? 'Nothing to show.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center gap-2 border-t border-line px-5 py-2.5 sm:px-6">
          <span className="text-xs text-ink-3">
            Page {current + 1} of {pages}
          </span>
          <div className="ml-auto flex gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={current === 0}
              className="grid size-7 place-items-center rounded-lg border border-line text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={current >= pages - 1}
              className="grid size-7 place-items-center rounded-lg border border-line text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
