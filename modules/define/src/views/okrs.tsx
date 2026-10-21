import { useMemo, useState } from 'react';
import {
  Button,
  EmptyState,
  Modal,
  Select,
  StatusBadge,
  useOptionalUser,
  useToast,
} from '@adhar/shell-ui';
import { cn, formatRelative } from '@adhar/utils';
import { memberDisplayName, useMembers } from '../data/plane.ts';
import {
  alignmentTree,
  currentQuarter,
  type KeyResult,
  krConfidence,
  krProgress,
  type LinkResolver,
  type Objective,
  objectiveConfidence,
  type ObjectiveData,
  objectiveProgress,
  objectiveScore,
  type OkrLevel,
  type OkrNode,
  paceStatus,
  progressHistory,
  quarterRange,
  scoreBand,
  shiftQuarter,
  statusMeta,
  useAllObjectives,
  useObjectiveMutations,
} from '../data/okrs.ts';
import { classifyError } from '../data/insights-data.ts';
import {
  defineLink,
  useDefineParams,
  useOpenDefine,
  useSetDefineParams,
} from '../data/insights-nav.ts';
import { useLinkResolver } from '../data/okrs-links.ts'
import { CheckInModal, GradeModal, ObjectiveEditor } from '../components/okr-editor.tsx';
import { Avatar, ConsoleSideBadge, Loading, SourceNote, Stat } from '../components/insights-ui.tsx';
import { LineChart, Meter, useSeriesColor } from '../components/insights-viz.tsx';

/**
 * OKRs — objectives → key results, aligned company → team → individual,
 * per quarter, with check-ins, confidence, scoring and key results that can
 * track linked Plane work automatically. Console-side data (docStore).
 */

type View = 'tree' | 'list';
type LevelFilter = 'all' | OkrLevel;

