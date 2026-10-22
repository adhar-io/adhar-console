import { useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  type Column,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  StatusBadge,
  useToast,
} from '@adhar/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar/utils'
import { type PerfInsights, useSaveSchedule, useScheduleActions } from '../data/perf-automation.ts'
import { cronJobCheck, runScheduleNowChecks, saveScheduleChecks, useAllowedNamespaces } from '../data/access.ts'
import { CRON_PRESETS, cronError, describeCron, nextRuns } from '../data/perf-cron.ts'
import {
  defaultScheduleName,
  DEFAULT_RUNNER_IMAGE,
  type PerfSchedule,
  type ScheduleInput,
  scheduleNameError,
} from '../data/perf-runner.ts'
import type { RunRecord } from '../data/perf-results.ts'
import { VerdictBadge } from './perf-bits.tsx'

/**
 * Schedules — recurring runs as Kubernetes CronJobs.
 *
 * A CronJob is the native answer: it survives the console, it is visible to
 * kubectl and Argo CD, it has history and suspend built in. Each fire starts
 * the in-cluster runner, which runs the committed test, keeps the result and
 * applies the gate — so a nightly regression run needs nobody watching.
 */

export function SchedulesView({ insights, presetTest }: { insights: PerfInsights; presetTest?: string }) {
  const { schedules, records, verdictOf, tests: allTests, configs } = insights
  // RBAC per namespace (docs/rbac.md). A schedule is a CronJob plus the
  // runner and artefact it needs; run-now creates a Job; pause patches and
  // delete deletes the CronJob. New schedules are offered only for tests whose
  // namespace allows writing all of that.
  const nsOf = (t: string) => configs.get(t)?.namespace || 'default'
  const saveNs = useAllowedNamespaces([...allTests.map(nsOf), ...schedules.map((s) => s.namespace)], saveScheduleChecks)
  const scheduleNs = schedules.map((s) => s.namespace)
  const runNowNs = useAllowedNamespaces(scheduleNs, runScheduleNowChecks)
  const patchNs = useAllowedNamespaces(scheduleNs, (ns) => [cronJobCheck('patch', ns)])
  const deleteNs = useAllowedNamespaces(scheduleNs, (ns) => [cronJobCheck('delete', ns)])
  const tests = allTests.filter((t) => saveNs.has(nsOf(t)))
  const canManage = saveNs.size > 0 || runNowNs.size > 0 || patchNs.size > 0 || deleteNs.size > 0
  const toast = useToast()
  const { setSuspended, remove, runNow } = useScheduleActions()
  const [editing, setEditing] = useState<PerfSchedule | 'new' | null>(presetTest ? 'new' : null)
  const [busy, setBusy] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)

  /** The newest result each schedule produced. */
  const lastResult = useMemo(() => {
    const out = new Map<string, RunRecord>()
    for (const r of records) {
      if (!r.schedule) continue
      const k = `${r.namespace}/${r.schedule}`
      const prev = out.get(k)
      if (!prev || (r.startedAt ?? '') > (prev.startedAt ?? '')) out.set(k, r)
    }
    return out
  }, [records])

  const act = (s: PerfSchedule, label: string, fn: () => Promise<unknown>) => {
    const key = `${s.namespace}/${s.name}`
    setBusy(key)
    fn()
      .then(() => toast.success(label))
      .catch((e: Error) => toast.error(`Could not ${label.toLowerCase()}`, { description: e.message }))
      .finally(() => setBusy(null))
  }

  const columns: Column<PerfSchedule>[] = [
    {
      key: 'name',
      header: 'Schedule',
      pinned: true,
      value: (s) => s.name,
      cell: (s) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-content">{s.name}</div>
          <div className="truncate text-[11px] text-content-subtle">{s.description || s.namespace}</div>
        </div>
      ),
    },
    {
      key: 'test',
      header: 'Test',
      value: (s) => s.test,
      cell: (s) => <span className="font-mono text-[12px] text-content">{s.test}</span>,
    },
    {
      key: 'cron',
      header: 'When',
      value: (s) => s.cron,
      cell: (s) => (
        <div className="min-w-0">
          <div className="truncate text-[12px] text-content">{describeCron(s.cron)}</div>
          <div className="truncate font-mono text-[10px] text-content-subtle">
            {s.cron}
            {s.timeZone ? ` · ${s.timeZone}` : ' · UTC'}
          </div>
        </div>
      ),
    },
    {
      key: 'next',
      header: 'Next run',
      value: (s) => (s.suspend ? Infinity : nextRuns(s.cron, Date.now(), 1, s.timeZone)[0] ?? Infinity),
      cell: (s) => {
        if (s.suspend) return <StatusBadge kind="paused">paused</StatusBadge>
        const at = nextRuns(s.cron, Date.now(), 1, s.timeZone)[0]
        return at
          ? <span className="text-[12px] text-content-muted" title={formatAbsolute(at)}>{formatRelative(at)}</span>
          : <span className="text-[12px] text-rose-600 dark:text-rose-400">invalid schedule</span>
      },
    },
    {
      key: 'last',
      header: 'Last run',
      value: (s) => s.lastScheduleTime ?? '',
      cell: (s) => {
        const r = lastResult.get(`${s.namespace}/${s.name}`)
        return (
          <div className="flex items-center gap-2">
            {s.active ? <StatusBadge kind="progressing" pulse>running</StatusBadge> : null}
            {r ? <VerdictBadge verdict={verdictOf(r)} compact /> : null}
            <span className="text-[12px] text-content-muted" title={s.lastScheduleTime ? formatAbsolute(s.lastScheduleTime) : undefined}>
              {s.lastScheduleTime ? formatRelative(s.lastScheduleTime) : 'never'}
            </span>
          </div>
        )
      },
    },
    {
      key: 'gate',
      header: 'Gate',
      value: (s) => (s.enforceGate ? 'enforced' : 'report only'),
      cell: (s) => (s.enforceGate ? <Badge tone="brand">fails the job</Badge> : <Badge>report only</Badge>),
    },
  ]

  if (canManage) {
    columns.push({
      key: 'actions',
      header: '',
      sortable: false,
      filter: false,
      cell: (s) => {
        const key = `${s.namespace}/${s.name}`
        return (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {runNowNs.has(s.namespace)
              ? (
                <Button size="xs" variant="ghost" disabled={busy === key} onClick={() => act(s, `Started ${s.name} now`, () => runNow.mutateAsync(s))}>
                  Run now
                </Button>
              )
              : null}
            {patchNs.has(s.namespace)
              ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy === key}
                  onClick={() =>
                    act(s, s.suspend ? `Resumed ${s.name}` : `Paused ${s.name}`, () =>
                      setSuspended.mutateAsync({ schedule: s, suspend: !s.suspend }))}
                >
                  {s.suspend ? 'Resume' : 'Pause'}
                </Button>
              )
              : null}
            {saveNs.has(s.namespace) ? <Button size="xs" variant="ghost" disabled={busy === key} onClick={() => setEditing(s)}>Edit</Button> : null}
            {deleteNs.has(s.namespace) ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy === key}
              className="text-rose-700 dark:text-rose-300"
              onBlur={() => setArmed(null)}
              onClick={() => {
                if (armed !== key) return setArmed(key)
                setArmed(null)
                act(s, `Deleted ${s.name}`, () => remove.mutateAsync(s))
              }}
            >
              {armed === key ? 'Confirm delete' : 'Delete'}
            </Button>
            ) : null}
          </div>
        )
      },
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-content">Schedules</div>
          <div className="text-[12px] text-content-muted">
            Recurring runs as CronJobs. Each fire runs the committed test, keeps its result and applies its gate — no
            browser needed.
          </div>
        </div>
        {tests.length
          ? (
            <Button className="ml-auto" size="sm" variant="primary" onClick={() => setEditing('new')}>
              New schedule
            </Button>
          )
          : null}
      </div>

      <DataTable
        columns={columns}
        rows={schedules}
        rowKey={(s) => `${s.namespace}/${s.name}`}
        onRowClick={(s) => (saveNs.has(s.namespace) ? setEditing(s) : undefined)}
        tableId="k6-schedules"
        features={{ search: true, filters: true, columns: true, density: true }}
        defaultSort={{ key: 'next', dir: 'asc' }}
        searchPlaceholder="Search schedules…"
        empty={
          <EmptyState
            title="Nothing is scheduled"
            description="A schedule runs a test on a cron — nightly regression runs, hourly smoke tests, a weekly soak. Results land in Results and count towards the pass rate."
            action={tests.length ? <Button variant="primary" onClick={() => setEditing('new')}>New schedule</Button> : undefined}
          />
        }
      />

      {/* "new" waits for the RBAC answer: no test → nothing to schedule into. */}
      {editing && (editing !== 'new' || tests.length)
        ? (
          <ScheduleDialog
            tests={tests}
            namespaceOf={(t) => configs.get(t)?.namespace || 'default'}
            existing={editing === 'new' ? undefined : editing}
            presetTest={presetTest}
            taken={schedules.map((s) => `${s.namespace}/${s.name}`)}
            onClose={() => setEditing(null)}
          />
        )
        : null}
    </div>
  )
}

