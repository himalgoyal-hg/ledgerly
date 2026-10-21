// Option labels shared by the pickers and the page-level datalists.
//
// A tagging page lists every row (no cap, per Himal) and each row carries
// three type-ahead pickers. Rendering a private <datalist> per picker put
// ~60,000 <option> elements on one page — 5 MB of HTML. The page now renders
// each list ONCE and the pickers point at it; both sides must agree on the
// labels, so the label logic lives here.

export interface HeadOptionBase {
  id: string;
  code: string;
  name: string;
}

/**
 * Datalist labels for a set of heads, A→Z. A name that occurs twice in one
 * set of books gets its code appended, so every option resolves to exactly
 * one head.
 */
export function headOptionLabels<H extends HeadOptionBase>(
  heads: H[],
): { head: H; label: string }[] {
  // One shared heads array reaches every picker on a page (React sends it
  // once and references it), so label it once instead of once per picker —
  // 700 pickers each sorting 400 heads is seconds of hydration.
  const cached = labelCache.get(heads) as
    { head: H; label: string }[] | undefined;
  if (cached) return cached;
  const seen = new Map<string, number>();
  for (const h of heads) seen.set(h.name, (seen.get(h.name) ?? 0) + 1);
  const labelled = heads
    .map((h) => ({
      head: h,
      label: (seen.get(h.name) ?? 0) > 1 ? `${h.name} (${h.code})` : h.name,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  labelCache.set(heads, labelled);
  return labelled;
}

const labelCache = new WeakMap<
  object,
  { head: HeadOptionBase; label: string }[]
>();

export function sortByLabel<O extends { label: string }>(options: O[]): O[] {
  return [...options].sort((a, b) => a.label.localeCompare(b.label));
}
