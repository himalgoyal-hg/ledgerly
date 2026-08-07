import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { GST_RATES, GST_TYPES, TDS_SECTIONS } from '@/lib/tax/calc'
import { suggestPaymentSource, rankForAmount } from '@/lib/automation/suggest'
import { SourceSelect } from '../source-select'
import { createBillAction, payBillAction, deleteBillAction } from './actions'
import { ConfirmButton } from '@/components/confirm-button'

// Bills & insurance (spec §6.3): entry posts the payable; payment clears it.
// Recurring bills spawn their next instance on payment.

export default async function BillsPage() {
  const admin = await requireAdmin()
  const entity = await getCurrentEntity(admin)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const today = new Date().toISOString().slice(0, 10)
  const [pending, paid, heads, costCentres, policyBills] = await Promise.all([
    prisma.bill.findMany({
      where: { entityId: entity.id, status: 'PENDING' },
      orderBy: { dueDate: 'asc' },
    }),
    prisma.bill.findMany({
      where: { entityId: entity.id, status: 'PAID' },
      orderBy: { paidAt: 'desc' },
      take: 20,
    }),
    prisma.ledgerAccount.findMany({
      where: { entityId: entity.id, isGroup: false, archivedAt: null, kind: 'EXPENSE' },
      orderBy: { code: 'asc' },
    }),
    prisma.costCentre.findMany({
      where: { entityId: entity.id, archivedAt: null },
      orderBy: { name: 'asc' },
    }),
    prisma.bill.findMany({
      where: { entityId: entity.id, policyNumber: { not: null } },
      orderBy: { billDate: 'desc' },
    }),
  ])
  // Latest bill per policy number — that instance carries the live renewal
  // date, so it decides active / renews-soon / lapsed.
  const policies = [...new Map(policyBills.map((b) => [b.policyNumber!, b])).values()]
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
  const policyStatus = (renewal: Date | null) => {
    if (!renewal) return { label: 'no renewal date', cls: 'bg-zinc-100 text-zinc-500' }
    const d = renewal.toISOString().slice(0, 10)
    if (d < today) return { label: `LAPSED — renewal was ${d}`, cls: 'bg-red-100 text-red-700' }
    if (d <= soon) return { label: `renews soon — ${d}`, cls: 'bg-amber-100 text-amber-700' }
    return { label: `active till ${d}`, cls: 'bg-emerald-100 text-emerald-700' }
  }
  // Balances and commitment reservations once; ranked per bill below.
  const baseSuggestion = await suggestPaymentSource({ entityId: entity.id, module: 'bill' })
  const headName = (id: string) => {
    const h = heads.find((a) => a.id === id)
    return h ? `${h.code} · ${h.name}` : '—'
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900">
        Bills & insurance — {entity.name} ({entity.code})
      </h1>

      {/* New bill */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <h2 className="font-medium text-zinc-900">New bill (posts the payable)</h2>
        <form action={createBillAction} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="entityId" value={entity.id} />
          <input name="vendor" required placeholder="Vendor" className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <input name="billType" required placeholder="Type (Electricity, Insurance…)" className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <input name="amount" required inputMode="decimal" placeholder="Taxable ₹" className="w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <label className="text-xs text-zinc-400">bill date</label>
          <input name="billDate" type="date" required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <label className="text-xs text-zinc-400">due</label>
          <input name="dueDate" type="date" required className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <label className="text-xs text-zinc-400">renewal</label>
          <input name="renewalDate" type="date" className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <select name="expenseAccountId" required className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
            <option value="">— expense head —</option>
            {heads.map((h) => (
              <option key={h.id} value={h.id}>{h.code} · {h.name}</option>
            ))}
          </select>
          <select name="costCentreId" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
            <option value="">— cost centre —</option>
            {costCentres.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select name="recurrence" className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
            <option value="NONE">One-time</option>
            <option value="MONTHLY">Monthly</option>
            <option value="QUARTERLY">Quarterly</option>
            <option value="HALF_YEARLY">Half-yearly</option>
            <option value="YEARLY">Yearly</option>
          </select>
          <input name="link" placeholder="Drive link" className="w-36 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <input name="remarks" placeholder="Remarks" className="w-36 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
          <button type="submit" className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700">
            Add bill
          </button>

          {/* GST / TDS (spec §7): GST adds Input Credit; TDS is withheld
              from the vendor and lands in TDS Payable. */}
          <details className="w-full">
            <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-700">
              GST / TDS details (optional)
            </summary>
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 p-2">
              <span className="text-[10px] font-medium uppercase text-zinc-400">GST</span>
              <select name="gstType" className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs">
                <option value="">type</option>
                {GST_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <select name="gstRate" className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs">
                <option value="">no GST</option>
                {GST_RATES.map((r) => (
                  <option key={r} value={r}>{r}%</option>
                ))}
              </select>
              <input name="hsn" placeholder="HSN/SAC" className="w-24 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
              <input name="vendorGstin" placeholder="Vendor GSTIN" className="w-36 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
              <span className="ml-3 text-[10px] font-medium uppercase text-zinc-400">TDS</span>
              <select name="tdsSection" className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs">
                <option value="">section</option>
                {TDS_SECTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <input name="tdsRate" placeholder="rate %" inputMode="decimal" className="w-16 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
              <input name="vendorPan" placeholder="Vendor PAN" className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
            </div>
          </details>

          {/* Insurance (v2 prototype): policy metadata; renewal date above
              drives the lapse alert. Periodicity = the recurrence picker. */}
          <details className="w-full">
            <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-700">
              Insurance details (optional)
            </summary>
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 p-2">
              <input name="policyNumber" placeholder="Policy number" className="w-36 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
              <input name="insuredValue" inputMode="decimal" placeholder="Insured value ₹" className="w-32 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
              <input name="insuredFor" placeholder="For whom (e.g. Himal)" className="w-40 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
              <span className="text-[10px] text-zinc-400">
                set the renewal date above — a passed renewal shows a lapse alert
              </span>
            </div>
          </details>
        </form>
      </div>

      {/* Pending */}
      <div className="space-y-2">
        <h2 className="font-medium text-zinc-900">Pending ({pending.length})</h2>
        {pending.map((bill) => {
          const overdue = bill.dueDate.toISOString().slice(0, 10) < today
          const payable = (
            Number(bill.amount) + Number(bill.gstAmount) - Number(bill.tdsAmount)
          ).toFixed(2)
          // This bill is itself a reserved commitment — don't count it against
          // the account that is about to pay it.
          const suggestion = rankForAmount(baseSuggestion.options, payable)
          return (
            <div key={bill.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium text-zinc-800">{bill.vendor}</span>
                <span className="text-zinc-500">{bill.billType}</span>
                <form action={deleteBillAction} className="order-last ml-auto">
                  <input type="hidden" name="billId" value={bill.id} />
                  <ConfirmButton
                    message={`Delete this ${bill.vendor} bill? Its ledger postings are reversed (restorable from Journal).`}
                    className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                  >
                    Delete
                  </ConfirmButton>
                </form>
                <span className="text-xs text-zinc-400">{headName(bill.expenseAccountId)}</span>
                <span className={`text-xs ${overdue ? 'font-medium text-red-600' : 'text-zinc-400'}`}>
                  due {bill.dueDate.toISOString().slice(0, 10)}{overdue ? ' — OVERDUE' : ''}
                </span>
                {bill.renewalDate && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${policyStatus(bill.renewalDate).cls}`}
                  >
                    {policyStatus(bill.renewalDate).label}
                  </span>
                )}
                {(bill.policyNumber || bill.insuredValue) && (
                  <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                    {bill.policyNumber && `Policy ${bill.policyNumber}`}
                    {bill.insuredValue && ` · covers ${displayINR(String(bill.insuredValue))}`}
                    {bill.insuredFor && ` · for ${bill.insuredFor}`}
                  </span>
                )}
                {bill.recurrence !== 'NONE' && (
                  <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                    {bill.recurrence.toLowerCase().replace('_', '-')}
                  </span>
                )}
                {bill.link && (
                  <a href={bill.link} target="_blank" rel="noreferrer" className="text-xs text-sky-600 hover:underline">bill</a>
                )}
                {Number(bill.gstAmount) > 0 && (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                    GST {String(bill.gstRate)}% · ITC {displayINR(String(bill.gstAmount))}
                  </span>
                )}
                {Number(bill.tdsAmount) > 0 && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                    TDS {bill.tdsSection} · {displayINR(String(bill.tdsAmount))} withheld
                  </span>
                )}
                <span className="ml-auto text-right">
                  <span className="block font-semibold text-zinc-900">
                    {displayINR(
                      String(
                        Number(bill.amount) + Number(bill.gstAmount) - Number(bill.tdsAmount),
                      ),
                    )}
                  </span>
                  {(Number(bill.gstAmount) > 0 || Number(bill.tdsAmount) > 0) && (
                    <span className="text-[10px] text-zinc-400">
                      payable · taxable {displayINR(String(bill.amount))}
                    </span>
                  )}
                </span>
              </div>
              <form action={payBillAction} className="mt-3 flex flex-wrap items-center gap-2">
                <input type="hidden" name="billId" value={bill.id} />
                <input name="date" type="date" required defaultValue={today} className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
                <SourceSelect suggestion={suggestion} compact />
                <button type="submit" className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600">
                  Mark paid (clears payable)
                </button>
              </form>
            </div>
          )
        })}
        {pending.length === 0 && <p className="text-sm text-zinc-400">Nothing pending.</p>}
      </div>

      {/* Insurance policies — one card per policy number; the latest bill in
          the series decides the renewal status (lapse alert). */}
      {policies.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-medium text-zinc-900">Insurance policies ({policies.length})</h2>
          {policies.map((p) => {
            const status = policyStatus(p.renewalDate)
            return (
              <div key={p.policyNumber} className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 text-sm shadow-sm">
                <span className="font-medium text-zinc-800">{p.vendor}</span>
                <span className="font-mono text-xs text-zinc-500">{p.policyNumber}</span>
                {p.insuredFor && <span className="text-xs text-zinc-400">for {p.insuredFor}</span>}
                {p.insuredValue && (
                  <span className="text-xs text-zinc-500">insured {displayINR(String(p.insuredValue))}</span>
                )}
                <span className="text-xs text-zinc-400">
                  premium {displayINR(String(p.amount))}
                  {p.recurrence !== 'NONE' ? ` · ${p.recurrence.toLowerCase().replace('_', '-')}` : ''}
                </span>
                <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium ${status.cls}`}>
                  {status.label}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Paid archive */}
      {paid.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-medium text-zinc-900">Recently paid</h2>
          {paid.map((bill) => (
            <div key={bill.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-100 bg-zinc-50 p-3 text-sm text-zinc-500">
              <span>{bill.vendor}</span>
              <span className="text-xs">{bill.billType}</span>
              <span className="text-xs">paid {bill.paidAt?.toISOString().slice(0, 10)}</span>
              <span className="ml-auto">{displayINR(String(bill.amount))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
