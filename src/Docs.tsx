import { Code, Link } from './ui.tsx'
import { SIZE_LABEL } from './engine/insights.ts'

// Last full calendar month.
const range = (col: string) => `${col} >= DATE_TRUNC('MONTH', DATEADD('MONTH', -1, CURRENT_DATE()))
  AND ${col} <  DATE_TRUNC('MONTH', CURRENT_DATE())`

const GRANTS = `-- Run once as ACCOUNTADMIN. Gives a FinOps role read access to the views below
-- without handing out IMPORTED PRIVILEGES on the whole SNOWFLAKE database.
USE ROLE ACCOUNTADMIN;
CREATE ROLE IF NOT EXISTS FINOPS;
GRANT DATABASE ROLE SNOWFLAKE.USAGE_VIEWER      TO ROLE FINOPS;  -- metering + attribution
GRANT DATABASE ROLE SNOWFLAKE.GOVERNANCE_VIEWER TO ROLE FINOPS;  -- QUERY_HISTORY (role, database)
GRANT USAGE ON WAREHOUSE ADMIN_WH TO ROLE FINOPS;               -- any small warehouse to run on
GRANT ROLE FINOPS TO USER <your_user>;`

const Q1 = `ALTER SESSION SET TIMEZONE = 'UTC';

SELECT
  start_time,
  warehouse_name,
  credits_used_compute,
  credits_used_cloud_services,
  credits_attributed_compute_queries
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE ${range('start_time')}
ORDER BY start_time, warehouse_name;`

const Q2 = `ALTER SESSION SET TIMEZONE = 'UTC';

-- One row per hour, warehouse and "who": small enough to download,
-- detailed enough for any mapping rule.
SELECT
  DATE_TRUNC('HOUR', qah.start_time)                       AS hour,
  qah.warehouse_name,
  qah.user_name,
  qh.role_name,
  qah.query_tag,
  qh.database_name,
  COUNT(*)                                                 AS queries,
  SUM(qh.execution_time)                                   AS execution_ms,
  SUM(qah.credits_attributed_compute)                      AS credits_attributed_compute,
  SUM(COALESCE(qah.credits_used_query_acceleration, 0))    AS credits_used_query_acceleration,
  SUM(qh.credits_used_cloud_services)                      AS credits_used_cloud_services
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY qah
LEFT JOIN SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY qh
  ON  qh.query_id = qah.query_id
  AND qh.start_time >= DATEADD('DAY', -1, DATE_TRUNC('MONTH', DATEADD('MONTH', -1, CURRENT_DATE())))
WHERE ${range('qah.start_time')}
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY 1, 2;`

const Q3 = `ALTER SESSION SET TIMEZONE = 'UTC';

SELECT
  usage_date,
  service_type,
  credits_used_compute,
  credits_used_cloud_services,
  credits_adjustment_cloud_services,
  credits_billed
FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
WHERE ${range('usage_date')}
ORDER BY usage_date, service_type;`

const Q4 = `SHOW WAREHOUSES;

SELECT "name", "size", "auto_suspend", "owner", "max_cluster_count"
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));`

const SNOWSQL = `snowsql -c finops -f metering.sql \\
  -o output_format=csv -o header=true -o timing=false \\
  -o friendly=false -o quiet=true > metering.csv`

const TAGS = `-- A default tag for a service account (applies to every session it opens)
ALTER USER SVC_TABLEAU SET QUERY_TAG = '{"team":"finance","source":"tableau"}';

-- dbt: set it per project in dbt_project.yml
--   models:
--     +query_tag: '{"team":"data-eng","app":"dbt"}'

-- Check adoption for the last 7 days
SELECT ROUND(100 * SUM(IFF(query_tag <> '', credits_attributed_compute, 0))
             / NULLIF(SUM(credits_attributed_compute), 0), 1) AS pct_tagged
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY
WHERE start_time >= DATEADD('DAY', -7, CURRENT_TIMESTAMP());`