export function Okrs({ projectId }: { projectId?: string }) {
  const params = useDefineParams();
  const setParams = useSetDefineParams();
  const quarter = /^\d{4}-Q[1-4]$/.test(params.quarter ?? '') ? params.quarter! : currentQuarter();
  const q = useAllObjectives();
  const m = useObjectiveMutations();
  const toast = useToast();
  const members = useMembers();
  const user = useOptionalUser();
  const [view, setView] = useState<View>('tree');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [allProjects, setAllProjects] = useState(false);
  const [editing, setEditing] = useState<Objective | 'new' | null>(null);
  const all = q.data ?? [];

  const inQuarter = all.filter((o) =>
    o.quarter === quarter && (allProjects || !o.project || o.project === projectId)
  );
  const visible = inQuarter.filter((o) => level === 'all' || (o.level ?? 'team') === level);
  const resolve = useLinkResolver(inQuarter);
  const open = params.objective ? all.find((o) => o.id === params.objective) : undefined;

  const memberName = (id: string) => {
    const mm = (members.data ?? []).find((x) => (x.member?.id ?? x.id) === id);
    return mm ? memberDisplayName(mm) : id ? 'Former member' : 'Unassigned';
  };
  const progressOf = (o: Objective) => objectiveProgress(o, all, resolve);

  const save = (data: ObjectiveData, id?: string) => {
    if (id) {
      const cur = all.find((o) => o.id === id)!;
      m.save.mutate({ ...cur, ...data }, {
        onSuccess: () => {
          toast.success('Objective saved');
          setEditing(null);
        },
        onError: (e) =>
          toast.error("Couldn't save the objective", { description: classifyError(e).message }),
      });
    } else {
      m.create.mutate(data, {
        onSuccess: (o) => {
          toast.success('Objective created');
          setEditing(null);
          setParams({ objective: o.id }, { push: true });
        },
        onError: (e) =>
          toast.error("Couldn't create the objective", { description: classifyError(e).message }),
      });
    }
  };

  const summary = useMemo(() => {
    const ps = visible.map((o) => ({ o, p: objectiveProgress(o, all, resolve) }));
    const status = ps.map(({ o, p }) => paceStatus(p, o.quarter));
    const conf = visible.map(objectiveConfidence).filter((c): c is number => c !== undefined);
    return {
      avg: ps.length ? Math.round(ps.reduce((a, x) => a + x.p, 0) / ps.length) : 0,
      on: status.filter((s) => s === 'on-track').length,
      risk: status.filter((s) => s === 'at-risk').length,
      off: status.filter((s) => s === 'off-track').length,
      conf: conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : undefined,
    };
  }, [visible, all, resolve]);

  const range = quarterRange(quarter);
  const closed = !!range && Date.now() >= range.end.getTime();

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='flex flex-wrap items-center gap-2'>
          <div className='inline-flex items-center rounded-lg border border-edge-default bg-surface-raised'>
            <button
              type='button'
              aria-label='Previous quarter'
              className='px-2 py-1.5 text-content-muted hover:text-content'
              onClick={() => setParams({ quarter: shiftQuarter(quarter, -1) })}
            >
              ‹
            </button>
            <span className='min-w-20 px-1 text-center text-[13px] font-semibold tabular-nums text-content'>
              {quarter}
            </span>
            <button
              type='button'
              aria-label='Next quarter'
              className='px-2 py-1.5 text-content-muted hover:text-content'
              onClick={() => setParams({ quarter: shiftQuarter(quarter, 1) })}
            >
              ›
            </button>
          </div>
          {quarter !== currentQuarter()
            ? (
              <Button size='xs' variant='ghost' onClick={() => setParams({ quarter: undefined })}>
                This quarter
              </Button>
            )
            : null}
          <Select
            aria-label='Level'
            value={level}
            onChange={(e) => setLevel(e.target.value as LevelFilter)}
            options={[
              { value: 'all', label: 'All levels' },
              { value: 'company', label: 'Company' },
              { value: 'team', label: 'Team' },
              { value: 'individual', label: 'Individual' },
            ]}
            className='h-8 py-1 text-[12px]'
          />
          <Select
            aria-label='View'
            value={view}
            onChange={(e) => setView(e.target.value as View)}
            options={[{ value: 'tree', label: 'Alignment tree' }, { value: 'list', label: 'List' }]}
            className='h-8 py-1 text-[12px]'
          />
          <label className='inline-flex items-center gap-1.5 text-[12px] text-content-muted'>
            <input
              type='checkbox'
              checked={allProjects}
              onChange={(e) => setAllProjects(e.target.checked)}
            />{' '}
            All projects
          </label>
          <ConsoleSideBadge />
        </div>
        <Button variant='primary' size='sm' onClick={() => setEditing('new')}>New objective</Button>
      </div>

      {q.isLoading
        ? <Loading label='Loading objectives…' />
        : q.error
        ? <SourceNote {...classifyError(q.error)} />
        : (
          <>
            <div className='grid grid-cols-2 gap-2 sm:grid-cols-5'>
              <Stat label='Objectives' value={visible.length} />
              <Stat label='Avg progress' value={visible.length ? `${summary.avg}%` : '—'} />
              <Stat label='On track' value={summary.on} />
              <Stat label='At risk' value={summary.risk} tone={summary.risk ? 'warn' : undefined} />
              <Stat
                label={closed ? 'Off track · closed' : 'Off track'}
                value={summary.off}
                tone={summary.off ? 'bad' : undefined}
                hint={summary.conf !== undefined
                  ? `avg confidence ${summary.conf.toFixed(1)}/10`
                  : undefined}
              />
            </div>
            {!visible.length
              ? (
                <EmptyState
                  title={`No objectives for ${quarter}`}
                  description='Set a few ambitious objectives with measurable key results. Link key results to Plane epics or issues and their progress updates itself.'
                  action={
                    <Button variant='primary' onClick={() => setEditing('new')}>
                      New objective
                    </Button>
                  }
                />
              )
              : view === 'tree'
              ? (
                <ul className='space-y-2'>
                  {alignmentTree(visible).map((n) => (
                    <TreeNode
                      key={n.objective.id}
                      node={n}
                      progressOf={progressOf}
                      memberName={memberName}
                      onOpen={(id) => setParams({ objective: id }, { push: true })}
                    />
                  ))}
                </ul>
              )
              : (
                <ul className='space-y-2'>
                  {[...visible].sort((a, b) => progressOf(a) - progressOf(b)).map((o) => (
                    <ObjectiveRow
                      key={o.id}
                      o={o}
                      progress={progressOf(o)}
                      memberName={memberName}
                      onOpen={() => setParams({ objective: o.id }, { push: true })}
                    />
                  ))}
                </ul>
              )}
          </>
        )}

      {editing
        ? (
          <ObjectiveEditor
            open
            onClose={() => setEditing(null)}
            initial={editing === 'new' ? undefined : editing}
            projectId={projectId}
            all={all}
            saving={m.create.isPending || m.save.isPending}
            onSave={save}
          />
        )
        : null}

      {open
        ? (
          <ObjectiveDetail
            o={open}
            all={all}
            resolve={resolve}
            memberName={memberName}
            by={user?.name}
            onClose={() => setParams({ objective: undefined })}
            onEdit={() => setEditing(open)}
            onSave={(next) =>
              m.save.mutate(next, {
                onError: (e) =>
                  toast.error("Couldn't save", { description: classifyError(e).message }),
              })}
            onDelete={() => {
              if (
                !confirm(
                  `Delete “${open.title}” and its key results? Aligned objectives become top-level.`,
                )
              ) return;
              for (const c of all.filter((x) => x.parentId === open.id)) {
                m.save.mutate({ ...c, parentId: undefined });
              }
              m.remove.mutate(open.id, {
                onSuccess: () => toast.success('Objective deleted'),
                onError: (e) =>
                  toast.error("Couldn't delete", { description: classifyError(e).message }),
              });
              setParams({ objective: undefined });
            }}
            saving={m.save.isPending}
          />
        )
        : null}
    </div>
  );
}

