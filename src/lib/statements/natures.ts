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
  { value: 'member_advance', label: 'Advance to member' },
  { value: 'reimbursement_settlement', label: 'Reimbursement settlement' },
  { value: 'gst_payment', label: 'GST payment' },
  { value: 'tds_deposit', label: 'TDS deposit' },
] as const

export type Nature = (typeof NATURES)[number]['value']

export function isNature(value: string): value is Nature {
  return NATURES.some((n) => n.value === value)
}

/**
 * Auto-suggest the nature from the chosen head. Ledger specials (bank /
 * cash / contra codes) win first; then the MASTER sheet's "Nature of a/c"
 * for the category speaks; the head's kind is the last word. Always just a
 * prefill — the tag row can change it.
 */
export function suggestNature(
  head: { kind: string; code: string; name?: string | null; masterNature?: string | null },
  isOutflow: boolean,
): Nature {
  if (head.name?.startsWith('Advance — ')) return 'member_advance' // a member's advance account
  if (head.code.startsWith('11')) return 'transfer_own' // bank accounts group
  if (head.code.startsWith('12')) return 'transfer_own' // cash locations
  if (head.code.startsWith('18')) return 'transfer_own' // transfers in transit (contra)
  if (head.code.startsWith('25')) return 'transfer_own' // credit-card settlement
  if (head.code.startsWith('14')) return 'loan_given' // loans & advances given
  if (head.code.startsWith('23')) return 'loan_received' // loans taken
  if (head.code.startsWith('31')) return 'capital'
  if (head.code.startsWith('24')) return 'reimbursement_settlement' // member payables
  if (head.code === '2220') return 'gst_payment'
  if (head.code === '2230') return 'tds_deposit'
  const mn = head.masterNature?.toLowerCase() ?? ''
  if (mn) {
    if (mn.includes('contra') || mn.includes('personal')) return 'transfer_own'
    if (mn.includes('expense') && mn.includes('income')) return isOutflow ? 'expense' : 'income'
    if (mn === 'income') return 'income'
    if (mn === 'expense') return 'expense'
    if (mn === 'liability' && !isOutflow) return 'loan_received'
  }
  if (head.kind === 'INCOME') return 'income'
  if (head.kind === 'EXPENSE') return 'expense'
  return isOutflow ? 'expense' : 'income'
}
