'use client'

// Select-all for a bin section: ticks every checkbox bound to the given
// bulk form, so "all" is one click away.

export function BinSelectAll(props: { formId: string }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-2">
      <input
        type="checkbox"
        className="accent-primary"
        onChange={(e) => {
          document
            .querySelectorAll<HTMLInputElement>(`input[type="checkbox"][form="${props.formId}"]`)
            .forEach((box) => {
              box.checked = e.target.checked
            })
        }}
      />
      all
    </label>
  )
}
