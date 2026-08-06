import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { transportConfigured } from '@/lib/automation/notify'
import { LEAD_DAYS } from '@/lib/automation/recurring'
import { COMMITMENT_WINDOW_DAYS } from '@/lib/automation/suggest'
import { TASK_KINDS } from '@/lib/ops/tasks'
import { setPreference, clearPreference, runNow, retryDelivery } from './actions'

// Automation & payment mapping (spec §8, §6.5, §10) — Admin only.

const MODULE_PURPOSES = [
  { value: 'default', label: 'Default (anything unmapped)' },
  { value: 'bill', label: 'Bills' },
  { value: 'salary', label: 'Salary payouts' },
  { value: 'reimbursement', label: 'Reimbursement settlements' },
  { value: 'invoice_receipt', label: 'Invoice receipts' },
]

export default async function AutomationPage() {
  const admin = await requireAdmin()
  const entity = await getCurrentEntity(admin)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const [preferences, banks, cashLocations, outbox, lastRun] = await Promise.all([
    prisma.paymentPreference.findMany({ where: { entityId: entity.id }, orderBy: { purpose: 'asc' } }),
    prisma.bankAccount.findMany({
      where: { entityId: entity.id, archivedAt: null, ledgerAccountId: { not: null } },
      orderBy: { nickname: 'asc' },
    }),
    prisma.cashLocation.findMany({
      where: { entityId: entity.id, archivedAt: null, ledgerAccountId: { not: null } },
      orderBy: { name: 'asc' },
    }),
    prisma.notificationOutbox.findMany({
      where: { entityId: entity.id },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
    prisma.auditLog.findFirst({
      where: { action: 'automation.run' },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  const sources = [
    ...banks.map((b) => ({ id: b.ledgerAccountId!, label: b.nickname })),
    ...cashLocations.map((c) => ({ id: c.ledgerAccountId!, label: `Cash — ${c.name}` })),
  ]
  const sourceLabel = (id: string) => sources.find((s) => s.id === id)?.label ?? '(removed account)'
  const purposeLabel = (purpose: string) =>
    MODULE_PURPOSES.find((p) => p.value === purpose)?.label ??
    (purpose.startsWith('head:') ? 'Specific expense head' : `Task: ${purpose}`)
  const smtp = transportConfigured()
  const queuedCount = outbox.filter((m) => m.status === 'QUEUED').length

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">
          Automation — {entity.name} ({entity.code})
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Payment mapping feeds the suggestions on every payment form. The job
          generates recurring bills and tasks {LEAD_DAYS} days ahead, queues
          reminders and alerts, and emails the weekly summary on Mondays.
        </p>
      </div>

      {/* Job status + run now */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-medium text-zinc-900">Scheduled job</h2>
          <span className="text-xs text-zinc-500">
            {lastRun
              ? `last run ${lastRun.createdAt.toISOString().replace('T', ' ').slice(0, 16)} — ${lastRun.summary}`
              : 'never run'}
          </span>
          <form action={runNow} className="ml-auto">
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
            >
              Run now
            </button>
          </form>
        </div>
        <div className="mt-3 space-y-2 text-xs text-zinc-500">
          <p>
            Nothing fires on a timer by itself — point a scheduler at the endpoint
            below once a day. The job is idempotent, so a missed or repeated run
            is harmless.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-zinc-50 p-3 text-[11px] text-zinc-600">
{`0 7 * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" \\
             https://<your-host>/api/automation/run`}
          </pre>
          <p>
            {smtp ? (
              <span className="text-emerald-700">
                ✓ SMTP configured — queued messages are delivered on each run.
              </span>
            ) : (
              <span className="text-amber-700">
                No SMTP transport configured. Messages are still rendered and
                stored below; set SMTP_HOST and SMTP_FROM in .env to send them.
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Payment mapping (spec §8.1) */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">Payment mapping</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Which account normally pays for what. Suggestions still check live
          balances and reserve anything due in {COMMITMENT_WINDOW_DAYS} days, so a
          mapped account is proposed only when it can actually cover the payment.
        </p>

        <div className="mt-3 space-y-1">
          {preferences.map((pref) => (
            <div key={pref.id} className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-zinc-700">{purposeLabel(pref.purpose)}</span>
              <span className="text-xs text-zinc-400">→</span>
              <span className="font-medium text-zinc-800">{sourceLabel(pref.ledgerAccountId)}</span>
              <form action={clearPreference} className="ml-auto">
                <input type="hidden" name="id" value={pref.id} />
                <button
                  type="submit"
                  className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                >
                  Clear
                </button>
              </form>
            </div>
          ))}
          {preferences.length === 0 && (
            <p className="text-sm text-zinc-400">
              No mapping yet — suggestions fall back to whichever account has the
              most available balance.
            </p>
          )}
        </div>

        <form action={setPreference} className="mt-4 flex flex-wrap items-center gap-2">
          <input type="hidden" name="entityId" value={entity.id} />
          <select
            name="purpose"
            required
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">— purpose —</option>
            {MODULE_PURPOSES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
            {TASK_KINDS.map((k) => (
              <option key={k} value={k}>Task: {k}</option>
            ))}
          </select>
          <span className="text-xs text-zinc-400">paid from</span>
          <select
            name="ledgerAccountId"
            required
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">— account —</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Save mapping
          </button>
        </form>
      </div>

      {/* Outbox */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-medium text-zinc-900">Notification outbox</h2>
          <span className="text-xs text-zinc-500">
            {queuedCount > 0 ? `${queuedCount} queued` : 'nothing queued'}
          </span>
          {queuedCount > 0 && smtp && (
            <form action={retryDelivery} className="ml-auto">
              <button
                type="submit"
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
              >
                Retry delivery
              </button>
            </form>
          )}
        </div>
        <div className="mt-3 space-y-2">
          {outbox.map((message) => (
            <details key={message.id} className="rounded-lg border border-zinc-100 p-2">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    message.status === 'SENT'
                      ? 'bg-emerald-100 text-emerald-700'
                      : message.status === 'FAILED'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {message.status.toLowerCase()}
                </span>
                <span className="text-zinc-800">{message.subject}</span>
                <span className="text-xs text-zinc-400">→ {message.recipient}</span>
                <span className="ml-auto text-xs text-zinc-400">
                  {message.createdAt.toISOString().slice(0, 10)}
                </span>
              </summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-zinc-50 p-3 text-xs text-zinc-600">
                {message.body}
              </pre>
              {message.error && (
                <p className="mt-1 text-xs text-red-600">Delivery error: {message.error}</p>
              )}
            </details>
          ))}
          {outbox.length === 0 && (
            <p className="text-sm text-zinc-400">
              Nothing yet. Run the job to generate reminders and the weekly summary.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
