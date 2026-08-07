import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'

// The base kit (docs/design-system.md). Server-safe: no state, no handlers —
// interactive pieces (DataTable, charts, shell) live in their own client files.

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

/* ----------------------------------- Card ---------------------------------- */

export function Card(props: {
  className?: string
  children: React.ReactNode
  /** Lift + border-highlight on hover — for cards that are links. */
  interactive?: boolean
}) {
  return (
    <div
      className={cx(
        'rounded-2xl border border-line bg-surface shadow-card',
        props.interactive &&
          'transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-pop',
        props.className,
      )}
    >
      {props.children}
    </div>
  )
}

export function CardHeader(props: {
  title: string
  hint?: string
  action?: { label: string; href: string }
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-baseline gap-3 px-5 pt-4 pb-1 sm:px-6">
      <div>
        <h2 className="text-sm font-semibold text-ink">{props.title}</h2>
        {props.hint && <p className="mt-0.5 text-xs text-ink-3">{props.hint}</p>}
      </div>
      {props.action && (
        <Link
          href={props.action.href}
          className="ml-auto whitespace-nowrap text-xs font-medium text-primary hover:underline"
        >
          {props.action.label} →
        </Link>
      )}
      {props.children}
    </div>
  )
}

/* ---------------------------------- Badge ----------------------------------- */

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger'

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  primary: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
}

export function Badge(props: { tone?: BadgeTone; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        BADGE_TONES[props.tone ?? 'neutral'],
        props.className,
      )}
    >
      {props.children}
    </span>
  )
}

/* --------------------------------- Buttons ----------------------------------
   Exported as class builders, not components: half the app's "buttons" are
   <Link>s or live inside <form action={…}>, and a class string composes with
   all of them. */

export function buttonClass(variant: 'primary' | 'secondary' | 'ghost' | 'danger' = 'primary') {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ' +
    'disabled:pointer-events-none disabled:opacity-50 px-4 py-2'
  switch (variant) {
    case 'primary':
      return cx(base, 'bg-primary text-white shadow-card hover:bg-primary-strong')
    case 'secondary':
      return cx(base, 'border border-line bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink')
    case 'ghost':
      return cx(base, 'text-ink-2 hover:bg-surface-2 hover:text-ink')
    case 'danger':
      return cx(base, 'bg-danger text-white hover:opacity-90')
  }
}

/* --------------------------------- StatCard ---------------------------------
   Contract per the dataviz stat-tile spec: label · value · optional signed
   delta vs a named period · optional 12-point sparkline. Delta color =
   direction × whether up is good. */

export function StatCard(props: {
  label: string
  value: string
  icon: LucideIcon
  iconClass: string // e.g. "text-primary bg-primary-soft"
  deltaPct?: number | null
  deltaBasis?: string // "vs 30 days ago"
  upIsGood?: boolean
  hint?: string
  href?: string
  sparkline?: number[]
}) {
  const Icon = props.icon
  const delta = props.deltaPct
  const up = delta != null && delta > 0
  const flat = delta != null && delta === 0
  const good = delta != null && (props.upIsGood ?? true) === up
  const body = (
    <Card interactive={Boolean(props.href)} className="h-full">
      <div className="flex h-full flex-col gap-3 p-5">
        <div className="flex items-center gap-3">
          <span className={cx('grid size-9 place-items-center rounded-xl', props.iconClass)}>
            <Icon className="size-[18px]" aria-hidden />
          </span>
          <p className="text-[13px] font-medium text-ink-2">{props.label}</p>
        </div>
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[22px] font-semibold leading-7 tracking-tight text-ink">
              {props.value}
            </p>
            {delta != null ? (
              <p className="mt-1 flex items-center gap-1 text-xs">
                <span
                  className={cx(
                    'inline-flex items-center gap-0.5 font-medium',
                    flat ? 'text-ink-3' : good ? 'text-success' : 'text-danger',
                  )}
                >
                  {flat ? (
                    <Minus className="size-3" aria-hidden />
                  ) : up ? (
                    <ArrowUpRight className="size-3" aria-hidden />
                  ) : (
                    <ArrowDownRight className="size-3" aria-hidden />
                  )}
                  {Math.abs(delta).toFixed(1)}%
                </span>
                {props.deltaBasis && <span className="text-ink-3">{props.deltaBasis}</span>}
              </p>
            ) : (
              props.hint && <p className="mt-1 text-xs text-ink-3">{props.hint}</p>
            )}
          </div>
          {props.sparkline && props.sparkline.some((v) => v !== 0) && (
            <Sparkline points={props.sparkline} />
          )}
        </div>
      </div>
    </Card>
  )
  return props.href ? (
    <Link href={props.href} className="block h-full rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
      {body}
    </Link>
  ) : (
    body
  )
}

/** 12-point trend in the de-emphasis hue; the current period carries the accent. */
function Sparkline({ points }: { points: number[] }) {
  const w = 96
  const h = 32
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const step = w / (points.length - 1 || 1)
  const x = (i: number) => +(i * step).toFixed(1)
  const y = (v: number) => +(h - 4 - ((v - min) / span) * (h - 8)).toFixed(1)
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join('')
  const last = points.length - 1
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="shrink-0">
      <path d={d} fill="none" stroke="var(--chart-mute)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(last)} cy={y(points[last])} r="4" fill="var(--chart-1)" stroke="var(--surface)" strokeWidth="2" />
    </svg>
  )
}

/* -------------------------------- EmptyState -------------------------------- */

export function EmptyState(props: {
  icon: LucideIcon
  title: string
  body?: string
  action?: { label: string; href: string }
  className?: string
}) {
  const Icon = props.icon
  return (
    <div className={cx('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', props.className)}>
      <span className="grid size-11 place-items-center rounded-2xl bg-surface-2 text-ink-3">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="text-sm font-medium text-ink">{props.title}</p>
      {props.body && <p className="max-w-xs text-xs leading-5 text-ink-3">{props.body}</p>}
      {props.action && (
        <Link href={props.action.href} className={cx(buttonClass('secondary'), 'mt-2')}>
          {props.action.label}
        </Link>
      )}
    </div>
  )
}

/* --------------------------------- Skeleton ---------------------------------
   For loading.tsx files and Suspense fallbacks. */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx(
        'animate-shimmer rounded-lg bg-[linear-gradient(90deg,var(--surface-2)_25%,var(--line-2)_50%,var(--surface-2)_75%)] bg-[length:200%_100%]',
        className,
      )}
      aria-hidden
    />
  )
}

/* ------------------------------ Avatar (initials) ---------------------------- */

const AVATAR_HUES = [
  'bg-primary-soft text-primary',
  'bg-success-soft text-success',
  'bg-warning-soft text-warning',
  'bg-surface-2 text-ink-2',
]

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return (
    <span
      className={cx(
        'grid shrink-0 place-items-center rounded-full font-semibold',
        size === 'sm' ? 'size-7 text-[10px]' : 'size-9 text-xs',
        AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length],
      )}
      aria-hidden
    >
      {initials || '•'}
    </span>
  )
}
