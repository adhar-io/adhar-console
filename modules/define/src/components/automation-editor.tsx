import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Checkbox, EmptyState, Field, Input, Modal, Select, useGiteaOrg, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import { gitea } from '@adhar/api-clients'
import { planeError, useLabels, useProject, useProjectMembers, useStates } from '../data/plane.ts'
import { useGitSync } from '../data/planning-plane.ts'
import { newId, storeError, useAutomationDoc, usePatchAutomation } from '../data/planning-store.ts'
import { type Action, type AutomationRule, describeAction, describeTrigger, type Trigger } from '../data/planning-workflow.ts'
import { Loading, Notice, SectionTitle } from './planning-ui.tsx'

/**
 * Console-side automation for one project: rules ("when … then …") kept in
 * the console's store (`define.automation`) and run BY THE CONSOLE when
 * someone acts in it — moving a card, assigning, creating, completing a
 * sprint — or when "Sync now" reads the watched Gitea repositories' pull
 * requests. Changes made directly in Plane do not trigger them.
 */

const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })

type TriggerKind = Trigger['kind']
type ActionKind = Action['kind']

export function AutomationEditor({ projectId }: { projectId: string }) {
  const doc = useAutomationDoc(projectId)
  const save = usePatchAutomation()
  const states = useStates(projectId)
  const labels = useLabels(projectId)
  const members = useProjectMembers(projectId)
  const project = useProject(projectId)
  const sync = useGitSync(projectId, project.data?.identifier)
  const toast = useToast()
  const [editing, setEditing] = useState<AutomationRule | null>(null)

  const names = useMemo(() => ({
    state: (id: string) => states.data?.find((s) => s.id === id)?.name ?? 'a removed state',
    label: (id: string) => labels.data?.find((l) => l.id === id)?.name ?? 'a removed label',
    member: (id: string) => {
      const m = members.data?.find((x) => x.id === id)
      return m?.display_name || m?.email || 'a former member'
    },
  }), [states.data, labels.data, members.data])

  const rules = doc.data?.rules ?? []
  const write = (next: AutomationRule[], msg: string) =>
    save.mutate({ id: projectId, fn: (cur) => ({ ...(cur ?? { rules: [] }), rules: next }) }, { onSuccess: () => toast.success(msg), onError: (e) => toast.error(storeError(e)) })

  const firstOf = (group: string) => states.data?.filter((s) => s.group === group).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))[0]
  const presets: Array<{ label: string; rule: () => AutomationRule | null }> = [
    {
      label: 'PR merged → Done',
      rule: () => {
        const done = firstOf('completed')
        return done ? { id: newId('rule'), name: `PR merged → ${done.name}`, enabled: true, trigger: { kind: 'pr-merged' }, actions: [{ kind: 'set-state', state: done.id }] } : null
      },
    },
    {
      label: 'PR opened → In progress',
      rule: () => {
        const started = states.data?.find((s) => s.group === 'started' && /review/i.test(s.name)) ?? firstOf('started')
        return started ? { id: newId('rule'), name: `PR opened → ${started.name}`, enabled: true, trigger: { kind: 'pr-opened' }, actions: [{ kind: 'set-state', state: started.id }] } : null
      },
    },
    {
      label: 'Assigned → Started',
      rule: () => {
        const started = firstOf('started')
        return started ? { id: newId('rule'), name: `Assigned → ${started.name}`, enabled: true, trigger: { kind: 'assigned' }, when: undefined, actions: [{ kind: 'set-state', state: started.id }] } : null
      },
    },
  ]

  if (doc.isLoading || states.isLoading) return <Loading label="Loading automation…" />
  if (doc.isError) return <Notice tone="warn">{storeError(doc.error)}</Notice>

  return (
    <div className="space-y-6">
      <Notice>
        Automation runs in the console: rules fire when someone acts here — on the board, in a drawer, in a sprint or in intake — or when "Sync now" reads pull requests. Changes made directly in Plane do not trigger them.
      </Notice>

      <section>
        <SectionTitle
          actions={
            <>
              <Select
                controlSize="sm"
                aria-label="Add a preset rule"
                value=""
                onChange={(e) => {
                  const p = presets[Number(e.target.value)]
                  const r = p?.rule()
                  if (!r) return toast.error('This project has no state for that preset.')
                  write([...rules, r], `Added “${r.name}”`)
                }}
                options={[{ value: '', label: 'Add preset…' }, ...presets.map((p, k) => ({ value: String(k), label: p.label }))]}
              />
              <Button size="sm" variant="primary" onClick={() => setEditing({ id: newId('rule'), name: '', enabled: true, trigger: { kind: 'entered-group', group: 'completed' }, actions: [] })}>New rule</Button>
            </>
          }
        >
          Rules · {rules.length}
        </SectionTitle>
        {rules.length === 0
          ? <EmptyState compact title="No automation rules" description="Start from a preset or write one: when something happens to a work item, change its state, priority, labels or assignees." />
          : (
            <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
              {rules.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <input
                    type="checkbox"
                    aria-label={`Enable ${r.name}`}
                    checked={r.enabled}
                    onChange={(e) => write(rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)), e.target.checked ? `Enabled “${r.name}”` : `Paused “${r.name}”`)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-content">{r.name || 'Untitled rule'}</div>
                    <div className="text-[12px] text-content-muted">
                      When {describeTrigger(r.trigger, names.state)}
                      {r.when?.priority?.length ? ` with priority ${r.when.priority.join('/')}` : ''}
                      {r.when?.label ? ` labelled ${names.label(r.when.label)}` : ''}
                      {' → '}
                      {r.actions.length ? r.actions.map((a) => describeAction(a, names)).join(', ') : 'nothing'}
                    </div>
                  </div>
                  <Button size="xs" variant="ghost" onClick={() => setEditing(r)}>Edit</Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`Delete “${r.name}”?`)) write(rules.filter((x) => x.id !== r.id), 'Rule deleted')
                    }}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
      </section>

      <RepoWatch projectId={projectId} repos={doc.data?.repos ?? []} onSync={() =>
        sync.mutate(undefined, {
          onSuccess: (r) => toast.success(r.applied ? `Applied automation to ${r.applied} work item${r.applied === 1 ? '' : 's'}` : 'No new pull requests matched a rule'),
          onError: (e) => toast.error(e instanceof Error && !(e as { status?: number }).status ? e.message : planeError(e, "Couldn't sync pull requests.")),
        })} syncing={sync.isPending} identifier={project.data?.identifier} />

      <section>
        <SectionTitle>Recent runs</SectionTitle>
        {(doc.data?.log ?? []).length
          ? (
            <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised text-[12px]">
              {(doc.data?.log ?? []).slice(0, 15).map((l, k) => (
                <li key={k} className="flex flex-wrap items-center gap-x-3 px-4 py-2">
                  <span className="font-medium text-content">{l.rule}</span>
                  <span className="min-w-0 flex-1 truncate text-content-muted">{l.summary}</span>
                  <span className="text-content-subtle">{formatRelative(l.at)}</span>
                </li>
              ))}
            </ul>
          )
          : <p className="text-[12px] text-content-subtle">Nothing has run yet.</p>}
      </section>

      {editing
        ? (
          <RuleModal
            rule={editing}
            states={states.data ?? []}
            labels={labels.data ?? []}
            members={(members.data ?? []).map((m) => ({ id: m.id, name: m.display_name || m.email || m.id }))}
            saving={save.isPending}
            onClose={() => setEditing(null)}
            onSave={(r) => {
              const exists = rules.some((x) => x.id === r.id)
              write(exists ? rules.map((x) => (x.id === r.id ? r : x)) : [...rules, r], exists ? 'Rule saved' : 'Rule added')
              setEditing(null)
            }}
          />
        )
        : null}
    </div>
  )
}

