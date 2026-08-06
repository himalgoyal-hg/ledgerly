import Link from 'next/link'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import {
  balanceTiles,
  queueTiles,
  duesTiles,
  receivableTiles,
  balanceAlerts,
  recentActivity,
} from '@/lib/reports/dashboard'

// Overview dashboard (spec §9). Every tile is a live query; members see
// only the tiles their permissions allow, and each one links to the screen
// where the work actually happens.

function Tile(props: {
  label: string
  value: string
  hint?: string
  href?: string
  tone?: 'default' | 'warn' | 'dark'
  children?: React.ReactNode
  wide?: boolean
}) {
  const tone =
    props.tone === 'warn'
      ? 'border-amber-200 bg-amber-50'
      : props.tone === 'dark'
        ? 'border-zinc-300 bg-zinc-900'
        : 'border-zinc-200 bg-white'
  const labelColor = props.tone === 'dark' ? 'text-zinc-400' : 'text-zinc-500'
  const valueColor = props.tone === 'dark' ? 'text-white' : 'text-zinc-900'
  const body = (
    <div className={`h-full rounded-xl border p-4 shadow-sm ${tone} ${props.wide ? 'sm:col-span-2' : ''}`}>
      <p className={`text-sm ${labelColor}`}>{props.label}</p>
      <p className={`mt-1 text-2xl font-semibold ${valueColor}`}>{props.value}</p>
      {props.hint && <p className="mt-1 text-xs text-zinc-400">{props.hint}</p>}
      {props.children}
    </div>
  )
  return props.href ? (
    <Link href={props.href} className={`block ${props.wide ? 'sm:col-span-2' : ''}`}>
      {body}
    </Link>
  ) : (
    <div className={props.wide ? 'sm:col-span-2' : ''}>{body}</div>
  )
}

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
  }

  if (!entity) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Overview</h1>
        <p className="mt-4 text-sm text-zinc-500">
          {admin
            ? 'Create an entity first (Admin → Entities) to start keeping books.'
            : 'No books have been shared with you yet. Ask the admin for access.'}
        </p>
      </div>
    )
  }

  // Fetch only what this viewer is allowed to see.
  const [balances, queues, dues, receivables, alerts, activity] = await Promise.all([
    can.financials || can.cash ? balanceTiles(entity.id) : null,
    can.tagging || can.upload || can.claims ? queueTiles(entity.id) : null,
    admin ? duesTiles(entity.id, 7) : null,
    admin || can.financials ? receivableTiles(entity.id) : null,
    admin ? balanceAlerts(entity.id) : null,
    admin ? recentActivity() : null,
  ])

  const nothingVisible =
    !can.financials && !can.cash && !can.tagging && !can.upload && !can.claims && !admin

  if (nothingVisible) {
    return (
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Overview</h1>
        <p className="mt-4 text-sm text-zinc-500">
          You don&apos;t have access to anything yet. Ask the admin to grant you
          permissions.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900">
        Overview — {entity.name} ({entity.code})
      </h1>

      {/* Alerts first — they are the reason to look at this screen */}
      {alerts && alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert) => (
            <div
              key={`${alert.label}-${alert.message}`}
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm"
            >
              <span className="font-medium text-amber-800">{alert.label}:</span>{' '}
              <span className="text-amber-700">{alert.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {balances && can.financials && (
          <Tile
            label="Bank balances"
            value={displayINR(balances.bankTotal)}
            href="/reports/cash-flow"
          >
            <div className="mt-2 space-y-1">
              {balances.banks.map((b) => (
                <div key={b.id} className="flex justify-between text-xs text-zinc-500">
                  <span>{b.label}</span>
                  <span>{displayINR(b.balance)}</span>
                </div>
              ))}
              {balances.banks.length === 0 && (
                <p className="text-xs text-zinc-400">No bank accounts yet.</p>
              )}
            </div>
          </Tile>
        )}

        {balances && can.cash && (
          <Tile label="Where is cash" value={displayINR(balances.cashTotal)} href="/cash">
            <div className="mt-2 space-y-1">
              {balances.cash.map((c) => (
                <div key={c.id} className="flex justify-between text-xs text-zinc-500">
                  <span>{c.label}</span>
                  <span>{displayINR(c.balance)}</span>
                </div>
              ))}
              {balances.cash.length === 0 && (
                <p className="text-xs text-zinc-400">No cash locations yet.</p>
              )}
            </div>
          </Tile>
        )}

        {queues && can.tagging && (
          <Tile
            label="Pending tagging queue"
            value={String(queues.pendingTags)}
            hint={
              queues.taggedUnposted > 0
                ? `${queues.taggedUnposted} tagged, awaiting posting`
                : 'nothing waiting to post'
            }
            href="/tagging"
            tone={queues.pendingTags > 0 ? 'warn' : 'default'}
          />
        )}

        {queues && can.upload && queues.unconfirmedImports > 0 && (
          <Tile
            label="Statements awaiting confirmation"
            value={String(queues.unconfirmedImports)}
            hint="detected, not yet imported"
            href="/statements"
            tone="warn"
          />
        )}

        {queues && can.claims && (
          <Tile
            label="Pending reimbursements"
            value={String(queues.pendingClaims)}
            hint={`${displayINR(queues.pendingClaimsAmount)} awaiting approval`}
            href="/reimbursements"
            tone={queues.pendingClaims > 0 ? 'warn' : 'default'}
          />
        )}

        {dues && (
          <Tile
            label="Due in 7 days"
            value={displayINR(dues.total)}
            hint={
              dues.overdueCount > 0
                ? `${dues.items.length} item(s), ${dues.overdueCount} overdue`
                : `${dues.items.length} item(s)`
            }
            href="/tasks"
            tone={dues.overdueCount > 0 ? 'warn' : 'default'}
          >
            <div className="mt-2 space-y-1">
              {dues.items.slice(0, 4).map((item) => (
                <div key={`${item.source}-${item.id}`} className="flex justify-between text-xs text-zinc-500">
                  <span className="truncate pr-2">{item.title}</span>
                  <span className="whitespace-nowrap">
                    {item.dueDate.toISOString().slice(5, 10)}
                    {item.amount && ` · ${displayINR(item.amount)}`}
                  </span>
                </div>
              ))}
            </div>
          </Tile>
        )}

        {receivables && (
          <Tile
            label="Receivables outstanding"
            value={displayINR(receivables.outstandingTotal)}
            hint={
              Number(receivables.overdueTotal) > 0
                ? `${displayINR(receivables.overdueTotal)} overdue across ${receivables.overdue.length} invoice(s)`
                : 'nothing overdue'
            }
            href="/invoices"
            tone={Number(receivables.overdueTotal) > 0 ? 'warn' : 'default'}
          />
        )}

        {balances && can.financials && (
          <Tile
            label="Total bank + cash"
            value={displayINR(
              (Number(balances.bankTotal) + Number(balances.cashTotal)).toFixed(2),
            )}
            hint="live from the ledger"
            tone="dark"
          />
        )}
      </div>

      {/* Quick actions (spec §9) */}
      <div className="flex flex-wrap gap-2">
        {can.upload && (
          <Link href="/statements" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700">
            Upload statements
          </Link>
        )}
        {can.tagging && (
          <Link href="/tagging" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">
            Work the tagging queue
          </Link>
        )}
        {can.claims && (
          <Link href="/reimbursements" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">
            Reimbursements
          </Link>
        )}
        {can.financials && (
          <Link href="/reports" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">
            Reports
          </Link>
        )}
        {admin && (
          <Link href="/tax" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">
            GST / TDS
          </Link>
        )}
      </div>

      {/* Recent activity — the audit trail, plain-language */}
      {activity && activity.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <h2 className="font-medium text-zinc-900">Recent activity</h2>
            <Link href="/admin/audit" className="ml-auto text-xs text-zinc-500 hover:underline">
              full audit log →
            </Link>
          </div>
          <div className="mt-2 space-y-1">
            {activity.map((row) => (
              <div key={row.id} className="flex flex-wrap items-baseline gap-2 text-sm text-zinc-600">
                <span className="text-xs text-zinc-400">
                  {row.at.toISOString().replace('T', ' ').slice(0, 16)}
                </span>
                <span>{row.summary}</span>
                <span className="text-xs text-zinc-400">— {row.actor}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
