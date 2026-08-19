'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { chipClass } from '@/components/ui'

// The reports tab strip. Hidden on the pages the sidebar already reaches
// directly (P&L, Balance Sheet, Cash Flow) per Himal — it shows only on the
// "Reports" hub (budget) and the deeper reports it is the sole way into.

const TABS = [
  { href: '/reports', label: 'P&L' },
  { href: '/reports/balance-sheet', label: 'Balance Sheet' },
  { href: '/reports/cash-flow', label: 'Cash Flow' },
  { href: '/reports/budget', label: 'Budget vs Actual' },
  { href: '/reports/monthly', label: 'Month by month' },
  { href: '/reports/mode', label: 'Actual vs Plan Mode' },
  { href: '/reports/by', label: 'By head / cost centre' },
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
  if (
    pathname === '/reports' || // P&L
    pathname.startsWith('/reports/balance-sheet') ||
    pathname.startsWith('/reports/cash-flow')
  ) {
    return null
  }
  return (
    <nav className="flex flex-wrap gap-1 border-b border-line pb-2 print:hidden">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className={chipClass(pathname === t.href)}>
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