function RepoWatch({ projectId, repos, onSync, syncing, identifier }: { projectId: string; repos: string[]; onSync(): void; syncing: boolean; identifier?: string }) {
  const org = useGiteaOrg()
  const save = usePatchAutomation()
  const toast = useToast()
  const [pick, setPick] = useState('')
  const list = useQuery({
    queryKey: ['gitea', 'repos', org],
    queryFn: () => giteaClient.listRepos(org),
    enabled: !!org,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const write = (next: string[]) =>
    save.mutate({ id: projectId, fn: (cur) => ({ ...(cur ?? { rules: [] }), rules: cur?.rules ?? [], repos: next }) }, { onError: (e) => toast.error(storeError(e)) })
  const options = (list.data ?? []).map((r) => `${org}/${r.name}`).filter((r) => !repos.includes(r))
  return (
    <section>
      <SectionTitle actions={<Button size="sm" onClick={onSync} loading={syncing} disabled={!repos.length}>Sync now</Button>}>Pull requests · Gitea</SectionTitle>
      <p className="mb-2 text-[12px] text-content-muted">
        Pull requests whose title, branch or description mention a key like <code className="font-mono">{identifier ?? 'KEY'}-42</code> trigger the “pull request merged / opened” rules once each.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Watch repository" hint={list.isError ? 'Gitea repositories could not be listed — type org/repo.' : undefined}>
          {list.isError || !options.length
            ? <Input controlSize="sm" value={pick} onChange={(e) => setPick(e.target.value)} placeholder="org/repo" />
            : <Select controlSize="sm" value={pick} onChange={(e) => setPick(e.target.value)} options={[{ value: '', label: 'Choose a repository…' }, ...options.map((r) => ({ value: r, label: r }))]} />}
        </Field>
        <Button
          size="sm"
          disabled={!/^[^/\s]+\/[^/\s]+$/.test(pick)}
          onClick={() => {
            write([...repos, pick])
            setPick('')
          }}
        >
          Watch
        </Button>
      </div>
      {repos.length
        ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {repos.map((r) => (
              <span key={r} className="inline-flex items-center gap-1.5 rounded-full border border-edge-default bg-surface-raised px-2.5 py-1 text-[12px] text-content">
                {r}
                <button type="button" aria-label={`Stop watching ${r}`} onClick={() => write(repos.filter((x) => x !== r))} className="text-content-subtle hover:text-content">×</button>
              </span>
            ))}
          </div>
        )
        : null}
    </section>
  )
}

const TRIGGERS: Array<{ value: string; label: string }> = [
  { value: 'group:completed', label: 'Moves into Done (completed group)' },
  { value: 'group:started', label: 'Moves into a started state' },
  { value: 'group:cancelled', label: 'Is cancelled' },
  { value: 'state', label: 'Moves to a specific state' },
  { value: 'assigned', label: 'Someone is assigned' },
  { value: 'created', label: 'Is created from the console' },
  { value: 'pr-opened', label: 'A linked pull request is opened' },
  { value: 'pr-merged', label: 'A linked pull request is merged' },
]

function triggerValue(t: Trigger): string {
  return t.kind === 'entered-group' ? `group:${t.group}` : t.kind === 'entered-state' ? 'state' : t.kind
}

function RuleModal({ rule, states, labels, members, saving, onClose, onSave }: {
  rule: AutomationRule
  states: Array<{ id: string; name: string; group: string }>
  labels: Array<{ id: string; name: string }>
  members: Array<{ id: string; name: string }>
  saving: boolean
  onClose(): void
  onSave(r: AutomationRule): void
}) {
  const [draft, setDraft] = useState<AutomationRule>(rule)
  const [addKind, setAddKind] = useState<ActionKind>('set-state')
  const tv = triggerValue(draft.trigger)
  const setTrigger = (v: string) => {
    let t: Trigger
    if (v.startsWith('group:')) t = { kind: 'entered-group', group: v.slice(6) as 'completed' }
    else if (v === 'state') t = { kind: 'entered-state', state: states[0]?.id ?? '' }
    else t = { kind: v as Exclude<TriggerKind, 'entered-group' | 'entered-state'> } as Trigger
    setDraft({ ...draft, trigger: t })
  }
  const newAction = (k: ActionKind): Action => {
    switch (k) {
      case 'set-state':
        return { kind: k, state: states[0]?.id ?? '' }
      case 'set-priority':
        return { kind: k, priority: 'high' }
      case 'add-label':
      case 'remove-label':
        return { kind: k, label: labels[0]?.id ?? '' }
      case 'assign':
        return { kind: k, member: members[0]?.id ?? '' }
      default:
        return { kind: k } as Action
    }
  }
  const setAction = (k: number, a: Action) => setDraft({ ...draft, actions: draft.actions.map((x, j) => (j === k ? a : x)) })
  const valid = draft.name.trim() && draft.actions.length && (draft.trigger.kind !== 'entered-state' || draft.trigger.state)

  return (
    <Modal
      open
      onClose={onClose}
      title={rule.name ? `Edit “${rule.name}”` : 'New automation rule'}
      width="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={saving} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>Save rule</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Merged PRs close the work item" autoFocus />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="When a work item…">
            <Select value={tv} onChange={(e) => setTrigger(e.target.value)} options={TRIGGERS} />
          </Field>
          {draft.trigger.kind === 'entered-state'
            ? (
              <Field label="State">
                <Select value={draft.trigger.state} onChange={(e) => setDraft({ ...draft, trigger: { kind: 'entered-state', state: e.target.value } })} options={states.map((s) => ({ value: s.id, label: s.name }))} />
              </Field>
            )
            : null}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Only with priority" hint="Leave empty for any.">
            <Select
              value={draft.when?.priority?.[0] ?? ''}
              onChange={(e) => setDraft({ ...draft, when: { ...draft.when, priority: e.target.value ? [e.target.value] : undefined } })}
              options={[{ value: '', label: 'Any priority' }, ...['urgent', 'high', 'medium', 'low', 'none'].map((p) => ({ value: p, label: p }))]}
            />
          </Field>
          <Field label="Only with label">
            <Select
              value={draft.when?.label ?? ''}
              onChange={(e) => setDraft({ ...draft, when: { ...draft.when, label: e.target.value || undefined } })}
              options={[{ value: '', label: 'Any label' }, ...labels.map((l) => ({ value: l.id, label: l.name }))]}
            />
          </Field>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-content">Then</div>
          <ul className="space-y-2">
            {draft.actions.map((a, k) => (
              <li key={k} className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-subtle px-3 py-2">
                <span className="text-[12px] font-medium text-content">{ACTION_LABEL[a.kind]}</span>
                {a.kind === 'set-state' ? <Select aria-label="State" value={a.state} onChange={(e) => setAction(k, { ...a, state: e.target.value })} options={states.map((s) => ({ value: s.id, label: s.name }))} /> : null}
                {a.kind === 'set-priority'
                  ? <Select aria-label="Priority" value={a.priority} onChange={(e) => setAction(k, { ...a, priority: e.target.value as typeof a.priority })} options={['urgent', 'high', 'medium', 'low', 'none'].map((p) => ({ value: p, label: p }))} />
                  : null}
                {a.kind === 'add-label' || a.kind === 'remove-label' ? <Select aria-label="Label" value={a.label} onChange={(e) => setAction(k, { ...a, label: e.target.value })} options={labels.map((l) => ({ value: l.id, label: l.name }))} /> : null}
                {a.kind === 'assign' ? <Select aria-label="Person" value={a.member} onChange={(e) => setAction(k, { ...a, member: e.target.value })} options={members.map((m) => ({ value: m.id, label: m.name }))} /> : null}
                <button type="button" className="ml-auto text-[12px] text-content-subtle hover:text-content" onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== k) })}>Remove</button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <Select aria-label="Action" value={addKind} onChange={(e) => setAddKind(e.target.value as ActionKind)} options={Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label }))} />
            <Button size="sm" onClick={() => setDraft({ ...draft, actions: [...draft.actions, newAction(addKind)] })}>Add action</Button>
          </div>
        </div>
        <Checkbox label="Enabled" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
      </div>
    </Modal>
  )
}

const ACTION_LABEL: Record<ActionKind, string> = {
  'set-state': 'Move to state',
  'set-priority': 'Set priority',
  'add-label': 'Add label',
  'remove-label': 'Remove label',
  assign: 'Assign',
  'unassign-all': 'Clear assignees',
  'set-target-today': 'Set due date to today',
}
