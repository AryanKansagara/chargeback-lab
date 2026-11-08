import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { Allocation } from './engine/allocate.ts'
import { budgets, snapshotOf, tagAdoption } from './engine/insights.ts'
import { UNASSIGNED, UNMAPPED, type Config, type Dataset, type IdleMethod } from './engine/types.ts'
import { StackBar } from './charts.tsx'
import { defaultMonth, financeCsv, METHODS, monthsIn, teamOrder, useAllocation, useProject } from './projectData.ts'
import { uuid, type Project } from './store.ts'
import { Timeline } from './Timeline.tsx'
import { download, fmtCr, fmtDay, fmtMonth, fmtPct, fmtUsd, go, isTyping, Link, Modal, SyntheticBadge, TeamDot, teamColors, toast } from './ui.tsx'

const Rules = lazy(() => import('./Rules.tsx'))
const Panels = lazy(() => import('./Panels.tsx'))
const DataTab = lazy(() => import('./Import.tsx'))

export const TABS = [
  ['overview', 'Overview'], ['rules', 'Rules'], ['optimize', 'Optimize'], ['budgets', 'Budgets'], ['anomalies', 'Anomalies'], ['history', 'History'], ['data', 'Data'],
] as const
export type Tab = (typeof TABS)[number][0]

export interface TabProps {
  project: Project
  ds: Dataset
  sliced: Dataset
  alloc: Allocation
  month: string
  months: string[]
  color(team: string): string
  teams: string[]
  setConfig(p: Partial<Config>): void
  update(p: Partial<Project>): void
  reload(): void
}

