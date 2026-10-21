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

export const NATURE_OPTIONS = NATURES.map((n) => ({
  id: n.value,
  label: n.label,
}))

/**
 * The bulk bar's three linked fields (Himal, 20 Aug: "expense head jari
 * tak tar automatically sagl feel zal pahije"): picking the Expense Head
 * fills the Cost centre (its master default) and mirrors into the
 * Accounting Head — both re-mount on every pick (the `seed` key) and stay
 * editable; a changed Accounting Head highlights and never writes back.
 */
export function BulkTagFields(props: {
  heads: HeadOption[]
  costCentres: CostCentreOption[]
  className?: string
}) {
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
        kindChoice={{ name: 'headKind', initial: 'EXPENSE' }}
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
        kindChoice={{ name: 'accountingHeadKind', initial: 'EXPENSE' }}
        defaultHeadId={acctHeadId || undefined}
        placeholder="Accounting Head — same as head"
        className={`${cls} ${
          acctHeadId && acctHeadId !== expHeadId
            ? 'border-primary/40 bg-primary-soft font-medium text-primary'
            : ''
        }`}
        onPick={(h) => setAcctHeadId(h?.id ?? '')}
      />
    </>
  )
}

type TagRowCellsProps = Parameters<typeof TagRowCells>[0]

/**
 * A posted row: the tag as plain text with an Edit button; the full retag
 * form (TagRowCells) mounts only on click. Hundreds of posted rows each
 * carrying three pickers and a form made the page seconds slow to hydrate —
 * and retagging a posted row is the rare action, not the common one.
 * The text comes as four strings (not rendered cells) to keep the payload
 * small — the page sends ~600 of these.
 */
