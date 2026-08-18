'use client'

import { useState } from 'react'
import { HeadCombobox, type HeadOpt } from '@/components/head-combobox'
import { SmartCombobox } from '@/components/smart-combobox'

// The Excel-style quick entry row: Date | Details | Location | Amount ± |
// Expense Head | Cost centre | Comments | Add. One signed amount replaces
// the separate receipt / payment forms (−4000 = paid, 4000 = received).
// Cash is one physical pool across all books, so locations from every books
// are offered; the head and cost-centre lists follow the picked location's
// books, and picking a head prefills its master default cost centre — both
// stay editable. The entry posts double-entry in those books on the server.

export interface QuickLocation {
  id: string
  name: string
  entityId: string
  entityCode: string
}

export interface CcOption {
  id: string
  label: string
}

const inputCls = 'rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm'

export function CashQuickRow(props: {
  locations: QuickLocation[]
  headsByEntity: Record<string, HeadOpt[]>
  costCentresByEntity: Record<string, CcOption[]>
  action: (formData: FormData) => Promise<void>
}) {
  const [locationId, setLocationId] = useState(props.locations[0]?.id ?? '')
  const entityId = props.locations.find((l) => l.id === locationId)?.entityId ?? ''
  const [costCentreId, setCostCentreId] = useState('')
  const [ccSeed, setCcSeed] = useState(0)

  return (
    <form action={props.action} className="flex flex-wrap items-center gap-2">
      <input name="date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} className={inputCls} />
      <input name="details" placeholder="Details — what / who" className={`w-48 ${inputCls}`} />
      <select
        name="locationId"
        required
        value={locationId}
        onChange={(e) => setLocationId(e.target.value)}
        className={inputCls}
      >
        {props.locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.entityCode} · {l.name}
          </option>
        ))}
      </select>
      <input
        name="amount"
        required
        inputMode="decimal"
        placeholder="₹ −paid / +received"
        title="Negative = cash paid out, positive = cash received"
        className={`w-36 text-right ${inputCls}`}
      />
      <HeadCombobox
        key={entityId}
        heads={props.headsByEntity[entityId] ?? []}
        required
        placeholder="Expense Head — type or add"
        createName="headText"
        className={`w-52 ${inputCls}`}
        onPick={(head) => {
          setCostCentreId(head?.defaultCostCentreId ?? '')
          setCcSeed((s) => s + 1)
        }}
        onCreateText={() => {
          setCostCentreId('')
          setCcSeed((s) => s + 1)
        }}
      />
      <SmartCombobox
        key={`${entityId}-${ccSeed}`}
        options={props.costCentresByEntity[entityId] ?? []}
        name="costCentreId"
        createName="costCentreText"
        defaultId={costCentreId}
        placeholder="Cost centre"
        className={`w-40 ${inputCls}`}
        onPick={(opt) => setCostCentreId(opt?.id ?? '')}
      />
      <input name="comments" placeholder="Comments" className={`w-36 ${inputCls}`} />
      <button
        type="submit"
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700"
      >
        Add
      </button>
    </form>
  )
}