const LEVEL_BADGE: Record<OkrLevel, string> = {
  company:
    'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-200 dark:ring-violet-500/30',
  team:
    'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-200 dark:ring-sky-500/30',
  individual: 'bg-surface-sunken text-content-muted ring-edge-default',
};

function LevelBadge({ level }: { level?: OkrLevel }) {
  const l = level ?? 'team';
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-0.5 text-[10px] font-semibold capitalize ring-1 ring-inset',
        LEVEL_BADGE[l],
      )}
    >
      {l}
    </span>
  );
}

function TreeNode(
  { node, progressOf, memberName, onOpen }: {
    node: OkrNode;
    progressOf(o: Objective): number;
    memberName(id: string): string;
    onOpen(id: string): void;
  },
) {
  const [open, setOpen] = useState(true);
  return (
    <li>
      <div className='flex items-stretch gap-1'>
        {node.children.length
          ? (
            <button
              type='button'
              aria-label={open ? 'Collapse' : 'Expand'}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className='w-5 shrink-0 text-content-subtle hover:text-content'
            >
              {open ? '▾' : '▸'}
            </button>
          )
          : <span className='w-5 shrink-0' />}
        <div className='min-w-0 flex-1'>
          <ObjectiveRow
            o={node.objective}
            progress={progressOf(node.objective)}
            memberName={memberName}
            onOpen={() => onOpen(node.objective.id)}
            childCount={node.children.length}
          />
        </div>
      </div>
      {open && node.children.length
        ? (
          <ul className='ml-3 mt-2 space-y-2 border-l border-edge-default pl-3 sm:ml-5 sm:pl-4'>
            {node.children.map((c) => (
              <TreeNode
                key={c.objective.id}
                node={c}
                progressOf={progressOf}
                memberName={memberName}
                onOpen={onOpen}
              />
            ))}
          </ul>
        )
        : null}
    </li>
  );
}

