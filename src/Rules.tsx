import { useMemo, useState } from 'react'
import { isPseudo, type Allocation, type FixItem } from './engine/allocate.ts'
import { compileRegex, FIELD_LABEL, matchRule, resolve, type Subject } from './engine/rules.ts'
import { UNMAPPED, type Config, type Dataset, type Rule, type RuleField, type RuleOp } from './engine/types.ts'
import { fixLabel } from './Project.tsx'
import { uuid, type Project } from './store.ts'
import { Empty, fmtCr, fmtUsd, TeamDot, toast } from './ui.tsx'

const OPS: Record<RuleOp, string> = { equals: 'equals', contains: 'contains', starts: 'starts with', regex: 'matches regex', any: 'is present' }
const FIELDS = Object.keys(FIELD_LABEL) as RuleField[]

interface Props {
  project: Project
  ds: Dataset
  sliced: Dataset
  alloc: Allocation | null
  color(team: string): string
  teams: string[]
  setConfig(p: Partial<Config>): void
}

export default function Rules({ project, ds, sliced, alloc, color, teams, setConfig }: Props) {
  const cfg = project.config
  const rules = cfg.rules
  const setRules = (next: Rule[]) => setConfig({ rules: next })
  const [test, setTest] = useState<Subject>({ tag: '{"team":"growth","dbt_model":"fct_orders"}', role: 'TRANSFORMER', user: 'SVC_DBT', warehouse: 'TRANSFORM_WH', database: 'ANALYTICS', service: '' })

  // Credits each rule claims this month, so dead rules and greedy rules are visible.
  const hits = useMemo(() => {
    const out: Record<string, number> = {}
    const memo = new Map<string, string | null>()
    for (const u of sliced.usage) {
      const k = `${u.warehouse}|${u.user}|${u.role}|${u.tag}|${u.database}`
      let id = memo.get(k)
      if (id === undefined) memo.set(k, id = resolve(rules, u).rule?.id ?? null)
      if (id) out[id] = (out[id] ?? 0) + u.credits + u.qas
    }
    for (const d of sliced.daily) {
      const id = resolve(rules, { service: d.service.toUpperCase() }).rule?.id
      if (id && !/^WAREHOUSE_METERING/.test(d.service.toUpperCase())) out[id] = (out[id] ?? 0) + d.billed
    }
    return out
  }, [sliced, rules])

  const patch = (id: string, p: Partial<Rule>) => setRules(rules.map(r => r.id === id ? { ...r, ...p } : r))
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= rules.length) return
    const next = [...rules]
    ;[next[i], next[j]] = [next[j], next[i]]
    setRules(next)
  }
  const remove = (r: Rule) => {
    const before = rules
    setRules(rules.filter(x => x.id !== r.id))
    toast(`Deleted rule: ${FIELD_LABEL[r.field]} ${OPS[r.op]} ${r.value || r.key || ''}`, { undo: () => setRules(before) })
  }
  const add = (r: Partial<Rule> = {}) => setRules([...rules, { id: uuid(), field: 'tag_key', key: 'team', op: 'equals', value: '', team: '', ...r }])

  const result = resolve(rules, test)
  const whNames = [...new Set([...ds.warehouses.map(w => w.name), ...(alloc?.warehouses.map(w => w.name) ?? [])])].sort()
  const price = cfg.pricePerCredit

  return (
    <div className="tab-body">
      <datalist id="team-list">{teams.map(t => <option key={t} value={t} />)}</datalist>

      {alloc && (
        <div className={`panel ${alloc.fixes.length ? 'panel-bad' : 'panel-good'}`}>
          <div className="panel-head">
            <h2>{alloc.fixes.length ? 'Fix these first' : 'Everything is mapped'}</h2>
            {alloc.fixes.length > 0 && <span className="chip over" title="Includes the idle share these rows pick up">{fmtUsd(alloc.teams.filter(t => isPseudo(t.team)).reduce((a, t) => a + t.total, 0) * price)} not on a team</span>}
          </div>
          {alloc.fixes.length === 0
            ? <p className="muted">Every query, idle hour and serverless credit this month lands on a team.</p>
            : <ol className="fix-list">{alloc.fixes.slice(0, 25).map((f, i) => <FixRow key={i} f={f} price={price} onRule={r => { add(r); toast('Rule added', { tone: 'ok' }) }} onOwner={(w, t) => setConfig({ owners: { ...cfg.owners, [w]: t } })} onTest={s => setTest({ ...s })} />)}</ol>}
        </div>
      )}

      <div className="grid-rules">
        <div className="panel">
          <div className="panel-head">
            <h2>Team mapping rules</h2>
            <button type="button" className="btn primary sm" onClick={() => add()}>Add rule</button>
          </div>
          <p className="muted small">Checked top to bottom; the first rule that matches decides the team. Matching ignores case. Anything no rule matches is Unmapped.</p>
          {rules.length === 0 ? (
            <Empty title="No rules yet">
              <p className="muted">Start with the query tag. If your tags are JSON like <code>{'{"team":"growth"}'}</code>, one rule covers every team:</p>
              <button type="button" className="btn primary sm" onClick={() => add({ field: 'tag_key', key: 'team', op: 'any', useValue: true })}>Use the tag&rsquo;s &ldquo;team&rdquo; key as the team</button>
            </Empty>
          ) : (
            <ol className="rules">
              {rules.map((r, i) => {
                const badRegex = r.op === 'regex' && !compileRegex(r.value)
                const testHit = matchRule(r, test) !== null
                return (
                  <li key={r.id} className={`rule${r.disabled ? ' off' : ''}${result.rule?.id === r.id ? ' hit' : ''}`}>
                    <div className="rule-order">
                      <span className="rule-n">{i + 1}</span>
                      <button type="button" className="icon-btn xs" aria-label={`Move rule ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>&#9650;</button>
                      <button type="button" className="icon-btn xs" aria-label={`Move rule ${i + 1} down`} disabled={i === rules.length - 1} onClick={() => move(i, 1)}>&#9660;</button>
                    </div>
                    <div className="rule-body">
                      <div className="rule-line">
                        <span className="kw">If</span>
                        <select aria-label="Field" value={r.field} onChange={e => patch(r.id, { field: e.target.value as RuleField })}>{FIELDS.map(f => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}</select>
                        {r.field === 'tag_key' && <input aria-label="JSON key" className="w-key mono" placeholder="team" value={r.key ?? ''} onChange={e => patch(r.id, { key: e.target.value })} />}
                        <select aria-label="Operator" value={r.op} onChange={e => patch(r.id, { op: e.target.value as RuleOp })}>{(Object.keys(OPS) as RuleOp[]).map(o => <option key={o} value={o}>{OPS[o]}</option>)}</select>
                        {r.op !== 'any' && <input aria-label="Value" aria-invalid={badRegex} className={`mono grow${badRegex ? ' invalid' : ''}`} placeholder={r.op === 'regex' ? '^svc_' : 'value'} value={r.value} onChange={e => patch(r.id, { value: e.target.value })} />}
                      </div>
                      <div className="rule-line">
                        <span className="kw">charge</span>
                        {r.useValue
                          ? <span className="pill-note">the matched value as the team name</span>
                          : <input aria-label="Team" list="team-list" placeholder="Team" value={r.team} onChange={e => patch(r.id, { team: e.target.value })} />}
                        <label className="check small"><input type="checkbox" checked={!!r.useValue} onChange={e => patch(r.id, { useValue: e.target.checked })} /> use matched value</label>
                        <span className="rule-stats">{hits[r.id] ? `${fmtCr(hits[r.id])} cr this month` : 'matches nothing this month'}{testHit && <span className="chip on-track">test row</span>}</span>
                      </div>
                      {badRegex && <p className="error small">That regex does not compile, so this rule never matches.</p>}
                    </div>
                    <div className="rule-actions">
                      <label className="switch" title={r.disabled ? 'Enable' : 'Disable'}><input type="checkbox" checked={!r.disabled} onChange={e => patch(r.id, { disabled: !e.target.checked })} aria-label={`Rule ${i + 1} enabled`} /><span /></label>
                      <button type="button" className="icon-btn xs danger" aria-label={`Delete rule ${i + 1}`} onClick={() => remove(r)}>&times;</button>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>

        <div className="panel test-panel">
          <div className="panel-head"><h2>Test a row</h2></div>
          <p className="muted small">Type what a query looks like in QUERY_HISTORY and see which rule claims it.</p>
          {(['tag', 'user', 'role', 'warehouse', 'database', 'service'] as const).map(k => (
            <label className="field" key={k}><span>{k === 'tag' ? 'Query tag' : k === 'service' ? 'Serverless service type' : k[0].toUpperCase() + k.slice(1)}</span>
              <input className="mono" value={test[k] ?? ''} onChange={e => setTest({ ...test, [k]: e.target.value })} />
            </label>
          ))}
          <div className={`test-result ${result.team === UNMAPPED ? 'bad' : 'good'}`} aria-live="polite">
            {result.rule
              ? <><span className="muted small">Rule {rules.indexOf(result.rule) + 1} matches</span><strong><TeamDot color={color(result.team)} />{result.team}</strong></>
              : <><span className="muted small">No rule matches</span><strong>Unmapped</strong></>}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Warehouse owners</h2></div>
        <p className="muted small">Used by the &ldquo;warehouse owner&rdquo; idle method, and as the fallback for idle hours no team can be matched to under the other methods.</p>
        {whNames.length === 0 ? <p className="muted">Import metering data to list warehouses.</p> : (
          <div className="owners">
            {whNames.map(w => (
              <label className="owner-row" key={w}>
                <span className="mono">{w}</span>
                <input list="team-list" placeholder="No owner" value={cfg.owners[w] ?? ''} onChange={e => { const owners = { ...cfg.owners, [w]: e.target.value }; if (!e.target.value) delete owners[w]; setConfig({ owners }) }} />
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FixRow({ f, price, onRule, onOwner, onTest }: { f: FixItem; price: number; onRule(r: Partial<Rule>): void; onOwner(w: string, team: string): void; onTest(s: Subject): void }) {
  const s = f.subject
  const options: [RuleField, string][] = f.kind === 'serverless'
    ? [['service_type', s.service ?? '']]
    : ([['user', s.user], ['role', s.role], ['warehouse', s.warehouse], ['database', s.database], ['query_tag', s.tag]] as [RuleField, string | undefined][]).filter((o): o is [RuleField, string] => !!o[1])
  const [field, setField] = useState<RuleField>(options[0]?.[0] ?? 'user')
  const [team, setTeam] = useState('')
  const value = options.find(o => o[0] === field)?.[1] ?? ''
  return (
    <li className="fix">
      <div className="fix-main">
        <span className="fix-label">{fixLabel(f)}</span>
        <span className="fix-amt"><b>{fmtCr(f.credits)} cr</b> <span className="muted">{fmtUsd(f.credits * price)}</span>{f.queries > 0 && <span className="muted small"> · {f.queries.toLocaleString()} queries</span>}</span>
      </div>
      <form className="fix-form" onSubmit={e => {
        e.preventDefault()
        if (!team.trim()) return
        if (f.kind === 'idle') onOwner(s.warehouse!, team.trim())
        else onRule({ field, op: 'equals', value, team: team.trim() })
        setTeam('')
      }}>
        {f.kind === 'idle' ? <span className="small">Set owner of <b className="mono">{s.warehouse}</b> to</span> : (
          <>
            <span className="small">Map by</span>
            <select aria-label="Match on" value={field} onChange={e => setField(e.target.value as RuleField)}>{options.map(([k, v]) => <option key={k} value={k}>{FIELD_LABEL[k]} = {v.length > 24 ? v.slice(0, 22) + '…' : v}</option>)}</select>
            <span className="small">to</span>
          </>
        )}
        <input aria-label="Team" list="team-list" placeholder="Team" value={team} onChange={e => setTeam(e.target.value)} />
        <button className="btn primary sm" disabled={!team.trim()}>{f.kind === 'idle' ? 'Set owner' : 'Add rule'}</button>
        {f.kind === 'query' && <button type="button" className="linkish small" onClick={() => onTest(s)}>Test</button>}
      </form>
    </li>
  )
}
