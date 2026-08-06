'use client'

import { useState } from 'react'
import { NATURES, suggestNature } from '@/lib/statements/natures'

// The 3-tier tag form (spec §3 step 5): head → nature (auto-suggested from
// the head) → cost centre. Members never see Dr/Cr.

export interface HeadOption {
  id: string
  code: string
  name: string
  kind: string
}

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

  return (
    <form action={props.action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="txnId" value={props.txnId} />
      <select
        name="headAccountId"
        required
        defaultValue={props.defaults?.headAccountId ?? ''}
        onChange={(e) => {
          const head = props.heads.find((h) => h.id === e.target.value)
          if (head) setNature(suggestNature(head, props.isOutflow))
        }}
        className="min-w-48 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
      >
        <option value="">— head —</option>
        {props.heads.map((h) => (
          <option key={h.id} value={h.id}>
            {h.code} · {h.name}
          </option>
        ))}
      </select>
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
        defaultValue={props.defaults?.costCentreId ?? ''}
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
    </form>
  )
}
