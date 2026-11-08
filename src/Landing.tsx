import { useEffect, useMemo, useRef, useState } from 'react'
import { allocate, type Allocation } from './engine/allocate.ts'
import { HOUR } from './engine/csv.ts'
import { SAMPLES, generate, sampleConfig } from './engine/sample.ts'
import { recommend, tagAdoption } from './engine/insights.ts'
import { UNASSIGNED, UNMAPPED, type Dataset, type IdleMethod } from './engine/types.ts'
import { Timeline } from './Timeline.tsx'
import { teamOrder } from './projectData.ts'
import { Code, fmtCr, fmtUsd, Link, teamColors } from './ui.tsx'

type Mode = 'raw' | IdleMethod
const MODES: { id: Mode; label: string; short: string; body: string }[] = [
  { id: 'raw', label: 'Attribution only', short: 'No rule', body: 'What QUERY_ATTRIBUTION_HISTORY gives you: query credits per team, and grey idle blocks that belong to nobody.' },
  { id: 'credits', label: 'By query credits', short: 'Credits', body: 'Each hour’s idle goes to the teams that ran queries in that hour, in proportion to their query credits.' },
  { id: 'exec', label: 'By execution time', short: 'Exec time', body: 'Same, weighted by execution time. Long, light queries that held the warehouse open pay more.' },
  { id: 'even', label: 'Even split', short: 'Even', body: 'Every team active that hour pays an equal share of its idle, however small its queries.' },
  { id: 'owner', label: 'Warehouse owner', short: 'Owner', body: 'The team that owns the warehouse (and its auto-suspend setting) pays all of its idle.' },
]

const DAY = Date.UTC(2026, 9, 20)

function useHeroData() {
  return useMemo(() => {
    const def = SAMPLES[0]
    const full = generate(def, '2026-10', '2026-10-21')
    const day: Dataset = { ...full, meter: full.meter.filter(m => m.hour >= DAY), usage: full.usage.filter(u => u.hour >= DAY), daily: [] }
    const cfg = sampleConfig(def)
    const runs = Object.fromEntries((['credits', 'exec', 'even', 'owner'] as IdleMethod[]).map(m => [m, allocate(day, { ...cfg, idleMethod: m, carryHours: 2 })])) as Record<IdleMethod, Allocation>
    // "No rule": only query credits are on a team; every idle credit is unassigned.
    const raw = allocate(day, { ...cfg, idleMethod: 'owner', owners: {} })
    const teams = teamOrder(cfg, runs.credits)
    const hasUnmapped = runs.credits.teams.some(t => t.team === UNMAPPED)
    return { runs: { raw, ...runs } as Record<Mode, Allocation>, teams, hasUnmapped, warehouses: full.warehouses }
  }, [])
}

function useTween(target: number, ms = 650) {
  const [v, setV] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setV(target); from.current = target; return }
    const a = from.current, t0 = performance.now()
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      const e = 1 - (1 - k) ** 3
      const cur = a + (target - a) * e
      setV(cur)
      from.current = cur
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}

function LedgerRow({ team, credits, max, color, price, hatch }: { team: string; credits: number; max: number; color: string; price: number; hatch?: boolean }) {
  const v = useTween(credits)
  return (
    <li className={`ledger-row${hatch && v < 0.05 ? ' cleared' : ''}`}>
      <span className="ledger-name"><i className={`dot${hatch ? ' hatch' : ''}`} style={{ background: color }} />{team}</span>
      <span className="ledger-bar"><span style={{ width: `${(v / max) * 100}%`, background: color }} className={hatch ? 'hatch' : ''} /></span>
      <span className="ledger-num">{fmtCr(v)} <small>cr</small></span>
      <span className="ledger-usd">{fmtUsd(v * price)}</span>
    </li>
  )
}

