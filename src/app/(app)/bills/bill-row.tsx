'use client'

import { useState, type ReactNode } from 'react'

// A register line that edits in place, invoice-style: "edit" swaps the
// row's cells for inputs bound to a row-scoped form. Bills post nothing,
// so everything is freely editable; amounts recompute GST/TDS server-side
// from the stored rates.

export interface BillRowData {
  id: string
  vendor: string
  billType: string
  insuredFor: string
  policyNumber: string
  insuredValue: string
  dueIso: string
  recurrence: string
  payFrom: string
  amount: string // taxable, raw
  link: string
  remarks: string
  overdue: boolean
  // display strings
  payableDisp: string
  insuredDisp: string
  taxTip?: string
  files: { view: string; download: string } | null
}

const RECURRENCES = [
  ['NONE', 'once'],
  ['MONTHLY', 'monthly'],
  ['QUARTERLY', 'quarterly'],
  ['HALF_YEARLY', 'half-yearly'],
  ['YEARLY', 'yearly'],
] as const

const inputCls = 'w-full min-w-14 rounded border border-line bg-surface px-1 py-0.5 text-xs'

export function BillRow(props: {
  data: BillRowData
  update: (formData: FormData) => Promise<void>
  /** Server-rendered ✓ Paid + delete forms. */
  children?: ReactNode
}) {
  const d = props.data
  const [editing, setEditing] = useState(false)
  const formId = `bill-${d.id}`

  if (!editing) {
    return (
      <tr className="align-top hover:bg-surface-2/60">
        <td className="px-3 py-1.5">
          <span className="font-medium text-ink" title={d.remarks || undefined}>
            {d.vendor}
          </span>
        </td>
        <td className="max-w-64 px-3 py-1.5">
          <span
            className="block truncate text-xs text-ink-2"
            title={[d.insuredFor, d.policyNumber, d.remarks].filter(Boolean).join(' · ')}
          >
            {d.insuredFor || <span className="text-ink-3">—</span>}
            {d.policyNumber && (
              <span className="ml-1 font-mono text-[10px] text-ink-3">{d.policyNumber}</span>
            )}
          </span>
          {d.insuredDisp && (
            <span className="block text-[10px] text-ink-3">covers {d.insuredDisp}</span>
          )}
        </td>
        <td className="whitespace-nowrap px-3 py-1.5">
          <span className={`text-xs tabular-nums ${d.overdue ? 'font-semibold text-danger' : 'text-ink-2'}`}>
            {d.dueIso}
          </span>
          {d.overdue && (
            <span className="ml-1 rounded bg-danger-soft px-1.5 py-0.5 text-[10px] font-medium text-danger">
              overdue
            </span>
          )}
        </td>
        <td className="whitespace-nowrap px-3 py-1.5">
          {d.recurrence !== 'NONE' ? (
            <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {d.recurrence.toLowerCase().replace('_', '-')}
            </span>
          ) : (
            <span className="text-xs text-ink-3">once</span>
          )}
        </td>
        <td className="max-w-44 truncate px-3 py-1.5 text-xs text-ink-2" title={d.payFrom}>
          {d.payFrom || '—'}
        </td>
        <td className="whitespace-nowrap px-3 py-1.5 text-right">
          <span className="font-semibold tabular-nums text-ink" title={d.taxTip}>
            {d.payableDisp}
          </span>
        </td>
        <td className="whitespace-nowrap px-3 py-1.5 text-xs">
          {d.files ? (
            <>
              <a href={d.files.view} target="_blank" rel="noreferrer" className="text-primary hover:underline">view</a>{' '}
              <a href={d.files.download} className="text-primary hover:underline">download</a>
            </>
          ) : d.link ? (
            <a href={d.link} target="_blank" rel="noreferrer" className="text-primary hover:underline">document</a>
          ) : (
            <span className="text-ink-3">—</span>
          )}
        </td>
        <td className="px-3 py-1">
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded border border-line px-2 py-1 text-[11px] text-ink-2 hover:bg-surface-2"
            >
              edit
            </button>
            {props.children}
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr className="bg-warning-soft/40 align-top">
      <td className="px-3 py-0.5">
        <div className="flex gap-0.5">
          <input name="vendor" form={formId} required defaultValue={d.vendor} placeholder="Vendor" className={inputCls} />
          <input name="billType" form={formId} required defaultValue={d.billType} placeholder="Type" title="Bill type (group)" className={inputCls} />
        </div>
      </td>
      <td className="px-3 py-0.5">
        <div className="flex gap-0.5">
          <input name="insuredFor" form={formId} defaultValue={d.insuredFor} placeholder="For whom" className={inputCls} />
          <input name="policyNumber" form={formId} defaultValue={d.policyNumber} placeholder="Policy no." className={inputCls} />
          <input name="insuredValue" form={formId} defaultValue={d.insuredValue} inputMode="decimal" placeholder="Covers ₹" title="Insured value" className={inputCls} />
        </div>
      </td>
      <td className="px-3 py-0.5">
        <input name="dueDate" type="date" form={formId} required defaultValue={d.dueIso} className={inputCls} />
      </td>
      <td className="px-3 py-0.5">
        <select name="recurrence" form={formId} defaultValue={d.recurrence} className={inputCls}>
          {RECURRENCES.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </td>
      <td className="px-3 py-0.5">
        <input name="payFrom" form={formId} defaultValue={d.payFrom} placeholder="Pay from" className={inputCls} />
      </td>
      <td className="px-3 py-0.5">
        <input
          name="amount"
          form={formId}
          required
          inputMode="decimal"
          defaultValue={d.amount}
          title="Taxable amount — GST/TDS recompute from the stored rates"
          className={`${inputCls} text-right`}
        />
      </td>
      <td className="px-3 py-0.5">
        <div className="flex gap-0.5">
          <input name="link" form={formId} defaultValue={d.link} placeholder="Drive link" className={inputCls} />
          <input name="remarks" form={formId} defaultValue={d.remarks} placeholder="Remarks" className={inputCls} />
        </div>
      </td>
      <td className="px-3 py-0.5">
        <div className="flex items-center justify-end gap-1.5">
          <form id={formId} action={props.update}>
            <input type="hidden" name="billId" value={d.id} />
            <button
              type="submit"
              className="whitespace-nowrap rounded bg-primary px-2 py-1 text-[11px] font-medium text-white hover:bg-primary-strong"
            >
              Save
            </button>
          </form>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded border border-line px-2 py-1 text-[11px] text-ink-2 hover:bg-surface-2"
          >
            ✕
          </button>
        </div>
      </td>
    </tr>
  )
}
