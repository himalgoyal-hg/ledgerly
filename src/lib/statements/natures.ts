// Tag natures (spec §3 step 5 tier 2) — client-safe, no server imports.
// The nature is auto-suggested from the chosen head; posting itself is
// uniform (outflow: Dr head / Cr bank; inflow: Dr bank / Cr head), which
// reproduces the spec §3 step 6 posting table exactly.

export const NATURES = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'transfer_own', label: 'Transfer between own accounts' },
  { value: 'loan_given', label: 'Loan given' },
  { value: 'loan_received', label: 'Loan received' },
  { value: 'capital', label: 'Capital' },
  { value: 'reimbursement_settlement', label: 'Reimbursement settlement' },
  { value: 'gst_payment', label: 'GST payment' },
  { value: 'tds_deposit', label: 'TDS deposit' },
] as const

export type Nature = (typeof NATURES)[number]['value']

export function isNature(value: string): value is Nature {
  return NATURES.some((n) => n.value === value)
}

/** Auto-suggest the nature from the chosen head (spec: "auto-suggested from head"). */
export function suggestNature(head: { kind: string; code: string }, isOutflow: boolean): Nature {
  if (head.code.startsWith('11')) return 'transfer_own' // bank accounts group
  if (head.code.startsWith('14')) return 'loan_given' // loans & advances given
  if (head.code.startsWith('23')) return 'loan_received' // loans taken
  if (head.code.startsWith('31')) return 'capital'
  if (head.code.startsWith('24')) return 'reimbursement_settlement' // member payables
  if (head.code === '2220') return 'gst_payment'
  if (head.code === '2230') return 'tds_deposit'
  if (head.kind === 'INCOME') return 'income'
  if (head.kind === 'EXPENSE') return 'expense'
  return isOutflow ? 'expense' : 'income'
}
