'use client'

import { useState } from 'react'
import { NATURES, suggestNature } from '@/lib/statements/natures'
import { GST_RATES, GST_TYPES, TDS_SECTIONS } from '@/lib/tax/calc'
import { HeadCombobox, type HeadOpt } from '@/components/head-combobox'

// The 3-tier tag form (spec §3 step 5): head → nature (auto-suggested from
// the head) → cost centre. Members never see Dr/Cr. The head is a type-ahead
// (v2 prototype): first letters filter, picking fills nature + cost centre.

export type HeadOption = HeadOpt

export interface CostCentreOption {
  id: string
  name: string
}

export function TagForm(props: {
  txnId: string
  isOutflow: boolean
  heads: HeadOption[]
  costCentres: CostCentreOption[]
  action: (formData: FormData) => Promise<void>
  submitLabel: string
  defaults?: { headAccountId?: string | null; nature?: string | null; costCentreId?: string | null }
}) {
  const [nature, setNature] = useState(props.defaults?.nature ?? '')
  const [costCentreId, setCostCentreId] = useState(props.defaults?.costCentreId ?? '')

  return (
    <form action={props.action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="txnId" value={props.txnId} />
      <HeadCombobox
        heads={props.heads}
        defaultHeadId={props.defaults?.headAccountId}
        required
        onPick={(head) => {
          if (head) {
            setNature(suggestNature(head, props.isOutflow))
            // Picking a head moves the cost centre with it: its default when
            // it has one, blank otherwise — the old tag's cost centre must
            // never silently ride along into the new head.
            setCostCentreId(head.defaultCostCentreId ?? '')
          }
        }}
      />
      <select
        name="nature"
        required
        value={nature}
        onChange={(e) => setNature(e.target.value)}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
      >
        <option value="">— nature —</option>
        {NATURES.map((n) => (
          <option key={n.value} value={n.value}>
            {n.label}
          </option>
        ))}
      </select>
      <select
        name="costCentreId"
        value={costCentreId}
        onChange={(e) => setCostCentreId(e.target.value)}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
      >
        <option value="">— cost centre —</option>
        {props.costCentres.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700"
      >
        {props.submitLabel}
      </button>

      {/* Optional GST / TDS details (spec §3 step 5 / §7) */}
      <details className="w-full">
        <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-700">
          GST / TDS details (optional)
        </summary>
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 p-2">
          <span className="text-[10px] font-medium uppercase text-zinc-400">GST</span>
          <select name="gstType" className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs">
            <option value="">type</option>
            {GST_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select name="gstRate" className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs">
            <option value="">rate %</option>
            {GST_RATES.map((r) => (
              <option key={r} value={r}>{r}%</option>
            ))}
          </select>
          <input name="hsn" placeholder="HSN/SAC" className="w-24 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
          <input name="counterpartyGstin" placeholder="Party GSTIN" className="w-36 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
          <span className="ml-3 text-[10px] font-medium uppercase text-zinc-400">or TDS</span>
          <select name="tdsSection" className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs">
            <option value="">section</option>
            {TDS_SECTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <input name="tdsRate" placeholder="rate %" inputMode="decimal" className="w-16 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
          <input name="deducteePan" placeholder="Deductee PAN" className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
        </div>
      </details>
    </form>
  )
}