function ObjectiveRow(
  { o, progress, memberName, onOpen, childCount }: {
    o: Objective;
    progress: number;
    memberName(id: string): string;
    onOpen(): void;
    childCount?: number;
  },
) {
  const color = useSeriesColor()(0);
  const st = statusMeta(paceStatus(progress, o.quarter));
  const conf = objectiveConfidence(o);
  const score = objectiveScore(o, progress);
  return (
    <button
      type='button'
      onClick={onOpen}
      className='block w-full rounded-xl border border-edge-default bg-surface-raised p-3 text-left shadow-sm transition-colors hover:border-edge-strong'
    >
      <div className='flex flex-wrap items-center gap-2'>
        <LevelBadge level={o.level} />
        <span className='min-w-0 flex-1 truncate text-[14px] font-semibold text-content'>
          {o.title}
        </span>
        <StatusBadge kind={st.kind}>{st.label}</StatusBadge>
      </div>
      <div className='mt-2 flex flex-wrap items-center gap-x-4 gap-y-1'>
        <div className='min-w-40 flex-1'>
          <Meter value={progress} color={color} />
        </div>
        <span className='text-[13px] font-semibold tabular-nums text-content'>{progress}%</span>
        <span className='text-[11px] text-content-muted'>
          score {score.toFixed(1)}
          {o.score !== undefined ? ' (graded)' : ''}
        </span>
        {conf !== undefined
          ? <span className='text-[11px] text-content-muted'>confidence {conf}/10</span>
          : null}
        <span className='inline-flex items-center gap-1 text-[11px] text-content-muted'>
          <Avatar name={memberName(o.ownerId)} size={18} /> {memberName(o.ownerId)}
        </span>
        <span className='text-[11px] text-content-subtle'>
          {o.key_results.length} KR{o.key_results.length === 1 ? '' : 's'}
          {childCount ? ` · ${childCount} aligned` : ''}
          {o.team ? ` · ${o.team}` : ''}
        </span>
      </div>
    </button>
  );
}