const VIEWS: [string, string, string, string, string][] = [
  ['WAREHOUSE_METERING_HISTORY', 'Credits metered per warehouse per hour, plus the credits attributed to queries in that hour', 'Up to 3 hours (6 hours for CREDITS_USED_CLOUD_SERVICES)', 'USAGE_VIEWER', 'Required'],
  ['QUERY_ATTRIBUTION_HISTORY', 'Compute credits per query, excluding idle time. Queries of about 100 ms or less are not included. Data from mid-August 2024', 'Up to 8 hours', 'USAGE_VIEWER or GOVERNANCE_VIEWER', 'Required'],
  ['QUERY_HISTORY', 'Joined in for role, database, execution time and per-query cloud services', 'Up to 45 minutes', 'GOVERNANCE_VIEWER', 'Joined into the query above'],
  ['METERING_DAILY_HISTORY', 'Billed credits per day and service type, including the cloud services adjustment and serverless features', 'Up to 3 hours', 'USAGE_VIEWER', 'Optional'],
  ['SHOW WAREHOUSES', 'Size, auto-suspend and owner, for recommendations', 'Live', 'Any role that can see the warehouses', 'Optional'],
]

export default function Docs() {
  return (
    <article className="page docs">
      <header className="docs-head">
        <div className="eyebrow">Docs</div>
        <h1>Getting the data out of Snowflake</h1>
        <p className="lede">Four read-only queries against <code>SNOWFLAKE.ACCOUNT_USAGE</code>, each downloaded as CSV. Column names below were checked against Snowflake&rsquo;s reference pages in November 2026. All ACCOUNT_USAGE views keep one year of history.</p>
        <nav className="toc" aria-label="On this page">
          <a href="#access">Access</a><a href="#views">Views and latency</a><a href="#q1">1. Metering</a><a href="#q2">2. Attribution</a><a href="#q3">3. Daily metering</a><a href="#q4">4. Warehouses</a><a href="#export">Export</a><a href="#math">How the math works</a><a href="#pricing">Pricing assumptions</a><a href="#tags">Query tags</a><a href="#monthly">Monthly routine</a>
        </nav>
      </header>

      <section id="access">
        <h2>Access</h2>
        <p>ACCOUNTADMIN can read every view. For a least-privilege role, grant two SNOWFLAKE database roles:</p>
        <Code code={GRANTS} />
      </section>

      <section id="views">
        <h2>Views and latency</h2>
        <p>Run the export after the slowest view has caught up: wait at least <b>8 hours after month end</b> before pulling last month, because QUERY_ATTRIBUTION_HISTORY lags the most. Exporting early shows up on the reconciliation panel as query credits in hours with no metering row.</p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>View</th><th>Used for</th><th>Latency</th><th>Database role</th><th>Needed</th></tr></thead>
            <tbody>{VIEWS.map(v => <tr key={v[0]}><th scope="row" className="mono">{v[0]}</th><td>{v[1]}</td><td>{v[2]}</td><td className="mono small">{v[3]}</td><td>{v[4]}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <section id="q1">
        <h2>1. Warehouse metering (required)</h2>
        <p>What Snowflake metered for each warehouse in each hour. This is the total the allocation reconciles to. <code>CREDITS_ATTRIBUTED_COMPUTE_QUERIES</code> is optional and only used as a cross-check (it is NULL for adaptive warehouses).</p>
        <Code code={Q1} label="metering.sql" />
      </section>

      <section id="q2">
        <h2>2. Query attribution, by hour and who (required)</h2>
        <p>QUERY_ATTRIBUTION_HISTORY has the credits, user and query tag; QUERY_HISTORY adds the role, database and execution time. Grouping by hour keeps a busy account to tens of thousands of rows instead of millions. A raw per-query export also works: any file with <code>START_TIME</code>, <code>WAREHOUSE_NAME</code> and <code>CREDITS_ATTRIBUTED_COMPUTE</code> is accepted and grouped by hour on import.</p>
        <Code code={Q2} label="attribution.sql" />
        <p className="muted small">The extra day on the QUERY_HISTORY side of the join only lets Snowflake prune partitions; it does not change the result. A query that runs across an hour boundary is counted in the hour it started.</p>
      </section>

      <section id="q3">
        <h2>3. Daily metering (optional, recommended)</h2>
        <p>Adds two things the hourly views cannot: the <b>cloud services adjustment</b> (cloud services are billed only for the part above 10% of that day&rsquo;s warehouse compute) and <b>serverless</b> features such as Snowpipe, automatic clustering, serverless tasks and query acceleration. Without it, the adjustment is estimated from the hourly data and serverless is left out.</p>
        <Code code={Q3} label="daily.sql" />
      </section>

      <section id="q4">
        <h2>4. Warehouse settings (optional)</h2>
        <p>Size and auto-suspend drive the recommendations. You can also type them in on the Data tab.</p>
        <Code code={Q4} label="warehouses.sql" />
      </section>

      <section id="export">
        <h2>Export</h2>
        <ol>
          <li><b>Snowsight:</b> run the query, then use the download button above the results and pick CSV.</li>
          <li><b>SnowSQL:</b> save each query to a file and redirect the output:</li>
        </ol>
        <Code code={SNOWSQL} label="shell" />
        <p>Then open a project, go to <b>Data</b>, and drop all four files at once. Each file&rsquo;s type is detected from its header row and the columns are mapped automatically; you can re-map any column, and every rejected row is listed with its line number before anything is imported. Re-importing a month replaces that month only.</p>
      </section>

      <section id="math">
        <h2>How the math works</h2>
        <ol className="math">
          <li><b>Map each query row to a team.</b> Rules run top to bottom; the first match wins. Rules can test the query tag (whole string or a JSON key, nested with dots), role, user, warehouse, database, or serverless service type. No match means <i>Unmapped</i>, which is listed first on the Rules tab.</li>
          <li><b>Idle per warehouse-hour</b> = <code>CREDITS_USED_COMPUTE</code> &minus; the sum of attributed query credits in that hour, never below zero.</li>
          <li><b>Split idle</b> by the chosen method: proportional to query credits, proportional to execution time, evenly among teams active that hour, or all to the warehouse owner.</li>
          <li><b>Hours with no queries</b> (usually the auto-suspend tail) follow the split of the last active hour on that warehouse, for up to the carry window (2 hours by default). After that they go to the warehouse owner, and if there is no owner they show as <i>Unassigned idle</i>.</li>
          <li><b>Cloud services</b> per warehouse-hour are split by each team&rsquo;s own <code>CREDITS_USED_CLOUD_SERVICES</code> from QUERY_HISTORY, or by its share of that hour if those are missing. Each day is then scaled by billed &divide; used from METERING_DAILY_HISTORY.</li>
          <li><b>Serverless</b> rows from METERING_DAILY_HISTORY go through the same rules (field &ldquo;Serverless service&rdquo;). Query acceleration is split by each team&rsquo;s per-query acceleration credits.</li>
          <li><b>Reconcile.</b> Billable = metered compute + billed cloud services + serverless. Allocated = everything assigned to a team or bucket. The residual is shown with its causes: query credits in hours with no metering row, and query credits above what an hour metered.</li>
          <li><b>Dollars</b> = credits &times; your price per credit.</li>
        </ol>
        <p>The engine is plain TypeScript with a test suite covering each method, the carry rule, the 10% adjustment, serverless mapping and reconciliation. It runs entirely in your browser.</p>
      </section>

      <section id="pricing">
        <h2>Pricing assumptions</h2>
        <p><b>As of November 2026.</b> The default is <b>$3.00 per credit</b>, roughly the on-demand list price for Enterprise edition in AWS US East. Standard is lower and Business Critical higher, and prices vary by cloud and region. Capacity contracts are usually discounted. Set your contract rate on each project; the price is stored with every snapshot.</p>
        <p>Recommendations assume standard warehouses, where credits per hour double with each size step:</p>
        <div className="size-table">{SIZE_LABEL.slice(0, 8).map((l, i) => <div key={l}><span>{l}</span><b>{2 ** i}</b></div>)}</div>
        <p className="muted small">A resumed warehouse is billed for at least 60 seconds, then per second. Auto-suspend savings are estimated assuming each idle stretch runs the full auto-suspend window and the workload does not change; the assumptions are listed next to each recommendation.</p>
      </section>

      <section id="tags">
        <h2>Query tags</h2>
        <p>Tags are the cheapest way to make attribution survive warehouse consolidation. Put JSON in them so one rule (&ldquo;use the tag&rsquo;s <code>team</code> key&rdquo;) maps everything. The Optimize tab writes these statements for every untagged user, biggest spend first:</p>
        <Code code={TAGS} />
      </section>

      <section id="monthly">
        <h2>Monthly routine</h2>
        <ol>
          <li>On the 2nd of the month, re-run the four queries for the month that just closed.</li>
          <li>Drop the files into the project&rsquo;s Data tab. Last month is replaced; earlier months stay.</li>
          <li>Clear the <b>Fix these first</b> list on the Rules tab until nothing is unmapped.</li>
          <li>Check the reconciliation residual is near zero, then <b>Save snapshot</b>.</li>
          <li>Print the statements (one page per team) and send finance the CSV.</li>
          <li>Open History to see which team grew and why.</li>
        </ol>
        <p><Link href="/app" className="btn primary">Open your projects</Link></p>
      </section>
    </article>
  )
}
