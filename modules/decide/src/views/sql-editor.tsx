import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
  useToolPublicUrl,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { metabase } from '@adhar-console/api-clients'
import { useDatabases, useRunQuery } from '../data/bi.ts'
import { MetabaseUnavailable } from './bi-states.tsx'
import { CodeEditor } from '../components/code-editor.tsx'

/**
 * Schema-agnostic starter queries. These use ANSI `information_schema`
 * introspection (portable across Postgres / MySQL / Snowflake / Redshift / H2 /
 * SQL Server) rather than any assumed business schema, so they run against
 * whatever database Metabase actually has connected — and surface a real error
 * honestly if the engine (e.g. BigQuery) shapes introspection differently.
 */
const STARTER_QUERIES: { label: string; sql: string }[] = [
  {
    label: 'List tables',
    sql: 'SELECT table_schema, table_name\nFROM information_schema.tables\nORDER BY 1, 2\nLIMIT 100',
  },
  {
    label: 'List schemas',
    sql: 'SELECT schema_name\nFROM information_schema.schemata\nORDER BY 1',
  },
  {
    label: 'Column catalog',
    sql: 'SELECT table_name, column_name, data_type\nFROM information_schema.columns\nORDER BY 1, 2\nLIMIT 200',
  },
  {
    label: 'Connectivity check',
    sql: 'SELECT 1 AS ok',
  },
]

const DEFAULT_SQL = STARTER_QUERIES[0].sql

/**
 * Native SQL workbench — pick a database, write a query, run it, and
 * inspect the result table. Supports a sample-query gallery to bootstrap.
 */
/**
 * LibreDB Studio — the platform's full database IDE.
 *
 * Studio is a separate first-party app on `libredb.<domain>` with its own
 * Keycloak sign-in and connections pre-provisioned to every platform database,
 * so it opens straight onto real data. It is deliberately opened in a new tab
 * rather than embedded: Studio sends `frame-ancestors 'none'` and
 * `X-Frame-Options: DENY`, and every route redirects to its own login, so an
 * iframe would render nothing. Framing it would mean overriding those headers
 * at the Gateway, which is a security decision for the platform to make rather
 * than something the console should quietly work around.
 */
function StudioBanner({ compact = false }: { compact?: boolean }) {
  const studio = useToolPublicUrl('libredb')
  if (!studio) return null
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-xl border border-edge-default bg-linear-to-br from-brand-50/70 to-surface-raised p-3 dark:from-brand-500/10',
        compact ? '' : 'shadow-sm',
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/12 text-brand-700 dark:text-brand-300">
        <IconDatabase />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-content">LibreDB Studio</div>
        <p className="text-[12px] text-content-muted">
          The full database client — schema browser, saved queries, history and multi-engine
          connections to every platform database. Signs in with the same account.
        </p>
      </div>
      <a
        href={studio}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 rounded-lg border border-edge-default bg-surface-raised px-3 py-1.5 text-xs font-medium text-content transition-colors hover:border-brand-400 hover:text-brand-700 dark:hover:text-brand-300"
      >
        Open Studio ↗
      </a>
    </div>
  )
}

function IconDatabase() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  )
}

