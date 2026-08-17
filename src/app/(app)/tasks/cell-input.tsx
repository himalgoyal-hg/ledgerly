'use client'

// A grid cell that shows everything it holds — long comments wrap over
// multiple lines instead of hiding past the input's edge. Enter saves
// (Shift+Enter for a new line inside a note), and clicking away saves too
// if the text changed. The form around it is a plain server-action post.

import { useRef } from 'react'

export function CellInput(props: {
  defaultValue: string
  placeholder?: string
  title?: string
  emphasis?: boolean
}) {
  const initial = useRef(props.defaultValue)
  return (
    <textarea
      name="value"
      defaultValue={props.defaultValue}
      placeholder={props.placeholder}
      title={props.title}
      rows={Math.max(1, props.defaultValue.split('\n').length)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          e.currentTarget.form?.requestSubmit()
        }
      }}
      onBlur={(e) => {
        if (e.currentTarget.value !== initial.current) {
          initial.current = e.currentTarget.value
          e.currentTarget.form?.requestSubmit()
        }
      }}
      className={`block w-full resize-none rounded border border-transparent bg-transparent px-1.5 py-1 text-xs leading-snug tabular-nums hover:border-zinc-300 focus:border-zinc-400 focus:bg-white focus:outline-none ${
        props.emphasis ? 'placeholder:text-amber-600' : ''
      }`}
    />
  )
}
