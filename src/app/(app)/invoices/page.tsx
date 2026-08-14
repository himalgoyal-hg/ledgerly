import { Fragment } from 'react'
import { prisma } from '@/lib/db'
import { requireAdmin, visibleEntityFilter } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { outstandingOf } from '@/lib/ops/invoices'
import { GST_RATES, GST_TYPES } from '@/lib/tax/calc'
import {
  createInvoiceAction,
  createFxInvoiceAction,
  recordPaymentAction,
  updateInvoiceAction,
  deleteInvoiceAction,
} from './actions'
import { ConfirmButton } from '@/components/confirm-button'
import { HeadCombobox } from '@/components/head-combobox'
import { SmartCombobox } from '@/components/smart-combobox'
import { InvoiceRow } from './invoice-row'

// Invoices (spec §6.6), export-first: billing knows only the client, the $
// and the date (due = +7 days, follow up after the 10th) — the money (rate,
// charges, fees, FIRC) is learned when the credit lands and recorded then.
// The list is the Excel register: one line per invoice with the realization
// economics computed, never typed.

const CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'NZD']
const inputCls = 'rounded-md border border-zinc-300 px-2 py-1.5 text-sm'

export default async function InvoicesPage() {
  const admin = await requireAdmin()
  const entity = await getCurrentEntity(admin)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const today = new Date()
  // Like the sheet: every books' invoices in ONE register, with a Books
  // column — the switcher only decides where a NEW invoice lands.
  const entities = await prisma.entity.findMany({
    where: { archivedAt: null, ...visibleEntityFilter(admin) },
    select: { id: true, code: true },
  })
  const entityCode = new Map(entities.map((e) => [e.id, e.code]))
  const [invoices, incomeHeads, costCentres, banks, cashLocations] = await Promise.all([
    prisma.invoice.findMany({
      where: { entityId: { in: entities.map((e) => e.id) } },
      include: { payments: true },
      orderBy: [{ date: 'asc' }, { number: 'asc' }],
      take: 200,
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

  const money = (invoice: (typeof invoices)[number]) => {
    const fx = invoice.currency !== 'INR'
    const invoicedFx = invoice.amountFx ? Number(invoice.amountFx) : null
    const receivedFx = invoice.receivedFx ? Number(invoice.receivedFx) : null
    const inr = invoice.realizedInr ? Number(invoice.realizedInr) : null
    const charges = Number(invoice.bankCharges) + Number(invoice.providerFees)
    const effective = receivedFx && inr ? (inr - charges) / receivedFx : null
    const days = invoice.creditDate
      ? Math.round((invoice.creditDate.getTime() - invoice.date.getTime()) / 86_400_000)
      : null
    const shortFx = invoicedFx !== null && receivedFx !== null ? invoicedFx - receivedFx : null
    return { fx, invoicedFx, receivedFx, inr, charges, effective, days, shortFx }
  }
  const totals = invoices.reduce(
    (t, i) => {
      const m = money(i)
      return {
        invoicedFx: t.invoicedFx + (m.invoicedFx ?? 0),
        receivedFx: t.receivedFx + (m.receivedFx ?? 0),
        inr: t.inr + (m.inr ?? 0) + (m.fx ? 0 : Number(i.amount)),
        charges: t.charges + m.charges,
      }
    },
    { invoicedFx: 0, receivedFx: 0, inr: 0, charges: 0 },
  )

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">
          Invoices — {entity.name} ({entity.code})
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Bill in $, record the money when the credit lands — rate, effective cost and days are computed.
        </p>
      </div>

      {/* New export invoice — only what is known at billing time */}
      <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
        <h2 className="text-sm font-medium text-zinc-900">
          New export invoice (next: {entity.invoicePrefix}-{String(entity.nextInvoiceNumber).padStart(4, '0')})
        </h2>
        <form action={createFxInvoiceAction} className="mt-2 flex flex-wrap items-center gap-2">
          <input type="hidden" name="entityId" value={entity.id} />
          <input name="customer" required placeholder="Client" className={inputCls} />
          <input name="country" placeholder="Country" className={`w-28 ${inputCls}`} />
          <select name="currency" className={`bg-white ${inputCls}`}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <input name="amountFx" required inputMode="decimal" placeholder="Amount $" className={`w-28 ${inputCls}`} />
          <label className="text-xs text-zinc-400">date</label>
          <input name="date" type="date" required className={inputCls} />
          <label className="text-xs text-zinc-400">due</label>
          <input name="dueDate" type="date" title="Blank = invoice date + 7 days" className={inputCls} />
          <span className="text-[10px] text-zinc-400">blank = +7 days</span>
          <input name="narration" placeholder="Description" className={`w-44 ${inputCls}`} />
          <button type="submit" className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700">
            Raise invoice
          </button>
        </form>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-700">
            Domestic INR invoice (posts to books, GST)
          </summary>
          <form action={createInvoiceAction} className="mt-2 flex flex-wrap items-center gap-2">
            <input type="hidden" name="entityId" value={entity.id} />
            <input type="hidden" name="currency" value="INR" />
            <input name="customer" required placeholder="Customer" className={inputCls} />
            <input name="amount" required inputMode="decimal" placeholder="Taxable ₹" className={`w-28 ${inputCls}`} />
            <label className="text-xs text-zinc-400">date</label>
            <input name="date" type="date" required className={inputCls} />
            <label className="text-xs text-zinc-400">due</label>
            <input name="dueDate" type="date" required className={inputCls} />
            <HeadCombobox
              heads={incomeHeads.map((h) => ({ id: h.id, code: h.code, name: h.name, kind: h.kind }))}
              name="incomeAccountId"
              required
              placeholder="Income head — type or add"
              createName="headText"
              className={`w-56 bg-white ${inputCls}`}
            />
            <SmartCombobox
              options={costCentres.map((c) => ({ id: c.id, label: c.name }))}
              name="costCentreId"
              createName="costCentreText"
              placeholder="Cost centre — type or add"
              className={`w-56 bg-white ${inputCls}`}
            />
            <input name="narration" placeholder="Description" className={`w-44 ${inputCls}`} />
            <select name="gstType" className={`bg-white ${inputCls}`}>
              <option value="">GST type</option>
              {GST_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <select name="gstRate" className={`bg-white ${inputCls}`}>
              <option value="">no GST</option>
              {GST_RATES.map((r) => (
                <option key={r} value={r}>{r}%</option>
              ))}
            </select>
            <input name="hsn" placeholder="HSN/SAC" className={`w-24 ${inputCls}`} />
            <input name="customerGstin" placeholder="Customer GSTIN" className={`w-40 ${inputCls}`} />
            <button type="submit" className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700">
              Raise INR invoice
            </button>
          </form>
        </details>
      </div>

      {/* The register — the Excel sheet, computed */}
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full min-w-[72rem] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
              <th className="px-1.5 py-2">#</th>
              <th className="px-1.5 py-2">Books</th>
              <th className="px-1.5 py-2">Date</th>
              <th className="px-1.5 py-2">Client</th>
              <th className="px-1.5 py-2">Country</th>
              <th className="px-1.5 py-2">Due</th>
              <th className="px-1.5 py-2 text-right">$ Inv</th>
              <th className="px-1.5 py-2 text-right">$ Recd</th>
              <th className="px-1.5 py-2 text-right">₹ Credited</th>
              <th className="px-1.5 py-2 text-right">Rate</th>
              <th className="px-1.5 py-2 text-right">Charges</th>
              <th className="px-1.5 py-2 text-right">Eff.</th>
              <th className="px-1.5 py-2">FIRC</th>
              <th className="px-1.5 py-2">FC disposal</th>
              <th className="px-1.5 py-2">Credit date</th>
              <th className="px-1.5 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {[...new Set(invoices.map((i) => i.date.toISOString().slice(0, 7)))].map((monthKey) => (
              <Fragment key={monthKey}>
                <tr className="bg-zinc-50">
                  <td colSpan={16} className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(monthKey.slice(5,7)) - 1]} {monthKey.slice(0,4)}
                  </td>
                </tr>
                {invoices.filter((i) => i.date.toISOString().slice(0, 7) === monthKey).map((invoice) => {
              const m = money(invoice)
              const settled = invoice.status === 'SETTLED'
              const overdueDays = Math.floor((today.getTime() - invoice.dueDate.getTime()) / 86_400_000)
              const sinceInvoice = Math.floor((today.getTime() - invoice.date.getTime()) / 86_400_000)
              const badge = settled
                ? null
                : sinceInvoice >= 10
                  ? { label: `follow up (${sinceInvoice}d)`, tone: 'red' as const }
                  : overdueDays > 0
                    ? { label: `overdue ${overdueDays}d`, tone: 'amber' as const }
                    : { label: 'not due', tone: 'zinc' as const }
              return (
                <InvoiceRow
                  key={invoice.id}
                  update={updateInvoiceAction}
                  data={{
                    id: invoice.id,
                    number: invoice.number,
                    books: entityCode.get(invoice.entityId) ?? '?',
                    dateIso: invoice.date.toISOString().slice(0, 10),
                    dueIso: invoice.dueDate.toISOString().slice(0, 10),
                    customer: invoice.customer,
                    narration: invoice.narration ?? '',
                    country: invoice.country ?? '',
                    fx: m.fx,
                    posted: Boolean(invoice.docId),
                    settled,
                    amountFx: invoice.amountFx ? String(invoice.amountFx) : '',
                    receivedFx: invoice.receivedFx ? String(invoice.receivedFx) : '',
                    realizedInr: invoice.realizedInr ? String(invoice.realizedInr) : '',
                    bankCharges: Number(invoice.bankCharges) > 0 ? String(invoice.bankCharges) : '',
                    providerFees: Number(invoice.providerFees) > 0 ? String(invoice.providerFees) : '',
                    creditDateIso: invoice.creditDate?.toISOString().slice(0, 10) ?? '',
                    firc: invoice.firc ?? '',
                    fcDisposal: invoice.fcDisposal ?? '',
                    invDisp: m.fx
                      ? `$${m.invoicedFx?.toLocaleString('en-US')}`
                      : displayINR(String(invoice.amount)),
                    recdDisp: m.receivedFx !== null ? `$${m.receivedFx.toLocaleString('en-US')}` : '',
                    shortDisp:
                      m.shortFx !== null && m.shortFx > 0
                        ? `−$${m.shortFx.toLocaleString('en-US')}`
                        : '',
                    inrDisp: m.inr !== null ? displayINR(m.inr.toFixed(2)) : m.fx ? '' : displayINR(String(invoice.amount)),
                    rateDisp: invoice.fxRate ? Number(invoice.fxRate).toFixed(2) : '',
                    chargesDisp: m.charges > 0 ? displayINR(m.charges.toFixed(2)) : '',
                    effDisp: m.effective !== null ? m.effective.toFixed(2) : '',
                    creditDisp: invoice.creditDate
                      ? `${invoice.creditDate.toISOString().slice(0, 10)}${m.days !== null ? ` (${m.days}d)` : ''}`
                      : '',
                    badge,
                  }}
                >
                  {!settled && !m.fx && (
                    <details>
                      <summary className="cursor-pointer whitespace-nowrap rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600">
                        Record payment
                      </summary>
                      <form action={recordPaymentAction} className="mt-1 w-44 space-y-1 text-left">
                        <input type="hidden" name="invoiceId" value={invoice.id} />
                        <input name="date" type="date" required className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                        <input name="amount" required inputMode="decimal" defaultValue={outstandingOf(invoice)} className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                        <select name="sourceAccountId" required className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs">
                          <option value="">— received into —</option>
                          {sources.map((s) => (
                            <option key={s.id} value={s.id}>{s.label}</option>
                          ))}
                        </select>
                        <button type="submit" className="w-full rounded bg-emerald-700 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-600">
                          Record payment
                        </button>
                      </form>
                    </details>
                  )}
                  <form action={deleteInvoiceAction}>
                    <input type="hidden" name="invoiceId" value={invoice.id} />
                    <ConfirmButton
                      message={`Delete invoice ${invoice.number}? Any postings are reversed (restorable from Journal).`}
                      className="rounded border border-red-200 px-1.5 py-1 text-[11px] text-red-600 hover:bg-red-50"
                    >
                      ✕
                    </ConfirmButton>
                  </form>
                </InvoiceRow>
              )
                })}
              </Fragment>
            ))}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={16} className="px-2 py-4 text-center text-sm text-zinc-400">
                  No invoices yet — raise the first one above.
                </td>
              </tr>
            )}
          </tbody>
          {invoices.length > 0 && (
            <tfoot className="border-t border-zinc-300 font-medium text-zinc-900">
              <tr>
                <td className="px-2 py-2" colSpan={6}>
                  Total ({invoices.length} invoices)
                </td>
                <td className="px-2 py-2 text-right tabular-nums">${totals.invoicedFx.toLocaleString('en-US')}</td>
                <td className="px-2 py-2 text-right tabular-nums">${totals.receivedFx.toLocaleString('en-US')}</td>
                <td className="px-2 py-2 text-right tabular-nums">{displayINR(totals.inr.toFixed(2))}</td>
                <td />
                <td className="px-2 py-2 text-right tabular-nums text-zinc-500">{displayINR(totals.charges.toFixed(2))}</td>
                <td colSpan={5} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}
