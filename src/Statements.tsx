import { useEffect, useMemo, useState } from 'react'
import { isPseudo } from './engine/allocate.ts'
import { budgets } from './engine/insights.ts'
import { DayBars } from './charts.tsx'
import { defaultMonth, financeCsv, METHODS, monthsIn, teamOrder, useAllocation, useProject } from './projectData.ts'
import { download, fmtCr, fmtMonth, fmtUsd, go, Link, Monogram, TeamDot, teamColors, ThemeToggle } from './ui.tsx'

export default function Statements({ id }: { id: string }) {
  const { loading, project, ds } = useProject(id)
  const months = useMemo(() => monthsIn(ds), [ds])
  const q = new URLSearchParams(location.search)
  const month = q.get('m') && months.includes(q.get('m')!) ? q.get('m')! : ds ? defaultMonth(ds, months) : null
  const { alloc } = useAllocation(ds, project?.config, month)
  const [only, setOnly] = useState<string>('all')
  const teams = useMemo(() => project ? teamOrder(project.config, alloc) : [], [project, alloc])
  const color = teamColors(teams)
  useEffect(() => { if (project && month) document.title = `Statements ${month} · ${project.name}` }, [project?.name, month])

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Preparing statements</div>
  if (!project || !alloc || !month) return (
    <div className="page narrow center"><h1>Nothing to print yet</h1><p className="muted">Import data first.</p><Link href={project ? `/app/p/${id}/data` : '/app'} className="btn primary">Go back</Link></div>
  )
  const [y, m] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const days = Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
  const bud = budgets(alloc, project.config, month)
  const list = alloc.teams.filter(t => only === 'all' || t.team === only)
  const r = alloc.recon
  const period = `${fmtMonth(month).split(' ')[0]} 1–${lastDay}, ${y} (UTC)`

  return (
    <div className="statements-page">
      <div className="statement-toolbar no-print">
        <Link href={`/app/p/${id}?m=${month}`} className="btn ghost sm">&larr; {project.name}</Link>
        <label className="ctl inline"><span>Month</span><select value={month} onChange={e => go(`${location.pathname}?m=${e.target.value}`, { replace: true })}>{months.map(mm => <option key={mm} value={mm}>{fmtMonth(mm)}</option>)}</select></label>
        <label className="ctl inline"><span>Team</span><select value={only} onChange={e => setOnly(e.target.value)}><option value="all">All teams ({alloc.teams.length} pages)</option>{alloc.teams.map(t => <option key={t.team} value={t.team}>{t.team}</option>)}</select></label>
        <span className="grow" />
        <ThemeToggle />
        <button type="button" className="btn ghost sm" onClick={() => download(`chargeback-${month}.csv`, financeCsv(alloc, month))}>Finance CSV</button>
        <button type="button" className="btn primary sm" onClick={() => print()}>Print or save PDF</button>
      </div>
      {list.map(t => {
        const b = bud.find(x => x.team === t.team)
        const whs = Object.entries(t.byWarehouse).map(([w, v]) => ({ w, ...v, total: v.query + v.idle + v.cloud })).filter(x => x.total > 0.0005).sort((a, b) => b.total - a.total)
        const users = Object.entries(t.byUser).sort((a, b) => b[1] - a[1]).slice(0, 8)
        const services = Object.entries(t.byService).sort((a, b) => b[1] - a[1])
        const ref = `CB-${month.replace('-', '')}-${t.team.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'TEAM'}`
        return (
          <article className="statement" key={t.team}>
            <header className="st-head">
              <div className="st-brand"><Monogram /><div><strong>Chargeback</strong><span>Snowflake usage statement</span></div></div>
              <div className="st-ref"><span>Statement</span><b className="mono">{ref}</b><span>Prepared {new Date().toLocaleDateString('en-US', { dateStyle: 'medium' })}</span></div>
            </header>
            <section className="st-bill">
              <div>
                <span className="st-label">Bill to</span>
                <h1><TeamDot color={color(t.team)} hatch={t.team === 'Unassigned idle'} />{t.team}</h1>
                <p>{project.name} · {period}</p>
                {isPseudo(t.team) && <p className="st-warn">Not a team. These credits matched no rule or had no warehouse owner. Map them on the Rules tab before sending.</p>}
              </div>
              <div className="st-due">
                <span className="st-label">Amount</span>
                <b>{fmtUsd(t.usd, 2)}</b>
                <span>{fmtCr(t.total, 2)} credits × {fmtUsd(alloc.price, 2)}</span>
              </div>
            </section>
            <table className="st-summary">
              <tbody>
                <tr><th scope="row">Query compute<small>Credits Snowflake attributed to this team&rsquo;s queries</small></th><td>{fmtCr(t.query, 2)}</td><td>{fmtUsd(t.query * alloc.price, 2)}</td></tr>
                <tr><th scope="row">Warehouse idle<small>{METHODS[alloc.method].label}</small></th><td>{fmtCr(t.idle, 2)}</td><td>{fmtUsd(t.idle * alloc.price, 2)}</td></tr>
                <tr><th scope="row">Cloud services<small>After the daily 10% adjustment{r.cloudEstimated ? ' (estimated)' : ''}</small></th><td>{fmtCr(t.cloud, 2)}</td><td>{fmtUsd(t.cloud * alloc.price, 2)}</td></tr>
                <tr><th scope="row">Serverless and query acceleration</th><td>{fmtCr(t.serverless + t.qas, 2)}</td><td>{fmtUsd((t.serverless + t.qas) * alloc.price, 2)}</td></tr>
                <tr className="total"><th scope="row">Total</th><td>{fmtCr(t.total, 2)}</td><td>{fmtUsd(t.usd, 2)}</td></tr>
              </tbody>
            </table>
            <div className="st-cols">
              <section>
                <h2>By warehouse</h2>
                <table className="st-table">
                  <thead><tr><th>Warehouse</th><th>Query</th><th>Idle</th><th>Cloud</th><th>Amount</th></tr></thead>
                  <tbody>{whs.map(x => <tr key={x.w}><th scope="row" className="mono">{x.w}</th><td>{fmtCr(x.query)}</td><td>{fmtCr(x.idle)}</td><td>{fmtCr(x.cloud, 2)}</td><td>{fmtUsd(x.total * alloc.price)}</td></tr>)}
                    {services.map(([s, v]) => <tr key={s}><th scope="row" className="mono">{s}</th><td colSpan={3} className="muted">serverless</td><td>{fmtUsd(v * alloc.price)}</td></tr>)}
                  </tbody>
                </table>
              </section>
              <section>
                <h2>Top users</h2>
                {users.length ? <table className="st-table"><thead><tr><th>User</th><th>Query credits</th></tr></thead><tbody>{users.map(([u, v]) => <tr key={u}><th scope="row" className="mono">{u}</th><td>{fmtCr(v, 2)}</td></tr>)}</tbody></table> : <p className="muted small">No query usage.</p>}
                {b && b.budget > 0 && <p className="st-budget">Budget {fmtUsd(b.budget)} · spent {fmtUsd(b.spent)} ({Math.round((b.spent / b.budget) * 100)}%)</p>}
              </section>
            </div>
            <section>
              <h2>Daily spend</h2>
              <DayBars days={days} values={days.map(d => t.byDay[d] ?? 0)} color={color(t.team)} label={`${t.team} daily credits`} fmt={v => `${fmtCr(v, 2)} cr`} fill />
              <div className="st-axis"><span>1</span><span>{lastDay}</span></div>
            </section>
            <footer className="st-foot">
              <p><b>How this was calculated.</b> Hourly metered compute per warehouse from WAREHOUSE_METERING_HISTORY, minus query credits from QUERY_ATTRIBUTION_HISTORY, is idle. {METHODS[alloc.method].body} Hours with no queries follow the last active hour on that warehouse for up to {project.config.carryHours} hours, then go to the warehouse owner.</p>
              <p>Account total for the period: {fmtCr(r.billable, 2)} billable credits; {fmtCr(r.allocated, 2)} allocated; residual {fmtCr(r.residual, 3)}. Price {fmtUsd(alloc.price, 2)} per credit. Times in UTC.</p>
            </footer>
          </article>
        )
      })}
    </div>
  )
}