function ObjectiveDetail(
  { o, all, resolve, memberName, by, onClose, onEdit, onSave, onDelete, saving }: {
    o: Objective;
    all: Objective[];
    resolve: LinkResolver;
    memberName(id: string): string;
    by?: string;
    onClose(): void;
    onEdit(): void;
    onSave(o: Objective): void;
    onDelete(): void;
    saving?: boolean;
  },
) {
  const c = useSeriesColor();
  const toast = useToast();
  const open = useOpenDefine();
  const [checkIn, setCheckIn] = useState<KeyResult | null>(null);
  const [grading, setGrading] = useState(false);
  const progress = objectiveProgress(o, all, resolve);
  const hist = progressHistory(o);
  const range = quarterRange(o.quarter);
  const parent = o.parentId ? all.find((x) => x.id === o.parentId) : undefined;
  const children = all.filter((x) => x.parentId === o.id);
  const st = statusMeta(paceStatus(progress, o.quarter));
  const checkIns = o.key_results.flatMap((kr) => (kr.checkIns ?? []).map((ci) => ({ kr, ci })))
    .sort((a, b) => b.ci.at.localeCompare(a.ci.at));
  const score = objectiveScore(o, progress);
  return (
    <>
      <Modal
        open={!checkIn && !grading}
        onClose={onClose}
        width='xl'
        title={
          <span className='flex flex-wrap items-center gap-2'>
            <LevelBadge level={o.level} /> {o.title}
          </span>
        }
        description={o.description}
        footer={
          <div className='flex w-full flex-wrap justify-between gap-2'>
            <Button variant='danger' size='sm' onClick={onDelete}>Delete</Button>
            <div className='flex flex-wrap gap-2'>
              <Button
                size='sm'
                variant='ghost'
                onClick={() =>
                  void navigator.clipboard?.writeText(defineLink({ objective: o.id })).then(() =>
                    toast.success('Link copied')
                  )}
              >
                Copy link
              </Button>
              <Button size='sm' onClick={() => setGrading(true)}>Grade</Button>
              <Button size='sm' variant='primary' onClick={onEdit}>Edit</Button>
            </div>
          </div>
        }
      >
        <div className='space-y-5'>
          <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
            <Stat label='Progress' value={`${progress}%`} hint={st.label} />
            <Stat
              label='Score'
              value={score.toFixed(1)}
              hint={scoreBand(score) === 'hit'
                ? 'hit'
                : scoreBand(score) === 'progress'
                ? 'progress'
                : 'miss'}
            />
            <Stat
              label='Confidence'
              value={objectiveConfidence(o) ?? '—'}
              hint='latest check-ins, /10'
            />
            <Stat
              label='Owner'
              value={<span className='text-base'>{memberName(o.ownerId)}</span>}
              hint={o.quarter}
            />
          </div>
          {parent || children.length
            ? (
              <div className='text-[12px] text-content-muted'>
                {parent
                  ? (
                    <>
                      Aligns to{' '}
                      <button
                        type='button'
                        className='font-medium text-brand-700 hover:underline dark:text-brand-300'
                        onClick={() =>
                          open('okrs', { objective: parent.id, quarter: parent.quarter })}
                      >
                        {parent.title}
                      </button>.{' '}
                    </>
                  )
                  : null}
                {children.length
                  ? (
                    <>
                      {children.length} objective{children.length === 1 ? '' : 's'}{' '}
                      align to this one.
                    </>
                  )
                  : null}
              </div>
            )
            : null}

          <section className='space-y-2'>
            <h3 className='text-[13px] font-semibold text-content'>Key results</h3>
            {!o.key_results.length
              ? (
                <p className='text-[12px] text-content-subtle'>
                  No key results — progress rolls up from aligned objectives.
                </p>
              )
              : null}
            <ul className='space-y-2'>
              {o.key_results.map((kr) => (
                <KrRow
                  key={kr.id}
                  kr={kr}
                  resolve={resolve}
                  memberName={memberName}
                  onCheckIn={() => setCheckIn(kr)}
                />
              ))}
            </ul>
          </section>

          <section className='space-y-2'>
            <h3 className='text-[13px] font-semibold text-content'>Progress history</h3>
            <LineChart
              height={180}
              series={[{ name: 'Progress', color: c(0), points: hist }]}
              yMax={100}
              formatY={(v) => `${Math.round(v)}%`}
              domain={range && hist.length
                ? [
                  Math.min(range.start.getTime(), hist[0][0]),
                  Math.max(range.end.getTime(), hist.at(-1)![0]),
                ]
                : undefined}
              emptyLabel='No check-ins yet — record one on a key result.'
            />
          </section>

          {checkIns.length
            ? (
              <section className='space-y-2'>
                <h3 className='text-[13px] font-semibold text-content'>Check-ins</h3>
                <ul className='divide-y divide-edge-subtle text-[12px]'>
                  {checkIns.slice(0, 20).map(({ kr, ci }) => (
                    <li key={ci.id} className='py-2'>
                      <div className='flex flex-wrap items-baseline gap-x-2'>
                        <span className='font-medium text-content'>{kr.title}</span>
                        <span className='tabular-nums text-content-muted'>
                          → {ci.progress}% · confidence {ci.confidence}/10
                        </span>
                        <span className='ml-auto text-content-subtle'>
                          {ci.by ? `${ci.by} · ` : ''}
                          {formatRelative(ci.at)}
                        </span>
                      </div>
                      {ci.note
                        ? <p className='mt-0.5 whitespace-pre-wrap text-content-muted'>{ci.note}</p>
                        : null}
                    </li>
                  ))}
                </ul>
              </section>
            )
            : null}
        </div>
      </Modal>
      {checkIn
        ? (
          <CheckInModal
            open
            kr={checkIn}
            resolve={resolve}
            by={by}
            saving={saving}
            onClose={() => setCheckIn(null)}
            onSave={(next) => {
              onSave({
                ...o,
                key_results: o.key_results.map((k) => (k.id === next.id ? next : k)),
              });
              setCheckIn(null);
            }}
          />
        )
        : null}
      {grading
        ? (
          <GradeModal
            open
            objective={o}
            suggested={Math.round(progress / 10) / 10}
            saving={saving}
            onClose={() => setGrading(false)}
            onSave={(s) => {
              onSave({ ...o, score: s });
              setGrading(false);
            }}
          />
        )
        : null}
    </>
  );
}

