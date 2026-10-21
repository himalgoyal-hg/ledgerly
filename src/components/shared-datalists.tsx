import { headOptionLabels, sortByLabel, type HeadOptionBase } from './option-labels'

// Page-level <datalist>s. Render each once, then hand its id to every
// HeadCombobox / SmartCombobox on the page (`listId`) so a table of hundreds
// of rows ships one copy of the options instead of one per row.

export function HeadDatalist(props: { id: string; heads: HeadOptionBase[] }) {
  return (
    <datalist id={props.id}>
      {headOptionLabels(props.heads).map((o) => (
        <option key={o.head.id} value={o.label}>
          {o.head.code}
        </option>
      ))}
    </datalist>
  )
}

export function OptionDatalist(props: { id: string; options: { id: string; label: string }[] }) {
  return (
    <datalist id={props.id}>
      {sortByLabel(props.options).map((o) => (
        <option key={o.id} value={o.label} />
      ))}
    </datalist>
  )
}
