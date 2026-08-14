import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { ReportsNav } from './reports-nav'

// Reports (spec §10). Everything here is a live query over the ledger,
// entity-filtered by the "Books of" switcher, date-ranged, drillable to the
// source entry, exportable to CSV and printable (print → PDF). The tab
// strip hides itself on Cash Flow (it carries its own tabs).

export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
  if (!isAdmin(user) && !hasPermission(user, 'viewFinancialReports')) {
    throw new Error('Forbidden: missing permission "viewFinancialReports"')
  }

  return (
    <div className="space-y-4">
      <ReportsNav />
      {children}
    </div>
  )
}
