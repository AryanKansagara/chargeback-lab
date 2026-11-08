# Chargeback

Snowflake cost attribution that assigns every credit to a team, idle time included.

**Live:** https://chargeback-lab.vercel.app

## The pain

`QUERY_ATTRIBUTION_HISTORY` charges each query for its own execution and leaves warehouse idle time out. After teams consolidate warehouses, part of the bill belongs to nobody, and "one warehouse, two teams, who pays?" has no written answer. The usual fix is query tags plus a rule for idle time. Chargeback is that rule, tested, with the statements and CSV finance asks for.

## What it does

- **Docs with copy-paste SQL** against `SNOWFLAKE.ACCOUNT_USAGE` (warehouse metering, query attribution joined to query history, daily metering, `SHOW WAREHOUSES`), with each view's latency and required database role.
- **Guided import**: drop CSVs, the export type is detected from its columns, columns are mapped automatically and can be re-mapped, and every rejected row is reported with its line number. Re-importing a month replaces just that month.
- **Ordered team-mapping rules** on query tag (including JSON keys), role, user, warehouse, database or serverless service, with a test-a-row panel and a loud "fix these first" list of unmapped spend.
- **Allocation engine** (plain TypeScript, 38 tests): hourly metered compute minus attributed query credits is idle; idle is split proportional to query credits, to execution time, evenly among active teams, or to the warehouse owner. Pure-idle hours follow the last active hour (auto-suspend tail). Cloud services get the daily 10% adjustment; serverless and query acceleration are mapped too. Totals reconcile to the metered bill and the residual is explained.
- **Outputs**: printable per-team statements (one page per team), finance CSV, budgets with burn-down and month-end forecast, day-over-day spike list with drivers, idle-waste ranking, `ALTER WAREHOUSE` recommendations with estimated savings and stated assumptions, query-tag adoption score and `ALTER USER ... SET QUERY_TAG` SQL.
- **Workspace**: multiple projects in IndexedDB, monthly snapshots and a month-over-month compare that explains which team grew and why.
- **Optional accounts** (email + password) sync projects, rules and snapshots across devices; everything works signed out.
- Two synthetic sample accounts, clearly labelled.

## Run locally

```bash
npm install
cp .env.example .env   # optional: Supabase URL + publishable key for sync
npm run dev
npm test
npm run build
```

Independent project, not affiliated with Snowflake.
