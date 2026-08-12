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

const inputCls = 'w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs'

export const NATURE_OPTIONS = NATURES.map((n) => ({ id: n.value, label: n.label }))

export function TagRowCells(props: {
  txnId: string
  isOutflow: boolean
  heads: HeadOption[]
  costCentres: CostCentreOption[]
  action: (formData: FormData) => Promise<void>
  submitLabel: string
  submitTitle?: string
  defaults?: { headAccountId?: string | null; nature?: string | null; costCentreId?: string | null }
  /** Extra row actions (Untag / Undo forms) rendered next to the submit. */
  children?: ReactNode
}) {
  const formId = `tag-${props.txnId}`
  const [nature, setNature] = useState(props.defaults?.nature ?? '')
  const [costCentreId, setCostCentreId] = useState(props.defaults?.costCentreId ?? '')
  const [seed, setSeed] = useState(0)

  return (
    <>
      {/* w-full: the head column absorbs the table's slack, so narration and
          amount stay snug together instead of drifting apart. */}
      <td className="w-full px-2 py-1">
        <HeadCombobox
          heads={props.heads}
          defaultHeadId={props.defaults?.headAccountId}
          required
          formId={formId}
          className={`${inputCls} min-w-36`}
          onPick={(head) => {
            if (head) {
              setNature(suggestNature(head, props.isOutflow))
              setCostCentreId(head.defaultCostCentreId ?? '')
              setSeed((s) => s + 1)
            }
          }}
        />
      </td>
      <td className="px-2 py-1">
        <SmartCombobox
          key={`n${seed}`}
          options={NATURE_OPTIONS}
          name="nature"
          defaultId={nature}
          required
          formId={formId}
          placeholder="nature"
          className={`${inputCls} w-28`}
          onPick={(opt) => setNature(opt?.id ?? '')}
        />
      </td>
      <td className="px-2 py-1">
        <SmartCombobox
          key={`c${seed}`}
          options={props.costCentres.map((c) => ({ id: c.id, label: c.name }))}
          name="costCentreId"
          createName="costCentreText"
          defaultId={costCentreId}
          formId={formId}
          placeholder="cost centre — new name adds it"
          className={`${inputCls} w-40`}
          onPick={(opt) => setCostCentreId(opt?.id ?? '')}
        />
      </td>
      <td className="px-2 py-1">
        <div className="flex items-start gap-1.5">
          <form id={formId} action={props.action}>
            <input type="hidden" name="txnId" value={props.txnId} />
            <button
              type="submit"
              title={props.submitTitle}
              className="whitespace-nowrap rounded bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700"
            >
              {props.submitLabel}
            </button>
          </form>
          {props.children}
          {/* Optional GST / TDS details (spec §3 step 5 / §7) — expands the
              row inline; absolute popovers would clip inside the scroll box. */}
          <details>
            <summary className="cursor-pointer whitespace-nowrap py-1 text-[10px] text-zinc-400 hover:text-zinc-700">
              GST/TDS
            </summary>
            <div className="mt-1 w-44 space-y-1 rounded-md bg-zinc-50 p-1.5">
              <select name="gstType" form={formId} className={inputCls}>
                <option value="">GST type</option>
                {GST_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <select name="gstRate" form={formId} className={inputCls}>
                <option value="">GST rate %</option>
                {GST_RATES.map((r) => (
                  <option key={r} value={r}>{r}%</option>
                ))}
              </select>
              <input name="hsn" form={formId} placeholder="HSN/SAC" className={inputCls} />
              <input
                name="counterpartyGstin"
                form={formId}
                placeholder="Party GSTIN"
                className={inputCls}
              />
              <select name="tdsSection" form={formId} className={inputCls}>
                <option value="">TDS section</option>
                {TDS_SECTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <input
                name="tdsRate"
                form={formId}
                placeholder="TDS rate %"
                inputMode="decimal"
                className={inputCls}
              />
              <input name="deducteePan" form={formId} placeholder="Deductee PAN" className={inputCls} />
            </div>
          </details>
        </div>
      </td>
    </>
  )
}
