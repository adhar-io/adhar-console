import { useMemo, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  StatusBadge,
  useToast,
} from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import { useCreateFunction, useDeleteFunction, useFunctions, useUpdateFunction, type FunctionXR, type NewFunctionInput, type UpdateFunctionInput } from '../data/functions.ts'

const DEFAULT_NAMESPACE = 'adhar-system'

const RUNTIME_OPTIONS: Array<{ value: NewFunctionInput['runtime']; label: string }> = [
  { value: 'node20', label: 'Node.js 20' },
  { value: 'python312', label: 'Python 3.12' },
  { value: 'go122', label: 'Go 1.22' },
  { value: 'custom', label: 'Custom' },
]

const TRIGGER_OPTIONS: Array<{ value: NewFunctionInput['trigger']; label: string }> = [
  { value: 'http', label: 'HTTP' },
  { value: 'cloudevent', label: 'CloudEvent' },
  { value: 'topic', label: 'Topic' },
  { value: 'bucket', label: 'Bucket' },
  { value: 'cron', label: 'Cron' },
]

function readyKind(fn: FunctionXR) {
  const ready = fn.status?.conditions?.find((c) => c.type === 'Ready')?.status
  if (ready === 'True') return 'healthy'
  if (ready === 'False') return 'failed'
  return 'unknown'
}

function slugOk(value: string) {
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)
}

function functionUrl(fn: FunctionXR): string | undefined {
  const raw = fn.status?.url?.trim()
  if (!raw) return undefined
  return raw
}

function toUpdateInput(fn: FunctionXR, namespace: string): UpdateFunctionInput {
  const p = fn.spec?.parameters
  return {
    name: fn.metadata.name,
    namespace,
    runtime: (p?.runtime as UpdateFunctionInput['runtime'] | undefined) ?? 'node20',
    image: p?.image ?? '',
    trigger: (p?.trigger as UpdateFunctionInput['trigger'] | undefined) ?? 'http',
    eventSource: p?.eventSource ?? '',
    minScale: p?.minScale ?? 0,
    maxScale: p?.maxScale ?? 10,
    timeoutSeconds: p?.timeoutSeconds ?? 30,
  }
}

