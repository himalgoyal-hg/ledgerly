import 'server-only'
import { hasPermission, isAdmin, type CurrentUser } from '@/lib/auth'

// Navigation mirrors the Ledgerly v2 HTML prototype (docs/requirements.md —
// the prototype is the feature spec): Overview · Books · Statements ·
// Operations · Setup & masters. Screens the prototype doesn't have (GST/TDS,
// journal, trial balance, ledgers, periods, automation, audit) stay built and
// URL-reachable but are hidden from the sidebar per Himal's instruction.
// Filtering happens HERE, server-side, before anything crosses to the client —
// a hidden item must never appear in the HTML or the RSC payload
// (verify-phase1 greps for exactly that). The filter is still cosmetic: every
// page and action re-checks permissions server-side.

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
      title: 'Books',
      items: [
        { href: '/tagging', label: 'Tag entries', icon: 'tagging', show: hasPermission(user, 'transactionTagging') },
        { href: '/statements', label: 'Import statement', icon: 'statements', show: hasPermission(user, 'statementUpload') },
        { href: '/cash', label: 'Cash', icon: 'cash', show: hasPermission(user, 'cashEntries') || hasPermission(user, 'viewCashReports') },
      ],
    },
    {
      title: 'Statements',
      items: [
        { href: '/reports', label: 'Profit & loss', icon: 'reports', show: hasPermission(user, 'viewFinancialReports') },
        { href: '/reports/balance-sheet', label: 'Balance sheet', icon: 'trialBalance', show: hasPermission(user, 'viewFinancialReports') },
        { href: '/reports/cash-flow', label: 'Cash flow', icon: 'banking', show: hasPermission(user, 'viewFinancialReports') },
        { href: '/reports/parties', label: 'Loans & advances', icon: 'ledgers', show: hasPermission(user, 'viewFinancialReports') },
        { href: '/reports/budget', label: 'Reports', icon: 'journal', show: hasPermission(user, 'viewFinancialReports') },
      ],
    },
    {
      title: 'Operations',
      items: [
        { href: '/invoices', label: 'Invoices & receivables', icon: 'invoices', show: admin },
        { href: '/reimbursements', label: 'Reimbursements', icon: 'reimbursements', show: hasPermission(user, 'reimbursementSubmit') || admin },
        { href: '/tasks', label: 'Finance tasks', icon: 'tasks', show: admin },
        { href: '/bills', label: 'Bills & insurance', icon: 'bills', show: admin },
        { href: '/salary', label: 'Salary register', icon: 'salary', show: admin },
      ],
    },
    {
      title: 'Setup & masters',
      items: [
        { href: '/admin/coa', label: 'Accounts', icon: 'accounts', show: admin },
        { href: '/admin/cost-centres', label: 'Cost centres', icon: 'costCentres', show: admin },
        { href: '/admin/banking', label: 'Banks & cash locations', icon: 'entities', show: admin },
        { href: '/admin/entities', label: 'Entities', icon: 'entities', show: admin },
        { href: '/admin/users', label: 'Users & permissions', icon: 'users', show: admin },
      ],
    },
  ]
  return groups
    .map((g) => ({ title: g.title, items: g.items.filter((i) => i.show).map(({ show: _show, ...i }) => i) }))
    .filter((g) => g.items.length > 0)
}
