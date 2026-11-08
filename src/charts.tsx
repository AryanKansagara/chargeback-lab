import { useState } from 'react'
import { fmtUsd } from './ui.tsx'

/** Cumulative spend against a budget line, with the month-end forecast dashed. */
export function BurnChart({ burn, budget, forecast, daysInMonth, color, label }: { burn: (number | null)[]; budget: number; forecast: number; daysInMonth: number; color: string; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 320, H = 140, P = { l: 6, r: 6, t: 12, b: 18 }
  const last = burn.findLastIndex(v => v !== null)
  const max = Math.max(budget, forecast, ...burn.map(v => v ?? 0), 1) * 1.08
  const x = (i: number) => P.l + (i / (daysInMonth - 1)) * (W - P.l - P.r)
  const y = (v: number) => H - P.b - (v / max) * (H - P.t - P.b)
  const pts = burn.slice(0, last + 1).map((v, i) => `${x(i)},${y(v ?? 0)}`).join(' ')
  const area = last >= 0 ? `${x(0)},${y(0)} ${pts} ${x(last)},${y(0)}` : ''
  const hv = hover !== null && hover <= last ? burn[hover] : null
  return (
    <figure className="burn">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: spent ${fmtUsd(burn[last] ?? 0)} of ${budget ? fmtUsd(budget) : 'no budget'}, forecast ${fmtUsd(forecast)}`}
        onMouseMove={e => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.round(((e.clientX - r.left) / r.width * W - P.l) / (W - P.l - P.r) * (daysInMonth - 1)); setHover(Math.max(0, Math.min(daysInMonth - 1, i))) }}
        onMouseLeave={() => setHover(null)}>
        <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} className="axis" />
        {budget > 0 && <><line x1={P.l} x2={W - P.r} y1={y(budget)} y2={y(budget)} className="budget-line" /><text x={W - P.r} y={y(budget) - 4} textAnchor="end" className="chart-label">budget {fmtUsd(budget)}</text></>}
        {area && <polygon points={area} fill={color} opacity="0.12" />}
        {pts && <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {last >= 0 && last < daysInMonth - 1 && <line x1={x(last)} y1={y(burn[last] ?? 0)} x2={x(daysInMonth - 1)} y2={y(forecast)} stroke={color} strokeWidth="2" strokeDasharray="4 4" />}
        {last >= 0 && <circle cx={x(last)} cy={y(burn[last] ?? 0)} r="4" fill={color} stroke="var(--surface)" strokeWidth="2" />}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={y(0)} className="crosshair" />}
        <text x={P.l} y={H - 4} className="chart-label">1</text>
        <text x={W - P.r} y={H - 4} textAnchor="end" className="chart-label">{daysInMonth}</text>
      </svg>
      {hover !== null && <figcaption className="burn-tip">Day {hover + 1}: {hv !== null ? fmtUsd(hv) : `forecast ${fmtUsd(burn[last] !== null && last >= 0 ? (burn[last] ?? 0) + (forecast - (burn[last] ?? 0)) * (hover - last) / Math.max(1, daysInMonth - 1 - last) : 0)}`}</figcaption>}
    </figure>
  )
}

/** Daily bars with one day highlighted. */
export function DayBars({ days, values, mark, color, label, fmt, fill }: { days: string[]; values: number[]; mark?: string; color: string; label: string; fmt(v: number): string; fill?: boolean }) {
  const max = Math.max(...values, 1e-9)
  return (
    <div className="daybars" role="img" aria-label={label}>
      {values.map((v, i) => (
        <span key={days[i]} title={`${days[i]}: ${fmt(v)}`} className={days[i] === mark ? 'mark' : ''} style={{ height: `${Math.max(2, (v / max) * 100)}%`, background: fill || days[i] === mark ? color : undefined }} />
      ))}
    </div>
  )
}

/** One horizontal stacked bar; segments separated by a surface gap. */
export function StackBar({ parts, total, label }: { parts: { key: string; value: number; color: string; hatch?: boolean; title: string }[]; total?: number; label: string }) {
  const t = total ?? parts.reduce((a, p) => a + p.value, 0)
  return (
    <div className="stackbar" role="img" aria-label={label}>
      {parts.filter(p => p.value > 0).map(p => <span key={p.key} title={p.title} className={p.hatch ? 'hatch' : ''} style={{ width: `${(p.value / (t || 1)) * 100}%`, background: p.color }} />)}
    </div>
  )
}

/** Diverging bars around zero for month-over-month change. */
export function DeltaBar({ value, max }: { value: number; max: number }) {
  const w = max ? Math.min(50, (Math.abs(value) / max) * 50) : 0
  return (
    <div className="deltabar" aria-hidden="true">
      <span className={value >= 0 ? 'up' : 'down'} style={value >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
    </div>
  )
}
