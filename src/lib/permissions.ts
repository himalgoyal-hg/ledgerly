// The member permission matrix (spec §1.1).
// Admin holds every permission unconditionally; members start with zero
// (except reimbursementSubmit). Admin-only capabilities (reimbursement
// approval, masters editing, user management) are NOT flags — they are
// gated by role === 'ADMIN' and can never be granted to members.

export const PERMISSION_FLAGS = [
  'statementUpload',
  'transactionTagging',
  'transactionEditDelete',
  'viewFinancialReports',
  'viewTaxRegisters',
  'cashEntries',
  'viewCashReports',
  'reimbursementSubmit',
] as const

export type PermissionFlag = (typeof PERMISSION_FLAGS)[number]

export const PERMISSION_LABELS: Record<PermissionFlag, string> = {
  statementUpload: 'Statement upload & import',
  transactionTagging: 'Transaction tagging (queue work)',
  transactionEditDelete: 'Transaction edit / delete / undo',
  viewFinancialReports: 'View P&L / Balance Sheet',
  viewTaxRegisters: 'View GST / TDS registers',
  cashEntries: 'Cash entries',
  viewCashReports: 'View cash reports',
  reimbursementSubmit: 'Reimbursement submit (own)',
}

export function isPermissionFlag(value: string): value is PermissionFlag {
  return (PERMISSION_FLAGS as readonly string[]).includes(value)
}

// Role presets (requirements §C3): the four working roles as flag bundles.
export const ROLE_PRESETS = {
  accounting: {
    label: 'Accounting',
    flags: ['statementUpload', 'transactionTagging', 'viewFinancialReports'],
  },
  finops: {
    label: 'Finance & Ops',
    flags: ['viewFinancialReports', 'viewCashReports', 'reimbursementSubmit'],
  },
  reimbursement: { label: 'Reimbursement entry', flags: ['reimbursementSubmit'] },
  none: { label: 'No access', flags: [] },
} as const
export type RolePreset = keyof typeof ROLE_PRESETS
