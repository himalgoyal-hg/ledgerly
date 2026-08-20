'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

// Excel's filter arrow (Himal, 20 Aug: "hyavar click kelyavar aal pahije"):
// the column header IS the button — click it and a menu drops with Sort
// actions first, then Show filters, the active one ticked. The menu is
// position:fixed so it escapes the table's overflow box instead of being
// clipped by it; it closes on outside click, Escape, scroll or navigation.
// Nothing is printed under the header (Himal, 20 Aug) — an applied filter
// shows by colouring the label itself, and the menu's ✓ says which one.

export interface MenuGroup {
  label: string
  options: { label: string; href: string; active?: boolean }[]
}

const MENU_W = 232

export function ColumnMenu(props: {
  label: string
  /** The applied filter — colours the label and rides in its tooltip. */
  state?: string | null
  /** Current sort direction for this column — shown in the tooltip and
   *  ticked inside the menu, not as a second arrow on the header. */
  arrow?: 'asc' | 'desc' | null
  groups: MenuGroup[]
  align?: 'right'
  /** A native date picker at the top of the menu — pick one exact day.
   *  hrefTemplate carries __DAY__ where the chosen date belongs (a function
   *  can't cross the server/client boundary, a template can). */
  dayPicker?: { value: string; hrefTemplate: string; clearHref: string }
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const active = Boolean(props.state)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onMove = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      setPos({
        top: r.bottom + 4,
        left:
          props.align === 'right'
            ? Math.max(8, r.right - MENU_W)
            : Math.min(r.left, window.innerWidth - MENU_W - 8),
      })
    }
    setOpen((o) => !o)
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title={[
          props.label,
          props.state ? `: ${props.state}` : '',
          props.arrow ? ` (${props.arrow === 'asc' ? 'ascending' : 'descending'})` : '',
          ' — click to sort and filter',
        ].join('')}
        aria-expanded={open}
        className={`flex w-full items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-2 ${
          props.align === 'right' ? 'justify-end' : ''
        } ${active ? 'text-primary' : 'hover:text-ink'}`}
      >
        <span>{props.label}</span>
        <span className="text-[8px] opacity-60">▼</span>
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          style={{ top: pos.top, left: pos.left, width: MENU_W }}
          className="fixed z-50 overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
        >
          <div className="max-h-80 overflow-y-auto py-1">
            {props.dayPicker && (
              <div className="border-b border-line-2 px-3 pb-2 pt-1.5">
                <div className="pb-1 text-[9px] font-semibold uppercase tracking-wider text-ink-3">
                  Pick a date
                </div>
                <div className="flex items-center gap-1">
                  <input
                    type="date"
                    defaultValue={props.dayPicker.value}
                    className="w-full rounded border border-line bg-surface px-1 py-0.5 text-xs font-normal normal-case tracking-normal text-ink"
                    onChange={(e) => {
                      const v = e.target.value
                      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return
                      setOpen(false)
                      router.push(props.dayPicker!.hrefTemplate.replace('__DAY__', v))
                    }}
                  />
                  {props.dayPicker.value && (
                    <Link
                      href={props.dayPicker.clearHref}
                      onClick={() => setOpen(false)}
                      title="Clear the date"
                      className="rounded border border-line px-1.5 py-0.5 text-xs font-normal text-ink-3 hover:bg-surface-2 hover:text-ink"
                    >
                      ✕
                    </Link>
                  )}
                </div>
              </div>
            )}
            {props.groups.map((g) => (
              <div key={g.label}>
                <div className="px-3 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-wider text-ink-3">
                  {g.label}
                </div>
                {g.options.map((o) => (
                  <Link
                    key={o.href}
                    href={o.href}
                    onClick={() => setOpen(false)}
                    className={`block truncate px-3 py-1 text-xs font-normal normal-case tracking-normal ${
                      o.active
                        ? 'bg-primary-soft font-medium text-primary'
                        : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                    }`}
                  >
                    {o.active ? '✓ ' : ''}
                    {o.label}
                  </Link>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
