import { displayINR } from '@/lib/ledger/money'
import type { SourceSuggestion } from '@/lib/automation/suggest'

// Smart payment source picker (spec §8). The suggested account is
// pre-selected with its reason shown, every option carries its available
// balance, and a low-balance warning appears when nothing comfortably
// covers the payment — but the choice always stays with the user.

export function SourceSelect(props: {
  suggestion: SourceSuggestion
  name?: string
  /** Rendered small, for inline forms inside a list row. */
  compact?: boolean
}) {
  const { options, best, warning } = props.suggestion
  const size = props.compact ? 'px-2 py-1 text-xs' : 'px-2 py-1.5 text-sm'

  return (
    <span className="flex flex-wrap items-center gap-2">
      <select
        name={props.name ?? 'sourceAccountId'}
        required
        defaultValue={best?.ledgerAccountId ?? ''}
        className={`rounded-md border border-zinc-300 bg-white ${size}`}
      >
        <option value="">— pay from —</option>
        {options.map((option) => (
          <option key={option.ledgerAccountId} value={option.ledgerAccountId}>
            {option.label} · {displayINR(option.available)} available
            {option.sufficient ? '' : ' ⚠'}
          </option>
        ))}
      </select>

      {best && (
        <span className="text-[10px] text-zinc-400">
          suggested: {best.label}
          {best.reasons.length > 0 && ` — ${best.reasons.join(', ')}`}
        </span>
      )}
      {warning && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
          {warning}
        </span>
      )}
    </span>
  )
}
