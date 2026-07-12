import { useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Modal,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { kargo } from '@adhar-console/api-clients'
import { useFreight, usePromote, useStages } from '../data/delivery.ts'

const PHASE_KIND: Record<string, StatusKind> = {
  Steady: 'healthy',
  Promoting: 'progressing',
  Verifying: 'progressing',
  Pending: 'info',
  Failed: 'failed',
  NotApplicable: 'unknown',
}

/**
 * Kargo promotion pipeline.
 *
 * Stages render as a horizontal flow with arrows. Each card shows the
 * current freight and exposes a "Promote…" button that opens a modal to
 * choose the next freight bundle to roll out. Below the pipeline, the
 * freight inventory lists available bundles with image tags + age.
 */
export function KargoStages() {
  const stages = useStages()
  const freight = useFreight()
  const promote = usePromote()
  const [promoteFor, setPromoteFor] = useState<kargo.Stage | null>(null)

  if (stages.isLoading || freight.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading Kargo…
      </div>
    )
  }
  if (stages.isError) {
    return <EmptyState title="Couldn't reach Kargo" />
  }

  const stageList = stages.data ?? []
  const freightList = freight.data ?? []

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-content">Promotion pipeline</h2>
          <span className="text-[11px] text-content-subtle">
            {stageList.length} stage{stageList.length === 1 ? '' : 's'}
          </span>
        </div>
        {stageList.length === 0 ? (
          <EmptyState compact title="No stages yet" />
        ) : (
          <div className="overflow-x-auto pb-2">
            <div className="flex items-stretch gap-3">
              {stageList.map((s, i) => (
                <div key={s.name} className="flex items-stretch gap-3">
                  <StageCard
                    stage={s}
                    onPromote={() => setPromoteFor(s)}
                    freightList={freightList}
                  />
                  {i < stageList.length - 1 ? <FlowArrow /> : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-content">Freight inventory</h2>
          <span className="text-[11px] text-content-subtle">
            {freightList.length} bundle{freightList.length === 1 ? '' : 's'}
          </span>
        </div>
        {freightList.length === 0 ? (
          <EmptyState compact title="No freight" />
        ) : (
          <Card>
            <CardBody className="p-0!">
              <ul className="divide-y divide-edge-subtle">
                {freightList.map((f) => (
                  <FreightRow key={f.id} freight={f} stages={stageList} />
                ))}
              </ul>
            </CardBody>
          </Card>
        )}
      </section>

      {promoteFor ? (
        <PromoteModal
          stage={promoteFor}
          freight={freightList}
          onClose={() => setPromoteFor(null)}
          onPromote={(freightId) => {
            promote.mutate({ stage: promoteFor.name, freight: freightId })
          }}
          loading={promote.isPending}
        />
      ) : null}
    </div>
  )
}

function StageCard({
  stage: s,
  onPromote,
  freightList,
}: {
  stage: kargo.Stage
  onPromote(): void
  freightList: kargo.Freight[]
}) {
  const phase = s.phase
  const tone = PHASE_KIND[phase] ?? 'unknown'
  const currentFreight = freightList.find((f) => f.id === s.currentFreight)
  return (
    <Card className="w-[280px] shrink-0">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-content">{s.name}</div>
            <div className="text-[11px] text-content-subtle">project {s.project}</div>
          </div>
          <StatusBadge kind={tone}>{phase}</StatusBadge>
        </div>
      </CardHeader>
      <CardBody className="space-y-3 text-[12px]">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
            Current freight
          </div>
          {currentFreight ? (
            <div className="mt-1 space-y-1">
              <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content">
                {currentFreight.id}
              </code>
              {currentFreight.images.map((img, i) => (
                <div key={i} className="truncate font-mono text-[11px] text-content-muted">
                  {img.repoURL.replace(/^https?:\/\//, '')}:
                  <span className="text-content">{img.tag}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-content-subtle">none</span>
          )}
        </div>
        <div className="text-[11px] text-content-muted">
          last promoted{' '}
          <span className="text-content">
            {s.lastPromoted ? formatRelative(s.lastPromoted) : '—'}
          </span>
        </div>
        <Button size="sm" onClick={onPromote} disabled={freightList.length === 0}>
          Promote…
        </Button>
      </CardBody>
    </Card>
  )
}

function FlowArrow() {
  return (
    <div className="flex shrink-0 items-center" aria-hidden>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-content-subtle)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14" />
        <path d="m12 5 7 7-7 7" />
      </svg>
    </div>
  )
}

function FreightRow({ freight: f, stages }: { freight: kargo.Freight; stages: kargo.Stage[] }) {
  const liveIn = stages.filter((s) => s.currentFreight === f.id).map((s) => s.name)
  return (
    <li className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40">
      <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content">
        {f.id}
      </code>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-content-subtle">
          created {formatRelative(f.created)}
          {liveIn.length ? ` · live in ${liveIn.join(', ')}` : ''}
        </div>
        <div className="mt-1 space-y-0.5 font-mono text-[11px]">
          {f.images.map((img, i) => (
            <div key={i} className="truncate text-content-muted">
              {img.repoURL.replace(/^https?:\/\//, '')}:
              <span className="text-content">{img.tag}</span>
            </div>
          ))}
        </div>
      </div>
      {liveIn.length ? (
        <div className="flex items-center gap-1">
          {liveIn.map((n) => (
            <StatusBadge key={n} kind="healthy">
              {n}
            </StatusBadge>
          ))}
        </div>
      ) : null}
    </li>
  )
}

function PromoteModal({
  stage,
  freight,
  onClose,
  onPromote,
  loading,
}: {
  stage: kargo.Stage
  freight: kargo.Freight[]
  onClose(): void
  onPromote(freightId: string): void
  loading: boolean
}) {
  const [picked, setPicked] = useState<string>(freight[0]?.id ?? '')
  if (typeof document === 'undefined') return null

  return (
    <Modal
      open
      onClose={onClose}
      title={`Promote ${stage.name}`}
      description="Pick the freight bundle to roll into this stage. Kargo handles the GitOps PR."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onPromote(picked)
              onClose()
            }}
            loading={loading}
            disabled={!picked}
          >
            Promote
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {freight.map((f) => {
          const on = picked === f.id
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setPicked(f.id)}
              className={
                on
                  ? 'flex w-full items-start gap-3 rounded-lg border border-brand-400 bg-brand-50 p-3 text-left ring-2 ring-brand-400/20'
                  : 'flex w-full items-start gap-3 rounded-lg border border-edge-default bg-white p-3 text-left hover:border-edge-strong'
              }
            >
              <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content ring-1 ring-edge-subtle">
                {f.id}
              </code>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-content-subtle">
                  created {formatRelative(f.created)}
                </div>
                <div className="mt-1 space-y-0.5 font-mono text-[11px]">
                  {f.images.map((img, i) => (
                    <div key={i} className="truncate text-content-muted">
                      {img.repoURL.replace(/^https?:\/\//, '')}:
                      <span className="text-content">{img.tag}</span>
                    </div>
                  ))}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}

export default KargoStages
