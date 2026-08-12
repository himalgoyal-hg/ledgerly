import { Fragment } from 'react'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { outstandingOf } from '@/lib/ops/invoices'
import { GST_RATES, GST_TYPES } from '@/lib/tax/calc'
import {
  createInvoiceAction,
  createFxInvoiceAction,
  recordPaymentAction,
  recordFxReceiptAction,
  updateInvoiceAction,
  deleteInvoiceAction,
} from './actions'
import { ConfirmButton } from '@/components/confirm-button'
import { HeadCombobox } from '@/components/head-combobox'
import { SmartCombobox } from '@/components/smart-combobox'

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
  const [invoices, incomeHeads, costCentres, banks, cashLocations] = await Promise.all([
    prisma.invoice.findMany({
      where: { entityId: entity.id },
      include: { payments: true },
      orderBy: [{ date: 'desc' }, { number: 'desc' }],
      take: 100,
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
  const dueBadge = (invoice: (typeof invoices)[number]) => {
    if (invoice.status === 'SETTLED') return null
    const overdueDays = Math.floor((today.getTime() - invoice.dueDate.getTime()) / 86_400_000)
    const sinceInvoice = Math.floor((today.getTime() - invoice.date.getTime()) / 86_400_000)
    if (sinceInvoice >= 10)
      return (
        <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
          follow up ({sinceInvoice}d)
        </span>
      )
    if (overdueDays > 0)
      return (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
          overdue {overdueDays}d
        </span>
      )
    return <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">not due</span>
  }

  const open = invoices.filter((i) => i.status !== 'SETTLED')
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
        <table className="w-full min-w-[76rem] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">Date</th>
              <th className="px-2 py-2">Client</th>
              <th className="px-2 py-2">Country</th>
              <th className="px-2 py-2">Due</th>
              <th className="px-2 py-2 text-right">$ invoiced</th>
              <th className="px-2 py-2 text-right">$ received</th>
              <th className="px-2 py-2 text-right">₹ credited</th>
              <th className="px-2 py-2 text-right">Rate</th>
              <th className="px-2 py-2 text-right">Chg + fees</th>
              <th className="px-2 py-2 text-right">Effective</th>
              <th className="px-2 py-2">FIRC</th>
              <th className="px-2 py-2 text-right">Days</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {invoices.map((invoice) => {
              const m = money(invoice)
              const settled = invoice.status === 'SETTLED'
              return (
                <Fragment key={invoice.id}>
                  <tr className={`align-top ${settled ? 'text-zinc-500' : ''} hover:bg-zinc-50/60`}>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs text-zinc-500">{invoice.number}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-xs tabular-nums text-zinc-500">
                      {invoice.date.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-2 py-1.5 font-medium text-zinc-800">
                      {invoice.customer}
                      {invoice.narration && (
                        <span className="block max-w-40 truncate text-[10px] font-normal text-zinc-400" title={invoice.narration}>
                          {invoice.narration}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-zinc-600">{invoice.country ?? '—'}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <span className="text-xs tabular-nums text-zinc-500">{invoice.dueDate.toISOString().slice(0, 10)}</span>{' '}
                      {dueBadge(invoice)}
                      {settled && (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                          settled
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                      {m.fx ? `$${m.invoicedFx?.toLocaleString('en-US')}` : displayINR(String(invoice.amount))}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                      {m.receivedFx !== null ? (
                        <>
                          ${m.receivedFx.toLocaleString('en-US')}
                          {m.shortFx !== null && m.shortFx > 0 && (
                            <span className="block text-[10px] text-red-500">−${m.shortFx.toLocaleString('en-US')}</span>
                          )}
                        </>
                      ) : (
                        <span className="text-zinc-300">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                      {m.inr !== null ? displayINR(m.inr.toFixed(2)) : m.fx ? <span className="text-zinc-300">—</span> : ''}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                      {invoice.fxRate ? Number(invoice.fxRate).toFixed(2) : <span className="text-zinc-300">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                      {m.charges > 0 ? displayINR(m.charges.toFixed(2)) : <span className="text-zinc-300">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-medium tabular-nums">
                      {m.effective !== null ? m.effective.toFixed(2) : <span className="text-zinc-300">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-xs">{invoice.firc ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right text-xs tabular-nums">{m.days ?? '—'}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-start justify-end gap-1.5">
                        {!settled && m.fx && (
                          <details>
                            <summary className="cursor-pointer whitespace-nowrap rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600">
                              Record receipt
                            </summary>
                            <form action={recordFxReceiptAction} className="mt-1 w-44 space-y-1">
                              <input type="hidden" name="invoiceId" value={invoice.id} />
                              <input name="receivedFx" required inputMode="decimal" defaultValue={m.invoicedFx ?? undefined} placeholder="$ received" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                              <input name="realizedInr" required inputMode="decimal" placeholder="₹ credited" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                              <input name="bankCharges" inputMode="decimal" placeholder="Bank charges ₹" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                              <input name="providerFees" inputMode="decimal" placeholder="Skydo/platform fees ₹" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                              <input name="creditDate" type="date" required title="Date of credit" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                              <select name="firc" className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs">
                                <option value="">FIRC —</option>
                                <option>Awaited</option>
                                <option>Partial</option>
                                <option>Received</option>
                              </select>
                              <button type="submit" className="w-full rounded bg-emerald-700 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-600">
                                Save — rate computes itself
                              </button>
                            </form>
                          </details>
                        )}
                        {!settled && !m.fx && (
                          <details>
                            <summary className="cursor-pointer whitespace-nowrap rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600">
                              Record payment
                            </summary>
                            <form action={recordPaymentAction} className="mt-1 w-44 space-y-1">
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
                        <details>
                          <summary className="cursor-pointer whitespace-nowrap rounded border border-zinc-300 px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100">
                            edit
                          </summary>
                          <form action={updateInvoiceAction} className="mt-1 w-44 space-y-1 text-left">
                            <input type="hidden" name="invoiceId" value={invoice.id} />
                            {!invoice.docId && (
                              <input name="customer" defaultValue={invoice.customer} placeholder="Client" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                            )}
                            <input name="country" defaultValue={invoice.country ?? ''} placeholder="Country" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                            {m.fx && (
                              <input name="amountFx" defaultValue={m.invoicedFx ?? undefined} inputMode="decimal" placeholder="Invoiced $" title="Invoiced $" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                            )}
                            <label className="block text-[10px] text-zinc-400">invoice date</label>
                            <input name="date" type="date" defaultValue={invoice.date.toISOString().slice(0, 10)} className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                            <label className="block text-[10px] text-zinc-400">due date</label>
                            <input name="dueDate" type="date" defaultValue={invoice.dueDate.toISOString().slice(0, 10)} className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                            {m.fx && settled && (
                              <>
                                <input name="receivedFx" defaultValue={m.receivedFx ?? undefined} inputMode="decimal" placeholder="$ received" title="$ received" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                                <input name="realizedInr" defaultValue={m.inr ?? undefined} inputMode="decimal" placeholder="₹ credited" title="₹ credited" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                                <input name="bankCharges" defaultValue={String(invoice.bankCharges)} inputMode="decimal" placeholder="Bank charges ₹" title="Bank charges" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                                <input name="providerFees" defaultValue={String(invoice.providerFees)} inputMode="decimal" placeholder="Skydo fees ₹" title="Skydo/platform fees" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                                <label className="block text-[10px] text-zinc-400">credit date</label>
                                <input name="creditDate" type="date" defaultValue={invoice.creditDate?.toISOString().slice(0, 10)} className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                              </>
                            )}
                            <select name="firc" defaultValue={invoice.firc ?? ''} className="w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs">
                              <option value="">FIRC —</option>
                              <option>Awaited</option>
                              <option>Partial</option>
                              <option>Received</option>
                            </select>
                            <input name="narration" defaultValue={invoice.narration ?? ''} placeholder="Description" className="w-full rounded border border-zinc-300 px-1.5 py-1 text-xs" />
                            <button type="submit" className="w-full rounded bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-700">
                              Save{m.fx && settled ? ' — rate recomputes' : ''}
                            </button>
                            {invoice.docId && (
                              <p className="text-[10px] leading-tight text-zinc-400">
                                Posted invoice: amounts/GST change via delete &amp; re-raise.
                              </p>
                            )}
                          </form>
                        </details>
                        <form action={deleteInvoiceAction}>
                          <input type="hidden" name="invoiceId" value={invoice.id} />
                          <ConfirmButton
                            message={`Delete invoice ${invoice.number}? Any postings are reversed (restorable from Journal).`}
                            className="rounded border border-red-200 px-1.5 py-1 text-[11px] text-red-600 hover:bg-red-50"
                          >
                            ✕
                          </ConfirmButton>
                        </form>
                      </div>
                    </td>
                  </tr>
                </Fragment>
              )
            })}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={14} className="px-2 py-4 text-center text-sm text-zinc-400">
                  No invoices yet — raise the first one above.
                </td>
              </tr>
            )}
          </tbody>
          {invoices.length > 0 && (
            <tfoot className="border-t border-zinc-300 font-medium text-zinc-900">
              <tr>
                <td className="px-2 py-2" colSpan={5}>
                  Total ({invoices.length} invoices, {open.length} open)
                </td>
                <td className="px-2 py-2 text-right tabular-nums">${totals.invoicedFx.toLocaleString('en-US')}</td>
                <td className="px-2 py-2 text-right tabular-nums">${totals.receivedFx.toLocaleString('en-US')}</td>
                <td className="px-2 py-2 text-right tabular-nums">{displayINR(totals.inr.toFixed(2))}</td>
                <td />
                <td className="px-2 py-2 text-right tabular-nums text-zinc-500">{displayINR(totals.charges.toFixed(2))}</td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}
