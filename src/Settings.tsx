import { useState } from 'react'
import type { IdleMethod } from './engine/types.ts'
import { METHODS } from './projectData.ts'
import { deleteProject, getDefaults, getProjects, setDefaults, type Defaults } from './store.ts'
import { exportAll, RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, setTheme, toast, useDark } from './ui.tsx'

export default function Settings() {
  const [d, setD] = useState<Defaults>(getDefaults)
  const dark = useDark()
  const sync = useSync()
  const save = (p: Partial<Defaults>) => { const next = { ...d, ...p }; setD(next); setDefaults(next); toast('Saved', { tone: 'ok', ttl: 1500 }) }

  return (
    <section className="page narrow settings">
      <div className="eyebrow">Settings</div>
      <h1>Settings</h1>

      <div className="panel">
        <h2>Defaults for new projects</h2>
        <p className="muted small">Existing projects keep their own settings; change those from the project toolbar.</p>
        <label className="field"><span>Price per credit (USD)</span><input type="number" min="0" step="0.01" value={d.pricePerCredit} onChange={e => save({ pricePerCredit: Math.max(0, Number(e.target.value)) })} /></label>
        <label className="field"><span>Idle split method</span>
          <select value={d.idleMethod} onChange={e => save({ idleMethod: e.target.value as IdleMethod })}>{(Object.keys(METHODS) as IdleMethod[]).map(m => <option key={m} value={m}>{METHODS[m].label}</option>)}</select>
        </label>
        <p className="muted small">{METHODS[d.idleMethod].body}</p>
        <label className="field"><span>Idle carry window (hours)</span><input type="number" min="0" max="24" value={d.carryHours} onChange={e => save({ carryHours: Math.min(24, Math.max(0, Number(e.target.value))) })} /></label>
      </div>

      <div className="panel">
        <h2>Appearance</h2>
        <div className="seg-control" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked={!dark} className={!dark ? 'on' : ''} onClick={() => setTheme('light')}>Light</button>
          <button type="button" role="radio" aria-checked={dark} className={dark ? 'on' : ''} onClick={() => setTheme('dark')}>Dark</button>
        </div>
      </div>

      <div className="panel">
        <h2>Your data</h2>
        <p>Projects live in this browser (IndexedDB). {sync.user ? <>Signed in as <b>{sync.user.email}</b>: rules, budgets, snapshots and raw data under {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB per project sync to your account.</> : 'Sign in from the account menu (top right) to sync across devices. It is optional.'}</p>
        <div className="row gap wrap">
          <button type="button" className="btn ghost" onClick={async () => download(`chargeback-export-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())}>Export all my data (JSON)</button>
          <button type="button" className="btn danger-ghost" onClick={async () => {
            const list = getProjects()
            if (!list.length) { toast('Nothing to delete'); return }
            if (!(await ask('Delete all local projects?', `Removes ${list.length} project${list.length > 1 ? 's' : ''} from this browser${sync.user ? ' and from your cloud account' : ''}. You can undo for a few seconds.`, 'Delete everything'))) return
            const undos = await Promise.all(list.map(p => deleteProject(p.id)))
            toast(`Deleted ${list.length} projects`, { undo: () => { for (const u of undos) void u() } })
          }}>Delete all projects</button>
        </div>
      </div>

      <div className="panel">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>7</kbd></dt><dd>Switch project tabs</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next month</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Save a snapshot</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Printable statements</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>Show shortcuts in a project</dd></div>
        </dl>
      </div>
    </section>
  )
}
