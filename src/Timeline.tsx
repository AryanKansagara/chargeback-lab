import { useMemo, useState, type CSSProperties } from 'react'
import type { Allocation, Cell } from './engine/allocate.ts'
import { HOUR } from './engine/csv.ts'
import { UNASSIGNED, UNMAPPED } from './engine/types.ts'
import type { WarehouseInfo } from './engine/types.ts'
import { creditsPerHour } from './engine/insights.ts'
import { fmtCr } from './ui.tsx'

/**
 * Warehouse-hours timeline. Each column is one metered hour: solid blocks are query credits by team,
 * striped blocks are idle. With `claimed` off, idle is drawn as one grey "no team" block, which is what
 * QUERY_ATTRIBUTION_HISTORY alone gives you. With it on, the same idle is drawn in the team colours the engine chose.
 */
export function Timeline({ alloc, start, hours, color, teams, claimed, infos, compact }: {
  alloc: Allocation
  start: number
  hours: number
  color(team: string): string
  teams: string[]
  claimed: boolean
  infos?: WarehouseInfo[]
  compact?: boolean
}) {
  const [tip, setTip] = useState<{ cell: Cell; x: number; y: number } | null>(null)
  const lanes = useMemo(() => {
    const byWh = new Map<string, Map<number, Cell>>()
    for (const c of alloc.cells) {
      if (c.hour < start || c.hour >= start + hours * HOUR) continue
      const m = byWh.get(c.warehouse) ?? new Map()
      m.set(c.hour, c)
      byWh.set(c.warehouse, m)
    }
    return alloc.warehouses.filter(w => byWh.has(w.name)).map(w => {
      const info = infos?.find(i => i.name === w.name)
      const cells = byWh.get(w.name)!
      let max = info ? creditsPerHour(info.size) : NaN
      if (!Number.isFinite(max)) max = Math.max(...[...cells.values()].map(c => Math.max(c.metered, sumv(c.query)))) || 1
      return { name: w.name, info, cells, max }
    })
  }, [alloc, start, hours, infos])

  const cols = Array.from({ length: hours }, (_, i) => start + i * HOUR)
  const tickEvery = hours <= 24 ? 3 : hours <= 72 ? 12 : 24
  const order = [...teams.filter(t => t !== UNASSIGNED && t !== UNMAPPED), UNMAPPED]

  return (
    <div className={`timeline${compact ? ' compact' : ''}`} onMouseLeave={() => setTip(null)}>
      {lanes.map(l => (
        <div className="tl-lane" key={l.name}>
          <div className="tl-label">
            <strong>{l.name}</strong>
            {l.info && <span className={`tl-meta${(l.info.autoSuspend ?? 0) === 0 || (l.info.autoSuspend ?? 0) >= 1800 ? ' warn' : ''}`}>{l.info.size} · {l.info.autoSuspend ? `suspend ${l.info.autoSuspend >= 60 ? `${l.info.autoSuspend / 60}m` : `${l.info.autoSuspend}s`}` : 'never suspends'}</span>}
          </div>
          <div className="tl-track" style={{ '--cols': hours } as CSSProperties} role="img" aria-label={laneLabel(l.name, l.cells, claimed)}>
            {cols.map((h, i) => {
              const c = l.cells.get(h)
              if (!c) return <div className="tl-col" key={h} />
              const idleTotal = sumv(c.idle)
              const unassigned = c.idle[UNASSIGNED] ?? 0
              const pct = (v: number) => `${Math.min(100, (v / l.max) * 100)}%`
              const delay = { transitionDelay: `${(i % 48) * 14}ms` }
              return (
                <div className="tl-col" key={h} onMouseEnter={e => { const r = e.currentTarget.getBoundingClientRect(); setTip({ cell: c, x: r.left + r.width / 2, y: r.top }) }} onFocus={e => { const r = e.currentTarget.getBoundingClientRect(); setTip({ cell: c, x: r.left + r.width / 2, y: r.top }) }} tabIndex={compact ? -1 : 0}>
                  <div className="tl-stack">
                    {order.map(t => c.query[t] ? <span key={'q' + t} className="seg q" style={{ height: pct(c.query[t]), background: color(t) }} /> : null)}
                    {order.map(t => (c.idle[t] ?? 0) > 0 ? <span key={'i' + t} className="seg i" style={{ height: claimed ? pct(c.idle[t]) : '0%', background: color(t), ...delay }} /> : null)}
                    <span className="seg raw" style={{ height: pct(claimed ? unassigned : idleTotal), ...delay }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      <div className="tl-axis" style={{ '--cols': hours } as CSSProperties} aria-hidden="true">
        <span className="tl-label" />
        <div className="tl-ticks">
          {cols.map((h, i) => <span key={h}>{i % tickEvery === 0 ? tickLabel(h, hours) : ''}</span>)}
        </div>
      </div>
      {tip && <CellTip {...tip} color={color} claimed={claimed} />}
    </div>
  )
}

const sumv = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)

function tickLabel(h: number, hours: number) {
  const d = new Date(h)
  if (hours > 72) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return `${String(d.getUTCHours()).padStart(2, '0')}:00`
}

function laneLabel(name: string, cells: Map<number, Cell>, claimed: boolean) {
  let q = 0, i = 0
  for (const c of cells.values()) { q += sumv(c.query); i += sumv(c.idle) }
  return `${name}: ${fmtCr(q)} query credits and ${fmtCr(i)} idle credits${claimed ? ', idle assigned to teams' : ', idle not assigned'}`
}

const HOW: Record<Cell['how'], string> = {
  split: 'Idle split among the teams that ran queries this hour',
  carried: 'No queries this hour: idle follows the last active hour (auto-suspend tail)',
  owner: 'Idle charged to the warehouse owner',
  unassigned: 'Nobody to charge: set a warehouse owner',
  none: 'No idle this hour',
}

function CellTip({ cell, x, y, color, claimed }: { cell: Cell; x: number; y: number; color(t: string): string; claimed: boolean }) {
  const idle = sumv(cell.idle)
  const d = new Date(cell.hour)
  const style: CSSProperties = { left: Math.max(150, Math.min(innerWidth - 150, x)), top: y - 10 }
  return (
    <div className="tip" style={style} role="tooltip">
      <div className="tip-head">{cell.warehouse} · {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} {String(d.getUTCHours()).padStart(2, '0')}:00 UTC</div>
      <div className="tip-row"><span>Metered</span><b>{fmtCr(cell.metered, 2)} cr</b></div>
      {Object.entries(cell.query).sort((a, b) => b[1] - a[1]).map(([t, v]) => <div className="tip-row" key={t}><span><i className="dot" style={{ background: color(t) }} />{t} queries</span><b>{fmtCr(v, 2)}</b></div>)}
      {idle > 0 && (claimed
        ? Object.entries(cell.idle).sort((a, b) => b[1] - a[1]).map(([t, v]) => <div className="tip-row" key={t}><span><i className="dot hatch" style={{ background: color(t) }} />{t} idle</span><b>{fmtCr(v, 2)}</b></div>)
        : <div className="tip-row"><span><i className="dot hatch" style={{ background: 'var(--unassigned)' }} />Idle, no team</span><b>{fmtCr(idle, 2)}</b></div>)}
      {claimed && idle > 0 && <div className="tip-note">{HOW[cell.how]}</div>}
    </div>
  )
}
