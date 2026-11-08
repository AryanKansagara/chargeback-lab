// Optional cloud sync. Local-first: everything works signed out; signing in merges projects by id, last write wins.
import { useSyncExternalStore } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Snapshot } from './engine/insights.ts'
import { clearTombstones, getData, getProjects, loadProjects, onProjectChange, putData, saveProject, tombstones, type Project } from './store.ts'
import type { Dataset } from './engine/types.ts'

export const APP_ID = 'chargeback'
/** Raw uploads above this stay on the device; config, rules and snapshots always sync. */
export const RAW_SYNC_LIMIT = 1_500_000

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
export const cloudConfigured = !!(URL_ && KEY)

export type SyncStatus = 'local' | 'syncing' | 'synced' | 'offline' | 'error'
interface State { user: { id: string; email: string } | null; status: SyncStatus; error: string | null; lastSynced: number | null; ready: boolean }
let state: State = { user: null, status: 'local', error: null, lastSynced: null, ready: false }
const subs = new Set<() => void>()
const set = (p: Partial<State>) => { state = { ...state, ...p }; subs.forEach(f => f()) }
export const useSync = () => useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f) }, () => state)
export const getSyncState = () => state

let clientP: Promise<SupabaseClient> | null = null
function client(): Promise<SupabaseClient> {
  if (!cloudConfigured) return Promise.reject(new Error('Cloud sync is not configured for this build.'))
  return clientP ??= import('@supabase/supabase-js').then(({ createClient }) => {
    const c = createClient(URL_!, KEY!, { auth: { persistSession: true, autoRefreshToken: true } })
    c.auth.onAuthStateChange((_e, session) => {
      const u = session?.user
      set({ user: u ? { id: u.id, email: u.email ?? '' } : null, status: u ? state.status === 'local' ? 'synced' : state.status : 'local' })
    })
    return c
  })
}

const hasStoredSession = () => Object.keys(localStorage).some(k => k.startsWith('sb-') && k.endsWith('-auth-token'))

/** Called once at boot. Only loads the Supabase client if a session is already stored. */
export async function initSync() {
  onProjectChange(() => schedule())
  addEventListener('online', () => { if (state.user) void syncNow() })
  addEventListener('offline', () => { if (state.user) set({ status: 'offline' }) })
  if (!hasStoredSession()) { set({ ready: true }); return }
  try {
    const c = await client()
    const { data } = await c.auth.getSession()
    const u = data.session?.user
    set({ user: u ? { id: u.id, email: u.email ?? '' } : null, ready: true })
    if (u) void syncNow()
  } catch (e) {
    set({ ready: true, status: 'error', error: msg(e) })
  }
}

const msg = (e: unknown) => {
  const m = e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e)
  return /fetch|network|load failed/i.test(m) ? 'Could not reach the sync server. Your work is safe on this device.' : m
}

export async function signUp(email: string, password: string) {
  const c = await client()
  const { data, error } = await c.auth.signUp({ email, password })
  if (error) throw new Error(error.message)
  if (!data.session) {
    // Confirmation is off for this project, but sign in explicitly in case the session was not returned.
    await signIn(email, password)
    return
  }
  set({ user: { id: data.user!.id, email } })
  await syncNow()
}

export async function signIn(email: string, password: string) {
  const c = await client()
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
  set({ user: { id: data.user.id, email: data.user.email ?? email } })
  await syncNow()
}

export async function signOut() {
  const c = await client()
  await c.auth.signOut()
  set({ user: null, status: 'local', lastSynced: null, error: null })
}

let timer: ReturnType<typeof setTimeout> | undefined
function schedule() {
  if (!state.user) return
  clearTimeout(timer)
  timer = setTimeout(() => void syncNow(), 1500)
}

interface CloudRow { id: string; name: string; data: CloudData; updated_at: string; created_at: string }
interface CloudData { project: Omit<Project, 'snapshots' | 'dataMissing'>; dataset?: Dataset }

let running: Promise<void> | null = null
export function syncNow(): Promise<void> {
  if (!state.user) return Promise.resolve()
  if (running) return running.then(() => syncNow())
  running = doSync().finally(() => { running = null })
  return running
}

