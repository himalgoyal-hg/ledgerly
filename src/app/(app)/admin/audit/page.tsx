import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

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
      <h1 className="text-xl font-semibold text-zinc-900">Audit log</h1>
      <p className="mt-1 text-sm text-zinc-500">Latest 200 events, newest first.</p>
      <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Who</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Summary</th>
              <th className="px-4 py-3">Before → after</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {logs.map((l) => (
              <tr key={l.id} className="align-top">
                <td className="whitespace-nowrap px-4 py-2 text-xs text-zinc-500">
                  {l.createdAt.toISOString().replace('T', ' ').slice(0, 19)} UTC
                </td>
                <td className="px-4 py-2 text-zinc-700">{l.actor?.name ?? 'System'}</td>
                <td className="px-4 py-2">
                  <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">
                    {l.action}
                  </code>
                </td>
                <td className="px-4 py-2 text-zinc-700">{l.summary}</td>
                <td className="px-4 py-2">
                  {(l.before !== null || l.after !== null) && (
                    <details className="text-xs text-zinc-500">
                      <summary className="cursor-pointer">diff</summary>
                      <pre className="mt-1 max-w-md overflow-x-auto rounded bg-zinc-50 p-2">
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
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-zinc-400">
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
