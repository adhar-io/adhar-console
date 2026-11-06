import { useMemo, useState } from 'react'
import { Button, Field, Input, Modal, Select, Spinner, Textarea, useToast } from '@adhar/shell-ui'
import { useRestartRun, useResumeRun, useRunNow, useRunTemplate, useSetHold, useStopRun } from '../../data/batch.ts'
import {
  type BatchJobXR,
  displayParam,
  initialParamValues,
  type ParamField,
  resolveParams,
  restartPlan,
  restartWarning,
  type RunRow,
  runName,
  scheduleOf,
} from '../../data/batch-model.ts'
import { Note } from '../../views/function-bits.tsx'

/**
 * The dialogs that change something. Each one performs exactly one Kubernetes
 * call as the signed-in user (§7.4), and each says what will happen first: Run
 * and Restart show the run name they are about to create, because that name IS
 * the run's identity (§8.3).
 */

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const INVALID_RUN = 'Kyverno compares every run with its template. If this was refused, the template changed underneath the page, or your role does not cover this job.'

/* ─────────────────────────── Run now ─────────────────────────── */

function ParamInput({ field, value, onChange }: { field: ParamField; value: string; onChange(v: string): void }) {
  if (field.allowed?.length) {
    return (
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {field.required && field.default === undefined ? <option value=''>Choose…</option> : field.default === undefined ? <option value=''>Not set</option> : null}
        {field.allowed.map((a) => <option key={a} value={a}>{a}</option>)}
      </Select>
    )
  }
  if (field.type === 'boolean') {
    return (
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {field.default === undefined ? <option value=''>{field.required ? 'Choose…' : 'Not set'}</option> : null}
        <option value='true'>true</option>
        <option value='false'>false</option>
      </Select>
    )
  }
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      type={field.sensitive ? 'password' : field.type === 'date' ? 'date' : 'text'}
      inputMode={field.type === 'long' || field.type === 'double' ? 'decimal' : undefined}
      placeholder={field.type === 'datetime' ? '2026-11-03T17:30:00Z' : undefined}
      autoComplete='off'
      spellCheck={false}
      className='font-mono'
    />
  )
}

