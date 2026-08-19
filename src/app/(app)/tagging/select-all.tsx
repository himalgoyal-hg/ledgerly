'use client'

// Select-all for the bulk-tag bar: flips every row checkbox that belongs to
// the #bulk-tag form (they live inside the pending cards, associated via the
// form attribute so nothing nests).

export function SelectAll() {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-2">
      <input
        type="checkbox"
        className="accent-primary"
        onChange={(e) => {
          document
            .querySelectorAll<HTMLInputElement>('input[name="ids"][form="bulk-tag"]')
            .forEach((box) => {
              box.checked = e.target.checked
            })
        }}
      />
      select all in view
    </label>
  )
}
