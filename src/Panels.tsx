import { useMemo, useState } from 'react'
import { allocate, filterMonth, isPseudo } from './engine/allocate.ts'
import { ANOMALY_FLOOR, ANOMALY_RATIO, anomalies, budgets, compare, recommend, tagAdoption, TARGET_SUSPEND } from './engine/insights.ts'
import { BurnChart, DayBars, DeltaBar } from './charts.tsx'
import { METHODS } from './projectData.ts'
import type { Tab, TabProps } from './Project.tsx'
import { deleteSnapshotCloud } from './sync.ts'
import { Code, CopyButton, Empty, fmtCr, fmtDay, fmtMonth, fmtPct, fmtUsd, Link, signed, TeamDot, toast } from './ui.tsx'

export default function Panels(props: TabProps & { tab: Tab }) {
  switch (props.tab) {
    case 'optimize': return <Optimize {...props} />
    case 'budgets': return <Budgets {...props} />
    case 'anomalies': return <Anomalies {...props} />
    case 'history': return <History {...props} />
    default: return null
  }
}

// ---------- Optimize ----------

function Optimize({ project, sliced, alloc, color, month }: TabProps) {
  const recs = useMemo(() => recommend(alloc, sliced.warehouses), [alloc, sliced.warehouses])
  const tags = useMemo(() => tagAdoption(sliced, project.config), [sliced, project.config])
  const ranked = [...alloc.warehouses].sort((a, b) => b.idle - a.idle)
  const maxIdle = Math.max(...ranked.map(w => w.idle), 1)
  const price = alloc.price
  const total = recs.reduce((a, r) => a + r.monthlyUsd, 0)
  const allSql = recs.map(r => r.sql).join('\n')
  const days = alloc.days.filter(d => d.startsWith(month)).length

  return (
    <div className="tab-body">
      <div className="panel">
        <div className="panel-head"><h2>Idle waste ranking</h2><span className="muted small">{fmtMonth(month)}</span></div>
        <ol className="rank">
          {ranked.map((w, i) => {
            const info = sliced.warehouses.find(x => x.name === w.name)
            return (
              <li key={w.name}>
                <span className="rank-n">{i + 1}</span>
                <div className="rank-body">
                  <div className="row between wrap">
                    <strong className="mono">{w.name}</strong>
                    <span><b>{fmtUsd(w.idle * price)}</b> <span className="muted small">idle · {fmtCr(w.idle)} cr · {fmtPct(w.idlePct)} of metered</span></span>
                  </div>
                  <div className="rank-bar"><span style={{ width: `${(w.idle / maxIdle) * 100}%` }} /></div>
                  <div className="muted small">
                    {info ? `${info.size}, auto-suspend ${info.autoSuspend ? `${info.autoSuspend}s` : 'off'}` : 'Settings unknown'} · {w.idleOnlyHours} hours with no queries · {w.activeHours} active hours
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      </div>

      <div className="panel">
        <div className="panel-head wrap">
          <h2>Recommended changes</h2>
          {recs.length > 0 && <div className="row gap-sm"><span className="chip on-track">~{fmtUsd(total)} / month</span><CopyButton text={allSql} label="Copy all SQL" /></div>}
        </div>
        {!sliced.warehouses.length ? (
          <Empty title="Warehouse settings needed">
            <p className="muted">Recommendations need each warehouse&rsquo;s size and auto-suspend. Run this and import the result on the Data tab:</p>
            <Code code={`SHOW WAREHOUSES;\nSELECT "name", "size", "auto_suspend", "owner", "max_cluster_count"\nFROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));`} />
          </Empty>
        ) : recs.length === 0 ? <p className="muted">Nothing worth changing: idle is low or auto-suspend is already {TARGET_SUSPEND} seconds.</p> : (
          <div className="recs">
            {recs.map(r => (
              <article className="rec" key={r.sql}>
                <div className="row between wrap gap-sm">
                  <h3>{r.title}</h3>
                  <span className="rec-save"><b>{fmtUsd(r.monthlyUsd)}</b><small> / month est.</small></span>
                </div>
                <p>{r.why} This period: {fmtCr(r.savingsCredits)} cr ({fmtUsd(r.savingsUsd)}) over {days} days.</p>
                <Code code={r.sql} />
                <details>
                  <summary>Assumptions</summary>
                  <ul>{r.assumptions.map(a => <li key={a}>{a}</li>)}</ul>
                </details>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head wrap"><h2>Query-tag adoption</h2><span className="muted small">Share of query credits with a QUERY_TAG</span></div>
        <div className="tag-score">
          <div className="gauge" style={{ '--p': tags.score } as React.CSSProperties} role="img" aria-label={`Tag adoption ${fmtPct(tags.score)}`}>
            <span>{Math.round(tags.score * 100)}</span><small>/ 100</small>
          </div>
          <div>
            <p>{fmtCr(tags.taggedCredits)} of {fmtCr(tags.totalCredits)} query credits carry a tag. Tags make rules simple and survive warehouse consolidation; a default tag per service account is the fastest win.</p>
            <p className="muted small">A tag set in the session (dbt, Airflow and most BI tools can) overrides the user default, so this never fights a tool that already tags.</p>
          </div>
        </div>
        {tags.users.length > 0 && (
          <>
            <div className="row between wrap"><h3 className="h4">Untagged users, by credits</h3><CopyButton text={tags.users.map(u => u.sql).join('\n')} label="Copy all ALTER USER" /></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>User</th><th className="num">Untagged</th><th className="num">Of their spend</th><th>Suggested team</th><th>SQL</th></tr></thead>
                <tbody>
                  {tags.users.slice(0, 15).map(u => (
                    <tr key={u.user}>
                      <th scope="row" className="mono">{u.user}</th>
                      <td className="num">{fmtCr(u.untagged)} cr</td>
                      <td className="num">{fmtPct(u.share)}</td>
                      <td>{u.team === '<team>' ? <span className="muted">unknown</span> : <><TeamDot color={color(u.team)} />{u.team}</>}</td>
                      <td className="sql-cell"><code>{u.sql}</code><CopyButton text={u.sql} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------- Budgets ----------

function Budgets({ project, ds, months, color, setConfig }: TabProps) {
  const cfg = project.config
  const current = months[months.length - 1]
  const alloc = useMemo(() => allocate(filterMonth(ds, current), cfg), [ds, current, cfg])
  const list = useMemo(() => budgets(alloc, cfg, current), [alloc, cfg, current])
  const setBudget = (team: string, v: number) => {
    const b = { ...cfg.budgets }
    if (v > 0) b[team] = v
    else delete b[team]
    setConfig({ budgets: b })
  }
  const first = list[0]
  return (
    <div className="tab-body">
      <div className="panel">
        <div className="panel-head wrap">
          <h2>Budgets · {fmtMonth(current)}</h2>
          {first && <span className="muted small">Data through day {first.daysElapsed} of {first.daysInMonth}. Forecast = spend to date + average of the last 7 days for each remaining day.</span>}
        </div>
        <div className="budget-grid">
          {list.map(b => (
            <article key={b.team} className={`budget-card ${b.status}`}>
              <div className="row between">
                <h3><TeamDot color={color(b.team)} />{b.team}</h3>
                <span className={`chip ${b.status}`}>{b.status === 'no-budget' ? 'No budget' : b.status === 'over' ? 'Over budget' : b.status === 'at-risk' ? 'Will overrun' : 'On track'}</span>
              </div>
              <div className="budget-nums">
                <div><span>Spent</span><b>{fmtUsd(b.spent)}</b></div>
                <div><span>Month-end</span><b>{fmtUsd(b.forecast)}</b></div>
                <label><span>Budget</span><input type="number" min="0" step="100" value={b.budget || ''} placeholder="Set" onChange={e => setBudget(b.team, Number(e.target.value))} aria-label={`${b.team} monthly budget in dollars`} /></label>
              </div>
              <BurnChart burn={b.burn} budget={b.budget} forecast={b.forecast} daysInMonth={b.daysInMonth} color={color(b.team)} label={`${b.team} burn-down`} />
              {b.budget > 0 && <p className="small muted">{b.forecast > b.budget ? `Projected ${fmtUsd(b.forecast - b.budget)} over. At this pace the budget runs out around day ${Math.min(b.daysInMonth, Math.ceil(b.budget / Math.max(1e-9, b.forecast / b.daysInMonth)))}.` : `${fmtUsd(b.budget - b.forecast)} of headroom at month end.`}</p>}
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------- Anomalies ----------

function Anomalies({ project, sliced, alloc, month, color }: TabProps) {
  const list = useMemo(() => anomalies(sliced, project.config, alloc), [sliced, project.config, alloc])
  const [scope, setScope] = useState<'all' | 'team' | 'warehouse'>('all')
  const days = alloc.days.filter(d => d.startsWith(month))
  const shown = list.filter(a => scope === 'all' || a.scope === scope)
  const price = alloc.price
  return (
    <div className="tab-body">
      <div className="panel">
        <div className="panel-head wrap">
          <h2>Day-over-day spikes · {fmtMonth(month)}</h2>
          <div className="seg-control sm" role="radiogroup" aria-label="Scope">
            {(['all', 'team', 'warehouse'] as const).map(s => <button key={s} type="button" role="radio" aria-checked={scope === s} className={scope === s ? 'on' : ''} onClick={() => setScope(s)}>{s === 'all' ? 'All' : s === 'team' ? 'Teams' : 'Warehouses'}</button>)}
          </div>
        </div>
        <p className="muted small">A day is flagged when it is at least {ANOMALY_RATIO}&times; the median of the 7 days before it and at least {ANOMALY_FLOOR} credits above it. Drivers compare that day with the average of those 7 days.</p>
        {shown.length === 0 ? <Empty title="No spikes this month"><p className="muted">Spend stayed within {ANOMALY_RATIO}&times; of its recent median every day.</p></Empty> : (
          <ol className="anoms">
            {shown.slice(0, 30).map((a, i) => {
              const series = a.scope === 'team' ? alloc.teams.find(t => t.team === a.name)?.byDay ?? {} : alloc.warehouses.find(w => w.name === a.name)?.byDay ?? {}
              const c = a.scope === 'team' ? color(a.name) : 'var(--accent)'
              return (
                <li key={i} className="anom">
                  <div className="anom-head">
                    <span className={`chip ${a.scope === 'team' ? 'team' : 'wh'}`}>{a.scope}</span>
                    <strong className={a.scope === 'warehouse' ? 'mono' : ''}>{a.scope === 'team' && <TeamDot color={c} />}{a.name}</strong>
                    <span className="muted">{fmtDay(a.day)}</span>
                    <span className="anom-amt"><b>{fmtCr(a.value)} cr</b> <span className="muted">vs {fmtCr(a.baseline)} usual</span> <span className="chip over">{Number.isFinite(a.ratio) ? `${a.ratio.toFixed(1)}×` : 'new'}</span></span>
                  </div>
                  <DayBars days={days} values={days.map(d => series[d] ?? 0)} mark={a.day} color={c} label={`${a.name} daily credits, ${fmtDay(a.day)} highlighted`} fmt={v => `${fmtCr(v)} cr`} />
                  {a.drivers.length > 0 && (
                    <ul className="drivers">
                      {a.drivers.map(d => <li key={d.label}><span className="mono small">{d.label}</span><b>{signed(d.delta, v => fmtCr(v))} cr</b><span className="muted small">{fmtUsd(d.delta * price)}</span></li>)}
                    </ul>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}

// ---------- History: snapshots and month-over-month ----------

function History({ project, update, alloc, month, color }: TabProps) {
  const snaps = [...project.snapshots].sort((a, b) => a.month.localeCompare(b.month))
  const [a, setA] = useState(snaps.at(-2)?.id ?? '')
  const [b, setB] = useState(snaps.at(-1)?.id ?? '')
  const A = snaps.find(s => s.id === a) ?? snaps.at(-2)
  const B = snaps.find(s => s.id === b) ?? snaps.at(-1)
  const changes = useMemo(() => A && B && A.id !== B.id ? compare(A, B) : [], [A, B])
  const maxDelta = Math.max(...changes.map(c => Math.abs(c.delta)), 1e-9)

  const remove = (id: string) => {
    const before = project.snapshots
    const s = before.find(x => x.id === id)
    void update({ snapshots: before.filter(x => x.id !== id) })
    let undone = false
    toast(`Deleted snapshot ${s?.label}`, { undo: () => { undone = true; void update({ snapshots: before }) } })
    setTimeout(() => { if (!undone) void deleteSnapshotCloud(id) }, 8500)
  }

  return (
    <div className="tab-body">
      <div className="panel">
        <div className="panel-head wrap">
          <h2>Monthly snapshots</h2>
          <span className="muted small">A snapshot freezes the bill as sent: rules, idle method and price at that moment. Save one per month with <kbd>S</kbd>.</span>
        </div>
        {snaps.length === 0 ? <Empty title="No snapshots yet"><p className="muted">Save a snapshot of {fmtMonth(month)} from the toolbar above to start the history.</p></Empty> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Snapshot</th><th>Saved</th><th>Idle method</th><th className="num">$/credit</th><th className="num">Credits</th><th className="num">Billed</th><th /></tr></thead>
              <tbody>
                {snaps.map(s => (
                  <tr key={s.id}>
                    <th scope="row">{s.label}</th>
                    <td>{new Date(s.createdAt).toLocaleDateString()}</td>
                    <td className="small">{METHODS[s.method].label}</td>
                    <td className="num">{fmtUsd(s.price, 2)}</td>
                    <td className="num">{fmtCr(s.billable)}</td>
                    <td className="num strong">{fmtUsd(s.billable * s.price)}</td>
                    <td className="num"><button type="button" className="btn danger-ghost sm" onClick={() => remove(s.id)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {snaps.length >= 2 && A && B && (
        <div className="panel">
          <div className="panel-head wrap">
            <h2>Month over month</h2>
            <div className="row gap-sm wrap">
              <label className="ctl inline"><span>From</span><select value={A.id} onChange={e => setA(e.target.value)}>{snaps.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
              <label className="ctl inline"><span>To</span><select value={B.id} onChange={e => setB(e.target.value)}>{snaps.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
            </div>
          </div>
          <div className="mom-summary">
            <div><span>{A.label}</span><b>{fmtUsd(A.billable * A.price)}</b></div>
            <span aria-hidden="true">&rarr;</span>
            <div><span>{B.label}</span><b>{fmtUsd(B.billable * B.price)}</b></div>
            <div className={B.billable * B.price >= A.billable * A.price ? 'up' : 'down'}><span>Change</span><b>{signed(B.billable * B.price - A.billable * A.price, v => fmtUsd(v))}</b></div>
          </div>
          {A.method !== B.method && <p className="warn-text small">These snapshots use different idle methods ({METHODS[A.method].label} vs {METHODS[B.method].label}), so part of the change is the rule, not the usage.</p>}
          <ol className="mom">
            {changes.map(c => (
              <li key={c.team} className={isPseudo(c.team) ? 'pseudo' : ''}>
                <div className="mom-head">
                  <strong><TeamDot color={color(c.team)} />{c.team}</strong>
                  <span className={`mom-delta ${c.delta >= 0 ? 'up' : 'down'}`}>{signed(c.usdDelta, v => fmtUsd(v))}<small>{c.pct !== null ? ` ${signed(c.pct, v => fmtPct(v))}` : ''}</small></span>
                </div>
                <DeltaBar value={c.delta} max={maxDelta} />
                <p className="small">{c.why}</p>
                <div className="mom-parts small muted">{c.parts.filter(p => Math.abs(p.delta) > 0.05).map(p => <span key={p.part}>{p.part} {signed(p.delta, v => fmtCr(v))} cr</span>)}</div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {snaps.length === 1 && <p className="muted center">Save another month to compare. Current month total: {fmtUsd(alloc.recon.billable * alloc.price)}.</p>}
      <p className="muted small center"><Link href={`/app/p/${project.id}/statements?m=${month}`}>Print this month&rsquo;s statements &rarr;</Link></p>
    </div>
  )
}

