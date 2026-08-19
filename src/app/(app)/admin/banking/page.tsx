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
import { PageHeader, buttonClass, controlClass, tableWrapClass, theadClass } from '@/components/ui'

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
      <PageHeader
        kicker="Setup"
        title="Banking & cash"
        subtitle="Bank accounts and cash locations per entity. From Phase 2, creating an account also creates its ledger account and posts the opening balance; archiving requires reconciliation first."
      />

      {/* Bank accounts */}
      <div className={tableWrapClass}>
        <table className="w-full text-left text-sm">
          <thead className={theadClass}>
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
          <tbody className="divide-y divide-line-2">
            {accounts.map((a) => (
              <tr key={a.id} className={a.archivedAt ? 'opacity-50' : undefined}>
                <td className="px-4 py-2 font-medium text-ink">
                  {a.nickname}
                  {a.archivedAt && (
                    <span className="ml-2 rounded bg-surface-2 px-1.5 text-[10px] text-ink-2">
                      archived
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-ink-2">{a.entity.code}</td>
                <td className="px-4 py-2 text-ink-2">{a.bankName}</td>
                <td className="px-4 py-2 font-mono text-xs text-ink-2">{a.accountNumber}</td>
                <td className="px-4 py-2 font-mono text-xs text-ink-2">{a.ifsc}</td>
                <td className="px-4 py-2 text-right text-ink-2">
                  {inr.format(Number(a.openingBalance))}
                  <span className="ml-1 text-xs text-ink-3">
                    as of {a.openingDate.toISOString().slice(0, 10)}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <form action={a.archivedAt ? restoreBankAccount : archiveBankAccount}>
                    <input type="hidden" name="id" value={a.id} />
                    <button
                      type="submit"
                      className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-surface-2"
                    >
                      {a.archivedAt ? 'Restore' : 'Archive'}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
            {accounts.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-sm text-ink-3">
                  No bank accounts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
        <h2 className="font-medium text-ink">Add bank account</h2>
        <form action={createBankAccount} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <select name="entityId" required className={controlClass}>
            <option value="">Entity…</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.code})
              </option>
            ))}
          </select>
          <input name="nickname" placeholder="Nickname (e.g. HG ICICI)" required className={controlClass} />
          <input name="bankName" placeholder="Bank name" required className={controlClass} />
          <input name="accountNumber" placeholder="Account number" required className={controlClass} />
          <input name="ifsc" placeholder="IFSC (ICIC0001234)" required className={`${controlClass} uppercase`} />
          <input name="openingBalance" type="number" step="0.01" placeholder="Opening balance ₹" required className={controlClass} />
          <input name="openingDate" type="date" required className={controlClass} />
          <button type="submit" className={buttonClass('primary')}>
            Add account
          </button>
        </form>
      </div>

      {/* Cash locations */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-card">
        <h2 className="font-medium text-ink">Cash locations</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {locations.map((l) => (
            <form
              key={l.id}
              action={l.archivedAt ? restoreCashLocation : archiveCashLocation}
              className={
                'flex items-center gap-2 rounded-full border px-3 py-1 text-sm ' +
                (l.archivedAt
                  ? 'border-line text-ink-3'
                  : 'border-line text-ink-2')
              }
            >
              <span>
                {l.name} <span className="text-xs text-ink-3">({l.entity.code})</span>
              </span>
              <input type="hidden" name="id" value={l.id} />
              <button type="submit" className="text-xs text-ink-3 hover:text-ink-2">
                {l.archivedAt ? 'restore' : 'archive'}
              </button>
            </form>
          ))}
          {locations.length === 0 && (
            <p className="text-sm text-ink-3">No cash locations yet.</p>
          )}
        </div>
        <form action={createCashLocation} className="mt-4 flex flex-wrap gap-2">
          <select name="entityId" required className={controlClass}>
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
            className={controlClass}
          />
          <button type="submit" className={buttonClass('primary')}>
            Add location
          </button>
        </form>
      </div>
    </div>
  )
}
