'use client'

import { useState } from 'react'

// Click the narration, see the whole transaction: every field of the row,
// the full narration, the tag, tax details, and (for posted rows) the
// journal entry underneath. A fixed overlay so nothing clips inside the
// table's scroll container and the row itself stays one line.

export interface TxnDetailData {
  title: string
  narration: string
  fields: [string, string][] // label → value, in display order
  tax?: string | null
  journal?: { account: string; costCentre: string | null; debit: string; credit: string }[]
}

export function TxnDetails(props: { data: TxnDetailData; className?: string }) {
  const [open, setOpen] = useState(false)
  const d = props.data

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={d.narration}
        className={
          props.className ??
          'block max-w-full truncate text-left font-medium text-zinc-800 hover:text-sky-700 hover:underline'
        }
      >
        {d.title}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <h3 className="text-base font-semibold text-zinc-900">{d.title}</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="ml-auto rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
              >
                ✕
              </button>
            </div>
            <p className="mt-2 break-words rounded-lg bg-zinc-50 p-2 font-mono text-xs leading-relaxed text-zinc-600">
              {d.narration}
            </p>
            <table className="mt-3 w-full text-sm">
              <tbody className="divide-y divide-zinc-100">
                {d.fields.map(([label, value]) => (
                  <tr key={label}>
                    <td className="py-1 pr-3 text-xs uppercase tracking-wider text-zinc-400">{label}</td>
                    <td className="py-1 text-right font-medium text-zinc-800">{value}</td>
                  </tr>
                ))}
                {d.tax && (
                  <tr>
                    <td className="py-1 pr-3 text-xs uppercase tracking-wider text-zinc-400">GST/TDS</td>
                    <td className="py-1 text-right font-medium text-amber-700">{d.tax}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {d.journal && d.journal.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Journal entry
                </p>
                <table className="mt-1 w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
                      <th className="py-1 text-left">Account</th>
                      <th className="py-1 text-right">Dr</th>
                      <th className="py-1 text-right">Cr</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {d.journal.map((l, i) => (
                      <tr key={i}>
                        <td className="py-1 text-zinc-700">
                          {l.account}
                          {l.costCentre && (
                            <span className="ml-1 text-[10px] text-zinc-400">· {l.costCentre}</span>
                          )}
                        </td>
                        <td className="py-1 text-right tabular-nums text-zinc-800">
                          {Number(l.debit) > 0 ? l.debit : ''}
                        </td>
                        <td className="py-1 text-right tabular-nums text-zinc-800">
                          {Number(l.credit) > 0 ? l.credit : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
