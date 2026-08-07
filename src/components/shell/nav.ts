import 'server-only'
import { hasPermission, isAdmin, type CurrentUser } from '@/lib/auth'

// The navigation registry, grouped the way the work is grouped. Filtering
// happens HERE, server-side, before anything crosses to the client — a hidden
// item must never appear in the HTML or the RSC payload (verify-phase1 greps
// for exactly that). The filter is still cosmetic: every page and action
// re-checks permissions server-side.

export interface NavItem {
  href: string
  label: string
  icon: string // name resolved by the client icon registry in shell.tsx
}

export interface NavGroup {
  title: string | null
  items: NavItem[]
}

export function buildNav(user: CurrentUser): NavGroup[] {
  const admin = isAdmin(user)
  const groups: { title: string | null; items: (NavItem & { show: boolean })[] }[] = [
    {
      title: null,
      items: [{ href: '/', label: 'Overview', icon: 'dashboard', show: true }],
    },
    {
      title: 'Banking',
      items: [
        { href: '/statements', label: 'Statements', icon: 'statements', show: hasPermission(user, 'statementUpload') },
        { href: '/tagging', label: 'Tagging queue', icon: 'tagging', show: hasPermission(user, 'transactionTagging') },
        { href: '/cash', label: 'Cash', icon: 'cash', show: hasPermission(user, 'cashEntries') || hasPermission(user, 'viewCashReports') },
        { href: '/reimbursements', label: 'Reimbursements', icon: 'reimbursements', show: hasPermission(user, 'reimbursementSubmit') || admin },
      ],
    },
    {
      title: 'Accounting',
      items: [
        { href: '/journal', label: 'Journal', icon: 'journal', show: admin },
        { href: '/bills', label: 'Bills', icon: 'bills', show: admin },
        { href: '/invoices', label: 'Invoices', icon: 'invoices', show: admin },
        { href: '/salary', label: 'Salary', icon: 'salary', show: admin },
        { href: '/tasks', label: 'Tasks', icon: 'tasks', show: admin },
      ],
    },
    {
      title: 'Insights',
      items: [
        { href: '/reports', label: 'Reports', icon: 'reports', show: hasPermission(user, 'viewFinancialReports') },
        { href: '/tax', label: 'GST / TDS', icon: 'tax', show: hasPermission(user, 'viewTaxRegisters') },
        { href: '/admin/trial-balance', label: 'Trial balance', icon: 'trialBalance', show: admin },
        { href: '/admin/ledgers', label: 'Ledgers', icon: 'ledgers', show: admin },
      ],
    },
    {
      title: 'Organisation',
      items: [
        { href: '/admin/coa', label: 'Accounts', icon: 'accounts', show: admin },
        { href: '/admin/cost-centres', label: 'Cost centres', icon: 'costCentres', show: admin },
        { href: '/admin/periods', label: 'Periods', icon: 'periods', show: admin },
        { href: '/admin/entities', label: 'Entities', icon: 'entities', show: admin },
        { href: '/admin/banking', label: 'Banking & cash', icon: 'banking', show: admin },
        { href: '/admin/users', label: 'Users & permissions', icon: 'users', show: admin },
        { href: '/admin/automation', label: 'Automation', icon: 'automation', show: admin },
        { href: '/admin/audit', label: 'Audit log', icon: 'audit', show: admin },
      ],
    },
  ]
  return groups
    .map((g) => ({ title: g.title, items: g.items.filter((i) => i.show).map(({ show: _show, ...i }) => i) }))
    .filter((g) => g.items.length > 0)
}
