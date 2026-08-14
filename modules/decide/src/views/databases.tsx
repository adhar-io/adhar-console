import { Card, CardBody, EmptyState, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { useDatabases, useQuestions } from '../data/bi.ts'

const ENGINE_ICON: Record<string, string> = {
  snowflake: '❄️',
  bigquery: '☁️',
  postgres: '🐘',
  mysql: '🐬',
  redshift: '🟧',
  h2: '🧪',
  clickhouse: '🟦',
}

export function Databases() {
  const dbs = useDatabases()
  const questions = useQuestions()

  if (dbs.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading databases…
      </div>
    )
  }
  const list = dbs.data ?? []
  if (list.length === 0) {
    return <EmptyState title="No databases" description="Register a database in Metabase to populate this list." />
  }
  const usedBy = (id: number) => (questions.data ?? []).filter((q) => q.database_id === id).length

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {list.map((d) => (
        <Card key={d.id}>
          <CardBody className="space-y-3 p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-2xl ring-1 ring-inset ring-brand-200">
                {ENGINE_ICON[d.engine] ?? '🗄️'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-content">{d.name}</span>
                  {d.is_sample ? <StatusBadge kind="info">sample</StatusBadge> : null}
                </div>
                <div className="text-[11px] text-content-subtle">{d.engine}</div>
              </div>
            </div>
            {d.description ? (
              <p className="line-clamp-2 text-xs leading-relaxed text-content-muted">{d.description}</p>
            ) : null}
            <div className="grid grid-cols-3 gap-2 text-center">
              <Mini label="Schemas" value={d.schema_count ?? 0} />
              <Mini label="Tables" value={d.table_count ?? 0} />
              <Mini label="Used by" value={usedBy(d.id)} accent="brand" />
            </div>
            <div className="text-[11px] text-content-muted">
              <a href="?sql" className="font-medium text-brand-700 hover:underline">
                Open SQL editor →
              </a>
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  )
}

function Mini({
  label,
  value,
  accent = 'slate',
}: {
  label: string
  value: number | string
  accent?: 'slate' | 'brand'
}) {
  const tone = accent === 'brand' ? 'text-brand-700' : 'text-content'
  return (
    <div className="rounded-md border border-edge-subtle bg-surface-sunken/40 p-2">
      <div className={`text-base font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
    </div>
  )
}
