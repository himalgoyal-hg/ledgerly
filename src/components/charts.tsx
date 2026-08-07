'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// useLayoutEffect measures the container; on the server it has nothing to
// measure, so fall back to useEffect to keep SSR quiet.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

// SVG chart kit, to the dataviz mark specs: bars ≤24px with a 4px rounded
// data-end (square at the baseline) and 2px surface gaps; 2px lines with a
// 10%-opacity area wash; ≥8px markers ringed in surface; hairline solid grid;
// a legend whenever two series share a plot; selective direct labels; hover
// tooltips with hit targets larger than the marks. Colors come from the
// --chart-* tokens (validated for both modes); text wears text tokens only.
// Every figure carries an sr-only table so the data is never chart-gated.

const BAR_MAX = 24
const GAP = 2

/* --------------------------------- shared ---------------------------------- */

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [w, setW] = useState(0)
  useIsoLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

export function inrCompact(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (abs >= 1e7) return `${sign}₹${trim(abs / 1e7)}Cr`
  if (abs >= 1e5) return `${sign}₹${trim(abs / 1e5)}L`
  if (abs >= 1e3) return `${sign}₹${trim(abs / 1e3)}K`
  return `${sign}₹${trim(abs)}`
}
const trim = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, ''))

const inrFull = (n: number) =>
  `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

/** Clean axis ticks: 0 always included, steps snapped to 1/2/2.5/5 × 10^k. */
function ticks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min)
  const hi = Math.max(0, max)
  if (lo === hi) return [0, 1]
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.floor(lo / step) * step; v <= hi + step / 2; v += step) out.push(v)
  return out
}

/** Bar with a 4px-rounded data-end and a square baseline end. */
function barPath(x: number, yTop: number, w: number, h: number, up: boolean): string {
  const r = Math.min(4, w / 2, h)
  if (h <= 0) return ''
  return up
    ? `M${x},${yTop + h} v${-(h - r)} q0,${-r} ${r},${-r} h${w - 2 * r} q${r},0 ${r},${r} v${h - r} z`
    : `M${x},${yTop} v${h - r} q0,${r} ${r},${r} h${w - 2 * r} q${r},0 ${r},${-r} v${-(h - r)} z`
}

function Tip(props: { x: number; y: number; w: number; children: React.ReactNode }) {
  const left = Math.max(8, Math.min(props.x, props.w - 148))
  return (
    <div
      className="pointer-events-none absolute z-10 w-[140px] rounded-xl border border-line bg-surface p-2.5 text-xs shadow-pop"
      style={{ left, top: Math.max(0, props.y - 8) }}
      role="status"
    >
      {props.children}
    </div>
  )
}

function LegendRow(props: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-4 px-1 pb-1">
      {props.items.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1.5 text-xs text-ink-2">
          <span className="size-2.5 rounded-full" style={{ background: s.color }} aria-hidden />
          {s.label}
        </span>
      ))}
    </div>
  )
}

function SrTable(props: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="sr-only">
      <caption>{props.caption}</caption>
      <thead>
        <tr>
          {props.head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const AXIS = { left: 44, right: 12, top: 8, bottom: 22 }

function Frame(props: {
  w: number
  h: number
  yTicks: number[]
  yOf: (v: number) => number
  children: React.ReactNode
}) {
  return (
    <>
      {props.yTicks.map((t) => (
        <g key={t}>
          <line
            x1={AXIS.left}
            x2={props.w - AXIS.right}
            y1={props.yOf(t)}
            y2={props.yOf(t)}
            stroke={t === 0 ? 'var(--chart-mute)' : 'var(--chart-grid)'}
            strokeWidth="1"
          />
          <text
            x={AXIS.left - 6}
            y={props.yOf(t) + 3}
            textAnchor="end"
            className="fill-[var(--ink-3)] text-[10px]"
          >
            {inrCompact(t)}
          </text>
        </g>
      ))}
      {props.children}
    </>
  )
}

/* ------------------------------- PairedBars ---------------------------------
   Two series, grouped columns — Income vs Expense, GST output vs ITC. */

export function PairedBars(props: {
  points: { label: string; a: number; b: number }[]
  seriesA: string
  seriesB: string
  colorA?: string
  colorB?: string
  height?: number
}) {
  const [ref, w] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const h = props.height ?? 216
  const colorA = props.colorA ?? 'var(--chart-1)'
  const colorB = props.colorB ?? 'var(--chart-3)'
  const values = props.points.flatMap((p) => [p.a, p.b])
  const yTicks = ticks(Math.min(...values, 0), Math.max(...values, 0))
  const lo = yTicks[0]
  const hi = yTicks[yTicks.length - 1]
  const plotH = h - AXIS.top - AXIS.bottom
  const yOf = (v: number) => AXIS.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH
  const plotW = Math.max(0, w - AXIS.left - AXIS.right)
  const band = plotW / (props.points.length || 1)
  const bar = Math.min(BAR_MAX, Math.max(3, (band - GAP * 3) / 2))

  return (
    <div>
      <LegendRow items={[{ label: props.seriesA, color: colorA }, { label: props.seriesB, color: colorB }]} />
      <div ref={ref} className="relative">
        {w > 0 && (
          <svg width={w} height={h} role="img" aria-label={`${props.seriesA} vs ${props.seriesB} by month`}>
            <Frame w={w} h={h} yTicks={yTicks} yOf={yOf}>
              {props.points.map((p, i) => {
                const cx = AXIS.left + band * i + band / 2
                return (
                  <g key={p.label + i}>
                    {hover === i && (
                      <rect x={AXIS.left + band * i} y={AXIS.top} width={band} height={plotH} fill="var(--surface-2)" opacity="0.6" />
                    )}
                    <path d={barPath(cx - bar - GAP / 2, yOf(p.a), bar, yOf(lo < 0 ? 0 : lo) - yOf(p.a), true)} fill={colorA} />
                    <path d={barPath(cx + GAP / 2, yOf(p.b), bar, yOf(lo < 0 ? 0 : lo) - yOf(p.b), true)} fill={colorB} />
                    <text x={cx} y={h - 7} textAnchor="middle" className="fill-[var(--ink-3)] text-[10px]">
                      {p.label}
                    </text>
                    <rect
                      x={AXIS.left + band * i}
                      y={0}
                      width={band}
                      height={h}
                      fill="transparent"
                      onMouseEnter={() => setHover(i)}
                      onMouseLeave={() => setHover(null)}
                    />
                  </g>
                )
              })}
            </Frame>
          </svg>
        )}
        {hover != null && props.points[hover] && (
          <Tip x={AXIS.left + band * hover + band / 2 - 70} y={AXIS.top} w={w}>
            <p className="font-medium text-ink">{props.points[hover].label}</p>
            <p className="mt-1 flex items-center justify-between gap-2 text-ink-2">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: colorA }} aria-hidden />
                {props.seriesA}
              </span>
              <span className="font-medium text-ink">{inrFull(props.points[hover].a)}</span>
            </p>
            <p className="mt-0.5 flex items-center justify-between gap-2 text-ink-2">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: colorB }} aria-hidden />
                {props.seriesB}
              </span>
              <span className="font-medium text-ink">{inrFull(props.points[hover].b)}</span>
            </p>
          </Tip>
        )}
      </div>
      <SrTable
        caption={`${props.seriesA} vs ${props.seriesB} by month`}
        head={['Month', props.seriesA, props.seriesB]}
        rows={props.points.map((p) => [p.label, inrFull(p.a), inrFull(p.b)])}
      />
    </div>
  )
}

/* ------------------------------ DivergingBars -------------------------------
   Net flow above/below zero — the diverging pair, not status colors. */

export function DivergingBars(props: { points: { label: string; value: number }[]; height?: number }) {
  const [ref, w] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const h = props.height ?? 216
  const values = props.points.map((p) => p.value)
  const yTicks = ticks(Math.min(...values, 0), Math.max(...values, 0))
  const lo = yTicks[0]
  const hi = yTicks[yTicks.length - 1]
  const plotH = h - AXIS.top - AXIS.bottom
  const yOf = (v: number) => AXIS.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH
  const plotW = Math.max(0, w - AXIS.left - AXIS.right)
  const band = plotW / (props.points.length || 1)
  const bar = Math.min(BAR_MAX, Math.max(3, band - GAP * 2))

  return (
    <div>
      <LegendRow
        items={[
          { label: 'Inflow', color: 'var(--chart-1)' },
          { label: 'Outflow', color: 'var(--chart-neg)' },
        ]}
      />
      <div ref={ref} className="relative">
        {w > 0 && (
          <svg width={w} height={h} role="img" aria-label="Net cash flow by month">
            <Frame w={w} h={h} yTicks={yTicks} yOf={yOf}>
              {props.points.map((p, i) => {
                const x = AXIS.left + band * i + (band - bar) / 2
                const up = p.value >= 0
                const y0 = yOf(0)
                const yV = yOf(p.value)
                return (
                  <g key={p.label + i}>
                    {hover === i && (
                      <rect x={AXIS.left + band * i} y={AXIS.top} width={band} height={plotH} fill="var(--surface-2)" opacity="0.6" />
                    )}
                    <path
                      d={up ? barPath(x, yV, bar, y0 - yV, true) : barPath(x, y0, bar, yV - y0, false)}
                      fill={up ? 'var(--chart-1)' : 'var(--chart-neg)'}
                    />
                    <text x={AXIS.left + band * i + band / 2} y={h - 7} textAnchor="middle" className="fill-[var(--ink-3)] text-[10px]">
                      {p.label}
                    </text>
                    <rect
                      x={AXIS.left + band * i}
                      y={0}
                      width={band}
                      height={h}
                      fill="transparent"
                      onMouseEnter={() => setHover(i)}
                      onMouseLeave={() => setHover(null)}
                    />
                  </g>
                )
              })}
            </Frame>
          </svg>
        )}
        {hover != null && props.points[hover] && (
          <Tip x={AXIS.left + band * hover + band / 2 - 70} y={AXIS.top} w={w}>
            <p className="font-medium text-ink">{props.points[hover].label}</p>
            <p className="mt-1 flex items-center justify-between gap-2 text-ink-2">
              <span>Net {props.points[hover].value >= 0 ? 'inflow' : 'outflow'}</span>
              <span className="font-medium text-ink">{inrFull(props.points[hover].value)}</span>
            </p>
          </Tip>
        )}
      </div>
      <SrTable
        caption="Net cash flow by month"
        head={['Month', 'Net flow']}
        rows={props.points.map((p) => [p.label, inrFull(p.value)])}
      />
    </div>
  )
}

/* -------------------------------- TrendLine ---------------------------------
   Single series: no legend box (the card title names it); the endpoint gets
   the direct label; crosshair + tooltip on hover. */

export function TrendLine(props: { points: { label: string; value: number }[]; height?: number }) {
  const [ref, w] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const h = props.height ?? 216
  const values = props.points.map((p) => p.value)
  const yTicks = ticks(Math.min(...values, 0), Math.max(...values, 0))
  const lo = yTicks[0]
  const hi = yTicks[yTicks.length - 1]
  const plotH = h - AXIS.top - AXIS.bottom
  const yOf = (v: number) => AXIS.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH
  const plotW = Math.max(0, w - AXIS.left - AXIS.right)
  const step = plotW / Math.max(1, props.points.length - 1)
  const xOf = (i: number) => AXIS.left + step * i
  const line = props.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i)},${yOf(p.value)}`).join('')
  const area = `${line} L${xOf(props.points.length - 1)},${yOf(Math.max(lo, 0))} L${xOf(0)},${yOf(Math.max(lo, 0))} z`
  const last = props.points.length - 1

  return (
    <div>
      <div ref={ref} className="relative">
        {w > 0 && props.points.length > 1 && (
          <svg
            width={w}
            height={h}
            role="img"
            aria-label="Monthly revenue trend"
            onMouseMove={(e) => {
              const x = e.clientX - e.currentTarget.getBoundingClientRect().left
              setHover(Math.max(0, Math.min(last, Math.round((x - AXIS.left) / step))))
            }}
            onMouseLeave={() => setHover(null)}
          >
            <Frame w={w} h={h} yTicks={yTicks} yOf={yOf}>
              <path d={area} fill="var(--chart-1)" opacity="0.1" />
              <path d={line} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              {hover != null && (
                <line x1={xOf(hover)} x2={xOf(hover)} y1={AXIS.top} y2={AXIS.top + plotH} stroke="var(--chart-mute)" strokeWidth="1" />
              )}
              <circle
                cx={xOf(hover ?? last)}
                cy={yOf(props.points[hover ?? last].value)}
                r="4"
                fill="var(--chart-1)"
                stroke="var(--surface)"
                strokeWidth="2"
              />
              {hover == null && (
                <text
                  x={Math.min(xOf(last) + 6, w - 4)}
                  y={yOf(props.points[last].value) - 8}
                  textAnchor="end"
                  className="fill-[var(--ink-2)] text-[10px] font-medium"
                >
                  {inrCompact(props.points[last].value)}
                </text>
              )}
              {props.points.map((p, i) =>
                i % Math.ceil(props.points.length / 6) === 0 || i === last ? (
                  <text key={i} x={xOf(i)} y={h - 7} textAnchor="middle" className="fill-[var(--ink-3)] text-[10px]">
                    {p.label}
                  </text>
                ) : null,
              )}
            </Frame>
          </svg>
        )}
        {hover != null && props.points[hover] && (
          <Tip x={xOf(hover) - 70} y={AXIS.top} w={w}>
            <p className="font-medium text-ink">{props.points[hover].label}</p>
            <p className="mt-1 flex items-center justify-between gap-2 text-ink-2">
              <span>Revenue</span>
              <span className="font-medium text-ink">{inrFull(props.points[hover].value)}</span>
            </p>
          </Tip>
        )}
      </div>
      <SrTable
        caption="Monthly revenue"
        head={['Month', 'Revenue']}
        rows={props.points.map((p) => [p.label, inrFull(p.value)])}
      />
    </div>
  )
}

/* ------------------------------- CategoryBars -------------------------------
   Horizontal magnitude bars, sequential single-hue ramp: more is darker.
   "Other" wears the de-emphasis gray. Value at the tip, in ink. */

const BLUE_RAMP = ['#1e3a8a', '#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa', '#93c5fd']

export function CategoryBars(props: { slices: { name: string; amount: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...props.slices.map((s) => s.amount), 1)
  return (
    <div>
      <ul className="space-y-2.5">
        {props.slices.map((s, i) => {
          const other = s.name === 'Other'
          const color = other ? 'var(--chart-mute)' : BLUE_RAMP[Math.min(i, BLUE_RAMP.length - 1)]
          return (
            <li
              key={s.name}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className="group"
            >
              <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                <span className="truncate text-ink-2">{s.name}</span>
                <span className="font-medium tabular-nums text-ink">
                  {hover === i ? inrFull(s.amount) : inrCompact(s.amount)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${Math.max(2, (s.amount / max) * 100)}%`, background: color }}
                />
              </div>
            </li>
          )
        })}
      </ul>
      <SrTable
        caption="Expenses by category"
        head={['Category', 'Amount']}
        rows={props.slices.map((s) => [s.name, inrFull(s.amount)])}
      />
    </div>
  )
}
