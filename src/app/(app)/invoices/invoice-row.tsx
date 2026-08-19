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
  books: string
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
  fcDisposal: string
  // Preformatted display strings (server-side formatting stays the truth)
  invDisp: string
  recdDisp: string
  shortDisp: string
  inrDisp: string
  rateDisp: string
  chargesDisp: string
  effDisp: string
  creditDisp: string // "10-Jun (7d)" — date of credit + days to receive
  badge: { label: string; tone: 'red' | 'amber' | 'zinc' } | null
}

const inputCls = 'w-full min-w-16 rounded border border-line bg-surface px-1 py-0.5 text-xs'
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
      <tr className={`align-top ${d.settled ? 'text-ink-2' : ''} hover:bg-surface-2/60`}>
        <td className={`${cellCls} font-mono text-xs text-ink-2`}>{d.number}</td>
        <td className={cellCls}>
          <span className="rounded bg-surface-2 px-1 text-[10px] font-medium text-ink-2">{d.books}</span>
        </td>
        <td className={`${cellCls} text-xs tabular-nums text-ink-2`}>{d.dateIso}</td>
        <td className="px-1.5 py-1">
          <span
            className="block max-w-40 truncate font-medium text-ink"
            title={d.narration ? `${d.customer} — ${d.narration}` : d.customer}
          >
            {d.customer}
          </span>
        </td>
        <td className="px-1.5 py-1 text-xs text-ink-2">{d.country || '—'}</td>
        <td className={cellCls}>
          <span className="text-xs tabular-nums text-ink-2">{d.dueIso}</span>{' '}
          {d.badge && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                d.badge.tone === 'red'
                  ? 'bg-danger-soft text-danger'
                  : d.badge.tone === 'amber'
                    ? 'bg-warning-soft text-warning'
                    : 'bg-surface-2 text-ink-2'
              }`}
            >
              {d.badge.label}
            </span>
          )}
          {d.settled && (
            <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-medium text-success">
              settled
            </span>
          )}
        </td>
        <td className={`${cellCls} text-right tabular-nums`}>{d.invDisp}</td>
        <td className={`${cellCls} text-right tabular-nums`}>
          {d.recdDisp || <span className="text-ink-3">—</span>}
          {d.shortDisp && <span className="ml-1 text-[10px] text-danger">{d.shortDisp}</span>}
        </td>
        <td className={`${cellCls} text-right tabular-nums`}>
          {d.inrDisp || <span className="text-ink-3">—</span>}
        </td>
        <td className={`${cellCls} text-right tabular-nums`}>
          {d.rateDisp || <span className="text-ink-3">—</span>}
        </td>
        <td className={`${cellCls} text-right tabular-nums`}>
          {d.chargesDisp || <span className="text-ink-3">—</span>}
        </td>
        <td className={`${cellCls} text-right font-medium tabular-nums`}>
          {d.effDisp || <span className="text-ink-3">—</span>}
        </td>
        <td className="px-1.5 py-1 text-xs">{d.firc || '—'}</td>
        <td className="px-1.5 py-1 text-xs">{d.fcDisposal || '—'}</td>
        <td className={`${cellCls} text-xs tabular-nums`}>{d.creditDisp || '—'}</td>
        <td className="px-1.5 py-1">
          <div className="flex items-start justify-end gap-1">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={`whitespace-nowrap rounded px-2 py-1 text-[11px] font-medium ${
                !d.settled && d.fx
                  ? 'bg-success text-white hover:opacity-90'
                  : 'border border-line text-ink-2 hover:bg-surface-2'
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
    <tr className="bg-warning-soft/40 align-top">
      <td className={`${cellCls} font-mono text-xs text-ink-2`}>{d.number}</td>
      <td className={cellCls}>
        <span className="rounded bg-surface-2 px-1 text-[10px] font-medium text-ink-2">{d.books}</span>
      </td>
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
            className={`${inputCls} disabled:bg-surface-2 disabled:text-ink-3`}
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
          <span className="block text-right text-xs text-ink-3">—</span>
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
      <td className={`${cellCls} text-right text-[10px] text-ink-3`}>auto</td>
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
          <span className="block text-right text-xs text-ink-3">—</span>
        )}
      </td>
      <td className={`${cellCls} text-right text-[10px] text-ink-3`}>auto</td>
      <td className="px-1.5 py-0.5">
        <select name="firc" form={formId} defaultValue={d.firc} className={inputCls}>
          <option value="">FIRC —</option>
          <option>Awaited</option>
          <option>Partial</option>
          <option>Received</option>
        </select>
      </td>
      <td className="px-1.5 py-0.5">
        <input
          name="fcDisposal"
          form={formId}
          defaultValue={d.fcDisposal}
          placeholder="Yes / Skydo"
          title="FC disposal instruction given?"
          className={inputCls}
        />
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
          <span className="block text-right text-xs text-ink-3">—</span>
        )}
      </td>
      <td className="px-1.5 py-0.5">
        <div className="flex items-start justify-end gap-1.5">
          <form id={formId} action={props.update}>
            <input type="hidden" name="invoiceId" value={d.id} />
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
            className="whitespace-nowrap rounded border border-line px-2 py-1 text-[11px] text-ink-2 hover:bg-surface-2"
          >
            ✕
          </button>
        </div>
      </td>
    </tr>
  )
}
