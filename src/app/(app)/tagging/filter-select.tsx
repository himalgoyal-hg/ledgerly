'use client'

import { useRouter } from 'next/navigation'

// Excel-style column dropdown (Himal, 20 Aug): the closed select shows what
// the column is doing right now ("Jul 2026", "All accounts", "Not tagged",
// "High → Low"); opening it offers Sort actions and Show filters, exactly
// like Excel's filter arrow. Every option is a ready-made href the server
// built with all other params folded in — picking one just navigates.

export interface FilterGroup {
  label: string
  options: { label: string; href: string }[]
}

export function FilterSelect(props: {
  /** What the column is doing now — shown when the select is closed. */
  current: string
  groups: FilterGroup[]
  title?: string
  active?: boolean
}) {
  const router = useRouter()
  return (
    <select
      value=""
      title={props.title}
      onChange={(e) => {
        if (e.target.value) router.push(e.target.value)
      }}
      className={`w-full rounded border px-1 py-0.5 text-[10px] font-normal normal-case tracking-normal ${
        props.active
          ? 'border-primary/40 bg-primary-soft font-medium text-primary'
          : 'border-line bg-surface text-ink-2'
      }`}
    >
      <option value="">{props.current}</option>
      {props.groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.href} value={o.href}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