export function Functions() {
  const toast = useToast()
  const [namespace, setNamespace] = useState(DEFAULT_NAMESPACE)
  const [editing, setEditing] = useState<UpdateFunctionInput | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string>('')
  const [form, setForm] = useState<NewFunctionInput>({
    name: '',
    namespace: DEFAULT_NAMESPACE,
    runtime: 'node20',
    image: '',
    trigger: 'http',
    eventSource: '',
    minScale: 0,
    maxScale: 10,
    timeoutSeconds: 30,
  })

  const listQ = useFunctions(namespace, Boolean(namespace))
  const createM = useCreateFunction()
  const updateM = useUpdateFunction()
  const deleteM = useDeleteFunction(namespace)

  const rows = useMemo(() => listQ.data ?? [], [listQ.data])
  const canCreate = form.name.trim() !== '' && form.image.trim() !== '' && slugOk(form.name.trim())

  const onCreate = async () => {
    const name = form.name.trim()
    if (!slugOk(name)) {
      toast.error('Function name must be a valid Kubernetes name', {
        description: 'Use lowercase letters, numbers and dashes only.',
      })
      return
    }
    try {
      await createM.mutateAsync({ ...form, name, namespace })
      toast.success(`Created function ${name}`, { description: `Namespace: ${namespace}` })
      setForm((prev) => ({ ...prev, name: '', eventSource: '' }))
    } catch (e) {
      toast.error('Could not create function', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const onDelete = async (fn: FunctionXR) => {
    try {
      await deleteM.mutateAsync(fn.metadata.name)
      toast.success(`Deleted function ${fn.metadata.name}`)
    } catch (e) {
      toast.error(`Could not delete ${fn.metadata.name}`, { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const onSave = async () => {
    if (!editing) return
    try {
      await updateM.mutateAsync(editing)
      toast.success(`Updated function ${editing.name}`)
      setEditing(null)
    } catch (e) {
      toast.error(`Could not update ${editing.name}`, { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const onInvoke = async (fn: FunctionXR) => {
    const url = functionUrl(fn)
    if (!url) {
      toast.error(`Function ${fn.metadata.name} has no route URL yet`)
      return
    }
    setTesting(fn.metadata.name)
    setTestResult('')
    const ac = new AbortController()
    const timer = globalThis.setTimeout(() => ac.abort(), 8000)
    try {
      const res = await fetch(url, { method: 'GET', signal: ac.signal })
      const body = await res.text()
      const contentType = res.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        try {
          const parsed = JSON.parse(body)
          setTestResult(JSON.stringify(parsed, null, 2))
        } catch {
          setTestResult(body)
        }
      } else {
        setTestResult(body)
      }
      toast.success(`Invoked ${fn.metadata.name}`, { description: `${res.status} ${res.statusText}` })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setTestResult(`Request failed: ${message}`)
      toast.error(`Could not invoke ${fn.metadata.name}`, { description: message })
    } finally {
      clearTimeout(timer)
      setTesting(null)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Create function</div>
        </CardHeader>
        <CardBody className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Namespace">
            <Input value={namespace} onChange={(e) => { const ns = e.target.value.trim(); setNamespace(ns); setForm((p) => ({ ...p, namespace: ns })) }} />
          </Field>
          <Field label="Function name">
            <Input value={form.name} placeholder="orders-handler" onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
          </Field>
          <Field label="Runtime">
            <Select value={form.runtime} onChange={(e) => setForm((p) => ({ ...p, runtime: e.target.value as NewFunctionInput['runtime'] }))}>
              {RUNTIME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Trigger">
            <Select value={form.trigger} onChange={(e) => setForm((p) => ({ ...p, trigger: e.target.value as NewFunctionInput['trigger'] }))}>
              {TRIGGER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </Select>
          </Field>
          <Field className="md:col-span-2 xl:col-span-2" label="Image">
            <Input
              value={form.image}
              placeholder="harbor.adhar.io/apps/orders-function:latest"
              onChange={(e) => setForm((p) => ({ ...p, image: e.target.value }))}
            />
          </Field>
          <Field className="md:col-span-2 xl:col-span-2" label="Event source (optional)">
            <Input value={form.eventSource} placeholder="kafka://orders-events" onChange={(e) => setForm((p) => ({ ...p, eventSource: e.target.value }))} />
          </Field>
          <Field label="Min scale">
            <Input
              type="number"
              min={0}
              value={String(form.minScale)}
              onChange={(e) => setForm((p) => ({ ...p, minScale: Number(e.target.value || 0) }))}
            />
          </Field>
          <Field label="Max scale">
            <Input
              type="number"
              min={1}
              value={String(form.maxScale)}
              onChange={(e) => setForm((p) => ({ ...p, maxScale: Number(e.target.value || 1) }))}
            />
          </Field>
          <Field label="Timeout (seconds)">
            <Input
              type="number"
              min={1}
              value={String(form.timeoutSeconds)}
              onChange={(e) => setForm((p) => ({ ...p, timeoutSeconds: Number(e.target.value || 30) }))}
            />
          </Field>
          <div className="md:col-span-2 xl:col-span-1 flex items-end">
            <Button onClick={onCreate} disabled={!canCreate || createM.isPending}>
              {createM.isPending ? <span className="inline-flex items-center gap-1"><Spinner size={12} /> Creating…</span> : 'Create Function'}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-content">Functions</div>
            <StatusBadge kind="info">{rows.length}</StatusBadge>
          </div>
        </CardHeader>
        <CardBody className="p-0!">
          {listQ.isLoading ? (
            <div className="flex items-center gap-2 px-4 py-5 text-sm text-content-subtle">
              <Spinner size={12} />
              Loading functions…
            </div>
          ) : listQ.isError ? (
            <EmptyState
              compact
              title="Could not load functions"
              description={listQ.error instanceof Error ? listQ.error.message : String(listQ.error)}
              action={<Button size="sm" variant="secondary" onClick={() => listQ.refetch()}>Retry</Button>}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              compact
              title="No functions yet"
              description="Create your first Function XR to deploy a Knative-backed function with scale-to-zero."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-surface-muted text-content-subtle">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-left font-medium">Runtime</th>
                    <th className="px-3 py-2 text-left font-medium">Trigger</th>
                    <th className="px-3 py-2 text-left font-medium">Scale</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Age</th>
                    <th className="px-3 py-2 text-left font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-subtle">
                  {rows.map((fn) => {
                    const params = fn.spec?.parameters
                    return (
                      <tr key={fn.metadata.name}>
                        <td className="px-3 py-2 font-medium">{fn.metadata.name}</td>
                        <td className="px-3 py-2">{params?.runtime ?? '—'}</td>
                        <td className="px-3 py-2">{params?.trigger ?? 'http'}</td>
                        <td className="px-3 py-2">{`${params?.minScale ?? 0}–${params?.maxScale ?? 0}`}</td>
                        <td className="px-3 py-2"><StatusBadge kind={readyKind(fn)}>{readyKind(fn)}</StatusBadge></td>
                        <td className="px-3 py-2 text-content-subtle">{formatRelative(fn.metadata.creationTimestamp)}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-2">
                            <Button size="xs" variant="secondary" onClick={() => setEditing(toUpdateInput(fn, namespace))}>
                              Edit
                            </Button>
                            <Button size="xs" variant="ghost" onClick={() => void onInvoke(fn)} disabled={testing === fn.metadata.name}>
                              {testing === fn.metadata.name ? 'Invoking…' : 'Test invoke'}
                            </Button>
                            <Button size="xs" variant="danger" onClick={() => onDelete(fn)} disabled={deleteM.isPending}>
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
      {editing ? (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={`Edit ${editing.name}`}
          footer={(
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void onSave()} loading={updateM.isPending}>Save</Button>
            </div>
          )}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Runtime">
              <Select value={editing.runtime} onChange={(e) => setEditing((p) => (p ? { ...p, runtime: e.target.value as UpdateFunctionInput['runtime'] } : p))}>
                {RUNTIME_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </Select>
            </Field>
            <Field label="Trigger">
              <Select value={editing.trigger} onChange={(e) => setEditing((p) => (p ? { ...p, trigger: e.target.value as UpdateFunctionInput['trigger'] } : p))}>
                {TRIGGER_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </Select>
            </Field>
            <Field className="md:col-span-2" label="Image">
              <Input value={editing.image} onChange={(e) => setEditing((p) => (p ? { ...p, image: e.target.value } : p))} />
            </Field>
            <Field className="md:col-span-2" label="Event source (optional)">
              <Input value={editing.eventSource ?? ''} onChange={(e) => setEditing((p) => (p ? { ...p, eventSource: e.target.value } : p))} />
            </Field>
            <Field label="Min scale">
              <Input type="number" min={0} value={String(editing.minScale)} onChange={(e) => setEditing((p) => (p ? { ...p, minScale: Number(e.target.value || 0) } : p))} />
            </Field>
            <Field label="Max scale">
              <Input type="number" min={1} value={String(editing.maxScale)} onChange={(e) => setEditing((p) => (p ? { ...p, maxScale: Number(e.target.value || 1) } : p))} />
            </Field>
            <Field label="Timeout (seconds)">
              <Input type="number" min={1} value={String(editing.timeoutSeconds)} onChange={(e) => setEditing((p) => (p ? { ...p, timeoutSeconds: Number(e.target.value || 30) } : p))} />
            </Field>
          </div>
        </Modal>
      ) : null}
      {testResult ? (
        <Modal
          open
          onClose={() => setTestResult('')}
          title="Function invoke result"
          footer={<div className="flex justify-end"><Button variant="primary" onClick={() => setTestResult('')}>Close</Button></div>}
        >
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-muted p-3 text-xs">{testResult}</pre>
        </Modal>
      ) : null}
    </div>
  )
}