async function doSync() {
  if (!navigator.onLine) { set({ status: 'offline' }); return }
  set({ status: 'syncing', error: null })
  try {
    const c = await client()
    const dead = tombstones()
    if (dead.length) {
      const { error } = await c.from('projects').delete().in('id', dead).eq('app', APP_ID)
      if (error) throw error
      clearTombstones(dead)
    }
    const { data: rows, error } = await c.from('projects').select('id,name,data,updated_at,created_at').eq('app', APP_ID)
    if (error) throw error
    const cloud = new Map((rows as CloudRow[]).map(r => [r.id, r]))
    const local = getProjects()
    const ids = [...new Set([...cloud.keys(), ...local.map(p => p.id)])]

    const { data: vrows, error: verr } = ids.length
      ? await c.from('project_versions').select('id,project_id,label,data,created_at').in('project_id', ids)
      : { data: [], error: null }
    if (verr) throw verr
    const cloudVersions = new Map<string, Snapshot[]>()
    for (const v of vrows as { id: string; project_id: string; data: Snapshot }[]) {
      const l = cloudVersions.get(v.project_id) ?? []
      l.push({ ...v.data, id: v.id })
      cloudVersions.set(v.project_id, l)
    }

    for (const id of ids) {
      const lp = local.find(p => p.id === id)
      const cp = cloud.get(id)
      const cvs = cloudVersions.get(id) ?? []
      const cloudTime = cp ? Date.parse(cp.updated_at) : 0
      if (lp && (!cp || lp.updatedAt > cloudTime)) {
        const ds = lp.sampleId ? undefined : await getData(id)
        const raw = ds ? JSON.stringify(ds) : ''
        const { snapshots: _s, dataMissing: _m, ...meta } = lp
        const payload: CloudData = { project: meta, ...(raw && raw.length <= RAW_SYNC_LIMIT ? { dataset: ds } : {}) }
        const { error: e1 } = await c.from('projects').upsert({ id, app: APP_ID, name: lp.name, data: payload, updated_at: new Date(lp.updatedAt).toISOString() })
        if (e1) throw e1
      } else if (cp && (!lp || cloudTime > lp.updatedAt)) {
        const { project, dataset } = cp.data
        const hasLocal = !!(await getData(id))
        if (dataset) await putData(id, dataset)
        await saveProject({ ...project, id, name: cp.name, updatedAt: cloudTime, snapshots: lp?.snapshots ?? [], dataMissing: !project.sampleId && !dataset && !hasLocal }, { touch: false, silent: true })
      }
      // Snapshots: union by id in both directions.
      const now = getProjects().find(p => p.id === id)
      if (!now) continue
      const missingUp = now.snapshots.filter(s => !cvs.some(v => v.id === s.id))
      if (missingUp.length) {
        const { error: e2 } = await c.from('project_versions').insert(missingUp.map(s => ({ id: s.id, project_id: id, label: s.label, data: s })))
        if (e2) throw e2
      }
      const missingDown = cvs.filter(v => !now.snapshots.some(s => s.id === v.id))
      if (missingDown.length) await saveProject({ ...now, snapshots: [...now.snapshots, ...missingDown].sort((a, b) => a.month.localeCompare(b.month)) }, { touch: false, silent: true })
    }
    set({ status: 'synced', lastSynced: Date.now() })
  } catch (e) {
    set({ status: navigator.onLine ? 'error' : 'offline', error: msg(e) })
  }
}

export async function deleteSnapshotCloud(id: string) {
  if (!state.user) return
  try { const c = await client(); await c.from('project_versions').delete().eq('id', id) } catch { /* offline: the next sync may bring it back, which is harmless */ }
}

export async function deleteCloudData() {
  const c = await client()
  const { data: rows } = await c.from('projects').select('id').eq('app', APP_ID)
  const ids = (rows ?? []).map(r => r.id as string)
  if (ids.length) await c.from('project_versions').delete().in('project_id', ids)
  const { error } = await c.from('projects').delete().eq('app', APP_ID)
  if (error) throw new Error(error.message)
  set({ status: 'synced', lastSynced: Date.now() })
}

export async function deleteAccount() {
  const c = await client()
  const { error } = await c.rpc('delete_my_account')
  if (error) throw new Error(error.message)
  await c.auth.signOut()
  set({ user: null, status: 'local', lastSynced: null })
}

export async function exportAll(): Promise<Blob> {
  await loadProjects()
  const list = await Promise.all(getProjects().map(async p => ({ ...p, dataset: p.sampleId ? undefined : await getData(p.id) })))
  return new Blob([JSON.stringify({ app: APP_ID, exportedAt: new Date().toISOString(), projects: list }, null, 1)], { type: 'application/json' })
}
