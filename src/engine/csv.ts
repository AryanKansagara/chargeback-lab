import type { DailyRow, Dataset, MeterRow, UsageRow, WarehouseInfo } from './types.ts'

/** RFC 4180 CSV (quotes, escaped quotes, CRLF, newlines in quotes). Also returns the line each record starts on. */
export function parseCsv(text: string): { rows: string[][]; lines: number[] } {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const delim = sniffDelimiter(text)
  const rows: string[][] = []
  const lines: number[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else {
        if (c === '\n') line++
        field += c
      }
      continue
    }
    if (c === '"' && field === '') quoted = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }
      row = []
      line++
      rowLine = line
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }
  }
  return { rows, lines }
}

function sniffDelimiter(text: string): string {
  const head = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  const counts = [',', '\t', ';', '|'].map(d => [d, head.split(d).length] as const)
  return counts.sort((a, b) => b[1] - a[1])[0][0]
}

/** Parses Snowflake timestamps as exported from Snowsight, SnowSQL or the connectors. Returns UTC ms or NaN. */
export function parseTime(raw: string): number {
  const s = raw.trim()
  if (!s) return NaN
  if (/^\d{10}(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000)
  if (/^\d{13}$/.test(s)) return Number(s)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i)
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', se = '0', frac = '0', tz] = m
    let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, Math.round(Number('0.' + frac) * 1000))
    if (tz && !/^(z|utc)$/i.test(tz)) {
      const sign = tz[0] === '-' ? -1 : 1
      const digits = tz.slice(1).replace(':', '')
      t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000
    }
    return t
  }
  // US style from spreadsheets: 10/1/2026 7:00(:00)( AM)
  const u = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i)
  if (u) {
    let h = Number(u[4] ?? 0)
    if (u[7]) h = (h % 12) + (/pm/i.test(u[7]) ? 12 : 0)
    return Date.UTC(+u[3], +u[1] - 1, +u[2], h, Number(u[5] ?? 0), Number(u[6] ?? 0))
  }
  return NaN
}

export const HOUR = 3600_000
export const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)

export function parseNum(raw: string): number {
  const s = raw.trim().replace(/[,\s$]/g, '')
  if (s === '' || /^null$/i.test(s)) return NaN
  return Number(s)
}

export type Kind = 'meter' | 'usage' | 'daily' | 'warehouses'
type FieldType = 'time' | 'day' | 'num' | 'str'
export interface FieldSpec { key: string; label: string; required?: boolean; type: FieldType; aliases: string[] }

