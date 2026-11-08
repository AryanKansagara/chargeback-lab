import { useMemo, useRef, useState } from 'react'
import { autoMap, detectKind, KINDS, mergeRows, parseCsv, toCsv, validate, type Kind, type Mapping } from './engine/csv.ts'
import { SIZE_LABEL } from './engine/insights.ts'
import type { Dataset, WarehouseInfo } from './engine/types.ts'
import { createBlankProject } from './projectData.ts'
import { toSnowflakeCsvs } from './engine/sample.ts'
import { filterMonth } from './engine/allocate.ts'
import { putData, saveProject, uuid, type Project } from './store.ts'
import { RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, Empty, fmtMonth, go, Link, toast } from './ui.tsx'

interface Pending {
  id: string
  name: string
  csv: ReturnType<typeof parseCsv>
  kind: Kind | null
  map: Mapping
}

const EMPTY: Dataset = { meter: [], usage: [], daily: [], warehouses: [] }
export default function DataTab({ project, ds, update, reload, months }: { project: Project; ds: Dataset | null; update(p: Partial<Project>): void; reload(): void; months: string[] }) {
  const data = ds ?? EMPTY
  const [pending, setPending] = useState<Pending[]>([])
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const sync = useSync()
  const rawSize = useMemo(() => project.sampleId ? 0 : JSON.stringify(data).length, [data, project.sampleId])

  const readFiles = async (files: FileList | File[]) => {
    setBusy(true)
    const next: Pending[] = []
    for (const f of [...files]) {
      if (f.size > 200_000_000) { toast(`${f.name} is over 200 MB. Aggregate it by hour in SQL first (see the docs).`, { tone: 'error' }); continue }
      const text = await f.text()
      await new Promise(r => setTimeout(r, 0))
      const csv = parseCsv(text)
      if (csv.rows.length < 2) { toast(`${f.name} has no data rows.`, { tone: 'error' }); continue }
      const kind = detectKind(csv.rows[0])
      next.push({ id: uuid(), name: f.name, csv, kind, map: kind ? autoMap(kind, csv.rows[0]) : {} })
    }
    setPending(p => [...p, ...next])
    setBusy(false)
  }

  const commit = async (p: Pending, rows: unknown[], skipped: number) => {
    if (!p.kind) return
    let target = project
    if (project.sampleId) {
      target = await createBlankProject('My Snowflake account')
    }
    const base = project.sampleId ? EMPTY : data
    const merged = mergeRows(base, p.kind, rows)
    await putData(target.id, merged)
    const meta = { id: uuid(), kind: p.kind, fileName: p.name, rows: rows.length, skipped, at: Date.now() }
    if (project.sampleId) {
      await saveProject({ ...target, imports: [meta] })
      setPending(x => x.filter(y => y.id !== p.id))
      toast(`Imported ${rows.length.toLocaleString()} rows into a new project (samples are read-only).`, { tone: 'ok' })
      go(`/app/p/${target.id}/data`)
      return
    }
    update({ imports: [...project.imports, meta], dataMissing: false })
    setPending(x => x.filter(y => y.id !== p.id))
    reload()
    toast(`Imported ${rows.length.toLocaleString()} ${KINDS[p.kind].title.toLowerCase()} rows${skipped ? `, skipped ${skipped}` : ''}`, { tone: 'ok' })
  }

  const counts = { meter: data.meter.length, usage: data.usage.length, daily: data.daily.length, warehouses: data.warehouses.length }

  return (
    <div className="tab-body">
      {project.dataMissing && <div className="fix-banner warn"><div><strong>This project&rsquo;s raw data is on another device.</strong><p className="small">Rules, budgets and snapshots synced. Raw uploads over {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB stay where they were imported. Re-import the CSVs here to recompute.</p></div></div>}

      <div className="panel">
        <div className="panel-head wrap"><h2>Import Snowflake exports</h2><Link href="/docs" className="linkish small">Which SQL to run &rarr;</Link></div>
        {project.sampleId && (
          <div className="row between wrap gap-sm sample-note">
            <p className="muted small">This is a synthetic sample, so its data is read-only. Importing here starts a new project with your files. Want to rehearse the import? Download the sample as the four CSVs the docs&rsquo; SQL produces.</p>
            <button type="button" className="btn ghost sm" onClick={() => {
              const files = toSnowflakeCsvs(filterMonth(data, months.includes('2026-10') ? '2026-10' : months[months.length - 1]))
              Object.entries(files).forEach(([k, v], i) => setTimeout(() => download(`sample-${k}.csv`, v), i * 300))
            }}>Download sample CSVs</button>
          </div>
        )}
        <div
          className={`dropzone${drag ? ' over' : ''}`}
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); void readFiles(e.dataTransfer.files) }}
        >
          <div className="drop-icon" aria-hidden="true" />
          <p><strong>Drop CSV files here</strong> or <button type="button" className="linkish" onClick={() => input.current?.click()}>choose files</button></p>
          <p className="muted small">Metering, query attribution, daily metering and SHOW WAREHOUSES. Each file&rsquo;s type is detected from its columns. Comma, tab or semicolon separated.</p>
          <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv" multiple hidden onChange={e => { if (e.target.files) void readFiles(e.target.files); e.target.value = '' }} />
          {busy && <p role="status"><span className="spinner" /> Reading files</p>}
        </div>
        {pending.map(p => <PendingCard key={p.id} p={p} onChange={np => setPending(x => x.map(y => y.id === p.id ? np : y))} onCancel={() => setPending(x => x.filter(y => y.id !== p.id))} onCommit={commit} />)}
      </div>

      <div className="panel">
        <div className="panel-head"><h2>What&rsquo;s loaded</h2>{months.length > 0 && <span className="muted small">{fmtMonth(months[0])} to {fmtMonth(months[months.length - 1])}</span>}</div>
        <div className="coverage">
          {(Object.keys(KINDS) as Kind[]).map(k => (
            <div key={k} className={`cov ${counts[k] ? 'ok' : k === 'meter' || k === 'usage' ? 'missing' : 'optional'}`}>
              <span className="mono small">{KINDS[k].view}</span>
              <b>{counts[k] ? counts[k].toLocaleString() + ' rows' : k === 'meter' || k === 'usage' ? 'Required' : 'Optional'}</b>
              <small>{k === 'daily' ? 'Cloud services adjustment and serverless' : k === 'warehouses' ? 'Owners and recommendations' : k === 'meter' ? 'What was metered per hour' : 'Who ran the queries'}</small>
            </div>
          ))}
        </div>
        {!counts.meter && !counts.usage && <Empty title="No data yet"><p className="muted">Start with WAREHOUSE_METERING_HISTORY and the query attribution export. <Link href="/docs">Get the SQL</Link>, or open the <Link href="/app?sample=acme">synthetic sample</Link> to look around first.</p></Empty>}
        {project.imports.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>File</th><th>Type</th><th className="num">Rows</th><th className="num">Skipped</th><th>Imported</th></tr></thead>
              <tbody>{[...project.imports].reverse().map(i => <tr key={i.id}><th scope="row" className="break">{i.fileName}</th><td>{KINDS[i.kind].title}</td><td className="num">{i.rows.toLocaleString()}</td><td className="num">{i.skipped}</td><td>{new Date(i.at).toLocaleString()}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        {!project.sampleId && rawSize > 0 && <p className="muted small">Raw data on this device: {(rawSize / 1e6).toFixed(2)} MB. {sync.user ? rawSize > RAW_SYNC_LIMIT ? 'Too large to sync; rules, budgets and snapshots sync, raw rows stay here.' : 'Small enough to sync with your account.' : 'Sign in to sync rules, budgets and snapshots across devices.'}</p>}
      </div>

      {!project.sampleId && data.meter.length > 0 && <WarehouseSettings data={data} id={project.id} reload={reload} />}

      {!project.sampleId && (counts.meter > 0 || counts.usage > 0) && (
        <div className="panel danger-zone">
          <div className="panel-head"><h2>Danger zone</h2></div>
          <div className="row between wrap gap">
            <p className="small">Remove every imported row from this project. Rules, budgets and snapshots stay.</p>
            <button type="button" className="btn danger-ghost sm" onClick={async () => {
              if (!(await ask('Clear imported data?', 'Removes all imported rows from this project on this device. Rules, budgets and snapshots are kept. You can undo for a few seconds.', 'Clear data'))) return
              const before = data
              const imports = project.imports
              await putData(project.id, EMPTY)
              update({ imports: [] })
              reload()
              toast('Imported data cleared', { undo: () => { void putData(project.id, before).then(() => { update({ imports }); reload() }) } })
            }}>Clear imported data</button>
          </div>
        </div>
      )}
    </div>
  )
}

function PendingCard({ p, onChange, onCancel, onCommit }: { p: Pending; onChange(p: Pending): void; onCancel(): void; onCommit(p: Pending, rows: unknown[], skipped: number): void }) {
  const headers = p.csv.rows[0]
  const first = p.csv.rows[1] ?? []
  const v = useMemo(() => p.kind ? validate(p.kind, p.csv, p.map) : null, [p.kind, p.csv, p.map])
  const [showAll, setShowAll] = useState(false)
  const issues = v?.issues ?? []
  return (
    <div className="pending">
      <div className="row between wrap gap-sm">
        <div><strong className="break">{p.name}</strong> <span className="muted small">{(p.csv.rows.length - 1).toLocaleString()} rows, {headers.length} columns</span></div>
        <label className="ctl inline"><span>Detected as</span>
          <select value={p.kind ?? ''} onChange={e => { const k = (e.target.value || null) as Kind | null; onChange({ ...p, kind: k, map: k ? autoMap(k, headers) : {} }) }}>
            <option value="">Unknown: pick a type</option>
            {(Object.keys(KINDS) as Kind[]).map(k => <option key={k} value={k}>{KINDS[k].title} ({KINDS[k].view})</option>)}
          </select>
        </label>
      </div>
      {!p.kind ? <p className="warn-text small">The columns do not match any export we know. Pick the type and map the columns by hand, or check the SQL in the docs.</p> : (
        <>
          <div className="mapping">
            {KINDS[p.kind].fields.map(f => (
              <label key={f.key} className="map-row">
                <span>{f.label}{f.required && <b className="req" aria-label="required">*</b>}</span>
                <select value={p.map[f.key] ?? ''} onChange={e => { const m = { ...p.map }; if (e.target.value === '') delete m[f.key]; else m[f.key] = Number(e.target.value); onChange({ ...p, map: m }) }} aria-invalid={f.required && p.map[f.key] === undefined}>
                  <option value="">Not in file</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                </select>
                <code className="sample">{p.map[f.key] !== undefined ? (first[p.map[f.key]] ?? '').slice(0, 32) || '(empty)' : ''}</code>
              </label>
            ))}
          </div>
          {v && (
            <div className={`report ${v.issues.length ? (v.rows.length ? 'warn' : 'bad') : 'good'}`}>
              <div className="row between wrap gap-sm">
                <span><b>{v.rows.length.toLocaleString()}</b> {v.rows.length === 1 ? 'row' : 'rows'} ready{v.skipped ? <>, <b>{v.skipped.toLocaleString()}</b> skipped</> : ''}{issues.length ? `, ${issues.length.toLocaleString()} issues` : ', no issues'}</span>
                {issues.length > 0 && <button type="button" className="btn ghost sm" onClick={() => download(`${p.name.replace(/\.\w+$/, '')}-issues.csv`, toCsv([['line', 'issue'], ...issues.map(i => [i.line, i.message])]))}>Download report</button>}
              </div>
              {issues.length > 0 && (
                <ul className="issues">
                  {issues.slice(0, showAll ? 200 : 6).map((i, k) => <li key={k}><span className="mono">line {i.line}</span> {i.message}</li>)}
                  {issues.length > 6 && !showAll && <li><button type="button" className="linkish small" onClick={() => setShowAll(true)}>Show more</button></li>}
                </ul>
              )}
            </div>
          )}
          <div className="row end gap-sm">
            <button type="button" className="btn ghost sm" onClick={onCancel}>Discard</button>
            <button type="button" className="btn primary sm" disabled={!v || !v.rows.length} onClick={() => v && onCommit(p, v.rows, v.skipped)}>Import {v?.rows.length.toLocaleString()} rows</button>
          </div>
        </>
      )}
    </div>
  )
}

function WarehouseSettings({ data, id, reload }: { data: Dataset; id: string; reload(): void }) {
  const names = [...new Set(data.meter.map(m => m.warehouse))].sort()
  const get = (n: string) => data.warehouses.find(w => w.name.toUpperCase() === n.toUpperCase())
  const save = async (n: string, p: Partial<WarehouseInfo>) => {
    const cur = get(n) ?? { name: n, size: 'X-Small', autoSuspend: 600 }
    const next = mergeRows(data, 'warehouses', [{ ...cur, ...p }])
    await putData(id, next)
    reload()
  }
  return (
    <div className="panel">
      <div className="panel-head"><h2>Warehouse settings</h2><span className="muted small">From SHOW WAREHOUSES, or set them here</span></div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Warehouse</th><th>Size</th><th>Auto-suspend (s)</th></tr></thead>
          <tbody>
            {names.map(n => {
              const w = get(n)
              return (
                <tr key={n}>
                  <th scope="row" className="mono">{n}</th>
                  <td><select aria-label={`${n} size`} value={w?.size ? SIZE_LABEL.find(l => l.toUpperCase().replace(/[-\s]/g, '') === w.size.toUpperCase().replace(/[-\s_]/g, '')) ?? w.size : ''} onChange={e => void save(n, { size: e.target.value })}>
                    {!w && <option value="">Unknown</option>}
                    {w && !SIZE_LABEL.some(l => l.toUpperCase().replace(/[-\s]/g, '') === w.size.toUpperCase().replace(/[-\s_]/g, '')) && <option value={w.size}>{w.size}</option>}
                    {SIZE_LABEL.map(l => <option key={l} value={l}>{l}</option>)}
                  </select></td>
                  <td><input aria-label={`${n} auto-suspend seconds`} type="number" min="0" step="60" defaultValue={w?.autoSuspend ?? ''} placeholder="unknown" onBlur={e => { if (e.target.value !== '') void save(n, { autoSuspend: Number(e.target.value) }) }} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