function KrRow(
  { kr, resolve, memberName, onCheckIn }: {
    kr: KeyResult;
    resolve: LinkResolver;
    memberName(id: string): string;
    onCheckIn(): void;
  },
) {
  const c = useSeriesColor();
  const open = useOpenDefine();
  const p = krProgress(kr, resolve);
  const conf = krConfidence(kr);
  const type = kr.type ?? 'metric';
  const last = kr.checkIns?.at(-1);
  return (
    <li className='rounded-lg border border-edge-subtle bg-surface-sunken/30 p-3'>
      <div className='flex flex-wrap items-start gap-2'>
        <div className='min-w-0 flex-1'>
          <div className='text-[13px] font-medium text-content'>{kr.title}</div>
          <div className='mt-0.5 text-[11px] text-content-subtle'>
            {kr.auto
              ? 'Follows linked work'
              : type === 'milestone'
              ? `${(kr.milestones ?? []).filter((m) => m.done).length}/${
                (kr.milestones ?? []).length
              } milestones`
              : `${kr.current}${kr.unit ? ` ${kr.unit}` : ''} of ${kr.target}${
                kr.unit ? ` ${kr.unit}` : ''
              } (from ${kr.start})`}
            {kr.ownerId ? ` · ${memberName(kr.ownerId)}` : ''}
            {(kr.weight ?? 1) !== 1 ? ` · weight ${kr.weight}` : ''}
            {last ? ` · checked in ${formatRelative(last.at)}` : ' · no check-ins'}
          </div>
        </div>
        <span className='text-[13px] font-semibold tabular-nums text-content'>{p}%</span>
        {conf !== undefined
          ? (
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                conf >= 7
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200'
                  : conf >= 4
                  ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200'
                  : 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-200',
              )}
            >
              conf {conf}
            </span>
          )
          : null}
        <Button size='xs' onClick={onCheckIn}>Check in</Button>
      </div>
      <Meter className='mt-2' value={p} color={c(0)} />
      {kr.links?.length
        ? (
          <div className='mt-2 flex flex-wrap gap-1.5'>
            {kr.links.map((l) => {
              const r = resolve(l);
              return (
                <button
                  key={`${l.kind}:${l.id}`}
                  type='button'
                  onClick={() => (l.kind === 'module'
                    ? open('reports', { report: 'epic', module: l.id, project: l.project })
                    : l.kind === 'cycle'
                    ? open('reports', { report: 'sprint', cycle: l.id, project: l.project })
                    : open('issues', { project: l.project, issue: l.id }))}
                  className='inline-flex items-center gap-1 rounded-full border border-edge-default bg-surface-raised px-2 py-0.5 text-[11px] text-content hover:border-edge-strong'
                >
                  <span className='text-content-subtle'>
                    {l.kind === 'module' ? 'Epic' : l.kind === 'cycle' ? 'Sprint' : 'Issue'}
                  </span>
                  {l.label}
                  {r
                    ? (
                      <span className='tabular-nums text-content-muted'>
                        {l.kind === 'issue'
                          ? (r.done ? '· done' : '· open')
                          : `· ${r.done}/${r.total}`}
                      </span>
                    )
                    : <span className='text-content-subtle'>· not found</span>}
                </button>
              );
            })}
          </div>
        )
        : null}
    </li>
  );
}
