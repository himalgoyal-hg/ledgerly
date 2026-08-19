'use client'

// Smart search for any register: type and the rows filter THERE AND THEN —
// no button, no reload. Points at every table matching `selector`; rows
// marked data-filter-keep="1" (add-rows, totals) never hide.

export function LiveFilter(props: { selector: string; placeholder?: string; className?: string }) {
  return (
    <input
      type="search"
      placeholder={props.placeholder ?? 'Type to search…'}
      className={
        props.className ??
        'w-52 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none'
      }
      onChange={(e) => {
        const q = e.target.value.trim().toLowerCase()
        document.querySelectorAll(props.selector).forEach((table) => {
          table.querySelectorAll('tbody tr').forEach((tr) => {
            const el = tr as HTMLTableRowElement
            if (el.dataset.filterKeep === '1') return
            const inputs = [...el.querySelectorAll('input')].map((i) => i.value).join(' ')
            const hay = `${el.textContent ?? ''} ${inputs}`.toLowerCase()
            el.style.display = !q || hay.includes(q) ? '' : 'none'
          })
        })
      }}
    />
  )
}
