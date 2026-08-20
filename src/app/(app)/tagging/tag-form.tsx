'use client'

import { useState, type ReactNode } from 'react'
import { NATURES, suggestNature } from '@/lib/statements/natures'
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

/**
 * The bulk bar's three linked fields (Himal, 20 Aug: "expense head jari
 * tak tar automatically sagl feel zal pahije"): picking the Expense Head
 * fills the Cost centre (its master default) and mirrors into the
 * Accounting Head — both re-mount on every pick (the `seed` key) and stay
 * editable; a changed Accounting Head highlights and never writes back.
 */
export function BulkTagFields(props: { heads: HeadOption[]; costCentres: CostCentreOption[]; className?: string }) {
  const cls = props.className ?? inputCls
  const [ccId, setCcId] = useState('')
  const [expHeadId, setExpHeadId] = useState('')
  const [acctHeadId, setAcctHeadId] = useState('')
  const [seed, setSeed] = useState(0)
  return (
    <>
      <HeadCombobox
        heads={props.heads}
        required
        placeholder="Expense Head — type or add"
        createName="headText"
        className={cls}
        onPick={(head) => {
          setExpHeadId(head?.id ?? '')
          setAcctHeadId(head?.id ?? '')
          setCcId(head?.defaultCostCentreId ?? '')
          setSeed((s) => s + 1)
        }}
        onCreateText={() => {
          setExpHeadId('')
          setAcctHeadId('')
          setCcId('')
          setSeed((s) => s + 1)
        }}
      />
      <SmartCombobox
        key={`c${seed}`}
        options={props.costCentres.map((c) => ({ id: c.id, label: c.name }))}
        name="costCentreId"
        createName="costCentreText"
        defaultId={ccId}
        placeholder="Cost centre — type or add"
        className={cls}
        onPick={(o) => setCcId(o?.id ?? '')}
      />
      <HeadCombobox
        key={`a${seed}`}
        heads={props.heads}
        name="accountingHeadId"
        createName="accountingHeadText"
        defaultHeadId={acctHeadId || undefined}
        placeholder="Accounting Head — same as head"
        className={`${cls} ${
          acctHeadId && acctHeadId !== expHeadId ? 'border-primary/40 bg-primary-soft font-medium text-primary' : ''
        }`}
        onPick={(h) => setAcctHeadId(h?.id ?? '')}
      />
    </>
  )
}

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
    /** The tag's 2nd head; null = mirrors the Expense Head. */
    accountingHeadId?: string | null
    /** Free comment on the row. */
    note?: string | null
    // Stored GST/TDS details. The panel that edited them was removed
    // (Himal, 20 Aug); they ride here only so nothing reads as missing —
    // a Save sends no tax fields, and the server then keeps what is stored.
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
  // The tag's 2nd head (Himal, 20 Aug): whatever lands in Expense Head
  // mirrors into Accounting Head automatically; changing the Accounting
  // Head is allowed and NEVER writes back into the Expense Head.
  const [expHeadId, setExpHeadId] = useState(props.defaults?.headAccountId ?? '')
  const [acctHeadId, setAcctHeadId] = useState(
    props.defaults?.accountingHeadId ?? props.defaults?.headAccountId ?? '',
  )
  const [seed, setSeed] = useState(0)

  return (
    <>
      {/* The tag tiers share the table's slack (narration and amount stay
          snug) and the same input styling; the Accounting Head is a head
          picker of its own — it mirrors the Expense Head until changed. */}
      <td className="w-[19%] px-2 py-1">
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
              // the Accounting Head follows the Expense Head pick (mirror);
              // the user can still change it after — one-way only
              setExpHeadId(head.id)
              setAcctHeadId(head.id)
              setSeed((s) => s + 1)
            }
          }}
          onCreateText={() => {
            // A brand-new head lands under Expenses (outflow) or Income
            // (inflow) on the server — suggest the matching nature here.
            setNature(props.isOutflow ? 'expense' : 'income')
            setCostCentreId('')
            // no id yet to mirror — the server stores NULL (= mirror)
            setExpHeadId('')
            setAcctHeadId('')
            setSeed((s) => s + 1)
          }}
        />
      </td>
      {/* Nature rides hidden — auto from the head / master, per Himal
          (18 Aug): it posts correctly without taking a column. */}
      <td className="w-[15%] px-2 py-1">
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
      {/* The tag's 2nd head — its own column: it mirrors whatever the
          Expense Head is (re-mounts on every head pick, the `seed` key),
          stays editable, and an override never flows back leftwards.
          Overridden = highlighted so a changed head is visible at a glance. */}
      <td className="w-[15%] px-2 py-1">
        <HeadCombobox
          key={`a${seed}`}
          heads={props.heads}
          name="accountingHeadId"
          createName="accountingHeadText"
          defaultHeadId={acctHeadId || undefined}
          formId={formId}
          placeholder="= Expense Head"
          className={`${inputCls} ${
            acctHeadId && acctHeadId !== expHeadId
              ? 'border-primary/40 bg-primary-soft font-medium text-primary'
              : ''
          }`}
          onPick={(h) => setAcctHeadId(h?.id ?? '')}
        />
      </td>
      {/* Note — a free comment on the row, saved with the tag */}
      <td className="w-[13%] px-2 py-1">
        <input
          name="note"
          form={formId}
          defaultValue={props.defaults?.note ?? ''}
          placeholder="Note"
          title="A comment on this transaction — saved with the tag"
          className={inputCls}
        />
      </td>
      <td className="sticky right-0 z-10 bg-surface px-2 py-1">
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
        </div>
      </td>
    </>
  )
}
