'use client'

import { useId, useMemo, useState } from 'react'

// Generic type-ahead picker — the same datalist pattern as HeadCombobox, for
// everything that isn't a ledger head (natures, cost centres, ...): first
// letters filter, picking an option submits its id via the hidden input.
//
// With `createName` set the picker is creatable: text that matches no option
// submits verbatim under that name, and the server finds-or-creates it (so a
// missing cost centre can be added right where you tag). Without `createName`
// unmatched text submits an empty id, which the server's required-guard
// catches — exactly like HeadCombobox.

export interface ComboOpt {
  id: string
  label: string
}

export function SmartCombobox(props: {
  options: ComboOpt[]
  /** Hidden input carrying the resolved option id. */
  name: string
  /** When set, unmatched text is submitted under this name for find-or-create. */
  createName?: string
  defaultId?: string | null
  required?: boolean
  placeholder?: string
  className?: string
  /** Bind to a <form> elsewhere in the page (table-row layouts). */
  formId?: string
  onPick?: (opt: ComboOpt | null) => void
}) {
  const listId = useId()

  const options = useMemo(
    () => [...props.options].sort((a, b) => a.label.localeCompare(b.label)),
    [props.options],
  )
  const initial = options.find((o) => o.id === props.defaultId)
  const [text, setText] = useState(initial?.label ?? '')
  const [id, setId] = useState(initial?.id ?? '')

  const resolve = (raw: string): ComboOpt | null => {
    const typed = raw.trim().toLowerCase()
    if (!typed) return null
    const exact =
      options.find((o) => o.label.toLowerCase() === typed) ??
      options.find((o) => o.id.toLowerCase() === typed)
    if (exact) return exact
    // Smart search: as soon as the typed text points at exactly ONE option,
    // snap to it — same Excel feel as the head box. Lets go if typing on.
    if (typed.length >= 2) {
      const starts = options.filter((o) => o.label.toLowerCase().startsWith(typed))
      if (starts.length === 1) return starts[0]
      if (starts.length === 0) {
        const contains = options.filter((o) => o.label.toLowerCase().includes(typed))
        if (contains.length === 1) return contains[0]
      }
    }
    return null
  }
  const unresolved = props.createName && !id ? text.trim() : ''
  const creating = unresolved !== ''

  return (
    <>
      <input
        list={listId}
        value={text}
        required={props.required}
        form={props.formId}
        placeholder={props.placeholder}
        autoComplete="off"
        onChange={(e) => {
          const v = e.target.value
          setText(v)
          const opt = resolve(v)
          setId(opt?.id ?? '')
          props.onPick?.(opt)
        }}
        className={
          props.className ?? 'min-w-40 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm'
        }
      />
      <datalist id={listId}>
        {creating && <option value={text}>➕ create new</option>}
        {options.map((o) => (
          <option key={o.id} value={o.label} />
        ))}
      </datalist>
      <input type="hidden" name={props.name} value={id} form={props.formId} />
      {props.createName && (
        <input type="hidden" name={props.createName} value={unresolved} form={props.formId} />
      )}
      {creating && (
        <span className="mt-0.5 block w-full text-[10px] font-medium leading-tight text-success">
          ➕ “{unresolved}” — new, created on save
        </span>
      )}
    </>
  )
}
