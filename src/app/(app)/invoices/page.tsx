import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { agingBucket, outstandingOf } from '@/lib/ops/invoices'
import { GST_RATES, GST_TYPES } from '@/lib/tax/calc'
import { createInvoiceAction, recordPaymentAction, deleteInvoiceAction } from './actions'
import { ConfirmButton } from '@/components/confirm-button'

// Invoices & receivables (spec §6.6): auto numbering, due-date tracking,
// partial payments, aging buckets, settled archive.

export default async function InvoicesPage() {
  const admin = await requireAdmin()
  const entity = await getCurrentEntity(admin)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const today = new Date()
  const [openInvoices, settled, incomeHeads, costCentres, banks, cashLocations] = await Promise.all([
    prisma.invoice.findMany({
      where: { entityId: entity.id, status: { in: ['OPEN', 'PARTIAL'] } },
      include: { payments: true },
      orderBy: { dueDate: 'asc' },
    }),
    prisma.invoice.findMany({
      where: { entityId: entity.id, status: 'SETTLED' },
      include: { payments: true },
      orderBy: { createdAt: 'desc' },
      take: 15,
    }),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null, kind: 'INCOME' },
      orderBy: { code: 'asc' },
    }),
    prisma.costCentre.findMany({
      where: { entityId: entity.id, archivedAt: null },
      orderBy: { name: 'asc' },
    }),
    prisma.bankAccount.findMany({
      where: { entityId: entity.id, archivedAt: null, ledgerAccountId: { not: null } },
    }),
    prisma.cashLocation.findMany({
      where: { entityId: entity.id, archivedAt: null, ledgerAccountId: { not: null } },
    }),
  ])
  const sources = [
    ...banks.map((b) => ({ id: b.ledgerAccountId!, label: b.nickname })),
    ...cashLocations.map((c) => ({ id: c.ledgerAccountId!, label: `Cash — ${c.name}` })),
  ]

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900">
        Invoices — {entity.name} ({entity.code})
      </h1>

      {/* New invoice */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">
          New invoice (next: {entity.invoicePrefix}-{String(entity.nextInvoiceNumber).padStart(4, '0')})
        </h2>
        <form action={createInvoiceAction} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="entityId" value={entity.id} />
          <input name="customer" required placeholder="Customer" className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <input name="amount" required inputMode="decimal" placeholder="Taxable ₹" className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <label className="text-xs text-zinc-400">date</label>
          <input name="date" type="date" required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <label className="text-xs text-zinc-400">due</label>
          <input name="dueDate" type="date" required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <select name="incomeAccountId" required className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
            <option value="">— income head —</option>
            {incomeHeads.map((h) => (
              <option key={h.id} value={h.id}>{h.code} · {h.name}</option>
            ))}
          </select>
          <select name="costCentreId" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
            <option value="">— cost centre —</option>
            {costCentres.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input name="narration" placeholder="Description" className="w-44 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          {/* FX (v2 prototype): billed in USD, realised in INR */}
          <select name="currency" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
            <option value="INR">INR</option>
            <option value="USD">USD</option>
          </select>
          <input name="amountFx" type="number" step="0.01" min="0" placeholder="$ amount" className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <input name="fxRate" type="number" step="0.0001" min="0" placeholder="Rate (₹/$)" className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <input name="bankCharges" type="number" step="0.01" min="0" placeholder="Bank charges" className="w-32 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <select name="firc" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
            <option value="">FIRC —</option>
            <option>Awaited</option>
            <option>Partial</option>
            <option>Received</option>
          </select>
          {/* GST (spec §7.1): tax adds on top of the taxable value */}
          <select name="gstType" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
            <option value="">GST type</option>
            {GST_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select name="gstRate" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
            <option value="">no GST</option>
            {GST_RATES.map((r) => (
              <option key={r} value={r}>{r}%</option>
            ))}
          </select>
          <input name="hsn" placeholder="HSN/SAC" className="w-24 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <input name="customerGstin" placeholder="Customer GSTIN" className="w-40 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <button type="submit" className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700">
            Raise invoice
          </button>
        </form>
      </div>

      {/* Open + partial, with aging buckets */}
      <div className="space-y-2">
        <h2 className="font-medium text-zinc-900">Outstanding ({openInvoices.length})</h2>
        {openInvoices.map((invoice) => {
          const bucket = agingBucket(invoice.dueDate, today)
          const outstanding = outstandingOf(invoice)
          return (
            <div key={invoice.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-mono text-xs text-zinc-500">{invoice.number}</span>
                <span className="font-medium text-zinc-800">{invoice.customer}</span>
                {invoice.currency === 'USD' && invoice.amountFx && (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                    ${Number(invoice.amountFx).toLocaleString('en-US')}
                    {invoice.fxRate ? ` @ ${Number(invoice.fxRate).toFixed(2)}` : ''}
                    {invoice.firc ? ` · FIRC ${invoice.firc}` : ''}
                  </span>
                )}
                <form action={deleteInvoiceAction} className="order-last ml-auto">
                  <input type="hidden" name="invoiceId" value={invoice.id} />
                  <ConfirmButton
                    message={`Delete invoice ${invoice.number}? The invoice and any payment postings are reversed (restorable from Journal).`}
                    className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                  >
                    Delete
                  </ConfirmButton>
                </form>
                <span className="text-xs text-zinc-400">
                  due {invoice.dueDate.toISOString().slice(0, 10)}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    bucket === 'current'
                      ? 'bg-zinc-100 text-zinc-600'
                      : bucket === '1–30'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-red-100 text-red-700'
                  }`}
                >
                  {bucket === 'current' ? 'not due' : `overdue ${bucket} days`}
                </span>
                {invoice.status === 'PARTIAL' && (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                    partial
                  </span>
                )}
                <span className="ml-auto text-xs text-zinc-500">
                  {displayINR(String(invoice.amount))} billed
                </span>
                <span className="font-semibold text-zinc-900">{displayINR(outstanding)} due</span>
              </div>
              <form action={recordPaymentAction} className="mt-3 flex flex-wrap items-center gap-2">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <input name="date" type="date" required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                <input name="amount" required inputMode="decimal" defaultValue={outstanding} className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                <select name="sourceAccountId" required className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
                  <option value="">— received into —</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
                <button type="submit" className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600">
                  Record payment
                </button>
              </form>
            </div>
          )
        })}
        {openInvoices.length === 0 && <p className="text-sm text-zinc-400">Nothing outstanding.</p>}
      </div>

      {/* Settled archive */}
      {settled.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-medium text-zinc-900">Settled</h2>
          {settled.map((invoice) => (
            <div key={invoice.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-100 bg-zinc-50 p-3 text-sm text-zinc-500">
              <span className="font-mono text-xs">{invoice.number}</span>
              <span>{invoice.customer}</span>
              <span className="ml-auto">{displayINR(String(invoice.amount))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
