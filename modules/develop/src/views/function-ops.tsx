import { useMemo, useState } from 'react'
import {
  Button,
  canResource,
  Checkbox,
  CONSOLE_PERMISSIONS,
  Field,
  Input,
  Modal,
  Select,
  StatusBadge,
  type StatusKind,
  Textarea,
  useAccessReview,
  useToast,
} from '@adhar/shell-ui'
import { cn, formatDuration } from '@adhar/utils'
import { type InvokeResult, useDeleteFunction, useDeleteOwningApplication, useInvokeFunction, useOpenOverridesPr } from '../data/functions.ts'
import {
  type ApplicationXR,
  type FunctionState,
  FUNCTIONS_GVR,
  type FunctionXR,
  giteaTreeUrl,
  type GitOpsOwner,
  overlayDir,
  overridesFileName,
  parseHeaderLines,
  prettyBody,
  type RepoRef,
  runtimeLabel,
  type ScaleOverrides,
  scaleView,
  triggerLabel,
  functionTriggers,
  validateOverrides,
} from '../data/functions-model.ts'
import { ExternalLink, Facts, Note, Section } from './function-bits.tsx'

/**
 * The drawer tabs that act: Invoke (a BFF call, never the browser calling the
 * function), Configuration (read-only, changed through a pull request against
 * the environment's overlay) and Delete (through the owning application unless
 * nothing in Git owns the Function).
 *
 * Every action is gated on the RBAC check its request will meet
 * (`useAccessReview` + `canResource`), and says why when the answer is no.
 */

/* ─────────────────────────── Invoke ─────────────────────────── */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const HEADERS_PLACEHOLDER = 'Content-Type: application/json\nX-Request-Id: test-1'
const BODY_PLACEHOLDER = '{\n  "hello": "world"\n}'

function statusKind(code: number): StatusKind {
  if (code >= 500) return 'failed'
  if (code >= 400) return 'paused'
  if (code >= 300) return 'info'
  return 'healthy'
}

export function InvokeTab({ fn, state }: { fn: FunctionXR; state: FunctionState }) {
  const ns = fn.metadata.namespace ?? ''
  const name = fn.metadata.name
  const access = useAccessReview(canResource(FUNCTIONS_GVR, 'get', { namespace: ns, name }))
  const invoke = useInvokeFunction()
  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState('/')
  const [headersText, setHeadersText] = useState('')
  const [body, setBody] = useState('')
  const parsed = useMemo(() => parseHeaderLines(headersText), [headersText])
  const noBody = method === 'GET' || method === 'HEAD'
  const zero = scaleView(fn).min === 0
  const pathOk = path.startsWith('/') && !path.startsWith('//')

  const send = () =>
    invoke.mutate({ namespace: ns, name, method, path, headers: parsed.headers, body: noBody || !body ? undefined : body })

  if (!access.loading && !access.allowed) {
    return (
      <Note tone='warn'>
        Invoking a function needs <span className='font-mono'>get functions.platform.adhar.io</span> on {ns}/{name}
        {access.unknown ? ' — and your permissions could not be checked just now.' : '.'}
      </Note>
    )
  }
  return (
    <div className='space-y-4'>
      <Note>
        The request goes out from the console server, as you, to the function’s own URL — never from your browser.
        {zero ? ' If the function is scaled to zero, the first request cold-starts a pod and takes a few seconds.' : ''}
        {state.health === 'failed' ? ' The function is not serving right now, so expect an error.' : ''}
      </Note>
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]'>
        <Field label='Method'>
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </Field>
        <Field label='Path' hint='appended to the function URL' error={pathOk ? undefined : 'Start with a single "/".'}>
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder='/orders?limit=5' className='font-mono' />
        </Field>
      </div>
      <Field label='Headers' hint='one "Name: value" per line' error={parsed.errors[0]}>
        <Textarea
          rows={3}
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          placeholder={HEADERS_PLACEHOLDER}
          className='font-mono text-[12px]'
        />
      </Field>
      <Field label='Body' hint={noBody ? `${method} carries no body` : 'up to 64 KiB'}>
        <Textarea
          rows={6}
          value={body}
          disabled={noBody}
          onChange={(e) => setBody(e.target.value)}
          placeholder={BODY_PLACEHOLDER}
          className='font-mono text-[12px]'
        />
      </Field>
      <div className='flex items-center gap-3'>
        {access.allowed
          ? (
            <Button variant='primary' onClick={send} loading={invoke.isPending} disabled={!pathOk || parsed.errors.length > 0}>
              Send request
            </Button>
          )
          : null}
        {invoke.isPending ? <span className='text-[12px] text-content-subtle'>Waiting for the function…</span> : null}
      </div>
      {invoke.isError ? <Note tone='warn'>{invoke.error instanceof Error ? invoke.error.message : String(invoke.error)}</Note> : null}
      {invoke.data ? <InvokeResultView result={invoke.data} /> : null}
    </div>
  )
}

