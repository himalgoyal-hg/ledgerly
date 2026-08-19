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
      className={`block w-full resize-none rounded border border-transparent bg-transparent px-1.5 py-1 text-xs leading-snug tabular-nums hover:border-line focus:border-primary focus:bg-surface focus:outline-none ${
        props.emphasis ? 'placeholder:text-warning' : ''
      }`}
    />
  )
}

// The Date column's cell — same save manners as the value cell (pick or
// click away and it saves). It lives in its own <td>, so it joins the
// value's form through the form= attribute; amount, date and remark
// always travel together in one post.
export function DateCell(props: { defaultValue: string; formId: string; title?: string }) {
  const initial = useRef(props.defaultValue)
  return (
    <input
      type="date"
      name="paidOn"
      form={props.formId}
      defaultValue={props.defaultValue}
      title={props.title}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
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
      className="block w-full rounded border border-transparent bg-transparent px-1 py-1 text-[11px] tabular-nums text-ink-2 hover:border-line focus:border-primary focus:bg-surface focus:text-ink focus:outline-none"
    />
  )
}
