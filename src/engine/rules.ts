import { UNMAPPED, type Rule, type RuleField } from './types.ts'

export interface Subject {
  tag?: string
  role?: string
  user?: string
  warehouse?: string
  database?: string
  service?: string
}

export const FIELD_LABEL: Record<RuleField, string> = {
  query_tag: 'Query tag',
  tag_key: 'Query tag JSON key',
  role: 'Role',
  user: 'User',
  warehouse: 'Warehouse',
  database: 'Database',
  service_type: 'Serverless service',
}

const jsonCache = new Map<string, unknown>()

/** Query tags are free text; teams often put JSON in them. Returns null when the tag is not a JSON object. */
export function parseTag(tag: string): Record<string, unknown> | null {
  const t = tag.trim()
  if (!t.startsWith('{')) return null
  if (!jsonCache.has(t)) {
    let v: unknown = null
    try { v = JSON.parse(t) } catch { v = null }
    if (jsonCache.size > 5000) jsonCache.clear()
    jsonCache.set(t, v && typeof v === 'object' && !Array.isArray(v) ? v : null)
  }
  return jsonCache.get(t) as Record<string, unknown> | null
}

function readField(rule: Rule, s: Subject): string | undefined {
  switch (rule.field) {
    case 'query_tag': return s.tag
    case 'role': return s.role
    case 'user': return s.user
    case 'warehouse': return s.warehouse
    case 'database': return s.database
    case 'service_type': return s.service
    case 'tag_key': {
      const obj = parseTag(s.tag ?? '')
      if (!obj || !rule.key) return undefined
      let cur: unknown = obj
      for (const part of rule.key.split('.')) {
        if (!cur || typeof cur !== 'object') return undefined
        cur = (cur as Record<string, unknown>)[part]
      }
      return cur === undefined || cur === null || typeof cur === 'object' ? undefined : String(cur)
    }
  }
}

const regexCache = new Map<string, RegExp | null>()
export function compileRegex(src: string): RegExp | null {
  if (!regexCache.has(src)) {
    let r: RegExp | null = null
    try { r = new RegExp(src, 'i') } catch { r = null }
    regexCache.set(src, r)
  }
  return regexCache.get(src)!
}

/** Returns the team this rule assigns, or null when it does not match. Comparisons ignore case. */
export function matchRule(rule: Rule, s: Subject): string | null {
  if (rule.disabled) return null
  const raw = readField(rule, s)
  if (raw === undefined || raw === '') return null
  const v = raw.toLowerCase()
  const want = rule.value.trim().toLowerCase()
  let ok = false
  switch (rule.op) {
    case 'equals': ok = v === want; break
    case 'contains': ok = want !== '' && v.includes(want); break
    case 'starts': ok = want !== '' && v.startsWith(want); break
    case 'regex': ok = !!compileRegex(rule.value)?.test(raw); break
    case 'any': ok = true; break
  }
  if (!ok) return null
  const team = rule.useValue ? raw.trim() : rule.team.trim()
  return team || null
}

/** First matching rule wins. */
export function resolve(rules: Rule[], s: Subject): { team: string; rule: Rule | null } {
  for (const r of rules) {
    const team = matchRule(r, s)
    if (team) return { team, rule: r }
  }
  return { team: UNMAPPED, rule: null }
}

/** Every team a rule set can produce, in rule order (useValue rules contribute nothing static). */
export function staticTeams(rules: Rule[]): string[] {
  const seen: string[] = []
  for (const r of rules) if (!r.useValue && r.team.trim() && !seen.includes(r.team.trim())) seen.push(r.team.trim())
  return seen
}
