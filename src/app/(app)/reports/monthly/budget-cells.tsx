'use client'

import { useRef, useState } from 'react'

// The four budget cells of an Expenses M/M row. Monthly and yearly are one
// linked pair — type in either and the other recalculates as you type
// (monthly × 12 = year); Enter or clicking away saves whichever side you
// edited, and the variances refresh from the server on save.

const fmtSigned = (n: number) => {
  const v = Math.round(n)
  if (!v) return '—'
  return v < 0 ? `-₹${(-v).toLocaleString('en-IN')}` : `₹${v.toLocaleString('en-IN')}`
}

const cellR = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap'
const inputCls =
  'w-24 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-right text-sm tabular-nums text-zinc-500 hover:border-zinc-300 focus:border-zinc-400 focus:bg-white focus:outline-none'

export function BudgetCells(props: {
  entityId: string
  accountId: string
  fy: number
  monthly: number
  year: number
  recentVariance: number
  yearVariance: number
  save: (formData: FormData) => Promise<void>
}) {
  const init = {
    monthly: props.monthly ? String(Math.round(props.monthly)) : '',
    year: props.year ? String(Math.round(props.year)) : '',
  }
  const [monthly, setMonthly] = useState(init.monthly)
  const [year, setYear] = useState(init.year)
  const [kind, setKind] = useState<'monthly' | 'year'>('year')
  const formRef = useRef<HTMLFormElement>(null)
  const saved = useRef(init)

  const submit = () => {
    saved.current = { monthly, year }
    formRef.current?.requestSubmit()
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }
  const maybeSave = () => {
    if (monthly !== saved.current.monthly || year !== saved.current.year) submit()
  }
  const parse = (v: string) => Number(v.replace(/[,₹\s]/g, ''))

  return (
    <>
      <td className={cellR}>
        <form ref={formRef} action={props.save}>
          <input type="hidden" name="entityId" value={props.entityId} />
          <input type="hidden" name="accountId" value={props.accountId} />
          <input type="hidden" name="fy" value={props.fy} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="amount" value={kind === 'monthly' ? monthly : year} />
        </form>
        <input
          value={monthly}
          inputMode="decimal"
          title="₹ per month — the year recalculates as you type; Enter saves"
          onChange={(e) => {
            const v = e.target.value
            setMonthly(v)
            setKind('monthly')
            const n = parse(v)
            setYear(v.trim() && !isNaN(n) ? String(Math.round(n * 12)) : '')
          }}
          onKeyDown={onKey}
          onBlur={maybeSave}
          className={inputCls}
        />
      </td>
      <td className={`${cellR} ${props.recentVariance < 0 ? 'text-red-600' : 'text-zinc-500'}`}>
        {fmtSigned(props.recentVariance)}
      </td>
      <td className={cellR}>
        <input
          value={year}
          inputMode="decimal"
          title="₹ for the whole FY — the monthly recalculates as you type; Enter saves"
          onChange={(e) => {
            const v = e.target.value
            setYear(v)
            setKind('year')
            const n = parse(v)
            setMonthly(v.trim() && !isNaN(n) ? String(Math.round(n / 12)) : '')
          }}
          onKeyDown={onKey}
          onBlur={maybeSave}
          className={inputCls}
        />
      </td>
      <td className={`${cellR} ${props.yearVariance < 0 ? 'text-red-600' : 'text-zinc-500'}`}>
        {fmtSigned(props.yearVariance)}
      </td>
    </>
  )
}
