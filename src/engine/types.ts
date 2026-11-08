// Shared shapes for the allocation engine. Times are UTC epoch milliseconds at the start of an hour.

/** One row of WAREHOUSE_METERING_HISTORY: what Snowflake metered for a warehouse in an hour. */
export interface MeterRow {
  hour: number
  warehouse: string
  compute: number
  cloud: number
  /** CREDITS_ATTRIBUTED_COMPUTE_QUERIES, kept for the reconciliation cross-check. */
  attributed?: number
}

/**
 * Query credits for one hour and warehouse, grouped by who ran them.
 * Built from QUERY_ATTRIBUTION_HISTORY joined to QUERY_HISTORY (role, database, execution time, cloud services).
 * Per-query exports become rows with queries = 1.
 */
export interface UsageRow {
  hour: number
  warehouse: string
  user: string
  role: string
  tag: string
  database: string
  credits: number
  qas: number
  execMs: number
  queries: number
  cloud: number
}

/** One row of METERING_DAILY_HISTORY. */
export interface DailyRow {
  day: string
  service: string
  compute: number
  cloud: number
  adjustment: number
  billed: number
}

/** SHOW WAREHOUSES output, used for owners and recommendations. */
export interface WarehouseInfo {
  name: string
  size: string
  /** Seconds. 0 or null means the warehouse never suspends. */
  autoSuspend: number | null
  owner?: string
  maxClusters?: number
}

export interface Dataset {
  meter: MeterRow[]
  usage: UsageRow[]
  daily: DailyRow[]
  warehouses: WarehouseInfo[]
}

export type RuleField = 'query_tag' | 'tag_key' | 'role' | 'user' | 'warehouse' | 'database' | 'service_type'
export type RuleOp = 'equals' | 'contains' | 'starts' | 'regex' | 'any'

export interface Rule {
  id: string
  field: RuleField
  /** JSON key inside the query tag, for field = tag_key. Dots reach nested keys. */
  key?: string
  op: RuleOp
  value: string
  /** Team to charge. Ignored when useValue is set. */
  team: string
  /** Use the matched value (e.g. the tag's "team" key) as the team name. */
  useValue?: boolean
  disabled?: boolean
}

export type IdleMethod = 'credits' | 'exec' | 'even' | 'owner'

export interface Config {
  rules: Rule[]
  idleMethod: IdleMethod
  pricePerCredit: number
  /** Warehouse name to owning team, for the owner method and as the fallback for idle nobody can claim. */
  owners: Record<string, string>
  /** Monthly budget per team in dollars. */
  budgets: Record<string, number>
  /** Hours to look back when an hour is pure idle (auto-suspend tail). 0 turns carrying off. */
  carryHours: number
}

export const UNMAPPED = 'Unmapped'
export const UNASSIGNED = 'Unassigned idle'