export function RunNowDialog({
  job,
  existingNames,
  onClose,
  onOpenRun,
}: {
  job: BatchJobXR
  existingNames: readonly string[]
  onClose(): void
  onOpenRun(name: string): void
}) {
  const namespace = job.metadata.namespace ?? ''
  const name = job.metadata.name
  const read = useRunTemplate(namespace, name, job.status?.runTemplate)
  const template = read.data?.state === 'ok' ? read.data.template : undefined
  const zone = scheduleOf(job).timeZone
  const [edited, setEdited] = useState<Record<string, string>>({})
  const start = useMemo(() => initialParamValues(template?.fields ?? [], { timeZone: zone }), [template, zone])
  const values = { ...start, ...edited }
  const resolved = useMemo(() => resolveParams(template?.fields ?? [], values), [template, JSON.stringify(values)])
  const invalid = Object.keys(resolved.errors).length > 0
  const preview = template && !invalid ? runName(name, resolved.identifying) : undefined
  const exists = Boolean(preview && existingNames.includes(preview))
  const run = useRunNow()
  const toast = useToast()

  const submit = async () => {
    if (!template) return
    try {
      const out = await run.mutateAsync({ namespace, batchJob: name, template, params: resolved.params, identifying: resolved.identifying })
      if (out.created) toast.success(`Started ${out.run.metadata.name}`)
      else toast.success(`${out.existing} already exists`, { description: 'A run with these parameters was started before, so this one is shown instead of a second.' })
      onOpenRun(out.created ? out.run.metadata.name : out.existing)
      onClose()
    } catch (e) {
      toast.error(`Could not start ${name}`, { description: errorText(e) })
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Run ${name}`}
      description={`In ${namespace}, from the deployed run template. The image and configuration are the template’s.`}
      width='lg'
      footer={
        <div className='flex w-full items-center justify-between gap-2'>
          <span className='min-w-0 truncate text-[11px] text-content-subtle'>
            {preview ? <>Run <span className='font-mono'>{preview}</span></> : null}
          </span>
          <div className='flex gap-2'>
            <Button variant='ghost' onClick={onClose}>Cancel</Button>
            {exists
              ? <Button variant='primary' onClick={() => { onOpenRun(preview as string); onClose() }}>Open the existing run</Button>
              : <Button variant='primary' onClick={submit} loading={run.isPending} disabled={!template || invalid}>Start run</Button>}
          </div>
        </div>
      }
    >
      {read.isLoading
        ? <div className='flex items-center gap-2 py-4 text-[13px] text-content-subtle' role='status'><Spinner size={12} /> Reading the run template…</div>
        : read.isError
        ? <Note tone='warn'>{errorText(read.error)}</Note>
        : read.data && read.data.state !== 'ok'
        ? <Note tone='warn'>{read.data.message}</Note>
        : template
        ? (
          <div className='space-y-4'>
            {template.paramsError ? <Note tone='warn'>{template.paramsError}</Note> : null}
            {template.fields.length === 0
              ? <Note>This job declares no parameters. Every manual run of it has the same identity, so it can run once until that run is removed.</Note>
              : (
                <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                  {template.fields.map((f) => (
                    <Field
                      key={f.name}
                      label={<span><span className='font-mono'>{f.name}</span>{f.required || f.source === 'schedule' ? ' *' : ''}</span>}
                      hint={[f.description, f.identifying ? 'part of the run’s identity' : 'does not affect its identity', f.default !== undefined ? `default ${displayParam(f, f.default || '""')}` : null].filter(Boolean).join(' · ')}
                      error={resolved.errors[f.name]}
                    >
                      <ParamInput field={f} value={values[f.name] ?? ''} onChange={(v) => setEdited((cur) => ({ ...cur, [f.name]: v }))} />
                    </Field>
                  ))}
                </div>
              )}
            {exists
              ? (
                <Note tone='warn'>
                  <span className='font-mono'>{preview}</span> already exists: a run is named for its identifying parameters, so these values
                  were already run. Spring Batch would not repeat a completed instance. Change a parameter to start a new one.
                </Note>
              )
              : null}
            {run.isError ? <Note tone='warn'>{errorText(run.error)} {INVALID_RUN}</Note> : null}
          </div>
        )
        : null}
    </Modal>
  )
}

/* ─────────────────────────── Restart ─────────────────────────── */

export function RestartDialog({
  run,
  job,
  existingNames,
  onClose,
  onOpenRun,
}: {
  run: RunRow
  job?: BatchJobXR
  existingNames: readonly string[]
  onClose(): void
  onOpenRun(name: string): void
}) {
  const batchJob = run.batchJob ?? ''
  const read = useRunTemplate(run.namespace, batchJob, job?.status?.runTemplate)
  const template = read.data?.state === 'ok' ? read.data.template : undefined
  const plan = useMemo(() => (template ? restartPlan(batchJob, run, template, existingNames) : undefined), [template, batchJob, run, existingNames])
  const restart = useRestartRun()
  const toast = useToast()
  const warning = restartWarning(run.exitCode)

  const submit = async () => {
    if (!template || !plan?.name || !plan.params) return
    try {
      const out = await restart.mutateAsync({ namespace: run.namespace, name: plan.name, template, params: plan.params, restartOf: run.name })
      if (out.created) toast.success(`Restarted as ${out.run.metadata.name}`)
      else toast.success(`${out.existing} already exists`, { description: 'This restart was started before; showing it.' })
      onOpenRun(out.created ? out.run.metadata.name : out.existing)
      onClose()
    } catch (e) {
      toast.error(`Could not restart ${run.name}`, { description: errorText(e) })
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Restart ${run.name}`}
      description='Spring Batch finds the same job instance and re-executes only the steps that did not complete.'
      width='lg'
      footer={
        <div className='flex w-full justify-end gap-2'>
          <Button variant='ghost' onClick={onClose}>Cancel</Button>
          <Button variant='primary' onClick={submit} loading={restart.isPending} disabled={!plan?.name}>Restart</Button>
        </div>
      }
    >
      {read.isLoading
        ? <div className='flex items-center gap-2 py-4 text-[13px] text-content-subtle' role='status'><Spinner size={12} /> Reading the run template…</div>
        : read.isError
        ? <Note tone='warn'>{errorText(read.error)}</Note>
        : read.data && read.data.state !== 'ok'
        ? <Note tone='warn'>{read.data.message}</Note>
        : plan?.error
        ? <Note tone='warn'>{plan.error}</Note>
        : plan
        ? (
          <div className='space-y-3 text-[13px] text-content'>
            <p>Creates <span className='font-mono'>{plan.name}</span> with the same identifying parameters.</p>
            {Object.keys(plan.params ?? {}).length
              ? (
                <ul className='space-y-0.5 rounded-lg bg-surface-sunken px-3 py-2 font-mono text-[12px]'>
                  {Object.entries(plan.params ?? {}).map(([k, v]) => (
                    <li key={k}>{k} = {displayParam(template?.fields.find((f) => f.name === k), v)}</li>
                  ))}
                </ul>
              )
              : null}
            {warning ? <Note tone='warn'>{warning}</Note> : null}
            {plan.imageChange
              ? (
                <Note tone='warn'>
                  The job was promoted since this run. It used <span className='font-mono [overflow-wrap:anywhere]'>{plan.imageChange.from}</span>; a restart
                  uses the deployed <span className='font-mono [overflow-wrap:anywhere]'>{plan.imageChange.to}</span>, because a run must equal its template.
                </Note>
              )
              : null}
            {restart.isError ? <Note tone='warn'>{errorText(restart.error)} {INVALID_RUN}</Note> : null}
          </div>
        )
        : null}
    </Modal>
  )
}

/* ─────────────────────────── Stop / Resume ─────────────────────────── */