export const KINDS: Record<Kind, { title: string; view: string; fields: FieldSpec[] }> = {
  meter: {
    title: 'Warehouse metering',
    view: 'WAREHOUSE_METERING_HISTORY',
    fields: [
      { key: 'hour', label: 'Hour start', required: true, type: 'time', aliases: ['start_time', 'hour', 'usage_hour'] },
      { key: 'warehouse', label: 'Warehouse', required: true, type: 'str', aliases: ['warehouse_name', 'warehouse'] },
      { key: 'compute', label: 'Compute credits', required: true, type: 'num', aliases: ['credits_used_compute'] },
      { key: 'cloud', label: 'Cloud services credits', type: 'num', aliases: ['credits_used_cloud_services'] },
      { key: 'attributed', label: 'Attributed to queries', type: 'num', aliases: ['credits_attributed_compute_queries'] },
    ],
  },
  usage: {
    title: 'Query attribution',
    view: 'QUERY_ATTRIBUTION_HISTORY + QUERY_HISTORY',
    fields: [
      { key: 'hour', label: 'Hour (or start time)', required: true, type: 'time', aliases: ['hour', 'start_time', 'start_hour'] },
      { key: 'warehouse', label: 'Warehouse', required: true, type: 'str', aliases: ['warehouse_name', 'warehouse'] },
      { key: 'credits', label: 'Attributed credits', required: true, type: 'num', aliases: ['credits_attributed_compute', 'credits'] },
      { key: 'user', label: 'User', type: 'str', aliases: ['user_name', 'user'] },
      { key: 'role', label: 'Role', type: 'str', aliases: ['role_name', 'role'] },
      { key: 'tag', label: 'Query tag', type: 'str', aliases: ['query_tag', 'tag'] },
      { key: 'database', label: 'Database', type: 'str', aliases: ['database_name', 'database'] },
      { key: 'qas', label: 'Query acceleration credits', type: 'num', aliases: ['credits_used_query_acceleration'] },
      { key: 'execMs', label: 'Execution time (ms)', type: 'num', aliases: ['execution_ms', 'execution_time', 'total_execution_ms'] },
      { key: 'queries', label: 'Query count', type: 'num', aliases: ['queries', 'query_count'] },
      { key: 'cloud', label: 'Cloud services credits', type: 'num', aliases: ['credits_used_cloud_services'] },
    ],
  },
  daily: {
    title: 'Daily metering',
    view: 'METERING_DAILY_HISTORY',
    fields: [
      { key: 'day', label: 'Usage date', required: true, type: 'day', aliases: ['usage_date', 'day', 'date'] },
      { key: 'service', label: 'Service type', required: true, type: 'str', aliases: ['service_type'] },
      { key: 'compute', label: 'Compute credits', type: 'num', aliases: ['credits_used_compute'] },
      { key: 'cloud', label: 'Cloud services credits', type: 'num', aliases: ['credits_used_cloud_services'] },
      { key: 'adjustment', label: 'Cloud services adjustment', type: 'num', aliases: ['credits_adjustment_cloud_services'] },
      { key: 'billed', label: 'Credits billed', type: 'num', aliases: ['credits_billed'] },
    ],
  },
  warehouses: {
    title: 'Warehouse settings',
    view: 'SHOW WAREHOUSES',
    fields: [
      { key: 'name', label: 'Name', required: true, type: 'str', aliases: ['name', 'warehouse_name'] },
      { key: 'size', label: 'Size', required: true, type: 'str', aliases: ['size', 'warehouse_size'] },
      { key: 'autoSuspend', label: 'Auto-suspend (s)', type: 'num', aliases: ['auto_suspend'] },
      { key: 'owner', label: 'Owner role', type: 'str', aliases: ['owner'] },
      { key: 'maxClusters', label: 'Max clusters', type: 'num', aliases: ['max_cluster_count'] },
    ],
  },
}

const norm = (h: string) => h.trim().toLowerCase().replace(/^"|"$/g, '').replace(/[\s-]+/g, '_')

export type Mapping = Record<string, number>

export function autoMap(kind: Kind, headers: string[]): Mapping {
  const hs = headers.map(norm)
  const map: Mapping = {}
  for (const f of KINDS[kind].fields) {
    const i = f.aliases.map(a => hs.indexOf(a)).find(i => i >= 0)
    if (i !== undefined) map[f.key] = i
  }
  return map
}

/** Picks the kind whose required columns are all present and that matches the most columns. */
export function detectKind(headers: string[]): Kind | null {
  const hs = new Set(headers.map(norm))
  // credits_attributed_compute_queries only exists in metering; credits_used_compute only in metering/daily.
  let best: Kind | null = null
  let bestScore = 0
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const map = autoMap(kind, headers)
    const fields = KINDS[kind].fields
    if (!fields.every(f => !f.required || f.key in map)) continue
    let score = Object.keys(map).length
    if (kind === 'usage' && hs.has('credits_used_compute')) score -= 5
    if (kind === 'meter' && hs.has('usage_date')) score -= 5
    if (score > bestScore) { best = kind; bestScore = score }
  }
  return best
}

export interface Issue { line: number; message: string }
export interface Validated<T> { rows: T[]; issues: Issue[]; skipped: number; total: number }

