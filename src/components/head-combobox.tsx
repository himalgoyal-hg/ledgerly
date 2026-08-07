'use client'

import { useId, useState } from 'react'

// Type-ahead account picker (v2 prototype's datalist inputs): type a few
// letters, the browser filters "code · name" suggestions, picking one sets
// the hidden id field the form actually submits. Free text that matches no
// head submits an empty id — the server's "Pick a head" guard catches it.

export interface HeadOpt {
  id: string
  code: string
  name: string
  kind: string
  defaultCostCentreId?: string | null
}

const label = (h: HeadOpt) => `${h.code} · ${h.name}`

export function HeadCombobox(props: {
  heads: HeadOpt[]
  name?: string
  defaultHeadId?: string | null
  onPick?: (head: HeadOpt | null) => void
  required?: boolean
  placeholder?: string
  className?: string
}) {
  const listId = useId()
  const initial = props.heads.find((h) => h.id === props.defaultHeadId)
  const [text, setText] = useState(initial ? label(initial) : '')
  const [id, setId] = useState(initial?.id ?? '')

  return (
    <>
      <input
        list={listId}
        value={text}
        required={props.required}
        placeholder={props.placeholder ?? 'Head — type to search'}
        autoComplete="off"
        onChange={(e) => {
          const v = e.target.value
          setText(v)
          const typed = v.trim().toLowerCase()
          const head =
            props.heads.find((h) => label(h).toLowerCase() === typed) ??
            props.heads.find((h) => h.name.toLowerCase() === typed) ??
            null
          setId(head?.id ?? '')
          props.onPick?.(head)
        }}
        className={
          props.className ?? 'min-w-48 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm'
        }
      />
      <datalist id={listId}>
        {props.heads.map((h) => (
          <option key={h.id} value={label(h)} />
        ))}
      </datalist>
      <input type="hidden" name={props.name ?? 'headAccountId'} value={id} />
    </>
  )
}
