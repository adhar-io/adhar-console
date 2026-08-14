import { useMemo, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Modal,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { plane } from '@adhar-console/api-clients'
import { memberDisplayName, memberInitials, useMembers } from '../data/plane.ts'
import {
  krProgress,
  objectiveProgress,
  objectiveStatus,
  statusMeta,
  useCreateObjective,
  useDeleteObjective,
  useObjectives,
  useUpdateObjective,
  type KeyResult,
  type Objective,
  type ObjectiveDraft,
  type OkrStatus,
} from '../data/okrs.ts'
import { ListToolbar } from '../components/list-toolbar.tsx'

/**
 * OKRs — Objectives → Key Results. Each objective rolls its progress up from
 * its KRs and earns a pace-aware on-track / at-risk / off-track status. Cards
 * show a progress ring, KR bars, owner, and quarter; a quarter filter scopes
 * the board and a create/edit modal writes back optimistically.
 */

const CURRENT_QUARTER = currentQuarter()

export function Okrs({ projectId }: { projectId?: string }) {
  const q = useObjectives(projectId)
  const members = useMembers()
  const create = useCreateObjective(projectId)
  const update = useUpdateObjective(projectId)
  const remove = useDeleteObjective(projectId)

  const [search, setSearch] = useState('')
  const [quarter, setQuarter] = useState<string>('all')
  const [editing, setEditing] = useState<Objective | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const memberMap = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.member?.id ?? m.id, m])),
    [members.data],
  )

  if (!projectId) return <EmptyState title="Pick a project" />
  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading objectives…
      </div>
    )
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Couldn't load objectives"
        description={q.error instanceof Error ? q.error.message : 'Unknown error.'}
      />
    )
  }

  const all = q.data ?? []
  const quarters = Array.from(new Set([CURRENT_QUARTER, ...all.map((o) => o.quarter)])).sort(
    (a, b) => (a < b ? 1 : -1),
  )
  const f = search.trim().toLowerCase()
  const rows = all
    .filter((o) => (quarter === 'all' ? true : o.quarter === quarter))
    .filter(
      (o) =>
        !f ||
        o.title.toLowerCase().includes(f) ||
        (o.description ?? '').toLowerCase().includes(f) ||
        o.key_results.some((kr) => kr.title.toLowerCase().includes(f)),
    )

  const summary = summarize(rows)

  return (
    <div className="space-y-5">
      <ListToolbar
        count={all.length}
        noun="objective"
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search objectives…"
        onNew={() => setCreateOpen(true)}
        newLabel="New objective"
        disabled={createOpen || editing !== null}
      />

      {all.length === 0 ? (
        <EmptyState
          title="No objectives yet"
          description="Objectives capture the outcomes this quarter is chasing — click New objective to set one."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <QuarterFilter
              quarters={quarters}
              value={quarter}
              onChange={setQuarter}
            />
            <div className="ml-auto flex items-center gap-2 text-[11px]">
              {summary.map((s) => (
                <span
                  key={s.status}
                  className="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2 py-0.5 font-medium text-content-muted"
                >
                  <span className={cn('h-2 w-2 rounded-full', DOT[s.status])} />
                  {statusMeta(s.status).label}
                  <span className="tabular-nums text-content">{s.count}</span>
                </span>
              ))}
            </div>
          </div>

          {rows.length === 0 ? (
            <EmptyState
              title="No matches"
              description="No objectives match the current quarter or search. Try widening the filter."
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {rows.map((o) => (
                <ObjectiveCard
                  key={o.id}
                  objective={o}
                  owner={memberMap.get(o.ownerId)}
                  onEdit={() => setEditing(o)}
                  onDelete={() => {
                    if (!confirm(`Delete objective "${o.title}"?`)) return
                    remove.mutate(o.id)
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}

      {createOpen ? (
        <ObjectiveModal
          title="New objective"
          members={members.data ?? []}
          defaultQuarter={quarter === 'all' ? CURRENT_QUARTER : quarter}
          saving={create.isPending}
          onClose={() => setCreateOpen(false)}
          onSubmit={(draft) => create.mutate(draft, { onSuccess: () => setCreateOpen(false) })}
        />
      ) : null}

      {editing ? (
        <ObjectiveModal
          title="Edit objective"
          members={members.data ?? []}
          initial={editing}
          saving={update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(draft) =>
            update.mutate({ id: editing.id, draft }, { onSuccess: () => setEditing(null) })
          }
        />
      ) : null}
    </div>
  )
}

const DOT: Record<OkrStatus, string> = {
  'on-track': 'bg-emerald-500',
  'at-risk': 'bg-amber-500',
  'off-track': 'bg-rose-500',
}

function summarize(rows: Objective[]): Array<{ status: OkrStatus; count: number }> {
  const counts: Record<OkrStatus, number> = { 'on-track': 0, 'at-risk': 0, 'off-track': 0 }
  for (const o of rows) counts[objectiveStatus(o)]++
  return (['on-track', 'at-risk', 'off-track'] as OkrStatus[])
    .map((status) => ({ status, count: counts[status] }))
    .filter((s) => s.count > 0)
}

/* ───── objective card ───── */

function ObjectiveCard({
  objective,
  owner,
  onEdit,
  onDelete,
}: {
  objective: Objective
  owner?: plane.Member
  onEdit(): void
  onDelete(): void
}) {
  const progress = objectiveProgress(objective)
  const status = objectiveStatus(objective)
  const meta = statusMeta(status)
  return (
    <Card className="group relative">
      <CardHeader>
        <div className="flex items-start gap-3">
          <ProgressRing value={progress} status={status} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge kind={meta.kind}>{meta.label}</StatusBadge>
              <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                {objective.quarter}
              </span>
            </div>
            <h3 className="mt-1.5 text-sm font-semibold leading-snug text-content">
              {objective.title}
            </h3>
            {objective.description ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-content-muted">
                {objective.description}
              </p>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <ul className="space-y-2.5">
          {objective.key_results.map((kr) => (
            <KeyResultRow key={kr.id} kr={kr} />
          ))}
        </ul>
        <div className="flex items-center justify-between pt-1 text-[11px] text-content-subtle">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-700 ring-2 ring-surface-raised"
              title={memberDisplayName(owner)}
            >
              {memberInitials(owner)}
            </span>
            {memberDisplayName(owner)}
          </span>
          <span className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              onClick={onEdit}
              className="rounded-md px-2 py-0.5 font-medium text-brand-700 hover:bg-brand-50"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded-md px-2 py-0.5 font-medium text-rose-700 hover:bg-rose-50"
            >
              Delete
            </button>
          </span>
        </div>
      </CardBody>
    </Card>
  )
}

function KeyResultRow({ kr }: { kr: KeyResult }) {
  const pct = krProgress(kr)
  const tone = pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-rose-500'
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-content">{kr.title}</span>
        <span className="shrink-0 tabular-nums text-content-muted">
          {fmt(kr.current)}
          <span className="text-content-subtle"> / {fmt(kr.target)}</span>
          {kr.unit ? <span className="text-content-subtle"> {kr.unit}</span> : null}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
          <div
            className={cn('h-full rounded-full transition-[width] duration-500 ease-smooth', tone)}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="w-9 shrink-0 text-right text-[10px] font-medium tabular-nums text-content-subtle">
          {pct}%
        </span>
      </div>
    </li>
  )
}

function ProgressRing({ value, status }: { value: number; status: OkrStatus }) {
  const size = 52
  const stroke = 5
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const dash = (Math.max(0, Math.min(100, value)) / 100) * circ
  const color =
    status === 'on-track'
      ? 'var(--color-emerald-500, #10b981)'
      : status === 'at-risk'
        ? '#f59e0b'
        : '#f43f5e'
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-surface-sunken"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          stroke={color}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ - dash}`}
          className="transition-[stroke-dasharray] duration-700 ease-smooth"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums text-content">
        {value}
        <span className="text-[8px] text-content-subtle">%</span>
      </span>
    </div>
  )
}

function QuarterFilter({
  quarters,
  value,
  onChange,
}: {
  quarters: string[]
  value: string
  onChange(v: string): void
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-surface-sunken p-0.5">
      <QuarterTab active={value === 'all'} onClick={() => onChange('all')}>
        All
      </QuarterTab>
      {quarters.map((qtr) => (
        <QuarterTab key={qtr} active={value === qtr} onClick={() => onChange(qtr)}>
          {qtr}
        </QuarterTab>
      ))}
    </div>
  )
}

function QuarterTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick(): void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center rounded-md px-2.5 text-[11px] font-medium transition-colors',
        active ? 'bg-surface-raised text-content shadow-sm' : 'text-content-muted hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

/* ───── create / edit modal ───── */

interface KrRow {
  id?: string
  title: string
  unit: string
  start: string
  target: string
  current: string
}

function toKrRow(kr: KeyResult): KrRow {
  return {
    id: kr.id,
    title: kr.title,
    unit: kr.unit,
    start: String(kr.start),
    target: String(kr.target),
    current: String(kr.current),
  }
}

function blankKr(): KrRow {
  return { title: '', unit: '', start: '0', target: '100', current: '0' }
}

function ObjectiveModal({
  title,
  members,
  initial,
  defaultQuarter,
  saving,
  onClose,
  onSubmit,
}: {
  title: string
  members: plane.Member[]
  initial?: Objective
  defaultQuarter?: string
  saving: boolean
  onClose(): void
  onSubmit(draft: ObjectiveDraft): void
}) {
  const [name, setName] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [ownerId, setOwnerId] = useState(
    initial?.ownerId ?? members[0]?.member?.id ?? members[0]?.id ?? '',
  )
  const [quarter, setQuarter] = useState(initial?.quarter ?? defaultQuarter ?? CURRENT_QUARTER)
  const [krs, setKrs] = useState<KrRow[]>(
    initial ? initial.key_results.map(toKrRow) : [blankKr(), blankKr()],
  )

  const validKrs = krs.filter((k) => k.title.trim())
  const canSave = !!name.trim() && !!ownerId && validKrs.length > 0

  const setKr = (i: number, patch: Partial<KrRow>) =>
    setKrs((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const submit = () => {
    if (!canSave) return
    onSubmit({
      title: name.trim(),
      description: description.trim() || undefined,
      ownerId,
      quarter,
      key_results: validKrs.map((k) => ({
        id: k.id,
        title: k.title.trim(),
        unit: k.unit.trim(),
        start: num(k.start),
        target: num(k.target, 100),
        current: num(k.current),
      })),
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description="Roll objective progress up from 2–4 measurable key results."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={saving} disabled={!canSave}>
            {initial ? 'Save objective' : 'Create objective'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Objective">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ship a production-ready authentication platform"
            className={INPUT}
          />
        </Field>
        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional — the outcome this objective is chasing."
            className={INPUT}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Owner">
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={INPUT}>
              {members.length === 0 ? <option value="">No members</option> : null}
              {members.map((m) => (
                <option key={m.id} value={m.member?.id ?? m.id}>
                  {memberDisplayName(m)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Quarter">
            <select value={quarter} onChange={(e) => setQuarter(e.target.value)} className={INPUT}>
              {quarterOptions().map((qtr) => (
                <option key={qtr} value={qtr}>
                  {qtr}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
              Key results
            </span>
            <button
              type="button"
              onClick={() => setKrs((rows) => [...rows, blankKr()])}
              disabled={krs.length >= 4}
              className="text-[11px] font-medium text-brand-700 hover:text-brand-800 disabled:opacity-40"
            >
              + Add KR
            </button>
          </div>
          <div className="space-y-2">
            {krs.map((k, i) => (
              <div
                key={i}
                className="rounded-lg border border-edge-default bg-surface-sunken/40 p-2"
              >
                <div className="flex items-center gap-2">
                  <input
                    value={k.title}
                    onChange={(e) => setKr(i, { title: e.target.value })}
                    placeholder={`Key result ${i + 1}`}
                    className="block h-8 flex-1 rounded-md border border-edge-default bg-surface-raised px-2 text-xs focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
                  />
                  {krs.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setKrs((rows) => rows.filter((_, idx) => idx !== i))}
                      aria-label="Remove key result"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-rose-50 hover:text-rose-700"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                <div className="mt-2 grid grid-cols-4 gap-2">
                  <NumField label="Start" value={k.start} onChange={(v) => setKr(i, { start: v })} />
                  <NumField
                    label="Current"
                    value={k.current}
                    onChange={(v) => setKr(i, { current: v })}
                  />
                  <NumField
                    label="Target"
                    value={k.target}
                    onChange={(v) => setKr(i, { target: v })}
                  />
                  <label className="block">
                    <span className="block text-[9px] font-semibold uppercase tracking-wider text-content-subtle">
                      Unit
                    </span>
                    <input
                      value={k.unit}
                      onChange={(e) => setKr(i, { unit: e.target.value })}
                      placeholder="%"
                      className="mt-0.5 block h-7 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-xs focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-content-subtle">
            Progress rolls up automatically — targets below the start value track "reduce" metrics
            like latency.
          </p>
        </div>
      </div>
    </Modal>
  )
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange(v: string): void
}) {
  return (
    <label className="block">
      <span className="block text-[9px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 block h-7 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-xs tabular-nums focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
      />
    </label>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  )
}

const INPUT =
  'block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'

/* ───── helpers ───── */

function num(s: string, fallback = 0): number {
  const n = Number(s)
  return Number.isFinite(n) ? n : fallback
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function currentQuarter(d = new Date()): string {
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`
}

/** Current quarter plus the surrounding few, newest first — for the picker. */
function quarterOptions(): string[] {
  const now = new Date()
  const base = now.getFullYear() * 4 + Math.floor(now.getMonth() / 3)
  const out: string[] = []
  for (let offset = 2; offset >= -3; offset--) {
    const idx = base + offset
    const year = Math.floor(idx / 4)
    const q = (idx % 4) + 1
    out.push(`${year}-Q${q}`)
  }
  return out
}
