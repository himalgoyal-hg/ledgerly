'use client'

import { useId, useMemo, useState } from 'react'

// Type-ahead account picker (v2 prototype's datalist inputs). The option
// VALUE is the head's name, never "code · name": browsers match a datalist on
// the value, and Safari matches only from the start of it — with the code in
// front, typing "food" matched nothing. The code rides along as the option's
// label, which Chrome shows on the right and also searches.
//
// Picking a suggestion (or typing a name outright) sets the hidden id the
// form submits. Text that matches no head submits an empty id, so the
// server's "Pick a head" guard catches it.

export interface HeadOpt {
  id: string
  code: string
  name: string
  kind: string
  defaultCostCentreId?: string | null
}

export function HeadCombobox(props: {
  heads: HeadOpt[]
  name?: string
  defaultHeadId?: string | null
  onPick?: (head: HeadOpt | null) => void
  required?: boolean
  placeholder?: string
  className?: string
  /** Bind to a <form> elsewhere in the page (table-row layouts). */
  formId?: string
}) {
  const listId = useId()

  // A name that occurs twice in one set of books gets its code appended, so
  // every option still resolves to exactly one head.
  const options = useMemo(() => {
    const seen = new Map<string, number>()
    for (const h of props.heads) seen.set(h.name, (seen.get(h.name) ?? 0) + 1)
    return props.heads
      .map((h) => ({ head: h, label: (seen.get(h.name) ?? 0) > 1 ? `${h.name} (${h.code})` : h.name }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [props.heads])

  const initial = options.find((o) => o.head.id === props.defaultHeadId)
  const [text, setText] = useState(initial?.label ?? '')
  const [id, setId] = useState(initial?.head.id ?? '')

  const resolve = (raw: string): HeadOpt | null => {
    const typed = raw.trim().toLowerCase()
    if (!typed) return null
    const byLabel = options.find((o) => o.label.toLowerCase() === typed)
    if (byLabel) return byLabel.head
    // Accept a bare code, and the old "code · name" shape too.
    const byCode = props.heads.find((h) => h.code === typed)
    if (byCode) return byCode
    const byCombined = props.heads.find(
      (h) => `${h.code} · ${h.name}`.toLowerCase() === typed || h.name.toLowerCase() === typed,
    )
    return byCombined ?? null
  }

  return (
    <>
      <input
        list={listId}
        value={text}
        required={props.required}
        form={props.formId}
        placeholder={props.placeholder ?? 'Head — type to search'}
        autoComplete="off"
        onChange={(e) => {
          const v = e.target.value
          setText(v)
          const head = resolve(v)
          setId(head?.id ?? '')
          props.onPick?.(head)
        }}
        className={
          props.className ?? 'min-w-48 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm'
        }
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.head.id} value={o.label}>
            {o.head.code}
          </option>
        ))}
      </datalist>
      <input type="hidden" name={props.name ?? 'headAccountId'} value={id} form={props.formId} />
    </>
  )
}