function InvokeResultView({ result }: { result: InvokeResult }) {
  const ct = result.headers['content-type']
  return (
    <Section title='Response'>
      <div className='space-y-2 rounded-xl border border-edge-default bg-surface-raised p-3'>
        <div className='flex flex-wrap items-center gap-2 text-[12px]'>
          <StatusBadge kind={statusKind(result.status)}>{result.status} {result.statusText}</StatusBadge>
          <span className='text-content-subtle'>{formatDuration(result.durationMs)}</span>
          <span className='text-content-subtle'>· {result.size.toLocaleString()} bytes{result.truncated ? ' (cut at 256 KiB)' : ''}</span>
          <span className='min-w-0 truncate font-mono text-content-subtle' title={result.url}>· {result.url}</span>
        </div>
        {result.attempts.length > 1
          ? (
            <div className='text-[11px] text-content-subtle'>
              Tried {result.attempts.filter((a) => a.error).map((a) => `${a.url} (${a.error})`).join('; ')} first.
            </div>
          )
          : null}
        <details className='text-[12px]'>
          <summary className='cursor-pointer text-content-muted'>Headers ({Object.keys(result.headers).length})</summary>
          <pre className='mt-1 max-h-48 overflow-auto rounded-md bg-surface-sunken p-2 font-mono text-[11px]'>
            {Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
          </pre>
        </details>
        {result.binary
          ? <Note>Binary body ({ct ?? 'unknown type'}) — not shown.</Note>
          : (
            <pre className='max-h-[50vh] overflow-auto rounded-md bg-surface-sunken p-3 font-mono text-[12px] text-content'>
              {prettyBody(result.body, ct) || <span className='text-content-subtle'>(empty body)</span>}
            </pre>
          )}
      </div>
    </Section>
  )
}

/* ─────────────────────────── Configuration ─────────────────────────── */

export function ConfigurationTab({
  fn,
  env,
  repo,
  owner,
  app,
}: {
  fn: FunctionXR
  env?: string
  repo?: RepoRef
  owner: GitOpsOwner
  app?: ApplicationXR
}) {
  const p = fn.spec?.parameters ?? {}
  const [editing, setEditing] = useState(false)
  const manifestPath = app?.spec?.parameters?.source?.path || 'deploy'
  const branch = app?.spec?.parameters?.source?.targetRevision || 'main'
  const envVars = Object.entries(p.env ?? {})
  const canPr = Boolean(owner.managed && repo && env)
  return (
    <div className='space-y-5'>
      <Note>
        {owner.managed
          ? <>This function is deployed from Git. A change made to the live object would be put back by Argo CD (selfHeal), so it is changed in the repository — edit the overlay, or let the console open a pull request for scale, timeout and environment variables.</>
          : <>This Function is not managed from Git, so it has no overlay to change. Functions created from a template are; this one was applied by hand.</>}
      </Note>
      <div className='flex flex-wrap items-center gap-2'>
        {repo?.webUrl && env
          ? (
            <>
              <a href={giteaTreeUrl(repo.webUrl, branch, overlayDir(env, manifestPath))} target='_blank' rel='noreferrer' className={LINK_BUTTON}>
                Edit in Git · {overlayDir(env, manifestPath)}
              </a>
              <a href={giteaTreeUrl(repo.webUrl, branch, `${manifestPath}/base`)} target='_blank' rel='noreferrer' className={LINK_BUTTON}>
                Base · {manifestPath}/base
              </a>
            </>
          )
          : null}
        {canPr ? <Button variant='primary' size='sm' onClick={() => setEditing(true)}>Change scale, timeout or env…</Button> : null}
      </div>
      {!repo && owner.managed ? <Note tone='warn'>The source repository is unknown — no Application XR names this function’s application — so the console cannot link to its overlay.</Note> : null}

      <Section title='Parameters'>
        <Facts
          rows={[
            ['runtime', `${p.runtime ?? '—'} (${runtimeLabel(p.runtime)})`],
            ['image', p.image ? <span key='image' className='font-mono text-[12px]'>{p.image}</span> : '—'],
            ['imagePullSecrets', p.imagePullSecrets ? (p.imagePullSecrets.length ? p.imagePullSecrets.join(', ') : '[] (public image)') : 'harbor-dockercfg (default)'],
            ['triggers', triggerLabel(functionTriggers(fn))],
            ['eventSource', p.eventSource || undefined],
            ['port', String(p.port ?? 8080)],
            ['minScale', String(p.minScale ?? 0)],
            ['maxScale', String(p.maxScale ?? 20)],
            ['targetConcurrency', String(p.targetConcurrency ?? 100)],
            ['containerConcurrency', String(p.containerConcurrency ?? 0)],
            ['timeoutSeconds', String(p.timeoutSeconds ?? 30)],
            ['visibility', p.visibility ?? 'public'],
            ['hostname', p.hostname || undefined],
            ['dapr', p.dapr ? JSON.stringify(p.dapr) : undefined],
          ]}
        />
      </Section>

      <Section title={`Environment variables (${envVars.length})`}>
        {envVars.length
          ? (
            <div className='overflow-x-auto rounded-xl border border-edge-default'>
              <table className='min-w-full text-[12px]'>
                <tbody className='divide-y divide-edge-subtle'>
                  {envVars.map(([k, v]) => (
                    <tr key={k}>
                      <td className='px-3 py-1.5 font-mono font-medium'>{k}</td>
                      <td className='px-3 py-1.5 font-mono text-content-muted [overflow-wrap:anywhere]'>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          : <Note>None set beyond the platform’s own (FUNCTION_NAME, FUNCTION_RUNTIME, …).</Note>}
      </Section>

      {editing && repo && env
        ? (
          <OverridesModal
            fn={fn}
            env={env}
            repo={repo}
            branch={branch}
            manifestPath={manifestPath}
            onClose={() => setEditing(false)}
          />
        )
        : null}
    </div>
  )
}

const LINK_BUTTON =
  'inline-flex h-8 items-center rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong'

interface EnvRow {
  key: string
  value: string
}

function OverridesModal({
  fn,
  env,
  repo,
  branch,
  manifestPath,
  onClose,
}: {
  fn: FunctionXR
  env: string
  repo: RepoRef
  branch: string
  manifestPath: string
  onClose(): void
}) {
  const p = fn.spec?.parameters ?? {}
  const toast = useToast()
  const open = useOpenOverridesPr()
  const initialEnv = Object.entries(p.env ?? {}).map(([key, value]) => ({ key, value }))
  const [form, setForm] = useState({
    minScale: String(p.minScale ?? 0),
    maxScale: String(p.maxScale ?? 20),
    timeoutSeconds: String(p.timeoutSeconds ?? 30),
    targetConcurrency: String(p.targetConcurrency ?? 100),
  })
  const [envRows, setEnvRows] = useState<EnvRow[]>(initialEnv)
  const overrides: ScaleOverrides = {
    minScale: Number(form.minScale),
    maxScale: Number(form.maxScale),
    timeoutSeconds: Number(form.timeoutSeconds),
    targetConcurrency: Number(form.targetConcurrency),
    env: Object.fromEntries(envRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])),
    removeEnv: initialEnv.map((r) => r.key).filter((k) => !envRows.some((r) => r.key.trim() === k)),
  }
  const errors = validateOverrides(overrides)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async () => {
    try {
      const pr = await open.mutateAsync({ repo, branch, env, name: fn.metadata.name, overrides, manifestPath })
      toast.success(`Opened pull request #${pr.number}`, { description: `${repo.org}/${repo.repo} · ${pr.branch}` })
    } catch (e) {
      toast.error('Could not open the pull request', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Change ${fn.metadata.name} in ${env}`}
      description={`Opens a pull request against ${repo.org}/${repo.repo}: ${overlayDir(env, manifestPath)}/${overridesFileName(fn.metadata.name)}`}
      width='lg'
      footer={
        <div className='flex w-full items-center justify-between gap-2'>
          <span className='text-[11px] text-content-subtle'>Nothing changes until the pull request merges and Argo CD syncs {env}.</span>
          <div className='flex gap-2'>
            <Button variant='ghost' onClick={onClose}>{open.data ? 'Close' : 'Cancel'}</Button>
            {open.data
              ? null
              : <Button variant='primary' onClick={submit} loading={open.isPending} disabled={errors.length > 0}>Open pull request</Button>}
          </div>
        </div>
      }
    >
      {open.data
        ? (
          <Note>
            Pull request #{open.data.number} is open on branch <span className='font-mono'>{open.data.branch}</span>.{' '}
            {open.data.url ? <ExternalLink href={open.data.url}>Review it in Gitea</ExternalLink> : null}
          </Note>
        )
        : (
          <div className='space-y-4'>
            <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
              <Field label='Min scale' hint='0 = scale to zero'><Input type='number' min={0} value={form.minScale} onChange={set('minScale')} /></Field>
              <Field label='Max scale'><Input type='number' min={1} value={form.maxScale} onChange={set('maxScale')} /></Field>
              <Field label='Timeout (s)' hint='1–600'><Input type='number' min={1} max={600} value={form.timeoutSeconds} onChange={set('timeoutSeconds')} /></Field>
              <Field label='Target concurrency' hint='per pod'><Input type='number' min={1} value={form.targetConcurrency} onChange={set('targetConcurrency')} /></Field>
            </div>
            <div className='space-y-2'>
              <div className='flex items-center justify-between'>
                <span className='text-[13px] font-medium text-content'>Environment variables</span>
                <Button size='xs' variant='ghost' onClick={() => setEnvRows((r) => [...r, { key: '', value: '' }])}>Add variable</Button>
              </div>
              {envRows.length
                ? envRows.map((row, i) => (
                  <div key={i} className='grid grid-cols-[1fr_2fr_auto] gap-2'>
                    <Input
                      aria-label='Name'
                      value={row.key}
                      placeholder='NAME'
                      className='font-mono'
                      onChange={(e) => setEnvRows((rows) => rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                    />
                    <Input
                      aria-label='Value'
                      value={row.value}
                      className='font-mono'
                      onChange={(e) => setEnvRows((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                    />
                    <Button size='sm' variant='ghost' aria-label={`Remove ${row.key || 'variable'}`} onClick={() => setEnvRows((rows) => rows.filter((_, j) => j !== i))}>Remove</Button>
                  </div>
                ))
                : <p className='text-[12px] text-content-subtle'>No variables. Removed ones are deleted from the overlay with a <span className='font-mono'>null</span>.</p>}
              <p className='text-[11px] text-content-subtle'>Values land in the repository in plain text — put secrets in a Secret, not here.</p>
            </div>
            {errors.length ? <Note tone='warn'><ul className='list-disc pl-4'>{errors.map((e) => <li key={e}>{e}</li>)}</ul></Note> : null}
          </div>
        )}
    </Modal>
  )
}

/* ─────────────────────────── Delete ─────────────────────────── */

export function DeleteTab({
  fn,
  owner,
  application,
  cells,
  onDeleted,
}: {
  fn: FunctionXR
  owner: GitOpsOwner
  application: string
  /** How many environments the function runs in. */
  cells: number
  onDeleted(): void
}) {
  return owner.managed
    ? <DeleteApplication fn={fn} owner={owner} application={application} cells={cells} onDeleted={onDeleted} />
    : <DeleteUnmanaged fn={fn} onDeleted={onDeleted} />
}

function Confirm({ word, value, onChange }: { word: string; value: string; onChange(v: string): void }) {
  return (
    <Field label={<span>Type <span className='font-mono'>{word}</span> to confirm</span>}>
      <Input value={value} onChange={(e) => onChange(e.target.value)} autoComplete='off' spellCheck={false} className='font-mono' />
    </Field>
  )
}

function DeleteApplication({ fn, owner, application, cells, onDeleted }: { fn: FunctionXR; owner: GitOpsOwner; application: string; cells: number; onDeleted(): void }) {
  const toast = useToast()
  const access = useAccessReview(CONSOLE_PERMISSIONS.applicationsDelete)
  const del = useDeleteOwningApplication()
  const [typed, setTyped] = useState('')
  const [deleteRepo, setDeleteRepo] = useState(false)
  const ns = fn.metadata.namespace ?? ''
  const run = async () => {
    try {
      const out = await del.mutateAsync({ name: application, deleteRepo })
      toast.success(`Deleting application ${application}`, {
        description: out.deleting ? 'The control plane is removing its Functions from every environment.' : 'Removed.',
      })
      onDeleted()
    } catch (e) {
      toast.error(`Could not delete ${application}`, { description: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <div className='space-y-4'>
      <Note tone='warn'>
        <strong className='font-semibold'>{fn.metadata.name}</strong> in <span className='font-mono'>{ns}</span> is deployed from Git
        {owner.argoApp ? <> by Argo CD application <span className='font-mono'>{owner.argoApp}</span></> : null}. Deleting the Function
        here would not stick — Argo CD would put it straight back. It belongs to the application <span className='font-mono'>{application}</span>,
        which owns it in {cells === 1 ? 'its one environment' : `all ${cells} environments`}.
      </Note>
      <ul className='list-disc space-y-1 pl-5 text-[13px] text-content-muted'>
        <li>To remove it from <em>one</em> environment, delete it from that environment’s overlay (<span className='font-mono'>deploy/envs/&lt;env&gt;</span>) in Git — see Configuration.</li>
        <li>To remove the function everywhere, delete its application: the Application XR goes, and the control plane removes its Function, Knative Service and routes from every environment.</li>
      </ul>
      {access.allowed
        ? (
          <Section title={`Delete application ${application}`}>
            <div className='space-y-3 rounded-xl border border-rose-200 p-4 dark:border-rose-500/25'>
              <Confirm word={application} value={typed} onChange={setTyped} />
              <Checkbox
                label='Also delete its repository'
                description='Off by default: the code stays in Gitea even when the application is gone.'
                checked={deleteRepo}
                onChange={(e) => setDeleteRepo(e.target.checked)}
              />
              <Button variant='danger' onClick={run} loading={del.isPending} disabled={typed !== application}>Delete application</Button>
            </div>
          </Section>
        )
        : !access.loading
        ? <Note>Deleting an application needs <span className='font-mono'>delete applications.console.adhar.io</span> — ask a platform admin.</Note>
        : null}
      <ExternalLink href={`/catalog?entity=${encodeURIComponent(`component:${application}`)}`}>Open {application} in the catalog</ExternalLink>
    </div>
  )
}

function DeleteUnmanaged({ fn, onDeleted }: { fn: FunctionXR; onDeleted(): void }) {
  const toast = useToast()
  const ns = fn.metadata.namespace ?? ''
  const name = fn.metadata.name
  const access = useAccessReview(canResource(FUNCTIONS_GVR, 'delete', { namespace: ns, name }))
  const del = useDeleteFunction()
  const [typed, setTyped] = useState('')
  const run = async () => {
    try {
      await del.mutateAsync({ namespace: ns, name })
      toast.success(`Deleting ${ns}/${name}`)
      onDeleted()
    } catch (e) {
      toast.error(`Could not delete ${name}`, { description: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <div className='space-y-4'>
      <Note>
        This Function is not managed from Git — nothing would put it back — so it can be deleted here. The control plane then removes
        what it composed: the Knative Service, its revisions, routes and event sources.
      </Note>
      {access.allowed
        ? (
          <div className={cn('space-y-3 rounded-xl border border-rose-200 p-4 dark:border-rose-500/25')}>
            <Confirm word={name} value={typed} onChange={setTyped} />
            <Button variant='danger' onClick={run} loading={del.isPending} disabled={typed !== name}>Delete function</Button>
          </div>
        )
        : !access.loading
        ? <Note tone='warn'>Deleting needs <span className='font-mono'>delete functions.platform.adhar.io</span> in {ns}.</Note>
        : null}
    </div>
  )
}
