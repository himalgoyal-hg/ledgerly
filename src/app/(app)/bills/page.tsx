import { Fragment } from 'react'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { GST_RATES, GST_TYPES, TDS_SECTIONS } from '@/lib/tax/calc'
import { createBillAction, payBillAction, deleteBillAction, updateBillAction } from './actions'
import { ConfirmButton } from '@/components/confirm-button'
import { BillRow } from './bill-row'

// Bills & insurance (spec §6.3): a document store + reminder list. Nothing
// posts from here — the expense reaches the books when the bank-statement
// row is tagged. Recurring bills spawn their next instance on "Mark paid".
// The screen is a register: one line per commitment, grouped by type.

const inputCls = 'rounded-md border border-zinc-300 px-2 py-1.5 text-sm'

export default async function BillsPage() {
  const admin = await requireAdmin()
  const entity = await getCurrentEntity(admin)
  if (!entity) return <p className="text-sm text-zinc-500">No books selected.</p>

  const today = new Date().toISOString().slice(0, 10)
  const [pending, paid] = await Promise.all([
    prisma.bill.findMany({
      where: { entityId: entity.id, status: 'PENDING' },
      orderBy: { dueDate: 'asc' },
    }),
    prisma.bill.findMany({
      where: { entityId: entity.id, status: 'PAID' },
      orderBy: { paidAt: 'desc' },
      take: 20,
    }),
  ])
  // The attached file lands in /files/<id>; a pasted Drive link stays a link.
  const fileLinks = (link: string | null) =>
    link?.startsWith('/files/') ? { view: link, download: `${link}?download=1` } : null
  const freqLabel = (r: string) =>
    r === 'NONE' ? '—' : r.toLowerCase().replace('_', '-')
  const payable = (b: (typeof pending)[number]) =>
    Number(b.amount) + Number(b.gstAmount) - Number(b.tdsAmount)

  // Groups, most urgent first.
  const types = [...new Set(pending.map((b) => b.billType))].sort((a, b) => {
    const due = (t: string) =>
      Math.min(...pending.filter((x) => x.billType === t).map((x) => x.dueDate.getTime()))
    return due(a) - due(b)
  })
  const monthlyRunRate = pending.reduce((t, b) => {
    const p = payable(b)
    switch (b.recurrence) {
      case 'MONTHLY': return t + p
      case 'QUARTERLY': return t + p / 3
      case 'HALF_YEARLY': return t + p / 6
      case 'YEARLY': return t + p / 12
      default: return t
    }
  }, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">
            Bills & insurance — {entity.name} ({entity.code})
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Documents & reminders only — the books post when the statement row is tagged.
            Recurring run rate ≈ {displayINR(monthlyRunRate.toFixed(0))}/month.
          </p>
        </div>
        {/* Document homes (from the EMI sheet) */}
        <div className="ml-auto flex items-center gap-3">
          <a
            href="https://drive.google.com/drive/folders/1tVDXx-URABNCn_gUjPQpmMRX_5PYx8Dz"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-sky-600 hover:underline"
          >
            📁 Documents folder
          </a>
          <a
            href="https://www.sihub.in/managesi/hdfcbank"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-sky-600 hover:underline"
          >
            HDFC standing instructions
          </a>
        </div>
      </div>

      {/* New bill — tucked away until needed */}
      <details className="rounded-xl border border-zinc-200 bg-white shadow-sm">
        <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50">
          ＋ New bill
        </summary>
        <form action={createBillAction} className="border-t border-zinc-100 p-4">
          <input type="hidden" name="entityId" value={entity.id} />
          {/* What is it — mirrors the register's Vendor / For-policy columns */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Vendor *</span>
              <input name="vendor" required placeholder="Star Health / Netflix…" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Type *</span>
              <input name="billType" required placeholder="EMI / Insurance / Subscription…" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">For whom</span>
              <input name="insuredFor" placeholder="Himal / Baleno / Synergy…" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Policy / ref no.</span>
              <input name="policyNumber" placeholder="Policy or account no." className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Insured value ₹</span>
              <input name="insuredValue" inputMode="decimal" placeholder="Cover amount" className={`mt-1 w-full ${inputCls}`} />
            </label>
          </div>

          {/* Money & timing — the register's Due / Every / Via / Amount */}
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-6">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Amount ₹ *</span>
              <input name="amount" required inputMode="decimal" placeholder="Taxable" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Bill date *</span>
              <input name="billDate" type="date" required className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Due date *</span>
              <input name="dueDate" type="date" required className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Renewal (insurance)</span>
              <input name="renewalDate" type="date" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Every</span>
              <select name="recurrence" className={`mt-1 w-full bg-white ${inputCls}`}>
                <option value="NONE">One-time</option>
                <option value="MONTHLY">Monthly</option>
                <option value="QUARTERLY">Quarterly</option>
                <option value="HALF_YEARLY">Half-yearly</option>
                <option value="YEARLY">Yearly</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Pay from</span>
              <input name="payFrom" placeholder="Bank / card / GPay" className={`mt-1 w-full ${inputCls}`} />
            </label>
          </div>

          {/* Documents & notes */}
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">📎 Attach bill</span>
              <input type="file" name="file" accept="application/pdf,image/*" className="mt-1 w-full text-xs" />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">…or Drive link</span>
              <input name="link" placeholder="https://drive.google.com/…" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="block md:col-span-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Remarks</span>
              <input name="remarks" placeholder="Anything worth remembering" className={`mt-1 w-full ${inputCls}`} />
            </label>
          </div>

          {/* GST / TDS (spec §7) */}
          <details className="mt-3">
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
                {TDS_SECTIONS.map((sec) => (
                  <option key={sec} value={sec}>{sec}</option>
                ))}
              </select>
              <input name="tdsRate" placeholder="rate %" inputMode="decimal" className="w-16 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
              <input name="vendorPan" placeholder="Vendor PAN" className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-xs" />
            </div>
          </details>

          <div className="mt-4 flex items-center gap-3">
            <button type="submit" className="rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700">
              Add bill
            </button>
            <span className="text-[10px] text-zinc-400">
              a passed renewal date shows a lapse alert · recurring bills spawn the next instance on ✓ Paid
            </span>
          </div>
        </form>
      </details>

      {/* The register */}
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full min-w-[72rem] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">For / policy</th>
              <th className="px-3 py-2">Due</th>
              <th className="px-3 py-2">Every</th>
              <th className="px-3 py-2">Via</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Docs</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {types.map((type) => {
              const group = pending
                .filter((b) => b.billType === type)
                .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
              const groupTotal = group.reduce((t, b) => t + payable(b), 0)
              return (
                <Fragment key={type}>
                  <tr className="bg-zinc-50">
                    <td colSpan={8} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      {type}
                      <span className="ml-2 font-normal normal-case text-zinc-400">
                        {group.length} · {displayINR(groupTotal.toFixed(2))} per cycle
                      </span>
                    </td>
                  </tr>
                  {group.map((bill) => {
                    const overdue = bill.dueDate.toISOString().slice(0, 10) < today
                    const files = fileLinks(bill.link)
                    return (
                      <BillRow
                        key={bill.id}
                        update={updateBillAction}
                        data={{
                          id: bill.id,
                          vendor: bill.vendor,
                          billType: bill.billType,
                          insuredFor: bill.insuredFor ?? '',
                          policyNumber: bill.policyNumber ?? '',
                          insuredValue: bill.insuredValue ? String(bill.insuredValue) : '',
                          dueIso: bill.dueDate.toISOString().slice(0, 10),
                          recurrence: bill.recurrence,
                          payFrom: bill.payFrom ?? '',
                          amount: String(bill.amount),
                          link: bill.link && !bill.link.startsWith('/files/') ? bill.link : '',
                          remarks: bill.remarks ?? '',
                          overdue,
                          payableDisp: displayINR(payable(bill).toFixed(2)),
                          insuredDisp: bill.insuredValue ? displayINR(String(bill.insuredValue)) : '',
                          taxTip:
                            Number(bill.gstAmount) > 0 || Number(bill.tdsAmount) > 0
                              ? `taxable ${displayINR(String(bill.amount))} · GST ${displayINR(String(bill.gstAmount))} · TDS ${displayINR(String(bill.tdsAmount))}`
                              : undefined,
                          files,
                        }}
                      >
                        <form action={payBillAction} className="flex items-center gap-1">
                          <input type="hidden" name="billId" value={bill.id} />
                          <input
                            name="date"
                            type="date"
                            required
                            defaultValue={today}
                            className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs"
                          />
                          <button
                            type="submit"
                            title="Mark paid — posting happens when the statement row is tagged; recurring bills spawn the next instance"
                            className="whitespace-nowrap rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600"
                          >
                            ✓ Paid
                          </button>
                        </form>
                        <form action={deleteBillAction}>
                          <input type="hidden" name="billId" value={bill.id} />
                          <ConfirmButton
                            message={`Delete this ${bill.vendor} bill and its stored document?`}
                            className="rounded border border-red-200 px-1.5 py-1 text-[11px] text-red-600 hover:bg-red-50"
                          >
                            ✕
                          </ConfirmButton>
                        </form>
                      </BillRow>
                    )
                  })}
                </Fragment>
              )
            })}
            {pending.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-sm text-zinc-400">
                  Nothing pending — add the first bill above.
                </td>
              </tr>
            )}
          </tbody>
          {pending.length > 0 && (
            <tfoot className="border-t border-zinc-300 font-medium text-zinc-900">
              <tr>
                <td className="px-3 py-2" colSpan={5}>Total ({pending.length} pending)</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {displayINR(pending.reduce((t, b) => t + payable(b), 0).toFixed(2))}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Paid archive */}
      {paid.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-200 px-4 py-2">
            <h2 className="text-sm font-medium text-zinc-900">Recently paid</h2>
          </div>
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-zinc-50">
              {paid.map((bill) => {
                const files = fileLinks(bill.link)
                return (
                  <tr key={bill.id} className="text-zinc-500">
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums">
                      {bill.paidAt?.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-3 py-1.5">{bill.vendor}</td>
                    <td className="px-3 py-1.5 text-xs">{bill.billType}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {displayINR(payable(bill).toFixed(2))}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs">
                      {files ? (
                        <>
                          <a href={files.view} target="_blank" rel="noreferrer" className="text-sky-600 hover:underline">view</a>{' '}
                          <a href={files.download} className="text-sky-600 hover:underline">download</a>
                        </>
                      ) : bill.link ? (
                        <a href={bill.link} target="_blank" rel="noreferrer" className="text-sky-600 hover:underline">document</a>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