export default function ProjectView({ id, tab: rawTab }: { id: string; tab: string }) {
  const { loading, project, ds, setConfig, update, reload } = useProject(id)
  const tab = (TABS.some(t => t[0] === rawTab) ? rawTab : 'overview') as Tab
  const months = useMemo(() => monthsIn(ds), [ds])
  const urlMonth = new URLSearchParams(location.search).get('m')
  const month = urlMonth && months.includes(urlMonth) ? urlMonth : defaultMonth(ds ?? { meter: [], usage: [], daily: [], warehouses: [] }, months)
  const { sliced, alloc } = useAllocation(ds, project?.config, month)
  const teams = useMemo(() => project ? teamOrder(project.config, alloc) : [], [project?.config, alloc])
  const color = useMemo(() => teamColors(teams), [teams])
  const [help, setHelp] = useState(false)

  useEffect(() => { if (project) document.title = `${project.name} · Chargeback` }, [project?.name])

  const setTab = (t: Tab) => go(`/app/p/${id}${t === 'overview' ? '' : '/' + t}${month ? `?m=${month}` : ''}`, { keepScroll: true })
  const setMonth = (m: string) => go(`${location.pathname}?m=${m}`, { replace: true, keepScroll: true })

  const saveSnapshot = () => {
    if (!project || !alloc || !month) return
    const prev = project.snapshots.find(s => s.month === month)
    const snap = snapshotOf(alloc, month, uuid(), fmtMonth(month))
    const snapshots = [...project.snapshots.filter(s => s.month !== month), snap].sort((a, b) => a.month.localeCompare(b.month))
    void update({ snapshots })
    toast(prev ? `Replaced the ${fmtMonth(month)} snapshot` : `Saved a snapshot of ${fmtMonth(month)}`, { tone: 'ok', undo: () => void update({ snapshots: project.snapshots }) })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length) { e.preventDefault(); setTab(TABS[n - 1][0]) }
      else if (e.key === '?') setHelp(true)
      else if (e.key === 's' && alloc) saveSnapshot()
      else if (e.key === 'p' && month) go(`/app/p/${id}/statements?m=${month}`)
      else if (e.key === '[' || e.key === ']') {
        const i = months.indexOf(month ?? '')
        const j = e.key === '[' ? i - 1 : i + 1
        if (months[j]) setMonth(months[j])
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Allocating</div>
  if (!project) return (
    <section className="page narrow center">
      <h1>Project not found</h1>
      <p className="muted">It may have been deleted, or it lives on another device and has not synced yet.</p>
      <Link href="/app" className="btn primary">Back to projects</Link>
    </section>
  )

  const noData = !ds || (!ds.meter.length && !ds.usage.length)
  const effectiveTab: Tab = noData && tab !== 'rules' ? 'data' : tab
  const cfg = project.config

  return (
    <section className="page project">
      <div className="project-head">
        <div className="crumbs"><Link href="/app">Projects</Link><span aria-hidden="true">/</span></div>
        <div className="row between wrap gap">
          <div className="row gap-sm wrap">
            <h1 className="project-title">{project.name}</h1>
            {project.sampleId && <SyntheticBadge />}
          </div>
          {!noData && alloc && month && (
            <div className="row gap-sm wrap">
              <Link href={`/app/p/${id}/statements?m=${month}`} className="btn primary sm">Statements</Link>
              <button type="button" className="btn ghost sm" onClick={() => download(`chargeback-${month}.csv`, financeCsv(alloc, month))}>Finance CSV</button>
              <button type="button" className="btn ghost sm" onClick={saveSnapshot} title="Shortcut: S">Save snapshot</button>
            </div>
          )}
        </div>
        {!noData && month && (
          <div className="controls">
            <label className="ctl"><span>Month</span>
              <select value={month} onChange={e => setMonth(e.target.value)}>{months.map(m => <option key={m} value={m}>{fmtMonth(m)}</option>)}</select>
            </label>
            <label className="ctl grow"><span>Idle split</span>
              <select value={cfg.idleMethod} onChange={e => setConfig({ idleMethod: e.target.value as IdleMethod })}>
                {(Object.keys(METHODS) as IdleMethod[]).map(m => <option key={m} value={m}>{METHODS[m].label}</option>)}
              </select>
            </label>
            <label className="ctl"><span>$ per credit</span>
              <input type="number" min="0" step="0.01" value={cfg.pricePerCredit} onChange={e => { const v = Number(e.target.value); if (v >= 0) setConfig({ pricePerCredit: v }) }} />
            </label>
            <label className="ctl"><span>Idle carry (h)</span>
              <input type="number" min="0" max="24" step="1" value={cfg.carryHours} onChange={e => { const v = Number(e.target.value); if (v >= 0 && v <= 24) setConfig({ carryHours: v }) }} title="Hours with no queries follow the last active hour for this long" />
            </label>
          </div>
        )}
        <nav className="tabs" aria-label="Project sections">
          {TABS.map(([t, label], i) => (
            <Link key={t} href={`/app/p/${id}${t === 'overview' ? '' : '/' + t}${month ? `?m=${month}` : ''}`} aria-current={effectiveTab === t ? 'page' : undefined} className={noData && t !== 'data' && t !== 'rules' ? 'disabled' : ''} title={`Shortcut: ${i + 1}`}>
              {label}
              {t === 'rules' && alloc && alloc.fixes.length > 0 && <span className="count bad">{alloc.fixes.length}</span>}
              {t === 'history' && project.snapshots.length > 0 && <span className="count">{project.snapshots.length}</span>}
            </Link>
          ))}
          <button type="button" className="linkish small kbd-help" onClick={() => setHelp(true)}>Shortcuts <kbd>?</kbd></button>
        </nav>
      </div>

      <Suspense fallback={<div className="boot" role="status"><span className="spinner" /> Loading</div>}>
        {effectiveTab === 'data' || noData || !alloc || !sliced || !month || !ds
          ? (effectiveTab === 'rules'
            ? <Rules project={project} ds={ds ?? { meter: [], usage: [], daily: [], warehouses: [] }} sliced={sliced ?? { meter: [], usage: [], daily: [], warehouses: [] }} alloc={alloc} color={color} teams={teams} setConfig={setConfig} />
            : <DataTab project={project} ds={ds} update={update} reload={reload} months={months} />)
          : (() => {
            const props: TabProps = { project, ds, sliced, alloc, month, months, color, teams, setConfig, update, reload }
            switch (effectiveTab) {
              case 'overview': return <Overview {...props} onTab={setTab} />
              case 'rules': return <Rules {...props} />
              default: return <Panels {...props} tab={effectiveTab} />
            }
          })()}
      </Suspense>

      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>7</kbd></dt><dd>Switch tabs</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next month</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Save a snapshot of this month</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Open printable statements</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>This list</dd></div>
        </dl>
      </Modal>
    </section>
  )
}

// ---------- Overview ----------

function Overview({ project, sliced, alloc, month, color, teams, onTab }: TabProps & { onTab(t: Tab): void }) {
  const cfg = project.config
  const r = alloc.recon
  const price = alloc.price
  const idle = alloc.warehouses.reduce((a, w) => a + w.idle, 0)
  const unmapped = alloc.teams.filter(t => t.team === UNMAPPED || t.team === UNASSIGNED).reduce((a, t) => a + t.total, 0)
  const tags = useMemo(() => tagAdoption(sliced, cfg), [sliced, cfg])
  const bud = useMemo(() => budgets(alloc, cfg, month), [alloc, cfg, month])
  const monthDays = alloc.days.filter(d => d.startsWith(month))
  const [day, setDay] = useState(() => monthDays[Math.max(0, monthDays.length - 8)] ?? monthDays[0])
  const [span, setSpan] = useState<1 | 7>(() => innerWidth < 700 ? 1 : 7)
  const [claimed, setClaimed] = useState(true)
  const dayStart = Date.parse((monthDays.includes(day) ? day : monthDays[0]) + 'T00:00:00Z')
  const maxTotal = Math.max(...alloc.teams.map(t => t.total), 1)

  return (
    <div className="tab-body">
      <div className="kpis">
        <div className="kpi"><span>Billable this month</span><b>{fmtUsd(r.billable * price)}</b><small>{fmtCr(r.billable)} credits at {fmtUsd(price, 2)}</small></div>
        <div className="kpi"><span>Idle</span><b>{fmtPct(r.meteredCompute ? idle / r.meteredCompute : 0)}</b><small>{fmtCr(idle)} cr of warehouse compute, {fmtUsd(idle * price)}</small></div>
        <button type="button" className={`kpi clickable ${unmapped > 0.01 ? 'bad' : 'good'}`} onClick={() => onTab('rules')}>
          <span>Not on a team</span><b>{fmtUsd(unmapped * price)}</b><small>{unmapped > 0.01 ? `${fmtPct(unmapped / (r.billable || 1), 1)} of the bill. Fix on Rules →` : 'Every credit is on a team'}</small>
        </button>
        <div className={`kpi ${Math.abs(r.residual) > 0.01 ? 'warn' : ''}`}><span>Residual vs metered</span><b>{fmtCr(r.residual, 2)} cr</b><small>{Math.abs(r.residual) > 0.01 ? 'See reconciliation below' : 'Ties out to WAREHOUSE_METERING_HISTORY'}</small></div>
        <div className="kpi"><span>Query-tag adoption</span><b>{fmtPct(tags.score)}</b><small>of query credits carry a tag</small></div>
      </div>

      {alloc.fixes.length > 0 && (
        <div className="fix-banner" role="alert">
          <div>
            <strong>Fix these first: {fmtUsd(unmapped * price)} has no team.</strong>
            <ul>
              {alloc.fixes.slice(0, 3).map((f, i) => <li key={i}>{fixLabel(f)} <b>{fmtCr(f.credits)} cr</b></li>)}
            </ul>
          </div>
          <button type="button" className="btn danger sm" onClick={() => onTab('rules')}>Map them</button>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>Bill by team · {fmtMonth(month)}</h2>
          <span className="muted small">{METHODS[cfg.idleMethod].label}</span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Team</th><th className="num">Query</th><th className="num">Idle</th><th className="num">Cloud svc</th><th className="num">Serverless</th><th className="num">Credits</th><th className="num">Amount</th><th className="hide-sm">Share</th><th className="hide-sm">Budget</th></tr></thead>
            <tbody>
              {alloc.teams.map(t => {
                const b = bud.find(x => x.team === t.team)
                return (
                  <tr key={t.team} className={t.team === UNMAPPED || t.team === UNASSIGNED ? 'row-bad' : ''}>
                    <th scope="row"><TeamDot color={color(t.team)} hatch={t.team === UNASSIGNED} />{t.team}</th>
                    <td className="num">{fmtCr(t.query + t.qas)}</td>
                    <td className="num">{fmtCr(t.idle)}</td>
                    <td className="num">{fmtCr(t.cloud, 2)}</td>
                    <td className="num">{fmtCr(t.serverless)}</td>
                    <td className="num strong">{fmtCr(t.total)}</td>
                    <td className="num strong">{fmtUsd(t.usd)}</td>
                    <td className="hide-sm share-cell"><StackBar label={`${t.team} composition`} total={maxTotal} parts={[
                      { key: 'q', value: t.query + t.qas, color: color(t.team), title: `Query ${fmtCr(t.query + t.qas)} cr` },
                      { key: 'i', value: t.idle, color: color(t.team), hatch: true, title: `Idle ${fmtCr(t.idle)} cr` },
                      { key: 'o', value: t.cloud + t.serverless, color: 'var(--ink-3)', title: `Cloud + serverless ${fmtCr(t.cloud + t.serverless)} cr` },
                    ]} /></td>
                    <td className="hide-sm">{b && b.status !== 'no-budget' ? <span className={`chip ${b.status}`}>{b.status === 'over' ? 'Over' : b.status === 'at-risk' ? 'At risk' : 'On track'}</span> : <span className="muted small">&mdash;</span>}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot><tr><th scope="row">Total allocated</th><td className="num">{fmtCr(alloc.teams.reduce((a, t) => a + t.query + t.qas, 0))}</td><td className="num">{fmtCr(idle)}</td><td className="num">{fmtCr(alloc.teams.reduce((a, t) => a + t.cloud, 0), 2)}</td><td className="num">{fmtCr(alloc.teams.reduce((a, t) => a + t.serverless, 0))}</td><td className="num strong">{fmtCr(r.allocated)}</td><td className="num strong">{fmtUsd(r.allocated * price)}</td><td className="hide-sm" /><td className="hide-sm" /></tr></tfoot>
          </table>
        </div>
        <div className="legend small"><span><i className="sw solid" /> Query</span><span><i className="sw stripe" /> Idle</span><span><i className="sw other" /> Cloud services + serverless</span></div>
      </div>

      <div className="panel">
        <div className="panel-head wrap">
          <h2>Warehouse hours</h2>
          <div className="row gap-sm wrap">
            <label className="ctl inline"><span>From</span><input type="date" value={day} min={monthDays[0]} max={monthDays.at(-1)} onChange={e => setDay(e.target.value)} /></label>
            <div className="seg-control sm" role="radiogroup" aria-label="Span">
              {([1, 7] as const).map(s => <button type="button" role="radio" aria-checked={span === s} key={s} className={span === s ? 'on' : ''} onClick={() => setSpan(s)}>{s === 1 ? '1 day' : '7 days'}</button>)}
            </div>
            <div className="seg-control sm" role="radiogroup" aria-label="Idle display">
              <button type="button" role="radio" aria-checked={!claimed} className={!claimed ? 'on' : ''} onClick={() => setClaimed(false)}>Idle unassigned</button>
              <button type="button" role="radio" aria-checked={claimed} className={claimed ? 'on' : ''} onClick={() => setClaimed(true)}>Idle claimed</button>
            </div>
          </div>
        </div>
        <Timeline alloc={alloc} start={dayStart} hours={span * 24} color={color} teams={teams} claimed={claimed} infos={sliced.warehouses} />
        <div className="legend small">
          {teams.slice(0, 8).map(t => <span key={t}><TeamDot color={color(t)} />{t}</span>)}
          {alloc.teams.some(t => t.team === UNMAPPED) && <span><TeamDot color="var(--unmapped)" />Unmapped</span>}
          <span><i className="sw stripe" /> Idle</span><span><i className="sw grey" /> Idle, no team</span>
          <span className="muted">Times in UTC · {fmtDay(day)} onward</span>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Warehouses</h2><Link href={`/app/p/${project.id}/optimize?m=${month}`} className="linkish small">Idle ranking &rarr;</Link></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Warehouse</th><th className="num">Metered</th><th className="num">Idle</th><th>Idle charged to</th></tr></thead>
              <tbody>
                {alloc.warehouses.map(w => (
                  <tr key={w.name}>
                    <th scope="row" className="mono">{w.name}</th>
                    <td className="num">{fmtCr(w.metered)}</td>
                    <td className="num">{fmtPct(w.idlePct)}</td>
                    <td><StackBar label={`${w.name} idle by team`} parts={Object.entries(w.idleByTeam).sort((a, b) => b[1] - a[1]).map(([t, v]) => ({ key: t, value: v, color: color(t), hatch: t === UNASSIGNED, title: `${t}: ${fmtCr(v)} cr` }))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <Recon alloc={alloc} />
      </div>
    </div>
  )
}

export function fixLabel(f: Allocation['fixes'][number]) {
  if (f.kind === 'idle') return `Idle on ${f.subject.warehouse} with no owner`
  if (f.kind === 'serverless') return `Serverless ${f.subject.service}`
  const s = f.subject
  const bits = [s.user && `user ${s.user}`, s.role && `role ${s.role}`, s.tag ? `tag ${s.tag.length > 30 ? s.tag.slice(0, 28) + '…' : s.tag}` : 'no tag'].filter(Boolean)
  return `${bits.join(', ')} on ${s.warehouse}`
}

function Recon({ alloc }: { alloc: Allocation }) {
  const r = alloc.recon
  const rows: [string, number, string?][] = [
    ['Warehouse compute (metered)', r.meteredCompute],
    ['Cloud services used', r.meteredCloud],
    [`Cloud services adjustment${r.cloudEstimated ? ' (estimated: 10% rule)' : ''}`, r.cloudAdjustment, 'Only cloud services above 10% of daily warehouse compute are billed.'],
    ['Serverless and query acceleration', r.serverless],
  ]
  return (
    <div className="panel">
      <div className="panel-head"><h2>Reconciliation</h2><span className={`chip ${Math.abs(r.residual) < 0.01 ? 'on-track' : 'at-risk'}`}>{Math.abs(r.residual) < 0.01 ? 'Ties out' : 'Residual'}</span></div>
      <table className="recon">
        <tbody>
          {rows.map(([l, v, hint]) => <tr key={l}><th scope="row">{l}{hint && <small>{hint}</small>}</th><td className="num">{fmtCr(v, 2)}</td></tr>)}
          <tr className="sum"><th scope="row">Billable credits</th><td className="num">{fmtCr(r.billable, 2)}</td></tr>
          <tr><th scope="row">Allocated to teams and buckets</th><td className="num">{fmtCr(r.allocated, 2)}</td></tr>
          <tr className="sum"><th scope="row">Residual</th><td className="num">{fmtCr(r.residual, 3)}</td></tr>
        </tbody>
      </table>
      {(r.over > 0.001 || r.unmetered > 0.001) && (
        <ul className="recon-notes small">
          {r.unmetered > 0.001 && <li>{fmtCr(r.unmetered, 2)} cr of query credits fall in hours with no metering row. Metering lags by up to 3 hours and attribution by up to 8, so re-export after both have caught up, or trim the last day.</li>}
          {r.over > 0.001 && <li>{fmtCr(r.over, 2)} cr of query credits exceed what the warehouse metered in those hours, usually rounding or a time zone mismatch between exports. Run both with <code>ALTER SESSION SET TIMEZONE = 'UTC'</code>.</li>}
        </ul>
      )}
      {r.attributedCheck && Math.abs(r.attributedCheck.metering - r.attributedCheck.queries) > 0.5 && (
        <p className="small warn-text">Metering says {fmtCr(r.attributedCheck.metering)} cr were attributed to queries; the uploaded query rows add up to {fmtCr(r.attributedCheck.queries)}. Short queries (about 100 ms or less) are not in QUERY_ATTRIBUTION_HISTORY, and the two views have different latency.</p>
      )}
    </div>
  )
}
