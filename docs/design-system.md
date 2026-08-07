# Ledgerly design system

Premium-fintech shell (Stripe/Linear/Mercury register) on Tailwind v4.
Everything routes through semantic tokens in `src/app/globals.css` — a
component never hard-codes a hex.

## Tokens

| Token | Light | Dark | Used for |
|---|---|---|---|
| `canvas` | `#F8FAFC` | `#020617` | page background |
| `surface` | `#FFFFFF` | `#0F172A` | cards, sidebar, header |
| `surface-2` | `#F1F5F9` | `#1E293B` | hovers, wells, tracks |
| `ink` / `ink-2` / `ink-3` | `#0F172A` / `#475569` / `#94A3B8` | `#F1F5F9` / `#94A3B8` / `#64748B` | text hierarchy |
| `line` / `line-2` | `#E5E7EB` / `#F1F5F9` | `#1E293B` / `#16223A` | borders / hairlines |
| `primary` | `#2563EB` | `#3B82F6` | actions, active nav, links |
| `success` / `warning` / `danger` | `#16A34A` / `#B45309` / `#DC2626` | lighter steps | status only — never chart series |
| `*-soft` | tinted fills | alpha tints | badge/icon backgrounds |

Charts use their own validated slots (`--chart-1..3`, `--chart-neg`) — blue,
teal, amber + rose for the negative pole. Both modes pass the dataviz
six-check validator (lightness band, chroma, CVD ΔE, normal-vision floor,
contrast); dark steps are re-picked, not auto-flipped. Status colors are
never used as series colors.

- **Type**: Inter (`next/font`), 13px UI base, 22px stat values, 24px page
  titles. Tabular numerals only in table columns.
- **Grid**: 8px rhythm (`gap-4`/`gap-6`, `p-5`/`p-6`).
- **Radius**: 12px controls (`rounded-xl`), 16px cards (`rounded-2xl`).
- **Shadows**: `--shadow-card` (resting), `--shadow-pop` (hover/popover) —
  soft, two-layer, never heavy borders.
- **Motion**: 200ms color/transform transitions; `animate-fade-up` on page
  mount; `animate-shimmer` skeletons; all gated by `prefers-reduced-motion`.

## Dark mode

`html.dark` class, set pre-paint by an inline script (localStorage
`ledgerly-theme`, falling back to the OS), toggled in the header. New code
uses tokens and just works. Legacy screens that still hard-code zinc/amber
utilities are covered by the **compat bridge** at the bottom of
`globals.css` — delete entries as screens migrate to tokens.

## Component hierarchy

```
RootLayout                     Inter, theme-init script
└─ (app)/layout.tsx            auth + entities + server-filtered nav
   └─ Shell (client)           src/components/shell/shell.tsx
      ├─ Sidebar               logo · search (⌘K, filters nav) · grouped nav
      │                        (icons, active pill) · collapse (persisted)
      │                        <lg: overlay drawer via header hamburger
      ├─ Header (sticky, blur) breadcrumbs · entity switcher · notifications
      │                        (admin dues) · theme toggle · profile menu
      └─ <main>                max-w 1400px, page content
         └─ Overview page      src/app/(app)/page.tsx
            ├─ Alerts          funding shortfall, overdrawn accounts
            ├─ KPI row         StatCard ×6–8 (permission-gated)
            ├─ Analytics       DivergingBars (cash flow) · PairedBars
            │                  (income/expense, GST) · TrendLine (revenue)
            │                  · CategoryBars (expenses) — all with
            │                  tooltips, legends, sr-only tables
            ├─ Pending tasks   list card, overdue/open badges
            ├─ Quick actions   icon cards ×6
            └─ Recent activity avatar timeline + status badges
```

Kit (`src/components/`): `ui.tsx` — Card, CardHeader, Badge, `buttonClass()`,
StatCard (label · value · signed Δ vs named period · sparkline), EmptyState,
Skeleton, Avatar. `data-table.tsx` — DataTable (sticky header, sort, filter,
pagination, status chips via `"tone:Label"` cells, row hover) with
serializable column defs so RSC pages can use it directly. `charts.tsx` —
the SVG chart kit (no chart library): bars ≤24px with 4px rounded data-ends
and 2px surface gaps, 2px lines with 10% area wash, ringed ≥8px markers,
hairline grids.

## Nav registry & zero-trust

`src/components/shell/nav.ts` groups all 22 modules (Banking / Accounting /
Insights / Organisation) and filters by permission **on the server** — a
hidden destination never reaches the HTML or RSC payload (verify-phase1
asserts this). The filter stays cosmetic: every page and action re-checks
permissions server-side.

## Responsive

| Breakpoint | Layout |
|---|---|
| `<lg` (mobile/tablet) | sidebar → hamburger drawer; breadcrumbs hide `<md`; switcher shows code only `<sm`; KPI 1-col → 2-col at `sm` |
| `lg–xl` | fixed sidebar 264px (collapsible to 72px icon rail, persisted); charts 2-up |
| `≥xl` | KPI 3-up; analytics 2/3 + 1/3 rows; quick actions 6-up; content capped at 1400px |

Wide tables scroll inside their card (`overflow-auto` + sticky header) —
the page never scrolls horizontally.

## Forms

Inputs: `rounded-xl border-line bg-surface`, focus ring in primary, labels
above (13px medium) — floating labels were considered and rejected: they
fight browser autofill and the dense filter rows accountants live in.
Validation stays server-side (zod in actions) with inline error text in
`danger`; multi-step flows follow the statement-upload wizard pattern
(upload → detect → confirm), one clear primary action per step.
