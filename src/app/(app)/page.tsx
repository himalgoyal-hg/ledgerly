import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BookOpen,
  ClipboardList,
  CreditCard,
  FileSpreadsheet,
  FileText,
  Inbox,
  Landmark,
  PieChart,
  ReceiptText,
  Tags,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { prisma } from '@/lib/db'
import { displayINR } from '@/lib/ledger/money'
import {
  balanceTiles,
  queueTiles,
  receivableTiles,
  balanceAlerts,
  recentActivity,
} from '@/lib/reports/dashboard'
import {
  monthlyFlows,
  expenseCategories,
  statTrends,
  pendingBills,
} from '@/lib/reports/series'
import { Card, CardHeader, StatCard, Badge, EmptyState, Avatar, type BadgeTone } from '@/components/ui'
import { PairedBars, DivergingBars, TrendLine, CategoryBars } from '@/components/charts'

// Overview dashboard (spec §9). Every figure is a live ledger query; members
// see only the sections their permissions allow, and every card links to the
// screen where the work actually happens.

export default async function OverviewPage() {
  const user = await requireUser()
  const admin = isAdmin(user)
  const entity = await getCurrentEntity(user)

  const can = {
    financials: admin || hasPermission(user, 'viewFinancialReports'),
    cash: admin || hasPermission(user, 'viewCashReports'),
    tagging: hasPermission(user, 'transactionTagging'),
    upload: hasPermission(user, 'statementUpload'),
    claims: admin || hasPermission(user, 'reimbursementSubmit'),
    tax: admin || hasPermission(user, 'viewTaxRegisters'),
  }

  if (!entity) {
    return (
      <Card>
        <EmptyState
          icon={Inbox}
          title="No books yet"
          body={
            admin
              ? 'Create an entity to start keeping books — the chart of accounts is seeded for you.'
              : 'No books have been shared with you yet. Ask the admin for access.'
          }
          action={admin ? { label: 'Create an entity', href: '/admin/entities' } : undefined}
        />
      </Card>
    )
  }

  const nothingVisible = !can.financials && !can.cash && !can.tagging && !can.upload && !can.claims && !admin
  if (nothingVisible) {
    return (
      <Card>
        <EmptyState
          icon={Inbox}
          title="Nothing here yet"
          body="You don’t have access to anything yet. Ask the admin to grant you permissions."
        />
      </Card>
    )
  }

  // Fetch only what this viewer is allowed to see.
  const [balances, queues, receivables, alerts, activity, trends, flows, categories, bills] =
    await Promise.all([
      can.financials || can.cash ? balanceTiles(entity.id) : null,
      can.tagging || can.upload || can.claims ? queueTiles(entity.id) : null,
      admin || can.financials ? receivableTiles(entity.id) : null,
      admin ? balanceAlerts(entity.id) : null,
      admin ? recentActivity(10) : null,
      admin || can.financials ? statTrends(entity.id) : null,
      admin || can.financials ? monthlyFlows(entity.id, 12) : null,
      admin || can.financials ? expenseCategories(entity.id, 12, 6) : null,
      admin ? pendingBills(entity.id) : null,
    ])

  const hasPostings = Boolean(flows?.some((m) => m.income || m.expense || m.cashNet))
  const today = new Date().toISOString().slice(0, 10)

  return (
    <div className="space-y-6 animate-fade-up">
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Overview</h1>
          <p className="mt-1 text-sm text-ink-3">
            {entity.name} · live from the ledger
          </p>
        </div>
        {can.financials && balances && (
          <p className="text-sm text-ink-2">
            Total bank + cash{' '}
            <span className="ml-1 text-lg font-semibold text-ink">
              {displayINR((Number(balances.bankTotal) + Number(balances.cashTotal)).toFixed(2))}
            </span>
          </p>
        )}
      </div>

      {/* Alerts first — they are the reason to look at this screen */}
      {alerts && alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert) => (
            <div
              key={`${alert.label}-${alert.message}`}
              className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <p className="text-ink-2">
                <span className="font-medium text-ink">{alert.label}:</span> {alert.message}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* KPI row */}
      <section aria-label="Key figures" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {balances && can.financials && trends && (
          <StatCard
            label="Bank balance"
            value={displayINR(trends.bank.current)}
            icon={Landmark}
            iconClass="bg-primary-soft text-primary"
            deltaPct={trends.bank.deltaPct}
            deltaBasis="vs 30 days ago"
            href="/reports/cash-flow"
            sparkline={trends.liquiditySpark}
          />
        )}
        {balances && can.cash && (
          <StatCard
            label="Cash balance"
            value={displayINR(balances.cashTotal)}
            icon={Wallet}
            iconClass="bg-success-soft text-success"
            deltaPct={admin || can.financials ? trends?.cash.deltaPct : undefined}
            deltaBasis="vs 30 days ago"
            hint={balances.cash.length === 0 ? 'no cash locations yet' : `${balances.cash.length} location(s)`}
            href="/cash"
          />
        )}
        {receivables && trends && (
          <StatCard
            label="Receivables"
            value={displayINR(trends.receivables.current)}
            icon={ClipboardList}
            iconClass="bg-primary-soft text-primary"
            deltaPct={trends.receivables.deltaPct}
            deltaBasis="vs 30 days ago"
            hint={[
              // Whose money: the top debtor by ledger balance, so the tile
              // answers "who owes us" even when there is no invoice behind it.
              receivables.debtors.length === 1
                ? receivables.debtors[0].name
                : receivables.debtors.length > 1
                  ? `${receivables.debtors[0].name} ${displayINR(receivables.debtors[0].balance)} +${receivables.debtors.length - 1} more`
                  : null,
              Number(receivables.overdueTotal) > 0
                ? `${displayINR(receivables.overdueTotal)} overdue`
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || undefined}
            href="/reports/parties"
          />
        )}
        {admin && trends && (
          <StatCard
            label="Payables"
            value={displayINR(trends.payables.current)}
            icon={CreditCard}
            iconClass="bg-warning-soft text-warning"
            deltaPct={trends.payables.deltaPct}
            deltaBasis="vs 30 days ago"
            upIsGood={false}
            href="/bills"
          />
        )}
        {admin && bills && (
          <StatCard
            label="Pending bills"
            value={String(bills.count)}
            icon={FileText}
            iconClass="bg-warning-soft text-warning"
            hint={bills.count > 0 ? `${displayINR(bills.total)} to pay` : 'nothing waiting'}
            href="/bills"
          />
        )}
        {queues && can.claims && (
          <StatCard
            label="Pending reimbursements"
            value={String(queues.pendingClaims)}
            icon={ReceiptText}
            iconClass="bg-danger-soft text-danger"
            hint={
              queues.pendingClaims > 0
                ? `${displayINR(queues.pendingClaimsAmount)} awaiting approval`
                : 'nothing waiting'
            }
            href="/reimbursements"
          />
        )}
        {queues && can.tagging && (!admin || queues.pendingTags > 0) && (
          <StatCard
            label="Tagging queue"
            value={String(queues.pendingTags)}
            icon={Tags}
            iconClass="bg-primary-soft text-primary"
            hint={
              queues.taggedUnposted > 0
                ? `${queues.taggedUnposted} tagged, awaiting posting`
                : 'nothing waiting to post'
            }
            href="/tagging"
          />
        )}
        {queues && can.upload && queues.unconfirmedImports > 0 && (
          <StatCard
            label="Statements to confirm"
            value={String(queues.unconfirmedImports)}
            icon={FileSpreadsheet}
            iconClass="bg-warning-soft text-warning"
            hint="detected, not yet imported"
            href="/statements"
          />
        )}
      </section>

      {/* Analytics */}
      {(admin || can.financials) && (
        <section aria-label="Analytics" className="space-y-4">
          {!hasPostings ? (
            <Card>
              <EmptyState
                icon={BarChart3}
                title="No postings yet"
                body="Charts appear once the ledger has entries — upload a statement or post a journal to get started."
                action={can.upload ? { label: 'Upload a statement', href: '/statements' } : undefined}
              />
            </Card>
          ) : (
            flows && (
              <>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <Card>
                    <CardHeader
                      title="Cash flow"
                      hint="net bank + cash movement per month"
                      action={{ label: 'Cash flow statement', href: '/reports/cash-flow' }}
                    />
                    <div className="px-5 pb-5 sm:px-6">
                      <DivergingBars points={flows.map((m) => ({ label: m.label, value: m.cashNet }))} />
                    </div>
                  </Card>
                  <Card>
                    <CardHeader
                      title="Income vs expense"
                      hint="trailing 12 months"
                      action={{ label: 'P&L', href: '/reports' }}
                    />
                    <div className="px-5 pb-5 sm:px-6">
                      <PairedBars
                        points={flows.map((m) => ({ label: m.label, a: m.income, b: m.expense }))}
                        seriesA="Income"
                        seriesB="Expense"
                        colorA="var(--chart-1)"
                        colorB="var(--chart-3)"
                      />
                    </div>
                  </Card>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <Card className="lg:col-span-2">
                    <CardHeader title="Monthly revenue" hint="income posted per month" />
                    <div className="px-5 pb-5 sm:px-6">
                      <TrendLine points={flows.map((m) => ({ label: m.label, value: m.income }))} />
                    </div>
                  </Card>
                  <Card>
                    <CardHeader
                      title="Expense categories"
                      hint="trailing 12 months"
                      action={{ label: 'Cost centres', href: '/reports/cost-centres' }}
                    />
                    <div className="px-5 pb-5 sm:px-6">
                      {categories && categories.length > 0 ? (
                        <CategoryBars slices={categories} />
                      ) : (
                        <EmptyState icon={PieChart} title="No expenses yet" className="py-6" />
                      )}
                    </div>
                  </Card>
                </div>

              </>
            )
          )}
        </section>
      )}

      {/* Quick actions (spec §9) */}
      <section aria-label="Quick actions">
        <h2 className="mb-3 text-sm font-semibold text-ink">Quick actions</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {can.upload && <QuickAction href="/statements" icon={FileSpreadsheet} label="Upload statement" />}
          {admin && <QuickAction href="/invoices" icon={ClipboardList} label="Create invoice" />}
          {admin && <QuickAction href="/bills" icon={FileText} label="Add expense" />}
          {admin && <QuickAction href="/admin/banking" icon={Landmark} label="Add bank account" />}
          {can.financials && <QuickAction href="/reports" icon={BarChart3} label="Generate report" />}
          {can.tagging && !admin && <QuickAction href="/tagging" icon={Tags} label="Work the queue" />}
          {can.claims && !admin && <QuickAction href="/reimbursements" icon={ReceiptText} label="Claim expense" />}
        </div>
      </section>

      {/* Recent activity — the audit trail, plain-language */}
      {activity && activity.length > 0 && (
        <Card>
          <CardHeader title="Recent activity" action={{ label: 'Full audit log', href: '/admin/audit' }} />
          <ol className="px-5 pb-5 pt-1 sm:px-6">
            {activity.map((row, i) => {
              const at = row.at.toISOString()
              return (
                <li key={row.id} className="relative flex gap-3 pb-4 last:pb-0">
                  {i < activity.length - 1 && (
                    <span className="absolute left-[13px] top-8 h-[calc(100%-24px)] w-px bg-line" aria-hidden />
                  )}
                  <Avatar name={row.actor} size="sm" />
                  <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 pt-1">
                    <span className="text-[13px] font-medium text-ink">{row.actor}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{row.summary}</span>
                    <Badge tone={actionTone(row.action)}>{actionLabel(row.action)}</Badge>
                    <span className="whitespace-nowrap text-xs tabular-nums text-ink-3">
                      {at.slice(0, 10)} · {at.slice(11, 16)}
                    </span>
                  </div>
                </li>
              )
            })}
          </ol>
        </Card>
      )}
    </div>
  )
}

function QuickAction({ href, icon: Icon, label }: { href: string; icon: LucideIcon; label: string }) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-pop focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <span className="grid size-9 place-items-center rounded-xl bg-primary-soft text-primary">
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <span className="flex items-center gap-1 text-[13px] font-medium text-ink">
        {label}
        <ArrowRight className="size-3.5 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </span>
    </Link>
  )
}

function actionTone(action: string): BadgeTone {
  if (/delete|remove|reject/.test(action)) return 'danger'
  if (/create|approve|post|confirm/.test(action)) return 'success'
  if (/update|edit|switch|grant|revoke/.test(action)) return 'primary'
  return 'neutral'
}

function actionLabel(action: string): string {
  const last = action.split(/[._]/).pop() ?? action
  return last.charAt(0).toUpperCase() + last.slice(1)
}
