'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// The reports tab strip. Hidden on Cash Flow per Himal — that page has its
// own History / Cash-ahead tabs and the sidebar already reaches it.

const TABS = [
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

export function ReportsNav() {
  const pathname = usePathname()
  if (pathname.startsWith('/reports/cash-flow')) return null
  return (
    <nav className="flex flex-wrap gap-1 border-b border-zinc-200 pb-2 print:hidden">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`rounded-md px-3 py-1.5 text-sm ${
            pathname === t.href
              ? 'bg-zinc-900 text-white'
              : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
