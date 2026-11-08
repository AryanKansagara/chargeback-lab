import { useSyncExternalStore } from 'react'
import type { Snapshot } from './engine/insights.ts'
import type { Config, Dataset } from './engine/types.ts'
import type { Kind } from './engine/csv.ts'

export interface ImportMeta {
  id: string
  kind: Kind
  fileName: string
  rows: number
  skipped: number
  at: number
}

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  config: Config
  snapshots: Snapshot[]
  imports: ImportMeta[]
  /** Built-in synthetic account; its data is regenerated instead of stored. */
  sampleId?: string
  /** True when this device has no copy of the raw data (synced from another device). */
  dataMissing?: boolean
}

// ---------- Tiny IndexedDB wrapper (falls back to memory in private modes) ----------

const DB = 'chargeback'
let dbp: Promise<IDBDatabase | null> | null = null
function db(): Promise<IDBDatabase | null> {
  return dbp ??= new Promise(res => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('projects', { keyPath: 'id' })
        req.result.createObjectStore('data')
      }
      req.onsuccess = () => res(req.result)
      req.onerror = () => res(null)
    } catch { res(null) }
  })
}
const mem = { projects: new Map<string, unknown>(), data: new Map<string, unknown>() }

async function tx<T>(store: 'projects' | 'data', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  if (!d) throw new Error('no-idb')
  return new Promise((res, rej) => {
    const r = fn(d.transaction(store, mode).objectStore(store))
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}

async function idbGetAll<T>(store: 'projects'): Promise<T[]> {
  try { return await tx(store, 'readonly', s => s.getAll()) as T[] } catch { return [...mem[store].values()] as T[] }
}
async function idbGet<T>(store: 'projects' | 'data', key: string): Promise<T | undefined> {
  try { return await tx(store, 'readonly', s => s.get(key)) as T | undefined } catch { return mem[store].get(key) as T | undefined }
}
async function idbPut(store: 'projects' | 'data', value: unknown, key?: string) {
  try { await tx(store, 'readwrite', s => key === undefined ? s.put(value) : s.put(value, key)) } catch { mem[store].set(key ?? (value as { id: string }).id, value) }
}
async function idbDel(store: 'projects' | 'data', key: string) {
  try { await tx(store, 'readwrite', s => s.delete(key)) } catch { mem[store].delete(key) }
}

// ---------- In-memory project list with subscribers ----------

let projects: Project[] = []
let loaded = false
const subs = new Set<() => void>()
const emit = () => { projects = [...projects]; subs.forEach(f => f()) }
const changeHooks = new Set<(p: Project) => void>()

export const onProjectChange = (f: (p: Project) => void) => { changeHooks.add(f); return () => changeHooks.delete(f) }

export async function loadProjects() {
  projects = (await idbGetAll<Project>('projects')).sort((a, b) => b.updatedAt - a.updatedAt)
  loaded = true
  emit()
}

export function useProjects() {
  return useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f) }, () => loaded ? projects : null)
}

export const getProjects = () => projects
export const getProject = (id: string) => projects.find(p => p.id === id)

export async function saveProject(p: Project, opts: { touch?: boolean; silent?: boolean } = {}) {
  const next = opts.touch === false ? p : { ...p, updatedAt: Date.now() }
  await idbPut('projects', next)
  const i = projects.findIndex(x => x.id === p.id)
  if (i >= 0) projects[i] = next
  else projects.unshift(next)
  projects.sort((a, b) => b.updatedAt - a.updatedAt)
  emit()
  if (!opts.silent) changeHooks.forEach(f => f(next))
  return next
}

/** Deletes locally; returns an undo function that restores the project and its data. */
export async function deleteProject(id: string): Promise<() => Promise<void>> {
  const p = getProject(id)
  const data = await idbGet<Dataset>('data', id)
  projects = projects.filter(x => x.id !== id)
  emit()
  await idbDel('projects', id)
  await idbDel('data', id)
  addTombstone(id)
  return async () => {
    if (!p) return
    removeTombstone(id)
    if (data) await idbPut('data', data, id)
    await saveProject(p)
  }
}

export const getData = (id: string) => idbGet<Dataset>('data', id)
export const putData = (id: string, ds: Dataset) => idbPut('data', ds, id)

export const uuid = () => crypto.randomUUID()

// Tombstones keep a project deleted offline from coming back on the next sync.
const TOMB = 'chargeback.tombstones'
export const tombstones = (): string[] => { try { return JSON.parse(localStorage.getItem(TOMB) ?? '[]') } catch { return [] } }
const addTombstone = (id: string) => localStorage.setItem(TOMB, JSON.stringify([...new Set([...tombstones(), id])]))
const removeTombstone = (id: string) => localStorage.setItem(TOMB, JSON.stringify(tombstones().filter(x => x !== id)))
export const clearTombstones = (ids: string[]) => localStorage.setItem(TOMB, JSON.stringify(tombstones().filter(x => !ids.includes(x))))

// ---------- App defaults (settings page) ----------

export interface Defaults { pricePerCredit: number; idleMethod: Config['idleMethod']; carryHours: number }
const DEF_KEY = 'chargeback.defaults'
export function getDefaults(): Defaults {
  try { return { pricePerCredit: 3, idleMethod: 'credits', carryHours: 2, ...JSON.parse(localStorage.getItem(DEF_KEY) ?? '{}') } } catch { return { pricePerCredit: 3, idleMethod: 'credits', carryHours: 2 } }
}
export const setDefaults = (d: Defaults) => localStorage.setItem(DEF_KEY, JSON.stringify(d))

export function blankConfig(): Config {
  const d = getDefaults()
  return { rules: [], idleMethod: d.idleMethod, pricePerCredit: d.pricePerCredit, owners: {}, budgets: {}, carryHours: d.carryHours }
}