/** Turns raw CSV records into typed rows, collecting a line-numbered report of every problem. */
export function validate(kind: Kind, csv: { rows: string[][]; lines: number[] }, map: Mapping): Validated<MeterRow | UsageRow | DailyRow | WarehouseInfo> {
  const fields = KINDS[kind].fields
  const issues: Issue[] = []
  const out: Record<string, unknown>[] = []
  let skipped = 0
  for (const f of fields) if (f.required && !(f.key in map)) issues.push({ line: 1, message: `Required column "${f.label}" is not mapped` })
  if (issues.length) return { rows: [], issues, skipped: csv.rows.length - 1, total: csv.rows.length - 1 }
  for (let r = 1; r < csv.rows.length; r++) {
    const rec = csv.rows[r]
    const line = csv.lines[r]
    const obj: Record<string, unknown> = {}
    let bad = false
    for (const f of fields) {
      const idx = map[f.key]
      const raw = idx === undefined ? '' : (rec[idx] ?? '')
      if (f.type === 'str') { obj[f.key] = raw.trim(); if (f.required && !raw.trim()) { issues.push({ line, message: `${f.label} is empty` }); bad = true } continue }
      if (f.type === 'time' || f.type === 'day') {
        const t = parseTime(raw)
        if (Number.isNaN(t)) { issues.push({ line, message: `${f.label} "${raw.slice(0, 40)}" is not a date/time` }); bad = true; continue }
        obj[f.key] = f.type === 'time' ? hourOf(t) : dayOf(t)
        continue
      }
      const n = parseNum(raw)
      if (Number.isNaN(n)) {
        if (raw.trim() && !/^null$/i.test(raw.trim())) { issues.push({ line, message: `${f.label} "${raw.slice(0, 40)}" is not a number` }); bad = true }
        else if (f.required) { issues.push({ line, message: `${f.label} is empty` }); bad = true }
        obj[f.key] = f.key === 'autoSuspend' ? null : f.key === 'queries' ? 1 : 0
      } else if (n < 0 && f.key !== 'adjustment') { issues.push({ line, message: `${f.label} is negative (${n})` }); bad = true }
      else obj[f.key] = n
    }
    if (rec.length < 2 && rec[0]?.trim() === '') continue
    if (bad) { skipped++; continue }
    out.push(obj)
  }
  if (kind === 'daily') for (const o of out) {
    if (!('billed' in o) || map.billed === undefined) o.billed = Number(o.compute) + Number(o.cloud) + Number(o.adjustment)
  }
  if (kind === 'usage') for (const o of out) { if (map.queries === undefined) o.queries = 1 }
  if (kind === 'meter') for (const o of out) { if (map.attributed === undefined) delete o.attributed }
  return { rows: out as never, issues, skipped, total: csv.rows.length - 1 }
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map(r => r.map(v => {
    const s = typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : v
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n') + '\n'
}

const KIND_KEY: Record<Kind, keyof Dataset> = { meter: 'meter', usage: 'usage', daily: 'daily', warehouses: 'warehouses' }

function monthOfRow(kind: Kind, r: Record<string, unknown>): string | null {
  if (kind === 'warehouses') return null
  if (kind === 'daily') return String(r.day).slice(0, 7)
  return new Date(Number(r.hour)).toISOString().slice(0, 7)
}

/** New rows replace existing rows of the same kind for the months the file covers; other months are kept. */
export function mergeRows(ds: Dataset, kind: Kind, rows: unknown[]): Dataset {
  const key = KIND_KEY[kind]
  if (kind === 'warehouses') {
    const byName = new Map(ds.warehouses.map(w => [w.name.toUpperCase(), w]))
    for (const w of rows as WarehouseInfo[]) byName.set(w.name.toUpperCase(), w)
    return { ...ds, warehouses: [...byName.values()] }
  }
  const covered = new Set(rows.map(r => monthOfRow(kind, r as Record<string, unknown>)))
  const kept = (ds[key] as unknown[]).filter(r => !covered.has(monthOfRow(kind, r as Record<string, unknown>)))
  return { ...ds, [key]: [...kept, ...rows] }
}

