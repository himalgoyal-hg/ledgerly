import Link from 'next/link'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'

// Reports (spec §10). Everything here is a live query over the ledger,
// entity-filtered by the "Books of" switcher, date-ranged, drillable to the
// source entry, exportable to CSV and printable (print → PDF).

export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
  if (!isAdmin(user) && !hasPermission(user, 'viewFinancialReports')) {
    throw new Error('Forbidden: missing permission "viewFinancialReports"')
  }

  // Tab set mirrors the v2 prototype's Reports section.
  const tabs = [
    { href: '/reports', label: 'P&L' },
    { href: '/reports/balance-sheet', label: 'Balance Sheet' },
    { href: '/reports/cash-flow', label: 'Cash Flow' },
    { href: '/reports/budget', label: 'Budget vs Actual' },
    { href: '/reports/monthly', label: 'Month by month' },
    { href: '/reports/weekly', label: 'Weekly' },
    { href: '/reports/usage', label: 'Cash vs bank' },
    { href: '/reports/banks', label: 'Bank balances' },
    { href: '/reports/itr', label: 'ITR summary' },
    { href: '/reports/investments', label: 'Investments' },
    { href: '/reports/parties', label: 'Parties' },
    { href: '/reports/salary', label: 'Salary' },
  ]

  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-1 border-b border-zinc-200 pb-2 print:hidden">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  )
}
