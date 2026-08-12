'use client'

import { useState, type ReactNode } from 'react'

// One register line that edits IN PLACE: "edit" swaps the row's own cells
// for inputs (Excel-style) instead of dropping a form below it. Computed
// columns (rate, effective, days) stay computed. On an open FX invoice,
// filling $ received + ₹ credited + credit date and saving records the
// receipt right there — no separate popup.

export interface InvoiceRowData {
  id: string
  number: string
  dateIso: string
  dueIso: string
  customer: string
  narration: string
  country: string
  fx: boolean
  posted: boolean
  settled: boolean
  amountFx: string
  receivedFx: string
  realizedInr: string
  bankCharges: string
  providerFees: string
  creditDateIso: string
  firc: string
  // Preformatted display strings (server-side formatting stays the truth)
  invDisp: string
  recdDisp: string
  shortDisp: string
  inrDisp: string
  rateDisp: string
  chargesDisp: string
  effDisp: string
  daysDisp: string
  badge: { label: string; tone: 'red' | 'amber' | 'zinc' } | null
}

const inputCls = 'w-full min-w-16 rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs'
const cellCls = 'whitespace-nowrap px-1.5 py-1'

export function InvoiceRow(props: {
  data: InvoiceRowData
  update: (formData: FormData) => Promise<void>
  /** Server-rendered extra actions: delete, INR record-payment. */
  children?: ReactNode
}) {
  const d = props.data
  const [editing, setEditing] = useState(false)
  const formId = `inv-${d.id}`

  if (!editing) {
    return (
      <tr className={`align-top ${d.settled ? 'text-zinc-500' : ''} hover:bg-zinc-50/60`}>
        <td className={`${cellCls} font-mono text-xs text-zinc-500`}>{d.number}</td>
        <td className={`${cellCls} text-xs tabular-nums text-zinc-500`}>{d.dateIso}</td>
        <td className="px-1.5 py-1">
          <span
            className="block max-w-40 truncate font-medium text-zinc-800"
            title={d.narration ? `${d.customer} — ${d.narration}` : d.customer}
          >
            {d.customer}
          </span>
        </td>
        <td className="px-1.5 py-1 text-xs text-zinc-600">{d.country || '—'}</td>
        <td className={cellCls}>
          <span className="text-xs tabular-nums text-zinc-500">{d.dueIso}</span>{' '}
          {d.badge && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                d.badge.tone === 'red'
                  ? 'bg-red-100 text-red-700'
                  : d.badge.tone === 'amber'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-zinc-100 text-zinc-500'
              }`}
            >
              {d.badge.label}
            </span>
          )}
          {d.settled && (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
              settled
            </span>
          )}
        </td>
        <td className={`${cellCls} text-right tabular-nums`}>{d.invDisp}</td>
        <td className={`${cellCls} text-right tabular-nums`}>
          {d.recdDisp || <span className="text-zinc-300">—</span>}
          {d.shortDisp && <span className="ml-1 text-[10px] text-red-500">{d.shortDisp}</span>}
        </td>
        <td className={`${cellCls} text-right tabular-nums`}>
          {d.inrDisp || <span className="text-zinc-300">—</span>}
        </td>
        <td className={`${cellCls} text-right tabular-nums`}>
          {d.rateDisp || <span className="text-zinc-300">—</span>}
        </td>
        <td className={`${cellCls} text-right tabular-nums`}>
          {d.chargesDisp || <span className="text-zinc-300">—</span>}
        </td>
        <td className={`${cellCls} text-right font-medium tabular-nums`}>
          {d.effDisp || <span className="text-zinc-300">—</span>}
        </td>
        <td className="px-1.5 py-1 text-xs">{d.firc || '—'}</td>
        <td className={`${cellCls} text-right text-xs tabular-nums`}>{d.daysDisp || '—'}</td>
        <td className="px-1.5 py-1">
          <div className="flex items-start justify-end gap-1">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={`whitespace-nowrap rounded px-2 py-1 text-[11px] font-medium ${
                !d.settled && d.fx
                  ? 'bg-emerald-700 text-white hover:bg-emerald-600'
                  : 'border border-zinc-300 text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              {!d.settled && d.fx ? 'Record / edit' : 'edit'}
            </button>
            {props.children}
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr className="bg-amber-50/40 align-top">
      <td className={`${cellCls} font-mono text-xs text-zinc-500`}>{d.number}</td>
      <td className="px-1.5 py-0.5">
        <input name="date" type="date" form={formId} defaultValue={d.dateIso} className={inputCls} />
      </td>
      <td className="px-1.5 py-0.5">
        <div className="flex gap-0.5">
          <input
            name="customer"
            form={formId}
            defaultValue={d.customer}
            disabled={d.posted}
            title={d.posted ? 'Posted invoice — client is fixed' : 'Client'}
            className={`${inputCls} disabled:bg-zinc-100 disabled:text-zinc-400`}
          />
          <input
            name="narration"
            form={formId}
            defaultValue={d.narration}
            placeholder="Desc"
            title="Description"
            className={inputCls}
          />
        </div>
      </td>
      <td className="px-1.5 py-0.5">
        <input name="country" form={formId} defaultValue={d.country} placeholder="Country" className={inputCls} />
      </td>
      <td className="px-1.5 py-0.5">
        <input name="dueDate" type="date" form={formId} defaultValue={d.dueIso} className={inputCls} />
      </td>
      <td className="px-1.5 py-0.5">
        {d.fx ? (
          <input
            name="amountFx"
            form={formId}
            defaultValue={d.amountFx}
            inputMode="decimal"
            placeholder="$ invoiced"
            className={`${inputCls} text-right`}
          />
        ) : (
          <span className="block px-1 text-right text-xs tabular-nums">{d.invDisp}</span>
        )}
      </td>
      <td className="px-1.5 py-0.5">
        {d.fx ? (
          <input
            name="receivedFx"
            form={formId}
            defaultValue={d.receivedFx || d.amountFx}
            inputMode="decimal"
            placeholder="$ received"
            className={`${inputCls} text-right`}
          />
        ) : (
          <span className="block text-right text-xs text-zinc-300">—</span>
        )}
      </td>
      <td className="px-1.5 py-0.5">
        {d.fx ? (
          <input
            name="realizedInr"
            form={formId}
            defaultValue={d.realizedInr}
            inputMode="decimal"
            placeholder="₹ credited"
            className={`${inputCls} text-right`}
          />
        ) : (
          <span className="block px-1 text-right text-xs tabular-nums">{d.inrDisp}</span>
        )}
      </td>
      <td className={`${cellCls} text-right text-[10px] text-zinc-400`}>auto</td>
      <td className="px-1.5 py-0.5">
        {d.fx ? (
          <div className="flex gap-0.5">
            <input
              name="bankCharges"
              form={formId}
              defaultValue={d.bankCharges}
              inputMode="decimal"
              placeholder="Bank"
              title="Bank charges ₹"
              className={`${inputCls} text-right`}
            />
            <input
              name="providerFees"
              form={formId}
              defaultValue={d.providerFees}
              inputMode="decimal"
              placeholder="Skydo"
              title="Skydo / platform fees ₹"
              className={`${inputCls} text-right`}
            />
          </div>
        ) : (
          <span className="block text-right text-xs text-zinc-300">—</span>
        )}
      </td>
      <td className={`${cellCls} text-right text-[10px] text-zinc-400`}>auto</td>
      <td className="px-1.5 py-0.5">
        <select name="firc" form={formId} defaultValue={d.firc} className={inputCls}>
          <option value="">FIRC —</option>
          <option>Awaited</option>
          <option>Partial</option>
          <option>Received</option>
        </select>
      </td>
      <td className="px-1.5 py-0.5">
        {d.fx ? (
          <input
            name="creditDate"
            type="date"
            form={formId}
            defaultValue={d.creditDateIso}
            title="Date of credit"
            className={inputCls}
          />
        ) : (
          <span className="block text-right text-xs text-zinc-300">—</span>
        )}
      </td>
      <td className="px-1.5 py-0.5">
        <div className="flex items-start justify-end gap-1.5">
          <form id={formId} action={props.update}>
            <input type="hidden" name="invoiceId" value={d.id} />
            <button
              type="submit"
              className="whitespace-nowrap rounded bg-zinc-900 px-2 py-1 text-[11px] font-medium text-white hover:bg-zinc-700"
            >
              Save
            </button>
          </form>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="whitespace-nowrap rounded border border-zinc-300 px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100"
          >
            ✕
          </button>
        </div>
      </td>
    </tr>
  )
}