export function SqlEditor() {
  const databases = useDatabases()
  const [databaseId, setDatabaseId] = useState<number | null>(null)
  const [sql, setSql] = useState(DEFAULT_SQL)
  const run = useRunQuery()

  useEffect(() => {
    if (!databaseId && databases.data?.length) setDatabaseId(databases.data[0].id)
  }, [databaseId, databases.data])

  const onRun = () => {
    if (databaseId == null) return
    run.mutate({ databaseId, sql })
  }

  // ⌘+Enter / Ctrl+Enter to run.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        onRun()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId, sql])

  if (databases.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading databases…
      </div>
    )
  }
  // Metabase backs the in-console query box, but Studio is the full client and
  // does not depend on Metabase at all — so it stays offered in every state
  // rather than leaving the page a dead end when Metabase is unreachable.
  if (databases.isError) {
    return (
      <div className="space-y-3">
        <StudioBanner />
        <MetabaseUnavailable
          resource="databases"
          error={databases.error}
          onRetry={() => databases.refetch()}
          retrying={databases.isFetching}
        />
      </div>
    )
  }
  if ((databases.data ?? []).length === 0) {
    return (
      <div className="space-y-3">
        <StudioBanner />
        <EmptyState
          title="No databases connected to Metabase"
          description="The in-console query box runs through Metabase. Register a database there, or use LibreDB Studio above, which already has connections to every platform database."
        />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <StudioBanner compact />
      <header className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-raised p-2 shadow-sm">
        <select
          value={databaseId ?? ''}
          onChange={(e) => setDatabaseId(Number(e.target.value))}
          className="rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-xs"
          aria-label="Database"
        >
          {(databases.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} · {d.engine}
            </option>
          ))}
        </select>
        <select
          onChange={(e) => {
            const starter = STARTER_QUERIES.find((s) => s.label === e.target.value)
            if (starter) setSql(starter.sql)
          }}
          className="rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-xs"
          aria-label="Starter query"
          defaultValue=""
        >
          <option value="">Starter queries…</option>
          {STARTER_QUERIES.map((s) => (
            <option key={s.label} value={s.label}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-content-muted">⌘+Enter to run</span>
        <div className="ml-auto">
          <Button
            size="sm"
            onClick={onRun}
            loading={run.isPending}
            disabled={!sql.trim() || databaseId == null}
          >
            Run
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Query</div>
            <div className="text-[11px] text-content-subtle">Native SQL · {databases.data?.find((d) => d.id === databaseId)?.engine ?? '—'}</div>
          </CardHeader>
          <CardBody className="p-0!">
            {/* A real editor, not a textarea: SQL highlighting, bracket
                matching, find and replace, multi-cursor and fullscreen. */}
            <CodeEditor
              value={sql}
              language="sql"
              readOnly={false}
              onChange={setSql}
              onSave={onRun}
              hideToolbar
              height={Math.round(globalThis.innerHeight * 0.6)}
              className="rounded-none border-0"
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-content">Result</div>
                <div className="text-[11px] text-content-subtle">
                  {run.data?.row_count != null
                    ? `${run.data.row_count} row${run.data.row_count === 1 ? '' : 's'}`
                    : 'No results yet'}
                  {run.data?.running_time_ms != null
                    ? ` · ${run.data.running_time_ms}ms`
                    : ''}
                </div>
              </div>
              {run.isError || run.data?.status === 'failed' ? (
                <StatusBadge kind="failed">failed</StatusBadge>
              ) : run.data?.status === 'completed' ? (
                <StatusBadge kind="healthy">completed</StatusBadge>
              ) : null}
            </div>
          </CardHeader>
          <CardBody className="p-0!">
            {run.isPending ? (
              <div className="flex h-[60vh] items-center justify-center">
                <Spinner size={14} />
              </div>
            ) : run.isError ? (
              <div className="m-3 rounded-md border border-rose-200 bg-rose-50/60 p-3 font-mono text-[11px] text-rose-800">
                {(run.error as Error)?.message ?? 'Query request failed — Metabase may be unreachable.'}
              </div>
            ) : run.data ? (
              <ResultPane result={run.data} />
            ) : (
              <div className="flex h-[60vh] items-center justify-center">
                <EmptyState compact title="Press Run to execute the query" />
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function ResultPane({ result }: { result: metabase.QueryResult }) {
  if (result.status === 'failed') {
    return (
      <div className="m-3 rounded-md border border-rose-200 bg-rose-50/60 p-3 font-mono text-[11px] text-rose-800">
        {result.error ?? 'Query failed.'}
      </div>
    )
  }
  if (result.rows.length === 0) {
    return <EmptyState compact title="Query returned no rows" />
  }
  return (
    <div className="max-h-[60vh] overflow-auto">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-surface-sunken/80 backdrop-blur">
          <tr>
            {result.cols.map((c) => (
              <th key={c.name} className="px-3 py-2 text-left font-semibold text-content">
                {c.display_name ?? c.name}
                {c.base_type ? (
                  <span className="ml-1 font-mono text-[9px] uppercase text-content-subtle">
                    {c.base_type.replace('type/', '')}
                  </span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr
              key={i}
              className={`border-t border-edge-subtle ${i % 2 === 0 ? 'bg-surface-raised' : 'bg-surface-sunken/20'}`}
            >
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-1.5 font-mono text-content">
                  {cell == null ? <span className="text-content-subtle">NULL</span> : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