/* ─────────────────────────── the dialog ─────────────────────────── */

const ZONES = ['UTC', 'Asia/Kolkata', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Singapore', 'Australia/Sydney']

function validZone(tz: string): boolean {
  if (!tz) return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function ScheduleDialog({
  tests,
  namespaceOf,
  existing,
  presetTest,
  taken,
  onClose,
}: {
  tests: string[]
  namespaceOf(test: string): string
  existing?: PerfSchedule
  presetTest?: string
  taken: string[]
  onClose(): void
}) {
  const toast = useToast()
  const save = useSaveSchedule()
  const firstTest = existing?.test ?? presetTest ?? tests[0] ?? ''
  const [test, setTest] = useState(firstTest)
  const [name, setName] = useState(existing?.name ?? defaultScheduleName(firstTest, 'nightly'))
  const [nameTouched, setNameTouched] = useState(Boolean(existing))
  const [cron, setCron] = useState(existing?.cron ?? '0 2 * * *')
  const [timeZone, setTimeZone] = useState(existing?.timeZone ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [enforceGate, setEnforceGate] = useState(existing?.enforceGate ?? true)
  const [suspend, setSuspend] = useState(existing?.suspend ?? false)
  const [retain, setRetain] = useState(existing?.retain ?? 50)
  const [timeoutMin, setTimeoutMin] = useState(Math.round((existing?.timeoutSecs ?? 7200) / 60))
  const [image, setImage] = useState(existing?.image ?? DEFAULT_RUNNER_IMAGE)

  const namespace = existing?.namespace ?? namespaceOf(test)
  const cronErr = cronError(cron)
  const zoneErr = validZone(timeZone) ? null : 'Not a time zone this browser knows — use an IANA name like Europe/Berlin.'
  const nameErr = scheduleNameError(name) ??
    (!existing && taken.includes(`${namespace}/${name}`) ? 'A schedule with that name already exists.' : null)
  const preview = cronErr || zoneErr ? [] : nextRuns(cron, Date.now(), 3, timeZone || undefined)
  const ready = test && !cronErr && !zoneErr && !nameErr && retain >= 1 && timeoutMin >= 1

  const submit = () => {
    const input: ScheduleInput = {
      name,
      namespace,
      test,
      cron: cron.trim(),
      timeZone: timeZone || undefined,
      suspend,
      enforceGate,
      description: description.trim() || undefined,
      image: image.trim() || DEFAULT_RUNNER_IMAGE,
      retain,
      timeoutSecs: timeoutMin * 60,
    }
    save.mutate(input, {
      onSuccess: () => {
        toast.success(existing ? `Updated ${name}` : `Scheduled ${test}`, {
          description: suspend ? 'Saved paused.' : preview[0] ? `First run ${formatRelative(preview[0])}.` : undefined,
        })
        onClose()
      },
      onError: (e: Error) => toast.error('Could not save the schedule', { description: e.message }),
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      branded
      width="lg"
      title={existing ? `Edit ${existing.name}` : 'New schedule'}
      description={`A CronJob in ${namespace} that runs the committed test, records the result and applies its gate.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} loading={save.isPending} onClick={submit}>
            {existing ? 'Save schedule' : 'Create schedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Test">
            <Select
              value={test}
              disabled={Boolean(existing)}
              onChange={(e) => {
                setTest(e.target.value)
                if (!nameTouched) setName(defaultScheduleName(e.target.value, 'nightly'))
              }}
              options={tests.map((t) => ({ value: t, label: t }))}
            />
          </Field>
          <Field label="Name" error={nameErr ?? undefined} hint={existing ? 'The CronJob name cannot change.' : undefined}>
            <Input
              value={name}
              disabled={Boolean(existing)}
              onChange={(e) => {
                setName(e.target.value)
                setNameTouched(true)
              }}
            />
          </Field>
        </div>

        <Field label="Schedule" error={cronErr ?? undefined} hint={cronErr ? undefined : describeCron(cron)}>
          <Input value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono" placeholder="0 2 * * *" />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {CRON_PRESETS.map((p) => (
            <button
              key={p.cron}
              type="button"
              onClick={() => setCron(p.cron)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
                cron.trim() === p.cron
                  ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'
                  : 'border-edge-default text-content-muted hover:text-content',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Time zone" error={zoneErr ?? undefined}>
            <Input value={timeZone} list="perf-tz" onChange={(e) => setTimeZone(e.target.value.trim())} placeholder="UTC" />
            <datalist id="perf-tz">
              {ZONES.map((z) => <option key={z} value={z} />)}
            </datalist>
            <p className="text-[11px] text-content-subtle">Empty means UTC, the controller’s default.</p>
          </Field>
          <div className="rounded-lg border border-edge-default px-3 py-2">
            <div className="text-[11px] font-medium text-content-subtle">Next runs</div>
            {preview.length
              ? preview.map((t) => (
                <div key={t} className="text-[12px] text-content">
                  {formatAbsolute(t)} <span className="text-content-subtle">· {formatRelative(t)}</span>
                </div>
              ))
              : <div className="text-[12px] text-content-subtle">—</div>}
          </div>
        </div>

        <Field label="Description" hint="Optional, shown in the list.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Nightly regression run" />
        </Field>

        <div className="space-y-2">
          <Checkbox
            checked={enforceGate}
            onChange={(e) => setEnforceGate(e.target.checked)}
            label="Fail the job when the gate fails"
            description="The CronJob’s history then shows failing runs as failed Jobs, which alerting on Job failures picks up. Off: the verdict is recorded, the Job succeeds."
          />
          <Checkbox
            checked={suspend}
            onChange={(e) => setSuspend(e.target.checked)}
            label="Paused"
            description="Save it without firing. Resume from the list."
          />
        </div>

        <details className="rounded-lg border border-edge-default px-3 py-2">
          <summary className="cursor-pointer text-[12px] font-medium text-content-muted">Advanced</summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Results kept" hint="Per test; oldest go first.">
              <Input type="number" min={1} max={500} value={String(retain)} onChange={(e) => setRetain(Math.max(1, Number(e.target.value) || 1))} />
            </Field>
            <Field label="Timeout (min)" hint="Gives up waiting after this.">
              <Input type="number" min={1} value={String(timeoutMin)} onChange={(e) => setTimeoutMin(Math.max(1, Number(e.target.value) || 1))} />
            </Field>
            <Field label="Runner image" hint="Needs sh, awk and kubectl.">
              <Input value={image} onChange={(e) => setImage(e.target.value)} className="font-mono" />
            </Field>
          </div>
        </details>

        <p className="text-[11px] text-content-subtle">
          Saving also installs the runner’s ServiceAccount and Role in {namespace} and refreshes the test’s cluster copy
          from its latest commit. Commits made in the console refresh it too; a commit pushed straight to git is picked
          up the next time the test is run or saved here.
        </p>
      </div>
    </Modal>
  )
}
