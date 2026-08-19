import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { PageHeader, tableWrapClass, theadClass } from '@/components/ui'

// Audit report (spec §10): edits, deletes, undos, unlocks, permission
// changes — who, when, before → after. Append-only; nothing here is editable.

export default async function AuditPage() {
  await requireAdmin()

  const logs = await prisma.auditLog.findMany({
    include: { actor: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  return (
    <div>
      <PageHeader kicker="Admin" title="Audit log" subtitle="Latest 200 events, newest first." />
      <div className={`mt-4 ${tableWrapClass}`}>
        <table className="w-full text-left text-sm">
          <thead className={theadClass}>
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Who</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Summary</th>
              <th className="px-4 py-3">Before → after</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-2">
            {logs.map((l) => (
              <tr key={l.id} className="align-top">
                <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-2">
                  {l.createdAt.toISOString().replace('T', ' ').slice(0, 19)} UTC
                </td>
                <td className="px-4 py-2 text-ink-2">{l.actor?.name ?? 'System'}</td>
                <td className="px-4 py-2">
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-2">
                    {l.action}
                  </code>
                </td>
                <td className="px-4 py-2 text-ink-2">{l.summary}</td>
                <td className="px-4 py-2">
                  {(l.before !== null || l.after !== null) && (
                    <details className="text-xs text-ink-2">
                      <summary className="cursor-pointer">diff</summary>
                      <pre className="mt-1 max-w-md overflow-x-auto rounded bg-surface-2/60 p-2">
                        {l.before !== null &&
                          `before: ${JSON.stringify(l.before, null, 1)}\n`}
                        {l.after !== null && `after:  ${JSON.stringify(l.after, null, 1)}`}
                      </pre>
                    </details>
                  )}
                </td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-ink-3">
                  No events yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