function HeroDemo() {
  const { runs, teams, hasUnmapped, warehouses } = useHeroData()
  const [mode, setMode] = useState<Mode>('raw')
  const [auto, setAuto] = useState(true)
  useEffect(() => {
    if (!auto || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setMode(m => MODES[(MODES.findIndex(x => x.id === m) + 1) % MODES.length].id), 3400)
    return () => clearInterval(id)
  }, [auto])
  const alloc = runs[mode]
  const color = teamColors(teams)
  const totals = teams.map(t => ({ team: t, credits: alloc.teams.find(x => x.team === t)?.total ?? 0 }))
  const unassigned = alloc.teams.find(t => t.team === UNASSIGNED)?.total ?? 0
  const max = Math.max(...runs.credits.teams.map(t => t.total), unassigned, 1)
  const idleAll = runs.raw.warehouses.reduce((a, w) => a + w.idle, 0)
  const metered = runs.raw.recon.billable
  const info = MODES.find(m => m.id === mode)!

  return (
    <div className="hero-demo">
      <div className="hero-demo-head">
        <div>
          <div className="eyebrow mono">TUE 20 OCT 2026 · 6 WAREHOUSES · 24 METERED HOURS</div>
          <p className="muted small">Synthetic account, allocated live in your browser by the same engine the app uses.</p>
        </div>
        <div className="seg-control" role="radiogroup" aria-label="Idle split method">
          {MODES.map(m => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => { setMode(m.id); setAuto(false) }}>
              <span className="hide-sm">{m.label}</span><span className="show-sm">{m.short}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="hero-demo-grid">
        <div className="hero-timeline">
          <Timeline alloc={alloc} start={DAY} hours={24} color={color} teams={teams} claimed={mode !== 'raw'} infos={warehouses} compact />
          <p className="method-note" aria-live="polite"><b>{info.label}.</b> {info.body}</p>
        </div>
        <aside className="ledger" aria-label="Day total by team">
          <div className="ledger-head"><span>Bill for the day</span><span className="mono">{fmtCr(metered)} cr metered</span></div>
          <ul>
            {totals.map(t => <LedgerRow key={t.team} team={t.team} credits={t.credits} max={max} color={color(t.team)} price={3} />)}
            {hasUnmapped && <LedgerRow team="Unmapped queries" credits={alloc.teams.find(t => t.team === UNMAPPED)?.total ?? 0} max={max} color="var(--unmapped)" price={3} />}
            <LedgerRow team="No team (idle)" credits={unassigned} max={max} color="var(--unassigned)" price={3} hatch />
          </ul>
          <div className="ledger-foot">
            <span>{fmtCr(idleAll)} of {fmtCr(metered)} credits were idle</span>
            <b className={unassigned > 0.005 ? 'bad' : 'good'}>{unassigned > 0.005 ? `${fmtUsd(unassigned * 3, unassigned * 3 < 10 ? 2 : 0)} unbilled` : 'Every credit billed'}</b>
          </div>
        </aside>
      </div>
      <div className="legend" aria-label="Legend">
        <span><i className="sw solid" /> Query credits</span>
        <span><i className="sw stripe" /> Idle, claimed by a team</span>
        <span><i className="sw grey" /> Idle, no team</span>
        <span className="muted">Bar height = share of the warehouse&rsquo;s hourly credit rate. Hover a column for the numbers.</span>
      </div>
    </div>
  )
}

function useRecommendSql() {
  return useMemo(() => {
    const def = SAMPLES[0]
    const oct = generate(def, '2026-10', '2026-11-01')
    const cfg = sampleConfig(def)
    const alloc = allocate(oct, cfg)
    const recs = recommend(alloc, oct.warehouses).filter(r => r.kind === 'auto_suspend').slice(0, 2)
    const tag = tagAdoption(oct, cfg).users.find(u => u.user === 'SVC_TABLEAU')
    return recs.map(r => `-- ${r.why} Est. ${fmtCr(r.savingsCredits, 0)} cr (${fmtUsd(r.monthlyUsd)}) a month.\n${r.sql}`).join('\n\n')
      + (tag ? `\n\n-- Tag the Tableau service user so its spend maps itself\n${tag.sql}` : '')
  }, [])
}

export function Landing() {
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-grid" aria-hidden="true" />
        <div className="hero-copy">
          <a className="announce" href="https://docs.snowflake.com/en/sql-reference/account-usage/query_attribution_history" target="_blank" rel="noreferrer">
            <span className="announce-new">Why</span> QUERY_ATTRIBUTION_HISTORY doesn&rsquo;t include warehouse idle time <span aria-hidden="true">&rarr;</span>
          </a>
          <h1>Every Snowflake credit, <span className="accent">on a team&rsquo;s bill.</span></h1>
          <p className="lede">Chargeback turns your metering and query attribution history into a per-team statement finance can read. Idle time, cloud services and serverless all land on a team, and the total ties out to what Snowflake metered.</p>
          <div className="hero-actions">
            <Link href="/app?sample=acme" className="btn primary lg">Try the sample</Link>
            <Link href="/docs" className="btn outline lg">Get your data</Link>
          </div>
        </div>
        <HeroDemo />
      </section>

      <section className="section evidence">
        <div className="section-head">
          <div className="eyebrow">The gap</div>
          <h2>Query attribution covers the queries, and nothing between them.</h2>
        </div>
        <div className="cards three">
          <article className="card quote">
            <div className="mono tag-chip">docs.snowflake.com</div>
            <p>Snowflake&rsquo;s per-query cost view charges each query for its own execution. Minutes when a warehouse is running but no query is, are idle time, and they are left out.</p>
            <a href="https://docs.snowflake.com/en/sql-reference/account-usage/query_attribution_history" target="_blank" rel="noreferrer" className="linkish small">Read the usage notes &rarr;</a>
          </article>
          <article className="card quote">
            <div className="mono tag-chip">r/snowflake</div>
            <p>A team merged 14 warehouses into 4 to cut idle. Now the bill is smaller, and a slice of it has no team attached at all.</p>
          </article>
          <article className="card quote">
            <div className="mono tag-chip">r/snowflake</div>
            <p>One warehouse, two teams: who pays? The answer that keeps coming back is query tags plus a written rule for idle time.</p>
          </article>
        </div>
        <p className="kicker">Chargeback is that rule, written down, tested, and printable.</p>
      </section>

      <section className="section steps">
        <div className="section-head">
          <div className="eyebrow">How it works</div>
          <h2>From ACCOUNT_USAGE to a bill in three steps.</h2>
        </div>
        <ol className="cards three steps-list">
          <li className="card">
            <span className="step-n">01</span>
            <h3>Run four queries</h3>
            <p>Copy the SQL from the docs. It reads WAREHOUSE_METERING_HISTORY, QUERY_ATTRIBUTION_HISTORY joined to QUERY_HISTORY, and optionally METERING_DAILY_HISTORY and SHOW WAREHOUSES. Download each result as CSV.</p>
          </li>
          <li className="card">
            <span className="step-n">02</span>
            <h3>Map teams with rules</h3>
            <p>Ordered rules on query tag (including JSON keys), role, user, warehouse, database or serverless service. Unmapped spend is listed first, biggest first, with a one-click rule.</p>
          </li>
          <li className="card">
            <span className="step-n">03</span>
            <h3>Send the bill</h3>
            <p>One printable statement per team, a finance CSV, budgets with month-end forecasts, and a snapshot so next month you can see who grew and why.</p>
          </li>
        </ol>
      </section>

      <section className="section methods">
        <div className="section-head">
          <div className="eyebrow">Idle, decided once</div>
          <h2>Four idle rules, each one documented.</h2>
          <p className="muted">Pick the one your org agrees with. Hours with no queries at all follow the last active hour on that warehouse for up to two hours (the auto-suspend tail), then go to the owner.</p>
        </div>
        <div className="cards four">
          {MODES.slice(1).map(m => <article className="card method" key={m.id}><h3>{m.label}</h3><p>{m.body}</p></article>)}
        </div>
      </section>

      <section className="section outputs">
        <div className="split">
          <div>
            <div className="eyebrow">Actions, not charts</div>
            <h2>The statements finance asked for, and the SQL that shrinks them.</h2>
            <ul className="checks">
              <li>Per-team monthly statement, one page per team, print or save as PDF</li>
              <li>Finance CSV with query, idle, cloud services and serverless columns</li>
              <li>Reconciliation to the metered total, with the residual explained</li>
              <li>Cloud services with the daily 10% adjustment applied</li>
              <li>Day-over-day spike list by team and warehouse, with the driver</li>
              <li>Idle-waste ranking and ALTER WAREHOUSE statements with stated assumptions</li>
              <li>Query-tag adoption score and default-tag SQL per user</li>
            </ul>
          </div>
          <Code code={useRecommendSql()} label="Generated for the synthetic sample, October" />
        </div>
      </section>

      <section className="section cta">
        <h2>Close this month&rsquo;s bill before the next one starts.</h2>
        <p className="muted">Runs in your browser. Nothing leaves your device unless you sign in to sync.</p>
        <div className="hero-actions center-x">
          <Link href="/app?sample=acme" className="btn primary lg">Try the sample</Link>
          <Link href="/app" className="btn outline lg">Import your data</Link>
        </div>
      </section>
    </div>
  )
}
