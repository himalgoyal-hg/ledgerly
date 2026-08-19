'use client'

import { useState, type ReactNode } from 'react'
import { NATURES, suggestNature } from '@/lib/statements/natures'
import { GST_RATES, GST_TYPES, TDS_SECTIONS } from '@/lib/tax/calc'
import { HeadCombobox, type HeadOpt } from '@/components/head-combobox'
import { SmartCombobox } from '@/components/smart-combobox'

// Spreadsheet-style tag cells (spec §3 step 5): head → nature (auto-suggested
// from the head) → cost centre, laid out as table cells so the queue reads
// like a sheet — one transaction per line. All three tiers are type-ahead
// comboboxes; the cost centre is creatable (an unknown name is added to these
// books on submit). The inputs bind to a row-scoped <form> via the form=""
// attribute; picking a head fills nature and moves the cost centre with it
// (its default, blank otherwise — the old tag's cost centre must never
// silently ride along into the new head). The nature/cc comboboxes re-mount
// on every head pick (the `seed` key) so their text follows the head.

export type HeadOption = HeadOpt

export interface CostCentreOption {
  id: string
  name: string
}

const inputCls = 'w-full rounded border border-line bg-surface px-1.5 py-1 text-xs'

export const NATURE_OPTIONS = NATURES.map((n) => ({ id: n.value, label: n.label }))