export function StopDialog({ run, onClose }: { run: RunRow; onClose(): void }) {
  const stop = useStopRun()
  const toast = useToast()
  const submit = async () => {
    try {
      await stop.mutateAsync(run.raw)
      toast.success(`Stopping ${run.name}`, { description: 'It finishes the current chunk, records STOPPED and exits.' })
      onClose()
    } catch (e) {
      toast.error(`Could not stop ${run.name}`, { description: errorText(e) })
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Stop ${run.name}`}
      description='The run stops at the next chunk boundary and can be resumed from there.'
      footer={
        <div className='flex w-full justify-end gap-2'>
          <Button variant='ghost' onClick={onClose}>Cancel</Button>
          <Button variant='danger' onClick={submit} loading={stop.isPending}>Stop run</Button>
        </div>
      }
    >
      <p className='text-[13px] text-content-muted'>
        Its pods receive SIGTERM and their grace period; work committed so far is kept. {run.kind === 'VolcanoJob' ? 'Volcano aborts the whole gang.' : 'A suspended Job holds no capacity while it waits.'}
      </p>
      {stop.isError ? <div className='mt-3'><Note tone='warn'>{errorText(stop.error)}</Note></div> : null}
    </Modal>
  )
}

export function ResumeDialog({ run, onClose }: { run: RunRow; onClose(): void }) {
  const resume = useResumeRun()
  const toast = useToast()
  const submit = async () => {
    try {
      await resume.mutateAsync(run.raw)
      toast.success(`Resuming ${run.name}`)
      onClose()
    } catch (e) {
      toast.error(`Could not resume ${run.name}`, { description: errorText(e) })
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Resume ${run.name}`}
      description='A new pod finds the stopped execution and continues from the last committed chunk.'
      footer={
        <div className='flex w-full justify-end gap-2'>
          <Button variant='ghost' onClick={onClose}>Cancel</Button>
          <Button variant='primary' onClick={submit} loading={resume.isPending}>Resume run</Button>
        </div>
      }
    >
      <p className='text-[13px] text-content-muted'>
        The run’s active-deadline timer starts again from now{run.kind === 'VolcanoJob' ? ', as Volcano recreates its pods' : ''}.
      </p>
      {resume.isError ? <div className='mt-3'><Note tone='warn'>{errorText(resume.error)}</Note></div> : null}
    </Modal>
  )
}

/* ─────────────────────────── Hold / Release ─────────────────────────── */

export function HoldDialog({ job, onClose }: { job: BatchJobXR; onClose(): void }) {
  const namespace = job.metadata.namespace ?? ''
  const name = job.metadata.name
  const [reason, setReason] = useState('')
  const hold = useSetHold()
  const toast = useToast()
  const submit = async () => {
    try {
      await hold.mutateAsync({ namespace, name, reason })
      toast.success(`${name} is held`, { description: 'Its schedule is suspended until someone releases it.' })
      onClose()
    } catch (e) {
      toast.error(`Could not hold ${name}`, { description: errorText(e) })
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Hold ${name}`}
      description='Suspends the schedule. A run already in progress keeps running, and a person can still start one by hand.'
      footer={
        <div className='flex w-full justify-end gap-2'>
          <Button variant='ghost' onClick={onClose}>Cancel</Button>
          <Button variant='primary' onClick={submit} loading={hold.isPending} disabled={!reason.trim()}>Hold job</Button>
        </div>
      }
    >
      <Field label='Reason' hint='Shown to everyone who opens this job, so they know why it stopped firing.'>
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder='Upstream file is late, INC-1234' />
      </Field>
      {hold.isError ? <div className='mt-3'><Note tone='warn'>{errorText(hold.error)}</Note></div> : null}
    </Modal>
  )
}

export function ReleaseDialog({ job, reason, onClose }: { job: BatchJobXR; reason: string; onClose(): void }) {
  const namespace = job.metadata.namespace ?? ''
  const name = job.metadata.name
  const hold = useSetHold()
  const toast = useToast()
  const submit = async () => {
    try {
      await hold.mutateAsync({ namespace, name, reason: null })
      toast.success(`${name} is released`, { description: 'Its schedule fires again at the next time it is due.' })
      onClose()
    } catch (e) {
      toast.error(`Could not release ${name}`, { description: errorText(e) })
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Release ${name}`}
      description='The schedule resumes. Occurrences missed while held are not caught up beyond the misfire window.'
      footer={
        <div className='flex w-full justify-end gap-2'>
          <Button variant='ghost' onClick={onClose}>Cancel</Button>
          <Button variant='primary' onClick={submit} loading={hold.isPending}>Release job</Button>
        </div>
      }
    >
      <p className='text-[13px] text-content-muted'>It was held because: <span className='text-content'>{reason || 'no reason given'}</span></p>
      {hold.isError ? <div className='mt-3'><Note tone='warn'>{errorText(hold.error)}</Note></div> : null}
    </Modal>
  )
}
