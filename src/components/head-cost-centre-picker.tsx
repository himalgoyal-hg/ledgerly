'use client'

import { useState } from 'react'
import { HeadCombobox, type HeadOpt } from '@/components/head-combobox'
import { SmartCombobox } from '@/components/smart-combobox'

// Head + cost centre as a pair (invoices, reimbursements): picking a head
// pulls its master default straight into the cost-centre field, same as the
// tagging queue — still editable, still creatable. Without this, the two
// fields sit side by side with no tie between them and a blank cost centre
// silently posts unless the human fills it by hand every time.

export function HeadCostCentrePicker(props: {
  heads: HeadOpt[]
  costCentres: { id: string; name: string }[]
  headName?: string
  costCentreName?: string
  headPlaceholder?: string
  costCentrePlaceholder?: string
  className?: string
  formId?: string
  defaultHeadId?: string | null
  defaultCostCentreId?: string | null
  required?: boolean
}) {
  const [costCentreId, setCostCentreId] = useState(props.defaultCostCentreId ?? '')
  const [seed, setSeed] = useState(0)

  return (
    <>
      <HeadCombobox
        heads={props.heads}
        name={props.headName ?? 'headAccountId'}
        defaultHeadId={props.defaultHeadId}
        required={props.required}
        formId={props.formId}
        className={props.className}
        placeholder={props.headPlaceholder ?? 'Expense Head — type or add'}
        createName="headText"
        onPick={(head) => {
          setCostCentreId(head?.defaultCostCentreId ?? '')
          setSeed((s) => s + 1)
        }}
        onCreateText={() => {
          setCostCentreId('')
          setSeed((s) => s + 1)
        }}
      />
      <SmartCombobox
        key={`cc${seed}`}
        options={props.costCentres.map((c) => ({ id: c.id, label: c.name }))}
        name={props.costCentreName ?? 'costCentreId'}
        createName="costCentreText"
        defaultId={costCentreId}
        formId={props.formId}
        placeholder={props.costCentrePlaceholder ?? 'Cost centre — type or add'}
        className={props.className}
        onPick={(opt) => setCostCentreId(opt?.id ?? '')}
      />
    </>
  )
}