export function TagRowCells(props: {
  txnId: string
  isOutflow: boolean
  heads: HeadOption[]
  costCentres: CostCentreOption[]
  action: (formData: FormData) => Promise<void>
  submitLabel: string
  submitTitle?: string
  defaults?: {
    headAccountId?: string | null
    nature?: string | null
    costCentreId?: string | null
    separateReport?: boolean | null
    // Stored GST/TDS details — prefilled into the panel so a re-save or
    // retag carries them forward instead of silently blanking them.
    gstType?: string | null
    gstRate?: string | null
    hsn?: string | null
    counterpartyGstin?: string | null
    tdsSection?: string | null
    tdsRate?: string | null
    deducteePan?: string | null
  }
  /** Extra row actions (Untag / Undo forms) rendered next to the submit. */
  children?: ReactNode
}) {
  const formId = `tag-${props.txnId}`
  const [nature, setNature] = useState(props.defaults?.nature ?? '')
  const [costCentreId, setCostCentreId] = useState(props.defaults?.costCentreId ?? '')
  // 2nd tagging type — default No everywhere; Yes sends the posted line to
  // the separate-report lens on Reports → By (Himal, 19 Aug).
  const [sepReport, setSepReport] = useState(props.defaults?.separateReport ? 'Yes' : '')
  const [seed, setSeed] = useState(0)

  // GST and TDS can ride together on a row (professional fees: taxable +
  // GST − TDS; the server splits with TDS on the taxable value). The panel
  // prefills stored values so a re-save or retag never blanks them.
  const [gst, setGst] = useState({
    type: props.defaults?.gstType ?? '',
    rate: props.defaults?.gstRate ?? '',
    hsn: props.defaults?.hsn ?? '',
    gstin: props.defaults?.counterpartyGstin ?? '',
  })
  const [tds, setTds] = useState({
    section: props.defaults?.tdsSection ?? '',
    rate: props.defaults?.tdsRate ?? '',
    pan: props.defaults?.deducteePan ?? '',
  })
  const setGstField = (field: keyof typeof gst) => (value: string) => {
    setGst((g) => ({ ...g, [field]: value }))
  }
  const setTdsField = (field: keyof typeof tds) => (value: string) => {
    setTds((t) => ({ ...t, [field]: value }))
  }

  return (
    <>
      {/* The tag tiers share the table's slack (narration and amount stay
          snug) and the same input styling; the Accounting Head Yes/No gets
          its own column like the sheet would give it. */}
      <td className="w-[24%] px-2 py-1">
        <HeadCombobox
          heads={props.heads}
          defaultHeadId={props.defaults?.headAccountId}
          required
          formId={formId}
          className={inputCls}
          placeholder="Expense Head — type or add"
          createName="headText"
          onPick={(head) => {
            if (head) {
              setNature(suggestNature(head, props.isOutflow))
              setCostCentreId(head.defaultCostCentreId ?? '')
              setSeed((s) => s + 1)
            }
          }}
          onCreateText={() => {
            // A brand-new head lands under Expenses (outflow) or Income
            // (inflow) on the server — suggest the matching nature here.
            setNature(props.isOutflow ? 'expense' : 'income')
            setCostCentreId('')
            setSeed((s) => s + 1)
          }}
        />
      </td>
      {/* Nature rides hidden — auto from the head / master, per Himal
          (18 Aug): it posts correctly without taking a column. */}
      <td className="w-[22%] px-2 py-1">
        <SmartCombobox
          key={`c${seed}`}
          options={props.costCentres.map((c) => ({ id: c.id, label: c.name }))}
          name="costCentreId"
          createName="costCentreText"
          defaultId={costCentreId}
          formId={formId}
          placeholder="Cost centre — type or add"
          className={inputCls}
          onPick={(opt) => setCostCentreId(opt?.id ?? '')}
        />
      </td>
      {/* 2nd tag — its own column, like the sheet: Yes routes this entry to
          the Accounting Head report (Reports → By). No is the default. */}
      <td className="px-2 py-1">
        <select
          name="separateReport"
          form={formId}
          value={sepReport}
          onChange={(e) => setSepReport(e.target.value)}
          title="Accounting Head — Yes shows this entry in its own report on Reports → By (head / cost centre)"
          className={`w-full rounded border px-1.5 py-1 text-xs ${
            sepReport === 'Yes'
              ? 'border-primary/40 bg-primary-soft font-semibold text-primary'
              : 'border-line bg-surface text-ink-2'
          }`}
        >
          <option value="">No</option>
          <option value="Yes">Yes</option>
        </select>
      </td>
      <td className="px-2 py-1">
        <div className="flex items-start gap-1.5">
          <form id={formId} action={props.action}>
            <input type="hidden" name="txnId" value={props.txnId} />
            <input type="hidden" name="nature" value={nature || (props.isOutflow ? 'expense' : 'income')} />
            <button
              type="submit"
              title={props.submitTitle}
              className="whitespace-nowrap rounded bg-primary px-2.5 py-1 text-xs font-medium text-white hover:bg-primary-strong"
            >
              {props.submitLabel}
            </button>
          </form>
          {props.children}
          {/* Optional GST / TDS details (spec §3 step 5 / §7) — expands the
              row inline; absolute popovers would clip inside the scroll box.
              Prefilled from the stored tag, and the toggle shows what's set
              so a filled row is visible without opening it. */}
          <details>
            <summary
              className={`cursor-pointer whitespace-nowrap py-1 text-[10px] ${
                gst.rate || tds.rate
                  ? 'font-semibold text-warning'
                  : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {[
                gst.rate ? `GST ${gst.rate}%` : '',
                tds.rate ? `TDS ${tds.rate}%${tds.section ? ` ${tds.section}` : ''}` : '',
              ]
                .filter(Boolean)
                .join(' + ') || 'GST/TDS'}
            </summary>
            <div className="mt-1 w-44 space-y-1 rounded-lg bg-surface-2/60 p-1.5">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-ink-3">
                GST
              </p>
              <select name="gstType" form={formId} value={gst.type} onChange={(e) => setGstField('type')(e.target.value)} className={inputCls}>
                <option value="">GST type</option>
                {GST_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <select name="gstRate" form={formId} value={gst.rate} onChange={(e) => setGstField('rate')(e.target.value)} className={inputCls}>
                <option value="">GST rate %</option>
                {GST_RATES.map((r) => (
                  <option key={r} value={r}>{r}%</option>
                ))}
              </select>
              <input name="hsn" form={formId} value={gst.hsn} onChange={(e) => setGstField('hsn')(e.target.value)} placeholder="HSN/SAC" className={inputCls} />
              <input
                name="counterpartyGstin"
                form={formId}
                value={gst.gstin}
                onChange={(e) => setGstField('gstin')(e.target.value)}
                placeholder="Party GSTIN"
                className={inputCls}
              />
              <p className="pt-1 text-[9px] font-semibold uppercase tracking-wider text-ink-3">
                TDS — on the taxable value, both may apply
              </p>
              <select name="tdsSection" form={formId} value={tds.section} onChange={(e) => setTdsField('section')(e.target.value)} className={inputCls}>
                <option value="">TDS section</option>
                {TDS_SECTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <input
                name="tdsRate"
                form={formId}
                value={tds.rate}
                onChange={(e) => setTdsField('rate')(e.target.value)}
                placeholder="TDS rate %"
                inputMode="decimal"
                className={inputCls}
              />
              <input name="deducteePan" form={formId} value={tds.pan} onChange={(e) => setTdsField('pan')(e.target.value)} placeholder="Deductee PAN" className={inputCls} />
            </div>
          </details>
        </div>
      </td>
    </>
  )
}