export function PostedRowCells(
  props: TagRowCellsProps & {
    shown: {
      head: string | null
      incomeHead: string | null
      costCentre: string
      accountingHead: string | null
      note: string | null
    }
  },
) {
  const [editing, setEditing] = useState(false)
  if (!editing) {
    const t = props.shown
    return (
      <>
        <td className="px-2 py-1.5 text-xs text-ink-2">{t.head ?? <span className="text-ink-3">—</span>}</td>
        <td className="px-2 py-1.5 text-xs text-ink-2">
          {t.incomeHead ?? <span className="text-ink-3">—</span>}
        </td>
        <td className="px-2 py-1.5 text-xs text-ink-2">{t.costCentre}</td>
        <td className="px-2 py-1.5 text-xs">
          {/* overridden 2nd head shows highlighted; mirror shows muted */}
          {t.accountingHead ? (
            <span className="rounded bg-primary-soft px-1.5 py-0.5 font-medium text-primary">
              {t.accountingHead}
            </span>
          ) : (
            <span className="text-ink-3" title="Same as the Expense Head">
              —
            </span>
          )}
        </td>
        <td className="px-2 py-1.5 text-xs text-ink-2" title={t.note ?? undefined}>
          {t.note ?? <span className="text-ink-3">—</span>}
        </td>
        <td className="sticky right-0 z-10 bg-surface px-2 py-1.5">
          <button
            type="button"
            onClick={() => setEditing(true)}
            title={props.submitTitle}
            className="whitespace-nowrap rounded border border-line px-2 py-0.5 text-xs text-ink-2 hover:bg-surface-2"
          >
            Edit
          </button>
        </td>
      </>
    )
  }
  const { shown: _shown, ...rest } = props
  // Save closes the row again once the retag has gone through; an error
  // leaves it open with what was typed.
  const saveAndClose = async (formData: FormData) => {
    await props.action(formData)
    setEditing(false)
  }
  return (
    <TagRowCells {...rest} action={saveAndClose}>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="whitespace-nowrap rounded border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-2"
      >
        Cancel
      </button>
      {props.children}
    </TagRowCells>
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
    // Stored GST/TDS details — prefilled into the panel, so a re-save or
    // a retag carries them forward instead of silently blanking them.
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
  /** Page-level datalist ids (see shared-datalists.tsx) — one copy of the options for all rows. */
  headListId?: string
  costCentreListId?: string
  /** The two head columns: Expense Head lists every non-income head, Income Head the income ones. */
  expenseHeads: HeadOption[]
  incomeHeads: HeadOption[]
  expenseListId?: string
  incomeListId?: string
}) {
  const formId = `tag-${props.txnId}`
  const [nature, setNature] = useState(props.defaults?.nature ?? '')
  const [costCentreId, setCostCentreId] = useState(props.defaults?.costCentreId ?? '')
  // The tag's 2nd head (Himal, 20 Aug): whatever lands in Expense Head
  // mirrors into Accounting Head automatically; changing the Accounting
  // Head is allowed and NEVER writes back into the Expense Head.
  const [expHeadId, setExpHeadId] = useState(props.defaults?.headAccountId ?? '')
  // Which column holds the row's head; picking in one empties the other
  // (its own seed re-mounts it blank) so a row never submits two heads.
  const startsIncome = props.incomeHeads.some((h) => h.id === props.defaults?.headAccountId)
  // The column being used locks the other one (Himal, 21 Oct: "ek select
  // kel ki dusra select honar nahi"); emptying the box unlocks it again.
  const [headSide, setHeadSide] = useState<'expense' | 'income' | null>(
    props.defaults?.headAccountId ? (startsIncome ? 'income' : 'expense') : null,
  )
  const [expenseSeed, setExpenseSeed] = useState(0)
  const [incomeSeed, setIncomeSeed] = useState(0)
  const headPicked = (head: HeadOpt) => {
    setNature(suggestNature(head, props.isOutflow))
    setCostCentreId(head.defaultCostCentreId ?? '')
    // the Accounting Head follows the head pick (mirror); the user can
    // still change it after — one-way only
    setExpHeadId(head.id)
    setAcctHeadId(head.id)
    setSeed((s) => s + 1)
  }
  const headTyped = (kind: 'EXPENSE' | 'INCOME') => {
    // A brand-new head lands in the column it was typed in — nature follows.
    setNature(kind === 'INCOME' ? 'income' : 'expense')
    setCostCentreId('')
    // no id yet to mirror — the server stores NULL (= mirror)
    setExpHeadId('')
    setAcctHeadId('')
    setSeed((s) => s + 1)
  }
  const [acctHeadId, setAcctHeadId] = useState(
    props.defaults?.accountingHeadId ?? props.defaults?.headAccountId ?? '',
  )
  const [seed, setSeed] = useState(0)

  // GST and TDS can ride together on a row (professional fees: taxable +
  // GST − TDS; the server splits with TDS on the taxable value). Back at
  // Himal's ask, 20 Aug — prefilled, so re-saving never blanks them.
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
  // The panel's controls render only while it is open; closed, the same
  // values ride as hidden inputs so a plain Save still carries GST/TDS.
  // Hundreds of rows × a full panel each was a third of the page's HTML.
  const [taxOpen, setTaxOpen] = useState(false)

  return (
    <>
      {/* The tag tiers share the table's slack (narration and amount stay
          snug) and the same input styling; the Accounting Head is a head
          picker of its own — it mirrors the Expense Head until changed. */}
      <td className="w-[16%] px-2 py-1">
        <HeadCombobox
          key={`e${expenseSeed}`}
          heads={props.expenseHeads}
          listId={props.expenseListId}
          defaultHeadId={startsIncome ? undefined : props.defaults?.headAccountId}
          formId={formId}
          className={inputCls}
          placeholder="Expense Head — type or add"
          createName="headText"
          disabled={headSide === 'income'}
          onText={(t) => setHeadSide(t.trim() ? 'expense' : null)}
          onPick={(head) => {
            if (head) {
              headPicked(head)
              setIncomeSeed((s) => s + 1)
            }
          }}
          onCreateText={() => {
            headTyped('EXPENSE')
            setIncomeSeed((s) => s + 1)
          }}
        />
      </td>
      {/* Income Head — the same picker over the income heads only; a new
          name typed here is born under Income. One of the two columns
          carries the row's head, never both. */}
      <td className="w-[14%] px-2 py-1">
        <HeadCombobox
          key={`i${incomeSeed}`}
          heads={props.incomeHeads}
          listId={props.incomeListId}
          name="incomeHeadAccountId"
          defaultHeadId={startsIncome ? props.defaults?.headAccountId : undefined}
          formId={formId}
          className={inputCls}
          placeholder="Income Head — type or add"
          createName="incomeHeadText"
          disabled={headSide === 'expense'}
          onText={(t) => setHeadSide(t.trim() ? 'income' : null)}
          onPick={(head) => {
            if (head) {
              headPicked(head)
              setExpenseSeed((s) => s + 1)
            }
          }}
          onCreateText={() => {
            headTyped('INCOME')
            setExpenseSeed((s) => s + 1)
          }}
        />
      </td>
      {/* Nature rides hidden — auto from the head / master, per Himal
          (18 Aug): it posts correctly without taking a column. */}
      <td className="w-[13%] px-2 py-1">
        <SmartCombobox
          key={`c${seed}`}
          options={props.costCentres.map((c) => ({ id: c.id, label: c.name }))}
          listId={props.costCentreListId}
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
      <td className="w-[14%] px-2 py-1">
        <HeadCombobox
          key={`a${seed}`}
          heads={props.heads}
          listId={props.headListId}
          name="accountingHeadId"
          createName="accountingHeadText"
          kindChoice={{ name: 'accountingHeadKind', initial: props.isOutflow ? 'EXPENSE' : 'INCOME' }}
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
      <td className="w-[11%] px-2 py-1">
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
          {/* GST / TDS (spec §3 step 5 / §7) — expands inline; an absolute
              popover would clip inside the table's scroll box. The summary
              shows what is set, so a taxed row reads without opening. */}
          <details onToggle={(e) => setTaxOpen(e.currentTarget.open)}>
            <summary
              className={`cursor-pointer whitespace-nowrap py-1 text-[10px] ${
                gst.rate || tds.rate ? 'font-semibold text-warning' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {[
                gst.rate ? `GST ${gst.rate}%` : '',
                tds.rate ? `TDS ${tds.rate}%${tds.section ? ` ${tds.section}` : ''}` : '',
              ]
                .filter(Boolean)
                .join(' + ') || 'GST/TDS'}
            </summary>
            {/* marks the panel as present, so a blank one means "no tax"
                rather than "say nothing" — see tagFields */}
            <input type="hidden" name="taxPanel" value="1" form={formId} />
            {!taxOpen && (
              <>
                <input type="hidden" name="gstType" value={gst.type} form={formId} />
                <input type="hidden" name="gstRate" value={gst.rate} form={formId} />
                <input type="hidden" name="hsn" value={gst.hsn} form={formId} />
                <input type="hidden" name="counterpartyGstin" value={gst.gstin} form={formId} />
                <input type="hidden" name="tdsSection" value={tds.section} form={formId} />
                <input type="hidden" name="tdsRate" value={tds.rate} form={formId} />
                <input type="hidden" name="deducteePan" value={tds.pan} form={formId} />
              </>
            )}
            {taxOpen && (
              <div className="mt-1 w-44 space-y-1 rounded-lg bg-surface-2/60 p-1.5">
                <p className="text-[9px] font-semibold uppercase tracking-wider text-ink-3">GST</p>
                <select
                  name="gstType"
                  form={formId}
                  value={gst.type}
                  onChange={(e) => setGst((g) => ({ ...g, type: e.target.value }))}
                  className={inputCls}
                >
                  <option value="">GST type</option>
                  {GST_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <select
                  name="gstRate"
                  form={formId}
                  value={gst.rate}
                  onChange={(e) => setGst((g) => ({ ...g, rate: e.target.value }))}
                  className={inputCls}
                >
                  <option value="">GST rate %</option>
                  {GST_RATES.map((r) => (
                    <option key={r} value={r}>
                      {r}%
                    </option>
                  ))}
                </select>
                <input
                  name="hsn"
                  form={formId}
                  value={gst.hsn}
                  onChange={(e) => setGst((g) => ({ ...g, hsn: e.target.value }))}
                  placeholder="HSN/SAC"
                  className={inputCls}
                />
                <input
                  name="counterpartyGstin"
                  form={formId}
                  value={gst.gstin}
                  onChange={(e) => setGst((g) => ({ ...g, gstin: e.target.value }))}
                  placeholder="Party GSTIN"
                  className={inputCls}
                />
                <p className="pt-1 text-[9px] font-semibold uppercase tracking-wider text-ink-3">
                  TDS — on the taxable value, both may apply
                </p>
                <select
                  name="tdsSection"
                  form={formId}
                  value={tds.section}
                  onChange={(e) => setTds((t) => ({ ...t, section: e.target.value }))}
                  className={inputCls}
                >
                  <option value="">TDS section</option>
                  {TDS_SECTIONS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
                <input
                  name="tdsRate"
                  form={formId}
                  value={tds.rate}
                  onChange={(e) => setTds((t) => ({ ...t, rate: e.target.value }))}
                  placeholder="TDS rate %"
                  inputMode="decimal"
                  className={inputCls}
                />
                <input
                  name="deducteePan"
                  form={formId}
                  value={tds.pan}
                  onChange={(e) => setTds((t) => ({ ...t, pan: e.target.value }))}
                  placeholder="Deductee PAN"
                  className={inputCls}
                />
              </div>
            )}
          </details>
        </div>
      </td>
    </>
  )
}
