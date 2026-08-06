import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import {
  createBankAccount,
  archiveBankAccount,
  restoreBankAccount,
  createCashLocation,
  archiveCashLocation,
  restoreCashLocation,
} from './actions'

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })

export default async function BankingPage() {
  await requireAdmin()

  const [entities, accounts, locations] = await Promise.all([
    prisma.entity.findMany({ where: { archivedAt: null }, orderBy: { code: 'asc' } }),
    prisma.bankAccount.findMany({
      include: { entity: { select: { code: true } } },
      orderBy: [{ archivedAt: 'asc' }, { nickname: 'asc' }],
    }),
    prisma.cashLocation.findMany({
      include: { entity: { select: { code: true } } },
      orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
    }),
  ])

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Banking & cash</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Bank accounts and cash locations per entity. From Phase 2, creating an
          account also creates its ledger account and posts the opening balance;
          archiving requires reconciliation first.
        </p>
      </div>

      {/* Bank accounts */}
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-3">Nickname</th>
              <th className="px-4 py-3">Entity</th>
              <th className="px-4 py-3">Bank</th>
              <th className="px-4 py-3">Account no.</th>
              <th className="px-4 py-3">IFSC</th>
              <th className="px-4 py-3 text-right">Opening balance</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {accounts.map((a) => (
              <tr key={a.id} className={a.archivedAt ? 'opacity-50' : undefined}>
                <td className="px-4 py-2 font-medium text-zinc-800">
                  {a.nickname}
                  {a.archivedAt && (
                    <span className="ml-2 rounded bg-zinc-100 px-1.5 text-[10px] text-zinc-500">
                      archived
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-zinc-600">{a.entity.code}</td>
                <td className="px-4 py-2 text-zinc-600">{a.bankName}</td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-600">{a.accountNumber}</td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-600">{a.ifsc}</td>
                <td className="px-4 py-2 text-right text-zinc-700">
                  {inr.format(Number(a.openingBalance))}
                  <span className="ml-1 text-xs text-zinc-400">
                    as of {a.openingDate.toISOString().slice(0, 10)}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <form action={a.archivedAt ? restoreBankAccount : archiveBankAccount}>
                    <input type="hidden" name="id" value={a.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                    >
                      {a.archivedAt ? 'Restore' : 'Archive'}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
            {accounts.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-sm text-zinc-400">
                  No bank accounts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">Add bank account</h2>
        <form action={createBankAccount} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <select name="entityId" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm">
            <option value="">Entity…</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.code})
              </option>
            ))}
          </select>
          <input name="nickname" placeholder="Nickname (e.g. HG ICICI)" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm" />
          <input name="bankName" placeholder="Bank name" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm" />
          <input name="accountNumber" placeholder="Account number" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm" />
          <input name="ifsc" placeholder="IFSC (ICIC0001234)" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm uppercase" />
          <input name="openingBalance" type="number" step="0.01" placeholder="Opening balance ₹" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm" />
          <input name="openingDate" type="date" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm" />
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Add account
          </button>
        </form>
      </div>

      {/* Cash locations */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">Cash locations</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {locations.map((l) => (
            <form
              key={l.id}
              action={l.archivedAt ? restoreCashLocation : archiveCashLocation}
              className={
                'flex items-center gap-2 rounded-full border px-3 py-1 text-sm ' +
                (l.archivedAt
                  ? 'border-zinc-200 text-zinc-400'
                  : 'border-zinc-300 text-zinc-700')
              }
            >
              <span>
                {l.name} <span className="text-xs text-zinc-400">({l.entity.code})</span>
              </span>
              <input type="hidden" name="id" value={l.id} />
              <button type="submit" className="text-xs text-zinc-400 hover:text-zinc-700">
                {l.archivedAt ? 'restore' : 'archive'}
              </button>
            </form>
          ))}
          {locations.length === 0 && (
            <p className="text-sm text-zinc-400">No cash locations yet.</p>
          )}
        </div>
        <form action={createCashLocation} className="mt-4 flex flex-wrap gap-2">
          <select name="entityId" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm">
            <option value="">Entity…</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.code}
              </option>
            ))}
          </select>
          <input
            name="name"
            placeholder="Location (e.g. Office Drawer)"
            required
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Add location
          </button>
        </form>
      </div>
    </div>
  )
}
