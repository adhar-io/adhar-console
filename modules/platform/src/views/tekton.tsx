import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui';
import type { GatewayGVR as GVR, KubeObject } from '@adhar-console/api-clients/k8s';
import { kube } from '@adhar-console/api-clients/k8s';
import { cn } from '@adhar-console/utils';
import { type LiveStatus, useLiveList } from '../data/live.ts';
import { clusterParam, useActiveCluster } from '../data/client.ts';
import { CodeEditor } from '../components/code-editor.tsx';
import { useGeneric } from '../data/hooks.ts';
import { useHasK8sPermission } from '../data/access.ts';
import { age } from '../data/format.ts';
import { K8sRolePill } from '../components/role-gate.tsx';
import { DrawerSection, DrawerStatusTile, Row } from './resource-drawer.tsx';
import { ListShell, matchesSearch } from './list-shell.tsx';

/**
 * Tekton CI/CD surface — PipelineRuns (with a task DAG / service map, per-step
 * logs, and re-run / cancel / delete management), Pipelines (with a Run
 * action), Tasks, and Triggers. Everything reads/writes through the per-user
 * Kubernetes gateway (`kube`), so RBAC and audit reflect the real actor. All
 * GVRs are `tekton.dev/v1` unless noted; Triggers are `triggers.tekton.dev`.
 */

/* ─────────── GVRs ─────────── */

const PIPELINERUNS_GVR: GVR = {
  group: 'tekton.dev',
  version: 'v1',
  resource: 'pipelineruns',
  namespaced: true,
};
const TASKRUNS_GVR: GVR = {
  group: 'tekton.dev',
  version: 'v1',
  resource: 'taskruns',
  namespaced: true,
};
const PIPELINES_GVR: GVR = {
  group: 'tekton.dev',
  version: 'v1',
  resource: 'pipelines',
  namespaced: true,
};
const TASKS_GVR: GVR = { group: 'tekton.dev', version: 'v1', resource: 'tasks', namespaced: true };
const CLUSTERTASKS_GVR: GVR = {
  group: 'tekton.dev',
  version: 'v1beta1',
  resource: 'clustertasks',
  namespaced: false,
};
const EVENTLISTENERS_GVR: GVR = {
  group: 'triggers.tekton.dev',
  version: 'v1beta1',
  resource: 'eventlisteners',
  namespaced: true,
};
const TRIGGERTEMPLATES_GVR: GVR = {
  group: 'triggers.tekton.dev',
  version: 'v1beta1',
  resource: 'triggertemplates',
  namespaced: true,
};
const TRIGGERBINDINGS_GVR: GVR = {
  group: 'triggers.tekton.dev',
  version: 'v1beta1',
  resource: 'triggerbindings',
  namespaced: true,
};

/* ─────────── Loosely-typed Tekton shapes (any field may be absent) ─────────── */

interface TektonCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}
interface TektonParamValue {
  name?: string;
  value?: unknown;
}
interface TektonWhen {
  input?: string;
  operator?: string;
  values?: string[];
}
interface TektonPipelineTask {
  name?: string;
  displayName?: string;
  taskRef?: { name?: string; kind?: string };
  taskSpec?: { steps?: Array<{ name?: string; image?: string }> };
  runAfter?: string[];
  when?: TektonWhen[];
  params?: TektonParamValue[];
}
interface TektonParamSpec {
  name?: string;
  type?: string;
  description?: string;
  default?: unknown;
}
interface TektonWorkspaceDecl {
  name?: string;
  description?: string;
  optional?: boolean;
}
interface TektonPipelineSpec {
  tasks?: TektonPipelineTask[];
  finally?: TektonPipelineTask[];
  params?: TektonParamSpec[];
  workspaces?: TektonWorkspaceDecl[];
  results?: Array<{ name?: string; description?: string; value?: string }>;
}
interface TektonChildRef {
  name?: string;
  kind?: string;
  pipelineTaskName?: string;
}
interface TektonRunStatus {
  startTime?: string;
  completionTime?: string;
  conditions?: TektonCondition[];
  childReferences?: TektonChildRef[];
  taskRuns?: Record<
    string,
    { pipelineTaskName?: string; status?: { conditions?: TektonCondition[] } }
  >;
  pipelineSpec?: TektonPipelineSpec;
  results?: TektonParamValue[];
  skippedTasks?: Array<{ name?: string; reason?: string }>;
}
interface TektonRunSpec {
  pipelineRef?: { name?: string };
  pipelineSpec?: TektonPipelineSpec;
  params?: TektonParamValue[];
  workspaces?: Array<Record<string, unknown> & { name?: string }>;
  status?: string;
  timeouts?: Record<string, unknown>;
  serviceAccountName?: string;
  taskRunTemplate?: Record<string, unknown>;
}
interface TektonRun extends KubeObject {
  spec?: TektonRunSpec;
  status?: TektonRunStatus;
}

interface TektonStepState {
  name?: string;
  container?: string;
  terminated?: { exitCode?: number; reason?: string; startedAt?: string; finishedAt?: string };
  running?: { startedAt?: string };
  waiting?: { reason?: string };
}
interface TektonTaskRunObj extends KubeObject {
  spec?: { taskRef?: { name?: string; kind?: string } };
  status?: {
    conditions?: TektonCondition[];
    podName?: string;
    startTime?: string;
    completionTime?: string;
    steps?: TektonStepState[];
    taskSpec?: { steps?: Array<{ name?: string; image?: string }> };
    results?: TektonParamValue[];
  };
}
interface TektonPipelineObj extends KubeObject {
  spec?: TektonPipelineSpec;
}
interface TektonTaskObj extends KubeObject {
  spec?: {
    steps?: Array<{ name?: string; image?: string; script?: string }>;
    params?: TektonParamSpec[];
    results?: Array<{ name?: string; description?: string }>;
    workspaces?: TektonWorkspaceDecl[];
    description?: string;
  };
}

/* ─────────── Helpers ─────────── */

/** Human duration between two timestamps; end defaults to now while running. */
function duration(start?: string, end?: string): string {
  if (!start) return '—';
  const startMs = new Date(start).getTime();
  if (!Number.isFinite(startMs)) return '—';
  const endMs = end ? new Date(end).getTime() : Date.now();
  let s = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Re-render on an interval so live durations keep ticking. */
function useTick(ms = 1000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function creationOf(o: KubeObject): number {
  return new Date(o.metadata?.creationTimestamp ?? 0).getTime();
}
function newestFirst(a: KubeObject, b: KubeObject): number {
  return creationOf(b) - creationOf(a);
}

/** Newest `Succeeded`-type condition (falls back to first condition). */
function tektonCondition(conds?: TektonCondition[]): TektonCondition | undefined {
  const all = conds ?? [];
  const succeeded = all.filter((c) => c.type === 'Succeeded');
  const pool = succeeded.length ? succeeded : all;
  return [...pool].sort(
    (a, b) =>
      new Date(b.lastTransitionTime ?? 0).getTime() - new Date(a.lastTransitionTime ?? 0).getTime(),
  )[0];
}
function tektonKind(c?: TektonCondition): StatusKind {
  if (!c) return 'unknown';
  if (c.status === 'True') return 'healthy';
  if (c.status === 'False') return 'failed';
  return 'progressing';
}
function tektonLabel(c?: TektonCondition): string {
  if (!c) return 'Unknown';
  if (c.reason) return c.reason;
  return c.status === 'True' ? 'Succeeded' : c.status === 'False' ? 'Failed' : 'Running';
}
function isRunning(run: TektonRun): boolean {
  if (run.status?.completionTime) return false;
  const c = tektonCondition(run.status?.conditions);
  return !c || c.status === 'Unknown';
}
/** Numeric completed/total task counts for a run (best-effort from status). */
function runCounts(run: TektonRun): { done: number; total: number } {
  const refs = run.status?.childReferences ?? [];
  const trs = Object.values(run.status?.taskRuns ?? {});
  const specTasks = (run.status?.pipelineSpec?.tasks ?? run.spec?.pipelineSpec?.tasks ?? []).length;
  const skipped = (run.status?.skippedTasks ?? []).length;
  const total = refs.length || trs.length || specTasks;
  const done = trs.filter((tr) => {
    const c = (tr.status?.conditions ?? []).find((x) => x.type === 'Succeeded');
    return c ? c.status !== 'Unknown' : false;
  }).length + skipped;
  return { done: Math.min(done, total), total };
}
function runProgress(run: TektonRun): string {
  const { done, total } = runCounts(run);
  if (!total) return '—';
  return `${done}/${total}`;
}

/** Trigger source label from the run's labels or pipelineRef. */
function runTrigger(run: TektonRun): string {
  const labels = run.metadata?.labels ?? {};
  const el = labels['triggers.tekton.dev/eventlistener'];
  const trig = labels['triggers.tekton.dev/trigger'];
  if (el) return trig ? `${el} · ${trig}` : `EventListener ${el}`;
  const pl = labels['tekton.dev/pipeline'];
  if (pl) return pl;
  return run.spec?.pipelineRef?.name ?? 'manual';
}

/** Health-state → concrete colour usable in SVG (legible on both themes). */
function stateColor(kind: StatusKind): string {
  switch (kind) {
    case 'healthy':
      return '#10b981';
    case 'failed':
    case 'degraded':
      return '#f43f5e';
    case 'progressing':
      return '#6366f1';
    case 'paused':
      return '#f59e0b';
    case 'info':
      return '#0ea5e9';
    default:
      return '#94a3b8';
  }
}

const LIVE_TONE: Record<LiveStatus, string> = {
  live: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  reconnecting: 'bg-amber-500 animate-pulse',
  error: 'bg-rose-500',
};
function LiveIndicator({ status }: { status: LiveStatus }) {
  return (
    <span className='inline-flex items-center gap-1.5 text-[11px] font-medium text-content-subtle'>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${LIVE_TONE[status]}`} />
      {status}
    </span>
  );
}

/* ─────────── DAG model (shared by runs + pipeline preview) ─────────── */

interface DagNode {
  task: TektonPipelineTask;
  name: string;
  level: number;
  kind: StatusKind;
  label: string;
  isFinally: boolean;
}
interface DagEdge {
  from: string;
  to: string;
}

/** Extract cross-task references from `$(tasks.X.results...)`, `when`, params. */
function referencedTasks(task: TektonPipelineTask, taskNames: Set<string>): Set<string> {
  const out = new Set<string>();
  const scan = (v: unknown) => {
    if (typeof v !== 'string') return;
    const re = /\$\(tasks\.([a-z0-9][a-z0-9-]*)\./g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(v))) {
      if (taskNames.has(m[1])) out.add(m[1]);
    }
  };
  for (const p of task.params ?? []) scan(p.value);
  for (const w of task.when ?? []) {
    scan(w.input);
    for (const val of w.values ?? []) scan(val);
  }
  return out;
}

/**
 * Build a levelled DAG from a pipeline spec. Edges come from `runAfter` deps
 * plus best-effort `$(tasks.X.*)` result/when/param references. Levels are the
 * longest-path from a root, so dependencies read left→right. `finally` tasks
 * are pinned into the last column. `statusFor` colours each node.
 */
function buildDag(
  spec: TektonPipelineSpec | undefined,
  statusFor: (taskName: string) => { kind: StatusKind; label: string },
): { nodes: DagNode[]; edges: DagEdge[] } {
  const tasks = spec?.tasks ?? [];
  const finallyTasks = spec?.finally ?? [];
  const names = new Set(tasks.map((t) => t.name ?? '').filter(Boolean));

  const edges: DagEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (from: string, to: string) => {
    if (!from || !to || from === to) return;
    const key = `${from}→${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to });
  };
  for (const t of tasks) {
    const to = t.name ?? '';
    for (const dep of t.runAfter ?? []) if (names.has(dep)) addEdge(dep, to);
    for (const ref of referencedTasks(t, names)) addEdge(ref, to);
  }

  // Longest-path levelling (iterate until stable; capped against cycles).
  const level = new Map<string, number>();
  for (const n of names) level.set(n, 0);
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    const arr = incoming.get(e.to) ?? [];
    arr.push(e.from);
    incoming.set(e.to, arr);
  }
  let maxRegular = 0;
  for (let iter = 0; iter < names.size + 1; iter++) {
    let changed = false;
    for (const n of names) {
      const parents = incoming.get(n) ?? [];
      const lvl = parents.length ? Math.max(...parents.map((p) => (level.get(p) ?? 0) + 1)) : 0;
      if (lvl !== level.get(n)) {
        level.set(n, lvl);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const n of names) maxRegular = Math.max(maxRegular, level.get(n) ?? 0);
  const finallyLevel = names.size ? maxRegular + 1 : 0;

  const nodes: DagNode[] = [];
  for (const t of tasks) {
    const s = statusFor(t.name ?? '');
    nodes.push({
      task: t,
      name: t.name ?? '',
      level: level.get(t.name ?? '') ?? 0,
      kind: s.kind,
      label: s.label,
      isFinally: false,
    });
  }
  for (const t of finallyTasks) {
    const s = statusFor(t.name ?? '');
    nodes.push({
      task: t,
      name: t.name ?? '',
      level: finallyLevel,
      kind: s.kind,
      label: s.label,
      isFinally: true,
    });
  }
  return { nodes, edges };
}

const NODE_W = 216;
const NODE_H = 78;
const COL_GAP = 68;
const ROW_GAP = 22;

/* ─────────── Fine-grained stage visuals (every Tekton status) ─────────── */

type TaskVisualId =
  | 'succeeded'
  | 'failed'
  | 'timedout'
  | 'running'
  | 'pending'
  | 'waiting'
  | 'skipped'
  | 'when-skipped'
  | 'cancelled'
  | 'none';

interface TaskVisual {
  id: TaskVisualId;
  /** Fallback display label (the live condition reason usually overrides this). */
  label: string;
  /** Concrete colour for the SVG edge / glyph fill (legible on both themes). */
  accent: string;
  /** Theme-aware tone classes for the card. */
  glyphTone: string;
  labelTone: string;
  borderTone: string;
  tint: string;
  dashed: boolean;
  running: boolean;
  /** Legend display label. */
  legend: string;
}

const TASK_VISUALS: Record<TaskVisualId, TaskVisual> = {
  succeeded: {
    id: 'succeeded',
    label: 'Succeeded',
    accent: '#10b981',
    glyphTone: 'text-emerald-600 dark:text-emerald-400',
    labelTone: 'text-emerald-700 dark:text-emerald-300',
    borderTone: 'border-l-emerald-500',
    tint: 'from-emerald-50/70 to-transparent dark:from-emerald-500/10',
    dashed: false,
    running: false,
    legend: 'Succeeded',
  },
  failed: {
    id: 'failed',
    label: 'Failed',
    accent: '#f43f5e',
    glyphTone: 'text-rose-600 dark:text-rose-400',
    labelTone: 'text-rose-700 dark:text-rose-300',
    borderTone: 'border-l-rose-500',
    tint: 'from-rose-50/70 to-transparent dark:from-rose-500/10',
    dashed: false,
    running: false,
    legend: 'Failed',
  },
  timedout: {
    id: 'timedout',
    label: 'Timed out',
    accent: '#fb7185',
    glyphTone: 'text-rose-600 dark:text-rose-400',
    labelTone: 'text-rose-700 dark:text-rose-300',
    borderTone: 'border-l-rose-400',
    tint: 'from-rose-50/60 to-transparent dark:from-rose-500/10',
    dashed: false,
    running: false,
    legend: 'Timed out',
  },
  running: {
    id: 'running',
    label: 'Running',
    accent: '#6366f1',
    glyphTone: 'text-indigo-600 dark:text-indigo-400',
    labelTone: 'text-indigo-700 dark:text-indigo-300',
    borderTone: 'border-l-indigo-500',
    tint: 'from-indigo-50/80 to-transparent dark:from-indigo-500/12',
    dashed: false,
    running: true,
    legend: 'Running',
  },
  pending: {
    id: 'pending',
    label: 'Pending',
    accent: '#94a3b8',
    glyphTone: 'text-content-subtle',
    labelTone: 'text-content-subtle',
    borderTone: 'border-l-slate-300 dark:border-l-slate-600',
    tint: 'from-surface-sunken/60 to-transparent',
    dashed: false,
    running: false,
    legend: 'Pending',
  },
  waiting: {
    id: 'waiting',
    label: 'Waiting',
    accent: '#94a3b8',
    glyphTone: 'text-content-subtle',
    labelTone: 'text-content-subtle',
    borderTone: 'border-l-slate-300 dark:border-l-slate-600',
    tint: 'from-surface-sunken/60 to-transparent',
    dashed: false,
    running: false,
    legend: 'Waiting',
  },
  skipped: {
    id: 'skipped',
    label: 'Skipped',
    accent: '#f59e0b',
    glyphTone: 'text-amber-600 dark:text-amber-400',
    labelTone: 'text-amber-700 dark:text-amber-400',
    borderTone: 'border-l-amber-400',
    tint: 'from-amber-50/60 to-transparent dark:from-amber-500/10',
    dashed: true,
    running: false,
    legend: 'Skipped',
  },
  'when-skipped': {
    id: 'when-skipped',
    label: 'Skipped (when)',
    accent: '#f59e0b',
    glyphTone: 'text-amber-600 dark:text-amber-400',
    labelTone: 'text-amber-700 dark:text-amber-400',
    borderTone: 'border-l-amber-400',
    tint: 'from-amber-50/60 to-transparent dark:from-amber-500/10',
    dashed: true,
    running: false,
    legend: 'When-skipped',
  },
  cancelled: {
    id: 'cancelled',
    label: 'Cancelled',
    accent: '#64748b',
    glyphTone: 'text-slate-500 dark:text-slate-400',
    labelTone: 'text-slate-600 dark:text-slate-400',
    borderTone: 'border-l-slate-400 dark:border-l-slate-500',
    tint: 'from-slate-50/70 to-transparent dark:from-slate-500/10',
    dashed: false,
    running: false,
    legend: 'Cancelled',
  },
  none: {
    id: 'none',
    label: '—',
    accent: '#94a3b8',
    glyphTone: 'text-content-subtle',
    labelTone: 'text-content-subtle',
    borderTone: 'border-l-edge-strong',
    tint: 'from-transparent to-transparent',
    dashed: false,
    running: false,
    legend: 'Not started',
  },
};

/**
 * Map the coarse `StatusKind` + condition reason/label produced by `statusFor`
 * onto a fine-grained stage visual so every real Tekton status is distinct:
 * cancelled and timed-out separate out of the generic "failed", when-expression
 * skips separate out of plain skips, and pending vs waiting vs not-started read
 * apart. No data is invented — the label is the live condition reason.
 */
function taskVisual(kind: StatusKind, label: string): TaskVisual {
  const l = (label ?? '').toLowerCase();
  switch (kind) {
    case 'healthy':
      return TASK_VISUALS.succeeded;
    case 'progressing':
      return TASK_VISUALS.running;
    case 'paused':
      return l.includes('when') ? TASK_VISUALS['when-skipped'] : TASK_VISUALS.skipped;
    case 'failed':
    case 'degraded':
      if (l.includes('cancel')) return TASK_VISUALS.cancelled;
      if (l.includes('timeout') || l.includes('timed')) return TASK_VISUALS.timedout;
      return TASK_VISUALS.failed;
    default:
      if (!label || label === '—') return TASK_VISUALS.none;
      if (l.includes('wait')) return TASK_VISUALS.waiting;
      return TASK_VISUALS.pending;
  }
}

/** Small, status-specific glyph rendered inside each stage card + the legend. */
function StatusGlyph({ id, size = 15 }: { id: TaskVisualId; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (id) {
    case 'succeeded':
      return (
        <svg {...common}>
          <path d='M20 6 9 17l-5-5' />
        </svg>
      );
    case 'failed':
      return (
        <svg {...common}>
          <path d='M18 6 6 18' />
          <path d='m6 6 12 12' />
        </svg>
      );
    case 'timedout':
      return (
        <svg {...common}>
          <circle cx='12' cy='13' r='8' />
          <path d='M12 9v4' />
          <path d='M9 2h6' />
        </svg>
      );
    case 'running':
      return (
        <svg {...common} className='animate-spin' style={{ animationDuration: '1.1s' }}>
          <path d='M21 12a9 9 0 1 1-6.2-8.5' />
        </svg>
      );
    case 'skipped':
      return (
        <svg {...common}>
          <path d='m5 4 10 8-10 8z' />
          <path d='M19 5v14' />
        </svg>
      );
    case 'when-skipped':
      return (
        <svg {...common}>
          <path d='M22 3H2l8 9.5V19l4 2v-8.5z' />
        </svg>
      );
    case 'cancelled':
      return (
        <svg {...common}>
          <circle cx='12' cy='12' r='9' />
          <path d='m5.6 5.6 12.8 12.8' />
        </svg>
      );
    case 'waiting':
      return (
        <svg {...common}>
          <circle cx='12' cy='12' r='9' />
          <path d='M12 7v5l3 2' />
        </svg>
      );
    default:
      return (
        <svg {...common} strokeDasharray='2.5 2.5'>
          <circle cx='12' cy='12' r='8.5' />
        </svg>
      );
  }
}

/** Per-node runtime metadata (real TaskRun timings + step progress). */
interface TaskNodeMeta {
  start?: string;
  end?: string;
  stepsDone?: number;
  stepsTotal?: number;
}

/** SVG-topology DAG: absolute-positioned theme-aware HTML nodes over an SVG edge layer. */
function TaskGraph({
  spec,
  statusFor,
  metaFor,
  selected,
  onSelect,
}: {
  spec: TektonPipelineSpec | undefined;
  statusFor: (taskName: string) => { kind: StatusKind; label: string };
  metaFor?: (taskName: string) => TaskNodeMeta | undefined;
  selected?: string | null;
  onSelect?: (taskName: string) => void;
}) {
  const { nodes, edges } = useMemo(() => buildDag(spec, statusFor), [spec, statusFor]);

  const layout = useMemo(() => {
    const byLevel = new Map<number, DagNode[]>();
    for (const n of nodes) {
      const arr = byLevel.get(n.level) ?? [];
      arr.push(n);
      byLevel.set(n.level, arr);
    }
    const pos = new Map<string, { x: number; y: number }>();
    let maxRow = 0;
    for (const [lvl, group] of byLevel) {
      group.forEach((n, i) => {
        pos.set(n.name, { x: lvl * (NODE_W + COL_GAP) + 8, y: i * (NODE_H + ROW_GAP) + 10 });
        maxRow = Math.max(maxRow, i);
      });
    }
    const levels = [...byLevel.keys()];
    const maxLevel = levels.length ? Math.max(...levels) : 0;
    const width = (maxLevel + 1) * (NODE_W + COL_GAP) + 12;
    const height = (maxRow + 1) * (NODE_H + ROW_GAP) + 16;
    return { pos, width, height };
  }, [nodes]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const clamp = (z: number) => Math.min(1.6, Math.max(0.4, Math.round(z * 100) / 100));

  const fit = () => {
    const el = scrollRef.current;
    if (!el) return;
    const avail = el.clientWidth - 24;
    if (avail <= 0 || !layout.width) return;
    setScale(clamp(Math.min(1, avail / layout.width)));
  };
  // Auto fit-to-width once the graph is measured (and when its shape changes).
  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.width, layout.height]);

  // Drag-to-pan on the canvas background (never starts on a stage card).
  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const onPanDown = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!el || (e.target as HTMLElement).closest('button')) return;
    pan.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    setPanning(true);
  };
  useEffect(() => {
    if (!panning) return;
    const move = (e: MouseEvent) => {
      const el = scrollRef.current;
      const p = pan.current;
      if (!el || !p) return;
      el.scrollLeft = p.sl - (e.clientX - p.x);
      el.scrollTop = p.st - (e.clientY - p.y);
    };
    const up = () => {
      pan.current = null;
      setPanning(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [panning]);

  if (!nodes.length) {
    return (
      <EmptyState
        compact
        title='No task graph available'
        description="This run doesn't expose an inline pipelineSpec, and the referenced Pipeline couldn't be resolved."
      />
    );
  }

  return (
    <div className='rounded-xl border border-edge-default bg-surface-sunken/40'>
      <div className='flex items-center justify-between gap-2 border-b border-edge-subtle px-2.5 py-1.5'>
        <span className='pl-1 text-[11px] font-medium text-content-subtle'>
          {nodes.length} stage{nodes.length === 1 ? '' : 's'} · drag to pan
        </span>
        <div className='flex items-center gap-1'>
          <ZoomButton
            label='Zoom out'
            onClick={() => setScale((z) => clamp(z - 0.15))}
            disabled={scale <= 0.4}
          >
            <svg
              width='14'
              height='14'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2.2'
              strokeLinecap='round'
              aria-hidden
            >
              <path d='M5 12h14' />
            </svg>
          </ZoomButton>
          <span className='w-10 text-center font-mono text-[11px] tabular-nums text-content-muted'>
            {Math.round(scale * 100)}%
          </span>
          <ZoomButton
            label='Zoom in'
            onClick={() => setScale((z) => clamp(z + 0.15))}
            disabled={scale >= 1.6}
          >
            <svg
              width='14'
              height='14'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2.2'
              strokeLinecap='round'
              aria-hidden
            >
              <path d='M12 5v14' />
              <path d='M5 12h14' />
            </svg>
          </ZoomButton>
          <ZoomButton label='Fit to width' onClick={fit}>
            <svg
              width='14'
              height='14'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2.2'
              strokeLinecap='round'
              strokeLinejoin='round'
              aria-hidden
            >
              <path d='M8 3H5a2 2 0 0 0-2 2v3' />
              <path d='M21 8V5a2 2 0 0 0-2-2h-3' />
              <path d='M3 16v3a2 2 0 0 0 2 2h3' />
              <path d='M16 21h3a2 2 0 0 0 2-2v-3' />
            </svg>
          </ZoomButton>
        </div>
      </div>
      <div
        ref={scrollRef}
        onMouseDown={onPanDown}
        className={cn('overflow-auto p-1', panning ? 'cursor-grabbing select-none' : 'cursor-grab')}
        style={{ maxHeight: 480 }}
      >
        <div style={{ width: layout.width * scale, height: layout.height * scale }}>
          <div
            className='relative'
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          >
            <svg
              className='absolute inset-0'
              width={layout.width}
              height={layout.height}
              aria-hidden
            >
              {edges.map((e, i) => {
                const a = layout.pos.get(e.from);
                const b = layout.pos.get(e.to);
                if (!a || !b) return null;
                const x1 = a.x + NODE_W;
                const y1 = a.y + NODE_H / 2;
                const x2 = b.x;
                const y2 = b.y + NODE_H / 2;
                const mx = (x1 + x2) / 2;
                const target = nodes.find((n) => n.name === e.to);
                const vis = taskVisual(target?.kind ?? 'unknown', target?.label ?? '');
                const flowing = vis.running;
                return (
                  <path
                    key={i}
                    className={cn('dag-edge', flowing && 'dag-edge-flow')}
                    d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                    fill='none'
                    stroke={vis.accent}
                    strokeWidth={flowing ? 2.25 : 1.5}
                    strokeOpacity={flowing ? 0.9 : 0.5}
                  />
                );
              })}
            </svg>
            {nodes.map((n) => {
              const p = layout.pos.get(n.name)!;
              return (
                <GraphNode
                  key={(n.isFinally ? 'finally-' : '') + n.name}
                  left={p.x}
                  top={p.y}
                  name={n.displayName ?? n.name}
                  sub={n.task.taskRef?.name ?? (n.task.taskSpec ? 'inline taskSpec' : undefined)}
                  kind={n.kind}
                  label={n.label}
                  meta={metaFor?.(n.name)}
                  badge={n.isFinally ? 'finally' : undefined}
                  selected={selected === n.name}
                  onClick={onSelect ? () => onSelect(n.name) : undefined}
                />
              );
            })}
          </div>
        </div>
      </div>
      <GraphLegend nodes={nodes} />
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className='flex h-6 w-6 items-center justify-center rounded-md border border-edge-default bg-surface-raised text-content-muted transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-40 disabled:hover:bg-surface-raised'
    >
      {children}
    </button>
  );
}

function GraphNode({
  left,
  top,
  name,
  sub,
  kind,
  label,
  meta,
  badge,
  selected,
  onClick,
}: {
  left: number;
  top: number;
  name: string;
  sub?: string;
  kind: StatusKind;
  label?: string;
  meta?: TaskNodeMeta;
  badge?: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const vis = taskVisual(kind, label ?? '');
  const shownLabel = label && label !== '—' ? label : vis.label;
  const hasSteps = typeof meta?.stepsTotal === 'number' && meta.stepsTotal > 0;
  const stepPct = hasSteps
    ? Math.round(((meta?.stepsDone ?? 0) / (meta!.stepsTotal as number)) * 100)
    : 0;
  const dur = meta?.start ? duration(meta.start, meta.end) : undefined;

  const cls = cn(
    'absolute flex flex-col gap-1 overflow-hidden rounded-xl border bg-gradient-to-br bg-surface-raised px-2.5 py-2 text-left shadow-sm transition-all duration-300 border-edge-default border-l-4',
    vis.borderTone,
    vis.tint,
    vis.dashed && 'border-dashed',
    vis.id === 'cancelled' && 'opacity-80',
    onClick &&
      'cursor-pointer hover:shadow-md hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-brand-500',
    selected && 'ring-2 ring-brand-500/50',
    vis.running && 'pulse-ring dag-node-active',
  );
  const style = { left, top, width: NODE_W, height: NODE_H } as const;

  const inner = (
    <>
      <div className='flex items-center gap-1.5'>
        <span className={cn('shrink-0', vis.glyphTone)}>
          <StatusGlyph id={vis.id} />
        </span>
        <span className='truncate text-[13px] font-semibold text-content'>{name}</span>
        {badge
          ? (
            <span className='ml-auto shrink-0 rounded bg-surface-sunken px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-content-subtle'>
              {badge}
            </span>
          )
          : null}
      </div>

      <div className='flex items-center gap-1.5 pl-[21px]'>
        <span className={cn('truncate text-[10.5px] font-medium', vis.labelTone)}>
          {shownLabel}
        </span>
        {sub
          ? <span className='truncate font-mono text-[10px] text-content-subtle'>· {sub}</span>
          : null}
      </div>

      <div className='mt-auto flex items-center justify-between gap-2 pl-[21px] text-[10px] text-content-subtle'>
        {hasSteps
          ? (
            <span className='inline-flex items-center gap-1.5'>
              <span className='h-1 w-10 overflow-hidden rounded-full bg-surface-sunken'>
                <span
                  className='block h-full rounded-full transition-[width] duration-500'
                  style={{ width: `${stepPct}%`, backgroundColor: vis.accent }}
                />
              </span>
              <span className='font-mono tabular-nums'>
                {meta?.stepsDone ?? 0}/{meta?.stepsTotal}
              </span>
            </span>
          )
          : <span />}
        {dur ? <span className='font-mono tabular-nums'>{dur}</span> : null}
      </div>

      {vis.running
        ? (
          <span
            aria-hidden
            className='pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden'
          >
            <span className='dag-node-shimmer block h-full w-1/3 rounded-full bg-indigo-500/70' />
          </span>
        )
        : null}
    </>
  );

  const title = `${name} · ${shownLabel}${dur ? ` · ${dur}` : ''}`;
  return onClick
    ? (
      <button
        type='button'
        onClick={onClick}
        className={cls}
        style={style}
        title={title}
        aria-pressed={selected}
      >
        {inner}
      </button>
    )
    : (
      <div className={cls} style={style} title={title}>
        {inner}
      </div>
    );
}

function GraphLegend({ nodes }: { nodes: DagNode[] }) {
  // Tally the fine-grained visual state actually present in this graph.
  const counts = new Map<TaskVisualId, number>();
  for (const n of nodes) {
    const id = taskVisual(n.kind, n.label).id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const order: TaskVisualId[] = [
    'succeeded',
    'running',
    'failed',
    'timedout',
    'cancelled',
    'skipped',
    'when-skipped',
    'waiting',
    'pending',
    'none',
  ];
  const present = order.filter((id) => (counts.get(id) ?? 0) > 0);
  if (!present.length) return null;
  return (
    <div className='flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-edge-subtle px-3 py-2.5'>
      {present.map((id) => {
        const v = TASK_VISUALS[id];
        return (
          <span
            key={id}
            className='inline-flex items-center gap-1.5 text-[11px] text-content-muted'
          >
            <span className={cn('inline-flex', v.glyphTone)}>
              <StatusGlyph id={id} size={13} />
            </span>
            <span className='tabular-nums'>{counts.get(id)}</span> {v.legend}
          </span>
        );
      })}
    </div>
  );
}

/* ─────────── Run-level progress (segmented by real task status) ─────────── */

/** Order + colour for a stacked progress segment. */
const PROGRESS_SEGMENTS: Array<{ ids: TaskVisualId[]; color: string }> = [
  { ids: ['succeeded'], color: '#10b981' },
  { ids: ['skipped', 'when-skipped'], color: '#f59e0b' },
  { ids: ['cancelled'], color: '#64748b' },
  { ids: ['failed', 'timedout'], color: '#f43f5e' },
  { ids: ['running'], color: '#6366f1' },
];

function RunProgressBar({
  spec,
  statusFor,
  statusKind,
  statusLabel,
  durationText,
  running,
}: {
  spec: TektonPipelineSpec | undefined;
  statusFor: (taskName: string) => { kind: StatusKind; label: string };
  statusKind: StatusKind;
  statusLabel: string;
  durationText: string;
  running: boolean;
}) {
  const { counts, total, done } = useMemo(() => {
    const names = [
      ...(spec?.tasks ?? []).map((t) => t.name ?? ''),
      ...(spec?.finally ?? []).map((t) => t.name ?? ''),
    ].filter(Boolean);
    const c = new Map<TaskVisualId, number>();
    for (const n of names) {
      const s = statusFor(n);
      const id = taskVisual(s.kind, s.label).id;
      c.set(id, (c.get(id) ?? 0) + 1);
    }
    const pending = (c.get('pending') ?? 0) + (c.get('waiting') ?? 0) + (c.get('none') ?? 0) +
      (c.get('running') ?? 0);
    return { counts: c, total: names.length, done: Math.max(0, names.length - pending) };
  }, [spec, statusFor]);

  return (
    <div className='rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <StatusBadge kind={statusKind} pulse={running}>{statusLabel}</StatusBadge>
          <span className='text-[12px] text-content-muted'>
            {total ? `${done} of ${total} stages complete` : 'No stages'}
          </span>
        </div>
        <span className='font-mono text-[12px] tabular-nums text-content-muted'>
          {durationText}
        </span>
      </div>
      <div className='mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken'>
        {total
          ? PROGRESS_SEGMENTS.map((seg, i) => {
            const n = seg.ids.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0);
            if (!n) return null;
            return (
              <span
                key={i}
                className={cn(
                  'h-full transition-[width] duration-500',
                  seg.color === '#6366f1' && running && 'animate-pulse',
                )}
                style={{ width: `${(n / total) * 100}%`, backgroundColor: seg.color }}
              />
            );
          })
          : null}
      </div>
    </div>
  );
}

/** Compact task progress bar for the PipelineRuns list. */
function MiniTaskProgress({ run }: { run: TektonRun }) {
  const { done, total } = runCounts(run);
  const kind = tektonKind(tektonCondition(run.status?.conditions));
  const color = stateColor(kind);
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <span className='inline-flex items-center gap-2'>
      <span className='h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunken'>
        <span
          className='block h-full rounded-full transition-[width] duration-500'
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </span>
      <span className='font-mono text-xs tabular-nums text-content-muted'>
        {total ? `${done}/${total}` : '—'}
      </span>
    </span>
  );
}

/* ─────────── PipelineRuns tab ─────────── */

export function TektonPipelineRuns({ namespace }: { namespace?: string }) {
  const live = useLiveList<TektonRun>(PIPELINERUNS_GVR, { namespace });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<TektonRun | null>(null);
  useTick();

  const all = live.data;
  const rows = useMemo(
    () =>
      all
        .filter(
          (r) =>
            matchesSearch(r.metadata?.name, search) ||
            matchesSearch(r.metadata?.namespace, search) ||
            matchesSearch(r.spec?.pipelineRef?.name, search) ||
            matchesSearch(tektonCondition(r.status?.conditions)?.reason, search),
        )
        .slice()
        .sort(newestFirst),
    [all, search],
  );

  const notInstalled = live.status === 'error' && all.length === 0;

  return (
    <>
      <ListShell
        title='PipelineRuns'
        total={all.length}
        visible={rows.length}
        loading={live.isLoading}
        onRefresh={() => live.refetch()}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder='Search pipeline runs…'
        caption='newest first'
        filters={<LiveIndicator status={live.status} />}
      >
        <DataTable
          loading={live.isLoading}
          onRowClick={(r) => setSelected(r)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (r) => (
                <div className='min-w-0'>
                  <div className='truncate font-medium text-content'>{r.metadata?.name}</div>
                  <div className='truncate text-[11px] text-content-muted'>
                    {r.metadata?.namespace}
                  </div>
                </div>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (r) => {
                const c = tektonCondition(r.status?.conditions);
                return <StatusBadge kind={tektonKind(c)}>{tektonLabel(c)}</StatusBadge>;
              },
            },
            {
              key: 'pipeline',
              header: 'Pipeline',
              cell: (r) => (
                <code className='text-xs text-content-muted'>
                  {r.spec?.pipelineRef?.name ?? (r.spec?.pipelineSpec ? 'inline' : '—')}
                </code>
              ),
            },
            {
              key: 'trigger',
              header: 'Trigger',
              cell: (r) => <span className='text-xs text-content-muted'>{runTrigger(r)}</span>,
            },
            {
              key: 'tasks',
              header: 'Tasks',
              cell: (r) => <MiniTaskProgress run={r} />,
            },
            {
              key: 'started',
              header: 'Started',
              cell: (r) => age(r.status?.startTime ?? r.metadata?.creationTimestamp),
            },
            {
              key: 'duration',
              header: 'Duration',
              cell: (r) => (
                <span className='font-mono text-xs tabular-nums text-content-muted'>
                  {duration(r.status?.startTime, r.status?.completionTime)}
                </span>
              ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.metadata?.uid ?? `${r.metadata?.namespace}/${r.metadata?.name}`}
          empty={notInstalled
            ? (
              <EmptyState
                title='Tekton Pipelines not available'
                description="The tekton.dev/v1 PipelineRuns API isn't served on this cluster (or the watch was denied). Install Tekton Pipelines to see runs here."
              />
            )
            : (
              <EmptyState
                title='No pipeline runs'
                description='Tekton PipelineRuns in this scope will appear here as they start.'
              />
            )}
        />
      </ListShell>
      {selected ? <PipelineRunDrawer run={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

/* ─────────── PipelineRun detail drawer (the centerpiece) ─────────── */

function PipelineRunDrawer({ run: initial, onClose }: { run: TektonRun; onClose(): void }) {
  const { cluster } = useActiveCluster();
  const cp = clusterParam(cluster);
  const qc = useQueryClient();
  const canWrite = useHasK8sPermission('crds.write');
  const ns = initial.metadata?.namespace;
  const name = initial.metadata?.name ?? '';
  useTick();

  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  // Live single-run refetch so the drawer reflects progress.
  const runQ = useQuery<TektonRun>({
    queryKey: ['platform', 'tekton', 'pipelinerun', ns ?? '-', name, cp ?? '-'],
    queryFn: () => kube.get<TektonRun>(PIPELINERUNS_GVR, ns, name, { cluster: cp }),
    initialData: initial,
    refetchInterval: 5000,
    retry: false,
  });
  const run = runQ.data ?? initial;
  const running = isRunning(run);

  // TaskRuns for this run — colours the DAG and feeds per-step logs.
  const taskRunsQ = useQuery<TektonTaskRunObj[]>({
    queryKey: ['platform', 'tekton', 'taskruns', ns ?? '-', name, cp ?? '-'],
    queryFn: () =>
      kube
        .list<TektonTaskRunObj>(TASKRUNS_GVR, {
          namespace: ns,
          labelSelector: `tekton.dev/pipelineRun=${name}`,
          cluster: cp,
        })
        .then((l) => l.items),
    refetchInterval: running ? 5000 : false,
    retry: false,
  });
  const taskRunsForbidden = (taskRunsQ.error as { status?: number } | null)?.status === 403;

  const spec = run.status?.pipelineSpec ?? run.spec?.pipelineSpec;
  // name → skip reason (e.g. "When Expressions evaluated to false"); '' if unknown.
  const skipReason = new Map<string, string>();
  for (const s of run.status?.skippedTasks ?? []) {
    if (s.name) skipReason.set(s.name, s.reason ?? '');
  }

  // pipelineTaskName → TaskRun (label `tekton.dev/pipelineTask`, else childRef map).
  const trByTask = useMemo(() => {
    const map = new Map<string, TektonTaskRunObj>();
    const list = taskRunsQ.data ?? [];
    const childByName = new Map<string, string>(); // taskRun name → pipelineTaskName
    for (const ref of run.status?.childReferences ?? []) {
      if (ref.name && ref.pipelineTaskName) childByName.set(ref.name, ref.pipelineTaskName);
    }
    for (const tr of list) {
      const lbl = tr.metadata?.labels?.['tekton.dev/pipelineTask'];
      const key = lbl ?? (tr.metadata?.name ? childByName.get(tr.metadata.name) : undefined);
      if (key) map.set(key, tr);
    }
    return map;
  }, [taskRunsQ.data, run.status?.childReferences]);

  const statusFor = useMemo(
    () => (taskName: string): { kind: StatusKind; label: string } => {
      if (skipReason.has(taskName)) {
        const reason = skipReason.get(taskName) ?? '';
        // Distinguish a when-expression skip from other skips (e.g. missing results).
        const isWhen = /when/i.test(reason);
        return { kind: 'paused', label: isWhen ? 'When-skipped' : 'Skipped' };
      }
      const tr = trByTask.get(taskName);
      if (!tr) {
        // Embedded (deprecated) taskRuns fallback.
        const embedded = Object.values(run.status?.taskRuns ?? {}).find((t) =>
          t.pipelineTaskName === taskName
        );
        if (embedded) {
          const c = tektonCondition(embedded.status?.conditions);
          return { kind: tektonKind(c), label: tektonLabel(c) };
        }
        return { kind: 'unknown', label: running ? 'Pending' : '—' };
      }
      const c = tektonCondition(tr.status?.conditions);
      return { kind: tektonKind(c), label: tektonLabel(c) };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trByTask, skipReason, run.status?.taskRuns, running],
  );

  // Per-node runtime meta (real TaskRun timings + step progress) for the canvas.
  const metaFor = useMemo(
    () => (taskName: string): TaskNodeMeta | undefined => {
      const tr = trByTask.get(taskName);
      if (!tr) return undefined;
      const steps = tr.status?.steps ?? [];
      const declared = tr.status?.taskSpec?.steps ?? [];
      const stepsTotal = steps.length || declared.length || undefined;
      const stepsDone = steps.filter((s) => Boolean(s.terminated)).length;
      return {
        start: tr.status?.startTime,
        end: tr.status?.completionTime,
        stepsTotal,
        stepsDone: stepsTotal ? stepsDone : undefined,
      };
    },
    [trByTask],
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['platform', 'tekton'] });
  };

  const cancelMut = useMutation({
    mutationFn: () =>
      kube.patch(PIPELINERUNS_GVR, ns, name, { spec: { status: 'Cancelled' } }, 'merge', {
        cluster: cp,
      }),
    onSuccess: () => {
      setActionError(null);
      runQ.refetch();
      invalidate();
    },
    onError: (e) => setActionError(describeErr(e, 'Cancel failed')),
  });

  const rerunMut = useMutation({
    mutationFn: () => {
      const manifest: KubeObject = {
        apiVersion: 'tekton.dev/v1',
        kind: 'PipelineRun',
        metadata: { name: rerunName(name), ...(ns ? { namespace: ns } : {}) },
        spec: pruneSpec(run.spec),
      };
      return kube.apply<TektonRun>(manifest, { cluster: cp });
    },
    onSuccess: () => {
      setActionError(null);
      invalidate();
      onClose();
    },
    onError: (e) => setActionError(describeErr(e, 'Re-run failed')),
  });

  const deleteMut = useMutation({
    mutationFn: () => kube.delete(PIPELINERUNS_GVR, ns, name, { cluster: cp }),
    onSuccess: () => {
      setActionError(null);
      setDeleted(true);
      setConfirmDelete(false);
      invalidate();
    },
    onError: (e) => setActionError(describeErr(e, 'Delete failed')),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmDelete) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirmDelete]);

  const primary = tektonCondition(run.status?.conditions);
  const kind = tektonKind(primary);
  const label = tektonLabel(primary);
  const params = run.spec?.params ?? [];
  const results = run.status?.results ?? [];
  const workspaces = run.spec?.workspaces ?? [];
  const selectedTr = selectedTask ? trByTask.get(selectedTask) : undefined;

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className='fixed inset-0 z-50 flex justify-end' role='dialog' aria-modal='true'>
      <button
        type='button'
        aria-label='Close'
        className='absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]'
        onClick={onClose}
      />
      <aside className='relative flex h-full w-full max-w-5xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl'>
        <header className='flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4'>
          <div className='min-w-0'>
            <div className='text-xs font-semibold uppercase tracking-wider text-content-subtle'>
              PipelineRun · {ns ?? 'cluster'}
            </div>
            <h2 className='mt-0.5 truncate text-lg font-semibold text-content'>{name}</h2>
            <div className='mt-1 flex items-center gap-2 text-[11px] font-mono text-content-muted'>
              tekton.dev/v1
              {runQ.isFetching
                ? (
                  <span className='inline-flex items-center gap-1 text-content-subtle'>
                    <Spinner size={12} /> refreshing
                  </span>
                )
                : null}
            </div>
          </div>
          <div className='flex shrink-0 items-center gap-2'>
            <StatusBadge kind={kind}>{label}</StatusBadge>
            <button
              type='button'
              onClick={onClose}
              aria-label='Close'
              className='flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content'
            >
              <IconClose />
            </button>
          </div>
        </header>

        {/* Action bar */}
        <div className='flex flex-wrap items-center gap-2 border-b border-edge-default bg-surface-sunken/50 px-6 py-2.5'>
          {canWrite
            ? (
              <>
                <Button
                  size='sm'
                  variant='secondary'
                  disabled={!running || cancelMut.isPending}
                  onClick={() => cancelMut.mutate()}
                  title={running
                    ? 'Cancel this running PipelineRun'
                    : 'Only running PipelineRuns can be cancelled'}
                >
                  {cancelMut.isPending ? 'Cancelling…' : 'Cancel'}
                </Button>
                <Button
                  size='sm'
                  variant='secondary'
                  disabled={rerunMut.isPending}
                  onClick={() => rerunMut.mutate()}
                >
                  {rerunMut.isPending ? 'Starting…' : 'Re-run'}
                </Button>
                <Button
                  size='sm'
                  variant='danger'
                  disabled={deleteMut.isPending || deleted}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </Button>
              </>
            )
            : (
              <span className='inline-flex items-center gap-1.5 rounded-md border border-edge-default px-2 py-1 text-[11px] text-content-muted'>
                Manage runs <K8sRolePill perm='crds.write' />
              </span>
            )}
          {deleted
            ? (
              <span className='text-[12px] text-content-muted'>
                Deleted — this run has been removed.
              </span>
            )
            : null}
        </div>

        {actionError
          ? (
            <div
              className='border-b border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-6 py-2 text-[12px] text-rose-800 dark:text-rose-300'
              role='alert'
            >
              {actionError}
            </div>
          )
          : null}

        {confirmDelete
          ? (
            <div
              className='border-b border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-6 py-3'
              role='alertdialog'
              aria-label='Confirm delete'
            >
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <p className='min-w-0 flex-1 text-[12px] text-content-muted'>
                  Delete PipelineRun{' '}
                  <code className='font-mono'>{name}</code>? This removes the run and its
                  TaskRuns/logs. This cannot be undone.
                </p>
                <div className='flex items-center gap-2'>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleteMut.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    size='sm'
                    variant='danger'
                    disabled={deleteMut.isPending}
                    onClick={() => deleteMut.mutate()}
                  >
                    {deleteMut.isPending ? 'Deleting…' : 'Delete run'}
                  </Button>
                </div>
              </div>
            </div>
          )
          : null}

        <div className='flex-1 space-y-5 overflow-y-auto px-6 py-5'>
          <RunProgressBar
            spec={spec}
            statusFor={statusFor}
            statusKind={kind}
            statusLabel={label}
            durationText={duration(run.status?.startTime, run.status?.completionTime)}
            running={running}
          />

          <section className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
            <DrawerStatusTile label='Status' kind={kind} value={label} sub={primary?.message} />
            <DrawerStatusTile label='Tasks' kind='info' value={runProgress(run)} />
            <DrawerStatusTile
              label='Duration'
              kind='info'
              value={duration(run.status?.startTime, run.status?.completionTime)}
            />
            <DrawerStatusTile
              label='Started'
              kind='info'
              value={age(run.status?.startTime ?? run.metadata?.creationTimestamp)}
            />
          </section>

          <DrawerSection title='Pipeline stages'>
            {taskRunsForbidden
              ? (
                <div className='mb-2 flex items-center gap-1.5 text-[11px] text-content-muted'>
                  Task status hidden <K8sRolePill perm='crds.read' />{' '}
                  — the graph shows structure only.
                </div>
              )
              : null}
            <BlueOceanStages
              spec={spec}
              statusFor={statusFor}
              metaFor={metaFor}
              selected={selectedTask}
              onSelect={(t) => setSelectedTask(t)}
            />
            <p className='mt-2 text-[11px] text-content-subtle'>
              {selectedTask
                ? 'Select a step on the left to stream its console. Search, follow, and download from the console toolbar.'
                : 'Click a stage to open its steps and stream the console — live for running stages.'}
            </p>
          </DrawerSection>

          {selectedTask
            ? (
              <DrawerSection title={`Console · ${selectedTask}`}>
                <BlueOceanStageDetail
                  namespace={ns}
                  taskRun={selectedTr}
                  taskName={selectedTask}
                  running={running}
                  cluster={cp}
                />
              </DrawerSection>
            )
            : null}

          <DrawerSection title={`Parameters (${params.length})`}>
            {params.length
              ? (
                <div className='divide-y divide-edge-subtle text-sm'>
                  {params.map((p, i) => (
                    <Row
                      key={p.name ?? i}
                      label={p.name ?? '—'}
                      value={<code className='font-mono text-xs'>{formatValue(p.value)}</code>}
                    />
                  ))}
                </div>
              )
              : <EmptyState compact title='No parameters' />}
          </DrawerSection>

          <DrawerSection title={`Results (${results.length})`}>
            {results.length
              ? (
                <div className='divide-y divide-edge-subtle text-sm'>
                  {results.map((r, i) => (
                    <Row
                      key={r.name ?? i}
                      label={r.name ?? '—'}
                      value={<code className='font-mono text-xs'>{formatValue(r.value)}</code>}
                    />
                  ))}
                </div>
              )
              : (
                <EmptyState
                  compact
                  title={running ? 'No results yet — run in progress' : 'No results emitted'}
                />
              )}
          </DrawerSection>

          <DrawerSection title={`Workspaces (${workspaces.length})`}>
            {workspaces.length
              ? (
                <div className='divide-y divide-edge-subtle text-sm'>
                  {workspaces.map((w, i) => (
                    <Row
                      key={(w.name as string) ?? i}
                      label={(w.name as string) ?? '—'}
                      value={<code className='font-mono text-xs'>{workspaceBinding(w)}</code>}
                    />
                  ))}
                </div>
              )
              : <EmptyState compact title='No workspaces bound' />}
          </DrawerSection>

          <DrawerSection title='Timeline'>
            <RunTimeline trByTask={trByTask} spec={spec} onSelect={(t) => setSelectedTask(t)} />
          </DrawerSection>

          <DrawerSection title={`Conditions (${(run.status?.conditions ?? []).length})`}>
            {(run.status?.conditions ?? []).length
              ? (
                <ul className='divide-y divide-edge-subtle'>
                  {(run.status?.conditions ?? []).map((c, i) => (
                    <li
                      key={`${c.type ?? 'c'}-${i}`}
                      className='flex items-start gap-3 px-1 py-2 text-sm'
                    >
                      <StatusBadge kind={tektonKind(c)}>{c.reason ?? c.type ?? '—'}</StatusBadge>
                      <div className='min-w-0 flex-1'>
                        <div className='text-content'>{c.type ?? '—'}</div>
                        {c.message
                          ? <div className='mt-0.5 text-xs text-content-muted'>{c.message}</div>
                          : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )
              : <EmptyState compact title='No conditions reported' />}
          </DrawerSection>

          <Card>
            <CardHeader>
              <div className='text-sm font-semibold text-content'>Raw object</div>
            </CardHeader>
            <CardBody>
              <CodeEditor
                value={JSON.stringify(run, null, 2)}
                language='json'
                readOnly
                height={384}
                filename={`${run.metadata?.name ?? 'pipelinerun'}.json`}
              />
            </CardBody>
          </Card>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function stepKind(s: TektonStepState): StatusKind {
  if (s.terminated) {
    return s.terminated.reason === 'Completed' || s.terminated.exitCode === 0
      ? 'healthy'
      : 'failed';
  }
  if (s.running) return 'progressing';
  if (s.waiting) return 'unknown';
  return 'unknown';
}

/* ═══════════════ Blue Ocean stage viewer ═══════════════ */

/** Strip ANSI colour/control sequences so CI output reads cleanly. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Blue Ocean-style pipeline graph — stages flow left→right by DAG level, with
 * parallel stages stacked in a column and connectors drawn between them. Each
 * stage is a circular status node with its name + duration; clicking one selects
 * it and streams that stage's console below (Jenkins Blue Ocean model).
 */
/** Stroke colour for an edge leaving a stage in the given state. */
function edgeStroke(kind: StatusKind): string {
  return kind === 'healthy'
    ? '#10b981'
    : kind === 'failed' || kind === 'degraded'
    ? '#f43f5e'
    : kind === 'progressing'
    ? '#6366f1'
    : kind === 'paused'
    ? '#f59e0b'
    : '#94a3b8';
}

const ZOOM_STEPS = [0.6, 0.75, 0.9, 1, 1.15, 1.35, 1.6];

/**
 * The pipeline DAG, drawn on a canvas.
 *
 * Presented the way a pipeline actually reads: nodes laid out by dependency
 * level on a dotted canvas ground, connected by status-coloured bezier edges.
 * Edges leaving a running stage animate their dashes in the direction of flow,
 * so at a glance you can see where the pipeline currently *is* — green behind,
 * indigo moving, grey ahead, red where it broke.
 *
 * Canvas affordances: zoom in/out/reset and a full-page view, because real
 * pipelines outgrow a drawer section quickly.
 */
function BlueOceanStages({
  spec,
  statusFor,
  metaFor,
  selected,
  onSelect,
}: {
  spec: TektonPipelineSpec | undefined;
  statusFor: (t: string) => { kind: StatusKind; label: string };
  metaFor: (t: string) => TaskNodeMeta | undefined;
  selected: string | null;
  onSelect: (t: string) => void;
}) {
  const { nodes, edges } = useMemo(() => buildDag(spec, statusFor), [spec, statusFor]);
  const [zoomIdx, setZoomIdx] = useState(3);
  const [full, setFull] = useState(false);
  const zoom = ZOOM_STEPS[zoomIdx];

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false);
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [full]);

  const layout = useMemo(() => {
    // group by level → columns; assign a row within each column
    const byLevel = new Map<number, DagNode[]>();
    for (const n of nodes) {
      const arr = byLevel.get(n.level) ?? [];
      arr.push(n);
      byLevel.set(n.level, arr);
    }
    const levels = [...byLevel.keys()].sort((a, b) => a - b);
    const NW = 190;
    const NH = 56;
    const CX = 96; // column gap
    const RY = 20; // row gap
    const maxRows = Math.max(1, ...[...byLevel.values()].map((a) => a.length));
    const totalH = maxRows * NH + (maxRows - 1) * RY;
    const pos = new Map<string, { x: number; y: number }>();
    levels.forEach((lvl, ci) => {
      const col = byLevel.get(lvl)!;
      const colH = col.length * NH + (col.length - 1) * RY;
      const y0 = (totalH - colH) / 2;
      col.forEach((n, ri) => {
        pos.set(n.name, { x: ci * (NW + CX), y: y0 + ri * (NH + RY) });
      });
    });
    return {
      pos,
      width: levels.length * NW + (levels.length - 1) * CX,
      height: totalH,
      NW,
      NH,
    };
  }, [nodes]);

  if (!nodes.length) {
    return <EmptyState compact title='No stages' description='This pipeline defines no tasks.' />;
  }

  const running = nodes.some((n) => statusFor(n.name).kind === 'progressing');

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border border-edge-default',
        full ? 'fixed inset-3 z-50 shadow-2xl' : '',
      )}
    >
      {/* canvas ground — the dotted grid you expect to be able to pan around */}
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0 bg-surface-sunken/40 [--dot:rgb(100_116_139_/_0.35)] dark:[--dot:rgb(148_163_184_/_0.20)]'
        style={{
          backgroundImage: 'radial-gradient(circle, var(--dot) 1px, transparent 1px)',
          backgroundSize: '16px 16px',
        }}
      />

      {/* canvas controls */}
      <div className='absolute right-2 top-2 z-20 flex items-center gap-1 rounded-lg border border-edge-default bg-surface-raised/90 p-0.5 shadow-sm backdrop-blur'>
        <CanvasBtn
          label='Zoom out'
          disabled={zoomIdx === 0}
          onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
        >
          −
        </CanvasBtn>
        <button
          type='button'
          onClick={() => setZoomIdx(3)}
          title='Reset zoom'
          className='px-1.5 text-[10px] font-semibold tabular-nums text-content-muted hover:text-content'
        >
          {Math.round(zoom * 100)}%
        </button>
        <CanvasBtn
          label='Zoom in'
          disabled={zoomIdx === ZOOM_STEPS.length - 1}
          onClick={() => setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
        >
          +
        </CanvasBtn>
        <span className='mx-0.5 h-4 w-px bg-edge-subtle' />
        <CanvasBtn label={full ? 'Exit full page (Esc)' : 'Full page'} onClick={() => setFull((f) => !f)}>
          {full ? '⤡' : '⤢'}
        </CanvasBtn>
      </div>

      {/* legend */}
      <div className='absolute bottom-2 left-2 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-raised/90 px-2 py-1 text-[10px] text-content-muted shadow-sm backdrop-blur'>
        {(
          [
            ['healthy', 'passed'],
            ['progressing', 'running'],
            ['failed', 'failed'],
            ['unknown', 'pending'],
          ] as Array<[StatusKind, string]>
        ).map(([k, label]) => (
          <span key={label} className='inline-flex items-center gap-1'>
            <span className='h-1.5 w-1.5 rounded-full' style={{ background: edgeStroke(k) }} />
            {label}
          </span>
        ))}
      </div>

      <div className={cn('relative overflow-auto p-4', full ? 'h-full' : 'max-h-[60vh]')}>
        <div
          className='relative'
          style={{
            width: layout.width * zoom,
            height: layout.height * zoom,
            minWidth: '100%',
          }}
        >
          <div
            className='relative origin-top-left transition-transform duration-200'
            style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
          >
            {/* connector layer */}
            <svg
              className='pointer-events-none absolute inset-0 overflow-visible'
              width={layout.width}
              height={layout.height}
            >
              {edges.map((e) => {
                const a = layout.pos.get(e.from);
                const b = layout.pos.get(e.to);
                if (!a || !b) return null;
                const x1 = a.x + layout.NW;
                const y1 = a.y + layout.NH / 2;
                const x2 = b.x;
                const y2 = b.y + layout.NH / 2;
                const mx = (x1 + x2) / 2;
                const kind = statusFor(e.from).kind;
                const stroke = edgeStroke(kind);
                const flowing = kind === 'progressing';
                return (
                  <g key={`${e.from}-${e.to}`}>
                    {/* soft glow so a live edge reads on the dotted ground */}
                    <path
                      d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                      fill='none'
                      stroke={stroke}
                      strokeWidth={flowing ? 6 : 4}
                      strokeOpacity={flowing ? 0.18 : 0.1}
                      strokeLinecap='round'
                    />
                    <path
                      d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                      fill='none'
                      stroke={stroke}
                      strokeWidth={2}
                      strokeOpacity={flowing ? 0.95 : 0.6}
                      strokeLinecap='round'
                      strokeDasharray={flowing ? '7 7' : undefined}
                      className={flowing ? 'adhar-dag-flow' : undefined}
                    />
                  </g>
                );
              })}
            </svg>

            {/* stage nodes */}
            {nodes.map((n) => {
              const p = layout.pos.get(n.name)!;
              const vis = taskVisual(n.kind, n.label);
              const meta = metaFor(n.name);
              const isSel = selected === n.name;
              const accent = edgeStroke(n.kind);
              return (
                <button
                  key={n.name}
                  type='button'
                  onClick={() => onSelect(n.name)}
                  title={`${n.name} — ${n.label}`}
                  className={cn(
                    'adhar-dag-node absolute flex items-center gap-2.5 rounded-full border bg-surface-raised px-3 text-left shadow-sm transition-all',
                    'hover:-translate-y-0.5 hover:shadow-lg',
                    isSel ? 'border-brand-400 ring-2 ring-brand-400/40' : vis.borderTone,
                    n.isFinally && 'border-dashed',
                  )}
                  style={{
                    left: p.x,
                    top: p.y,
                    width: layout.NW,
                    height: layout.NH,
                    animationDelay: `${Math.min(n.level, 8) * 60}ms`,
                    boxShadow: vis.running ? `0 0 0 3px ${accent}22` : undefined,
                  }}
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                      vis.glyphTone,
                      vis.running && 'animate-pulse',
                    )}
                  >
                    <StatusGlyph id={vis.id} size={16} />
                  </span>
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[12px] font-semibold text-content'>
                      {n.name}
                    </span>
                    <span className='block truncate text-[10px] text-content-subtle'>
                      {meta ? duration(meta.start, meta.end) : n.label}
                      {meta?.stepsTotal ? ` · ${meta.stepsDone ?? 0}/${meta.stepsTotal} steps` : ''}
                    </span>
                  </span>
                  {/* status accent so colour reads even at small zoom */}
                  <span
                    aria-hidden
                    className='absolute inset-y-2 right-2 w-1 rounded-full'
                    style={{ background: accent, opacity: 0.75 }}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <style>
        {`
        @keyframes adhar-dag-flow { to { stroke-dashoffset: -28; } }
        .adhar-dag-flow { animation: adhar-dag-flow 1s linear infinite; }
        @keyframes adhar-dag-in {
          from { opacity: 0; transform: translateY(6px) scale(0.97); }
          to   { opacity: 1; transform: none; }
        }
        .adhar-dag-node { animation: adhar-dag-in .3s cubic-bezier(.2,.7,.3,1) backwards; }
        @media (prefers-reduced-motion: reduce) {
          .adhar-dag-flow, .adhar-dag-node { animation: none !important; }
        }
      `}
      </style>
      {running ? <span className='sr-only'>Pipeline is running</span> : null}
    </div>
  );
}

function CanvasBtn({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className='flex h-6 w-6 items-center justify-center rounded text-[12px] font-semibold text-content-muted transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-30'
    >
      {children}
    </button>
  );
}

/** Steps rail + streaming console for the selected stage. */
function BlueOceanStageDetail({
  namespace,
  taskRun,
  taskName,
  running,
  cluster,
}: {
  namespace?: string;
  taskRun?: TektonTaskRunObj;
  taskName: string;
  running: boolean;
  cluster?: string;
}) {
  const canLogs = useHasK8sPermission('pods.logs');
  const steps = useMemo(() => {
    const s = taskRun?.status?.steps ?? [];
    if (s.length) return s;
    const decl = taskRun?.status?.taskSpec?.steps ?? [];
    return decl.map((d) =>
      ({ name: d.name, container: d.name ? `step-${d.name}` : undefined }) as TektonStepState
    );
  }, [taskRun]);

  // Auto-select the first running/failed step, else the last.
  const initialStep = useMemo(() => {
    const failed = steps.findIndex((s) => stepKind(s) === 'failed');
    if (failed >= 0) return failed;
    const runningIdx = steps.findIndex((s) => stepKind(s) === 'progressing');
    if (runningIdx >= 0) return runningIdx;
    return Math.max(0, steps.length - 1);
  }, [steps]);

  const [active, setActive] = useState(initialStep);
  useEffect(() => setActive(initialStep), [taskName, initialStep]);
  const activeStep = steps[active];
  const podName = taskRun?.status?.podName;
  const container = activeStep?.container ??
    (activeStep?.name ? `step-${activeStep.name}` : undefined);
  const cond = tektonCondition(taskRun?.status?.conditions);

  if (!taskRun) {
    return (
      <EmptyState
        compact
        title={running ? 'Stage not started yet' : 'No TaskRun found'}
        description={running
          ? 'This stage has not been scheduled yet — its steps and logs will appear once it starts.'
          : 'No TaskRun exists for this stage (it may have been skipped, or its status is unavailable).'}
      />
    );
  }

  return (
    <div className='overflow-hidden rounded-xl border border-edge-default'>
      <div className='flex flex-wrap items-center gap-2 border-b border-edge-default bg-surface-sunken/50 px-3 py-2'>
        <StatusBadge kind={tektonKind(cond)}>{tektonLabel(cond)}</StatusBadge>
        <span className='font-mono text-[12px] font-semibold text-content'>{taskName}</span>
        {taskRun.spec?.taskRef?.name
          ? (
            <code className='text-[11px] text-content-muted'>
              {taskRun.spec.taskRef.name}
            </code>
          )
          : null}
        <span className='ml-auto text-[11px] text-content-subtle'>
          {duration(taskRun.status?.startTime, taskRun.status?.completionTime)}
        </span>
      </div>
      <div className='grid grid-cols-1 sm:grid-cols-[210px_1fr]'>
        {/* steps rail */}
        <div className='max-h-[26rem] overflow-y-auto border-b border-edge-default bg-surface-sunken/30 p-2 sm:border-b-0 sm:border-r'>
          {steps.length
            ? (
              <ul className='space-y-0.5'>
                {steps.map((s, i) => {
                  const k = stepKind(s);
                  return (
                    <li key={s.name ?? i}>
                      <button
                        type='button'
                        onClick={() => setActive(i)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                          i === active
                            ? 'bg-brand-50 font-medium text-brand-800 dark:bg-brand-500/10 dark:text-brand-300'
                            : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                        )}
                      >
                        <span
                          className={cn('h-2 w-2 shrink-0 rounded-full', k === 'progressing' && 'animate-pulse')}
                          style={{ backgroundColor: stateColor(k) }}
                        />
                        <span className='min-w-0 flex-1 truncate'>{s.name ?? `step-${i}`}</span>
                        {s.terminated?.exitCode
                          ? <span className='font-mono text-[10px] text-rose-600'>×{s.terminated.exitCode}</span>
                          : s.terminated
                          ? <span className='font-mono text-[10px] text-content-subtle'>
                            {duration(s.running?.startedAt ?? s.terminated.startedAt, s.terminated.finishedAt)}
                          </span>
                          : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
            : <div className='px-2 py-3 text-[12px] text-content-subtle'>No steps.</div>}
        </div>
        {/* console */}
        <div className='min-w-0'>
          {!canLogs
            ? (
              <div className='flex items-center gap-1.5 px-3 py-3 text-[12px] text-content-muted'>
                Streaming step logs requires <K8sRolePill perm='pods.logs' />
              </div>
            )
            : !podName
            ? (
              <div className='px-3 py-6'>
                <EmptyState
                  compact
                  title='No pod yet'
                  description="This stage hasn't been assigned a pod — logs become available once it schedules."
                />
              </div>
            )
            : (
              <StageConsole
                namespace={namespace}
                pod={podName}
                container={container}
                stepName={activeStep?.name ?? `step-${active}`}
                taskName={taskName}
                running={running && stepKind(activeStep ?? {}) === 'progressing'}
                cluster={cluster}
              />
            )}
        </div>
      </div>
    </div>
  );
}

/** Enterprise console: true live streaming (follow), search, wrap, timestamps,
 * copy, download, and fullscreen — one step at a time. */
function StageConsole({
  namespace,
  pod,
  container,
  stepName,
  taskName,
  running,
  cluster,
}: {
  namespace?: string;
  pod: string;
  container?: string;
  stepName: string;
  taskName: string;
  running: boolean;
  cluster?: string;
}) {
  const [text, setText] = useState('');
  const [state, setState] = useState<
    'loading' | 'idle' | 'empty' | 'error' | 'forbidden' | 'notfound'
  >('loading');
  const [errMsg, setErrMsg] = useState('');
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [timestamps, setTimestamps] = useState(false);
  const [search, setSearch] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Stream (follow) while running; one-shot fetch when finished.
  useEffect(() => {
    if (!namespace || !pod) {
      setState('empty');
      return;
    }
    const ctrl = new AbortController();
    setText('');
    setState('loading');
    let got = false;
    kube
      .logStream(
        namespace,
        pod,
        { container, tailLines: 8000, timestamps, follow: running, cluster, signal: ctrl.signal },
        (chunk) => {
          got = true;
          setState('idle');
          setText((t) => t + chunk);
        },
      )
      .then((full) => {
        if (ctrl.signal.aborted) return;
        if (!got) {
          setText(full);
          setState(full.trim() ? 'idle' : 'empty');
        } else if (!full.trim()) {
          setState('empty');
        }
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        const st = (e as { status?: number })?.status;
        if (st === 403) setState('forbidden');
        else if (st === 404) setState('notfound');
        else {
          setErrMsg((e as Error).message);
          setState('error');
        }
      });
    return () => ctrl.abort();
  }, [namespace, pod, container, running, cluster, timestamps]);

  // Auto-scroll to tail while following.
  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [text, follow]);

  const lines = useMemo(() => {
    const raw = stripAnsi(text).replace(/\n$/, '').split('\n');
    if (!search.trim()) return raw.map((t, i) => ({ n: i + 1, t }));
    const q = search.toLowerCase();
    return raw.map((t, i) => ({ n: i + 1, t })).filter((l) => l.t.toLowerCase().includes(q));
  }, [text, search]);

  const download = () => {
    const blob = new Blob([stripAnsi(text)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${taskName}-${stepName}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const copy = () => {
    try {
      navigator.clipboard?.writeText(stripAnsi(text));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const body = (
    <div
      className={cn(
        'flex flex-col overflow-hidden bg-slate-950',
        fullscreen ? 'fixed inset-3 z-[60] rounded-xl shadow-2xl' : 'h-[26rem]',
      )}
    >
      {/* toolbar */}
      <div className='flex flex-wrap items-center gap-1.5 border-b border-slate-800 bg-slate-900/80 px-2 py-1.5'>
        <span className='mr-1 font-mono text-[11px] text-slate-400'>{stepName}</span>
        {running
          ? (
            <span className='inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300'>
              <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400' /> live
            </span>
          )
          : null}
        <div className='relative ml-auto'>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search logs…'
            className='h-6 w-36 rounded border border-slate-700 bg-slate-800 px-2 text-[11px] text-slate-100 placeholder:text-slate-500 outline-none focus:border-brand-400'
          />
          {search
            ? (
              <span className='absolute right-1.5 top-1/2 -translate-y-1/2 font-mono text-[9px] text-slate-500'>
                {lines.length}
              </span>
            )
            : null}
        </div>
        <ConsoleBtn active={follow} onClick={() => setFollow((f) => !f)} label='Follow / auto-scroll'>
          <IconTail />
        </ConsoleBtn>
        <ConsoleBtn active={wrap} onClick={() => setWrap((w) => !w)} label='Wrap lines'>
          <IconWrapC />
        </ConsoleBtn>
        <ConsoleBtn active={timestamps} onClick={() => setTimestamps((t) => !t)} label='Timestamps'>
          <IconClock2 />
        </ConsoleBtn>
        <ConsoleBtn onClick={copy} label={copied ? 'Copied' : 'Copy'}>
          {copied ? <IconCheckC /> : <IconCopyC />}
        </ConsoleBtn>
        <ConsoleBtn onClick={download} label='Download log'>
          <IconDownloadC />
        </ConsoleBtn>
        <ConsoleBtn onClick={() => setFullscreen((f) => !f)} label='Fullscreen'>
          <IconExpandC />
        </ConsoleBtn>
      </div>
      {/* log body */}
      <div ref={scrollRef} className='min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed'>
        {state === 'loading'
          ? (
            <div className='flex items-center gap-2 py-4 text-slate-300'>
              <Spinner size={14} /> Streaming logs…
            </div>
          )
          : state === 'forbidden'
          ? <div className='py-4 text-slate-400'>Not authorized to read logs for this pod.</div>
          : state === 'notfound'
          ? <div className='py-4 text-slate-400'>Pod no longer exists — logs have been cleaned up.</div>
          : state === 'error'
          ? <div className='py-4 text-rose-300'>Couldn&apos;t load logs: {errMsg}</div>
          : state === 'empty'
          ? <div className='py-4 text-slate-500'>No log output {running ? 'yet' : ''}.</div>
          : lines.length === 0
          ? <div className='py-4 text-slate-500'>No lines match “{search}”.</div>
          : (
            <table className='w-full border-collapse'>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.n} className='align-top hover:bg-slate-900/60'>
                    <td className='select-none pr-3 text-right font-mono text-[10px] text-slate-600'>
                      {l.n}
                    </td>
                    <td
                      className={cn(
                        'text-slate-200',
                        wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
                      )}
                    >
                      {highlightMatch(l.t, search)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );

  if (fullscreen) {
    return (
      <>
        <div
          className='fixed inset-0 z-[59] bg-slate-900/50 backdrop-blur-[1px]'
          onClick={() => setFullscreen(false)}
        />
        {body}
      </>
    );
  }
  return body;
}

function highlightMatch(line: string, q: string): React.ReactNode {
  if (!q.trim()) return line;
  const idx = line.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return line;
  return (
    <>
      {line.slice(0, idx)}
      <mark className='rounded bg-amber-400/40 text-amber-100'>{line.slice(idx, idx + q.length)}</mark>
      {line.slice(idx + q.length)}
    </>
  );
}

function ConsoleBtn({
  active,
  onClick,
  label,
  children,
}: {
  active?: boolean;
  onClick(): void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded transition-colors',
        active
          ? 'bg-brand-500/25 text-brand-200 ring-1 ring-inset ring-brand-400/40'
          : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100',
      )}
    >
      {children}
    </button>
  );
}

/* console toolbar icons (13px, on dark) */
const CS = ({ children }: { children: React.ReactNode }) => (
  <svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
    {children}
  </svg>
);
const IconTail = () => <CS><path d='M12 5v14' /><path d='m19 12-7 7-7-7' /></CS>;
const IconWrapC = () => <CS><path d='M3 6h18' /><path d='M3 12h15a3 3 0 1 1 0 6h-4' /><path d='m16 16-2 2 2 2' /><path d='M3 18h7' /></CS>;
const IconClock2 = () => <CS><circle cx='12' cy='12' r='9' /><path d='M12 7v5l3 2' /></CS>;
const IconCopyC = () => <CS><rect x='9' y='9' width='13' height='13' rx='2' /><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' /></CS>;
const IconCheckC = () => <CS><path d='M20 6 9 17l-5-5' /></CS>;
const IconDownloadC = () => <CS><path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' /><path d='m7 10 5 5 5-5' /><path d='M12 15V3' /></CS>;
const IconExpandC = () => <CS><path d='M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3' /></CS>;

/* ─────────── Timeline (TaskRuns ordered by start) ─────────── */

function RunTimeline({
  trByTask,
  spec,
  onSelect,
}: {
  trByTask: Map<string, TektonTaskRunObj>;
  spec: TektonPipelineSpec | undefined;
  onSelect: (taskName: string) => void;
}) {
  const rows = useMemo(() => {
    const taskNames = [
      ...(spec?.tasks ?? []).map((t) => t.name ?? ''),
      ...(spec?.finally ?? []).map((t) => t.name ?? ''),
    ].filter(Boolean);
    const list = taskNames.map((tn) => {
      const tr = trByTask.get(tn);
      return {
        task: tn,
        start: tr?.status?.startTime,
        end: tr?.status?.completionTime,
        cond: tektonCondition(tr?.status?.conditions),
        has: Boolean(tr),
      };
    });
    return list.sort((a, b) =>
      new Date(a.start ?? '9999').getTime() - new Date(b.start ?? '9999').getTime()
    );
  }, [trByTask, spec]);

  if (!rows.length) return <EmptyState compact title='No tasks to time' />;
  return (
    <ul className='divide-y divide-edge-subtle'>
      {rows.map((r) => (
        <li key={r.task}>
          <button
            type='button'
            onClick={() => onSelect(r.task)}
            className='flex w-full items-center justify-between gap-3 rounded-md px-1.5 py-2 text-left text-sm transition-colors hover:bg-surface-sunken'
          >
            <div className='min-w-0'>
              <div className='truncate font-medium text-content'>{r.task}</div>
              <div className='text-[11px] text-content-subtle'>
                {r.start ? `started ${age(r.start)} ago` : 'not started'}
                {r.start ? ` · ${duration(r.start, r.end)}` : ''}
              </div>
            </div>
            <StatusBadge kind={r.has ? tektonKind(r.cond) : 'unknown'}>
              {r.has ? tektonLabel(r.cond) : 'Pending'}
            </StatusBadge>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ─────────── Pipelines tab ─────────── */

export function TektonPipelines({ namespace }: { namespace?: string }) {
  const q = useGeneric(PIPELINES_GVR, namespace);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<TektonPipelineObj | null>(null);
  const [running, setRunning] = useState<TektonPipelineObj | null>(null);

  const is404 = q.isError && (q.error as { status?: number })?.status === 404;
  const all = (q.data ?? []) as unknown as TektonPipelineObj[];
  const rows = useMemo(
    () => all.filter((p) => matchesSearch(p.metadata?.name, search)).slice().sort(newestFirst),
    [all, search],
  );

  if (is404) {
    return (
      <EmptyState
        title='Tekton Pipelines not installed'
        description="The tekton.dev/v1 Pipelines API isn't registered on this cluster. Install Tekton Pipelines to define and run pipelines."
      />
    );
  }

  return (
    <>
      <ListShell
        title='Pipelines'
        total={all.length}
        visible={rows.length}
        loading={q.isLoading}
        isFetching={q.isFetching && !q.isLoading}
        onRefresh={() => q.refetch()}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder='Search pipelines…'
      >
        <DataTable
          loading={q.isLoading}
          onRowClick={(p) => setSelected(p)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (p) => <span className='font-medium text-content'>{p.metadata?.name}</span>,
            },
            { key: 'ns', header: 'Namespace', cell: (p) => p.metadata?.namespace ?? '—' },
            {
              key: 'tasks',
              header: 'Tasks',
              cell: (p) => (
                <span className='font-mono text-xs text-content-muted'>
                  {p.spec?.tasks?.length ?? 0}
                </span>
              ),
            },
            {
              key: 'params',
              header: 'Params',
              cell: (p) => (
                <span className='font-mono text-xs text-content-muted'>
                  {p.spec?.params?.length ?? 0}
                </span>
              ),
            },
            { key: 'age', header: 'Age', cell: (p) => age(p.metadata?.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(p) => p.metadata?.uid ?? `${p.metadata?.namespace}/${p.metadata?.name}`}
          empty={
            <EmptyState
              title='No pipelines'
              description='Tekton Pipelines defined in this scope will appear here.'
            />
          }
        />
      </ListShell>
      {selected
        ? (
          <PipelineDrawer
            pipeline={selected}
            onClose={() => setSelected(null)}
            onRun={(p) => {
              setSelected(null);
              setRunning(p);
            }}
          />
        )
        : null}
      {running ? <RunPipelineModal pipeline={running} onClose={() => setRunning(null)} /> : null}
    </>
  );
}

function PipelineDrawer({
  pipeline,
  onClose,
  onRun,
}: {
  pipeline: TektonPipelineObj;
  onClose(): void;
  onRun(p: TektonPipelineObj): void;
}) {
  const canWrite = useHasK8sPermission('crds.write');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const spec = pipeline.spec;
  const statusFor = () => ({ kind: 'info' as StatusKind, label: '' });

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className='fixed inset-0 z-50 flex justify-end' role='dialog' aria-modal='true'>
      <button
        type='button'
        aria-label='Close'
        className='absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]'
        onClick={onClose}
      />
      <aside className='relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl'>
        <header className='flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4'>
          <div className='min-w-0'>
            <div className='text-xs font-semibold uppercase tracking-wider text-content-subtle'>
              Pipeline · {pipeline.metadata?.namespace}
            </div>
            <h2 className='mt-0.5 truncate text-lg font-semibold text-content'>
              {pipeline.metadata?.name}
            </h2>
            <div className='mt-1 text-[11px] font-mono text-content-muted'>tekton.dev/v1</div>
          </div>
          <div className='flex shrink-0 items-center gap-2'>
            {canWrite
              ? (
                <Button size='sm' onClick={() => onRun(pipeline)}>
                  Run
                </Button>
              )
              : (
                <span className='inline-flex items-center gap-1.5 rounded-md border border-edge-default px-2 py-1 text-[11px] text-content-muted'>
                  Run <K8sRolePill perm='crds.write' />
                </span>
              )}
            <button
              type='button'
              onClick={onClose}
              aria-label='Close'
              className='flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content'
            >
              <IconClose />
            </button>
          </div>
        </header>
        <div className='flex-1 space-y-5 overflow-y-auto px-6 py-5'>
          <DrawerSection title='Task graph'>
            <TaskGraph spec={spec} statusFor={statusFor} />
          </DrawerSection>
          <DrawerSection title={`Parameters (${spec?.params?.length ?? 0})`}>
            {spec?.params?.length
              ? (
                <div className='divide-y divide-edge-subtle text-sm'>
                  {spec.params.map((p, i) => (
                    <Row
                      key={p.name ?? i}
                      label={p.name ?? '—'}
                      value={
                        <span className='text-right'>
                          <code className='font-mono text-xs'>{p.type ?? 'string'}</code>
                          {p.default !== undefined
                            ? (
                              <span className='ml-1 text-content-subtle'>
                                default {formatValue(p.default)}
                              </span>
                            )
                            : null}
                        </span>
                      }
                    />
                  ))}
                </div>
              )
              : <EmptyState compact title='No parameters' />}
          </DrawerSection>
          <DrawerSection title={`Workspaces (${spec?.workspaces?.length ?? 0})`}>
            {spec?.workspaces?.length
              ? (
                <div className='divide-y divide-edge-subtle text-sm'>
                  {spec.workspaces.map((w, i) => (
                    <Row
                      key={w.name ?? i}
                      label={w.name ?? '—'}
                      value={w.optional ? 'optional' : 'required'}
                    />
                  ))}
                </div>
              )
              : <EmptyState compact title='No workspaces declared' />}
          </DrawerSection>
          <Card>
            <CardHeader>
              <div className='text-sm font-semibold text-content'>Raw object</div>
            </CardHeader>
            <CardBody>
              <CodeEditor
                value={JSON.stringify(pipeline, null, 2)}
                language='json'
                readOnly
                height={384}
                filename={`${pipeline.metadata?.name ?? 'pipeline'}.json`}
              />
            </CardBody>
          </Card>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

/** Small generated form to start a PipelineRun from a Pipeline. */
function RunPipelineModal({ pipeline, onClose }: { pipeline: TektonPipelineObj; onClose(): void }) {
  const { cluster } = useActiveCluster();
  const cp = clusterParam(cluster);
  const qc = useQueryClient();
  const ns = pipeline.metadata?.namespace;
  const pname = pipeline.metadata?.name ?? '';
  const paramSpecs = pipeline.spec?.params ?? [];
  const workspaces = pipeline.spec?.workspaces ?? [];

  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const p of paramSpecs) {
      out[p.name ?? ''] = p.default !== undefined ? String(p.default) : '';
    }
    return out;
  });

  const runMut = useMutation({
    mutationFn: () => {
      const params: TektonParamValue[] = paramSpecs
        .map((p) => ({ name: p.name, value: values[p.name ?? ''] ?? '' }))
        .filter((p) => p.name);
      const wsBindings = workspaces
        .filter((w) => !w.optional && w.name)
        .map((w) => ({ name: w.name, emptyDir: {} }));
      const spec: TektonRunSpec = { pipelineRef: { name: pname } };
      if (params.length) spec.params = params;
      if (wsBindings.length) spec.workspaces = wsBindings as TektonRunSpec['workspaces'];
      const manifest: KubeObject = {
        apiVersion: 'tekton.dev/v1',
        kind: 'PipelineRun',
        metadata: {
          name: `${pname.slice(0, 40)}-run-${Date.now().toString(36)}`,
          ...(ns ? { namespace: ns } : {}),
        },
        spec,
      };
      return kube.apply<TektonRun>(manifest, { cluster: cp });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform', 'tekton'] });
      onClose();
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !runMut.isPending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, runMut.isPending]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className='fixed inset-0 z-[60] flex items-center justify-center p-4'
      role='dialog'
      aria-modal='true'
    >
      <button
        type='button'
        aria-label='Close'
        className='absolute inset-0 bg-slate-900/45 backdrop-blur-[2px]'
        onClick={() => !runMut.isPending && onClose()}
      />
      <div className='relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-app shadow-2xl'>
        <header className='border-b border-edge-default bg-surface-raised px-5 py-4'>
          <div className='text-xs font-semibold uppercase tracking-wider text-content-subtle'>
            Start a run
          </div>
          <h2 className='mt-0.5 text-lg font-semibold text-content'>Run {pname}</h2>
          <p className='mt-1 text-[12px] leading-relaxed text-content-muted'>
            Creates a real PipelineRun referencing this pipeline via server-side apply. Required
            workspaces are bound to an <code className='font-mono'>emptyDir</code> by default.
          </p>
        </header>
        <form
          className='flex-1 space-y-4 overflow-y-auto px-5 py-4'
          onSubmit={(e) => {
            e.preventDefault();
            runMut.mutate();
          }}
        >
          {paramSpecs.length
            ? (
              <fieldset className='space-y-3' disabled={runMut.isPending}>
                <legend className='text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>
                  Parameters
                </legend>
                {paramSpecs.map((p) => (
                  <div key={p.name}>
                    <label
                      className='mb-1 block text-xs font-medium text-content'
                      htmlFor={`p-${p.name}`}
                    >
                      {p.name}
                      {p.type
                        ? (
                          <span className='ml-1 font-mono text-[10px] text-content-subtle'>
                            {p.type}
                          </span>
                        )
                        : null}
                    </label>
                    <input
                      id={`p-${p.name}`}
                      value={values[p.name ?? ''] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [p.name ?? '']: e.target.value }))}
                      placeholder={p.default !== undefined ? String(p.default) : ''}
                      className='h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-xs text-content outline-none placeholder:text-content-subtle focus:ring-2 focus:ring-brand-500/30'
                    />
                    {p.description
                      ? <p className='mt-1 text-[11px] text-content-muted'>{p.description}</p>
                      : null}
                  </div>
                ))}
              </fieldset>
            )
            : (
              <p className='text-[12px] text-content-muted'>
                This pipeline declares no parameters — it runs as-is.
              </p>
            )}
          {workspaces.length
            ? (
              <p className='text-[11px] text-content-subtle'>
                Workspaces: {workspaces.map((w) => w.name).join(', ')} — bound to emptyDir.
              </p>
            )
            : null}
          {runMut.isError
            ? (
              <div
                className='rounded-lg border border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-3 py-2 text-[12px] text-rose-800 dark:text-rose-300'
                role='alert'
              >
                <div className='font-semibold'>Run failed</div>
                <div className='mt-0.5 break-words font-mono text-[11px]'>
                  {describeErr(runMut.error, 'apply failed')}
                </div>
              </div>
            )
            : null}
        </form>
        <footer className='flex items-center justify-end gap-2 border-t border-edge-default bg-surface-raised px-5 py-3'>
          <Button variant='ghost' size='sm' onClick={onClose} disabled={runMut.isPending}>
            Cancel
          </Button>
          <Button size='sm' disabled={runMut.isPending} onClick={() => runMut.mutate()}>
            {runMut.isPending ? 'Starting…' : 'Start run'}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/* ─────────── Tasks tab ─────────── */

export function TektonTasks({ namespace }: { namespace?: string }) {
  const q = useGeneric(TASKS_GVR, namespace);
  const clusterTasksQ = useGeneric(CLUSTERTASKS_GVR);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<TektonTaskObj | null>(null);

  const is404 = q.isError && (q.error as { status?: number })?.status === 404;
  const nsTasks = (q.data ?? []) as unknown as TektonTaskObj[];
  const clusterTasks = ((clusterTasksQ.data ?? []) as unknown as TektonTaskObj[]).map((
    t,
  ) => ({ ...t, __cluster: true } as TektonTaskObj & { __cluster?: boolean }));
  const all = [...nsTasks, ...clusterTasks];
  const rows = useMemo(
    () => all.filter((t) => matchesSearch(t.metadata?.name, search)).slice().sort(newestFirst),
    [all, search],
  );

  if (is404) {
    return (
      <EmptyState
        title='Tekton Tasks not installed'
        description="The tekton.dev/v1 Tasks API isn't registered on this cluster. Install Tekton Pipelines to define reusable tasks."
      />
    );
  }

  return (
    <>
      <ListShell
        title='Tasks'
        total={all.length}
        visible={rows.length}
        loading={q.isLoading}
        isFetching={q.isFetching && !q.isLoading}
        onRefresh={() => {
          q.refetch();
          clusterTasksQ.refetch();
        }}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder='Search tasks…'
      >
        <DataTable
          loading={q.isLoading}
          onRowClick={(t) => setSelected(t)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (t) => (
                <div className='flex items-center gap-2'>
                  <span className='font-medium text-content'>{t.metadata?.name}</span>
                  {(t as { __cluster?: boolean }).__cluster
                    ? (
                      <span className='rounded bg-surface-sunken px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-content-subtle'>
                        cluster
                      </span>
                    )
                    : null}
                </div>
              ),
            },
            {
              key: 'ns',
              header: 'Namespace',
              cell: (t) => t.metadata?.namespace ?? 'cluster-scoped',
            },
            {
              key: 'steps',
              header: 'Steps',
              cell: (t) => (
                <span className='font-mono text-xs text-content-muted'>
                  {t.spec?.steps?.length ?? 0}
                </span>
              ),
            },
            {
              key: 'stepnames',
              header: 'Step names',
              cell: (t) => (
                <span className='truncate text-xs text-content-muted'>
                  {(t.spec?.steps ?? []).map((s) => s.name).filter(Boolean).join(' → ') || '—'}
                </span>
              ),
            },
            { key: 'age', header: 'Age', cell: (t) => age(t.metadata?.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(t) => t.metadata?.uid ?? `${t.metadata?.namespace ?? '-'}/${t.metadata?.name}`}
          empty={
            <EmptyState
              title='No tasks'
              description='Tekton Tasks defined in this scope will appear here.'
            />
          }
        />
      </ListShell>
      {selected ? <TaskDrawer task={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

function TaskDrawer({ task, onClose }: { task: TektonTaskObj; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const spec = task.spec;
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className='fixed inset-0 z-50 flex justify-end' role='dialog' aria-modal='true'>
      <button
        type='button'
        aria-label='Close'
        className='absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]'
        onClick={onClose}
      />
      <aside className='relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl'>
        <header className='flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4'>
          <div className='min-w-0'>
            <div className='text-xs font-semibold uppercase tracking-wider text-content-subtle'>
              Task · {task.metadata?.namespace ?? 'cluster'}
            </div>
            <h2 className='mt-0.5 truncate text-lg font-semibold text-content'>
              {task.metadata?.name}
            </h2>
          </div>
          <button
            type='button'
            onClick={onClose}
            aria-label='Close'
            className='flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content'
          >
            <IconClose />
          </button>
        </header>
        <div className='flex-1 space-y-5 overflow-y-auto px-6 py-5'>
          {spec?.description
            ? <p className='text-sm text-content-muted'>{spec.description}</p>
            : null}
          <DrawerSection title={`Steps (${spec?.steps?.length ?? 0})`}>
            {spec?.steps?.length
              ? (
                <ol className='space-y-2'>
                  {spec.steps.map((s, i) => (
                    <li
                      key={s.name ?? i}
                      className='rounded-lg border border-edge-default bg-surface-raised px-3 py-2'
                    >
                      <div className='flex items-center justify-between gap-2'>
                        <span className='text-sm font-medium text-content'>
                          {s.name ?? `step-${i + 1}`}
                        </span>
                        <code className='truncate text-[11px] text-content-subtle'>
                          {s.image ?? '—'}
                        </code>
                      </div>
                      {s.script
                        ? (
                          <pre className='mt-2 max-h-40 overflow-auto rounded bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-100'>{s.script}</pre>
                        )
                        : null}
                    </li>
                  ))}
                </ol>
              )
              : <EmptyState compact title='No steps' />}
          </DrawerSection>
          <DrawerSection title={`Parameters (${spec?.params?.length ?? 0})`}>
            {spec?.params?.length
              ? (
                <div className='divide-y divide-edge-subtle text-sm'>
                  {spec.params.map((p, i) => (
                    <Row
                      key={p.name ?? i}
                      label={p.name ?? '—'}
                      value={<code className='font-mono text-xs'>{p.type ?? 'string'}</code>}
                    />
                  ))}
                </div>
              )
              : <EmptyState compact title='No parameters' />}
          </DrawerSection>
          <DrawerSection title={`Results (${spec?.results?.length ?? 0})`}>
            {spec?.results?.length
              ? (
                <div className='divide-y divide-edge-subtle text-sm'>
                  {spec.results.map((r, i) => (
                    <Row key={r.name ?? i} label={r.name ?? '—'} value={r.description ?? '—'} />
                  ))}
                </div>
              )
              : <EmptyState compact title='No results' />}
          </DrawerSection>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

/* ─────────── Triggers tab ─────────── */

interface EventListenerObj extends KubeObject {
  spec?: {
    triggers?: Array<{
      name?: string;
      bindings?: Array<{ ref?: string; name?: string; kind?: string }>;
      template?: { ref?: string; name?: string };
      interceptors?: Array<{ ref?: { name?: string }; name?: string }>;
    }>;
    serviceAccountName?: string;
  };
  status?: { conditions?: TektonCondition[]; configuration?: { generatedName?: string } };
}

export function TektonTriggers({ namespace }: { namespace?: string }) {
  const elQ = useGeneric(EVENTLISTENERS_GVR, namespace);
  const ttQ = useGeneric(TRIGGERTEMPLATES_GVR, namespace);
  const tbQ = useGeneric(TRIGGERBINDINGS_GVR, namespace);

  const is404 = elQ.isError && (elQ.error as { status?: number })?.status === 404;
  const eventListeners = (elQ.data ?? []) as unknown as EventListenerObj[];
  const templates = (ttQ.data ?? []) as unknown as KubeObject[];
  const bindings = (tbQ.data ?? []) as unknown as KubeObject[];

  if (is404) {
    return (
      <EmptyState
        title='Tekton Triggers not installed'
        description="The triggers.tekton.dev API isn't registered on this cluster. Install Tekton Triggers to wire event sources (push, PR, cron) to PipelineRuns."
      />
    );
  }

  const loading = elQ.isLoading || ttQ.isLoading || tbQ.isLoading;

  return (
    <div className='space-y-5'>
      <Card>
        <CardHeader>
          <div className='flex items-center justify-between'>
            <div className='text-sm font-semibold text-content'>EventListeners</div>
            <span className='font-mono text-[11px] text-content-subtle'>
              {eventListeners.length}
            </span>
          </div>
        </CardHeader>
        <CardBody>
          {loading
            ? (
              <div className='flex items-center gap-2 text-[12px] text-content-muted'>
                <Spinner size={14} /> Loading triggers…
              </div>
            )
            : !eventListeners.length
            ? (
              <EmptyState
                compact
                title='No EventListeners'
                description='EventListeners receive webhooks and fan out to triggers → templates → PipelineRuns.'
              />
            )
            : (
              <div className='space-y-4'>
                {eventListeners.map((el) => (
                  <EventListenerCard key={el.metadata?.uid ?? el.metadata?.name} el={el} />
                ))}
              </div>
            )}
        </CardBody>
      </Card>

      <div className='grid gap-5 md:grid-cols-2'>
        <RefListCard title='TriggerTemplates' items={templates} />
        <RefListCard title='TriggerBindings' items={bindings} />
      </div>
    </div>
  );
}

function EventListenerCard({ el }: { el: EventListenerObj }) {
  const cond = tektonCondition(el.status?.conditions);
  const triggers = el.spec?.triggers ?? [];
  return (
    <div className='rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <span className='text-sm font-semibold text-content'>{el.metadata?.name}</span>
          <code className='text-[11px] text-content-subtle'>{el.metadata?.namespace}</code>
        </div>
        <StatusBadge kind={el.status?.conditions?.length ? tektonKind(cond) : 'unknown'}>
          {el.status?.conditions?.length ? tektonLabel(cond) : 'Unknown'}
        </StatusBadge>
      </div>
      {/* Service map: push → EventListener → trigger → bindings/template → PipelineRun */}
      {triggers.length
        ? (
          <ul className='mt-3 space-y-2'>
            {triggers.map((t, i) => (
              <li
                key={t.name ?? i}
                className='rounded-lg border border-edge-subtle bg-surface-app px-3 py-2'
              >
                <div className='flex flex-wrap items-center gap-2 text-[12px]'>
                  <span className='rounded bg-sky-50 px-1.5 py-0.5 font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-300'>
                    {t.name ?? `trigger-${i + 1}`}
                  </span>
                  <span className='text-content-subtle'>→</span>
                  {(t.bindings ?? []).map((b, bi) => (
                    <code
                      key={bi}
                      className='rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-content-muted'
                    >
                      binding: {b.ref ?? b.name ?? '—'}
                    </code>
                  ))}
                  <span className='text-content-subtle'>→</span>
                  <code className='rounded bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'>
                    template: {t.template?.ref ?? t.template?.name ?? '—'}
                  </code>
                  {(t.interceptors ?? []).length
                    ? (
                      <span className='text-[11px] text-content-subtle'>
                        · {(t.interceptors ?? []).map((x) => x.ref?.name ?? x.name).filter(Boolean)
                          .join(', ')}
                      </span>
                    )
                    : null}
                </div>
              </li>
            ))}
          </ul>
        )
        : (
          <p className='mt-2 text-[12px] text-content-muted'>
            No triggers configured on this EventListener.
          </p>
        )}
    </div>
  );
}

function RefListCard({ title, items }: { title: string; items: KubeObject[] }) {
  return (
    <Card>
      <CardHeader>
        <div className='flex items-center justify-between'>
          <div className='text-sm font-semibold text-content'>{title}</div>
          <span className='font-mono text-[11px] text-content-subtle'>{items.length}</span>
        </div>
      </CardHeader>
      <CardBody>
        {!items.length
          ? <EmptyState compact title={`No ${title}`} />
          : (
            <ul className='divide-y divide-edge-subtle'>
              {items.map((it) => (
                <li
                  key={it.metadata?.uid ?? it.metadata?.name}
                  className='flex items-center justify-between gap-3 px-1 py-2 text-sm'
                >
                  <span className='truncate font-medium text-content'>{it.metadata?.name}</span>
                  <span className='text-[11px] text-content-subtle'>
                    {age(it.metadata?.creationTimestamp)}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </CardBody>
    </Card>
  );
}

/* ─────────── small util ─────────── */

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function workspaceBinding(w: Record<string, unknown>): string {
  const keys = Object.keys(w).filter((k) => k !== 'name');
  if (!keys.length) return '—';
  const k = keys[0];
  const v = w[k];
  if (v && typeof v === 'object') {
    const inner = v as Record<string, unknown>;
    const named = (inner.claimName ?? inner.name ?? inner.secretName ?? inner.configMap) as
      | string
      | undefined;
    return named ? `${k}: ${named}` : k;
  }
  return `${k}: ${formatValue(v)}`;
}

/** Generate a unique re-run name derived from the source run. */
function rerunName(base: string): string {
  const root = base.replace(/-(rerun|run)-[a-z0-9]+$/i, '').slice(0, 40);
  return `${root}-rerun-${Date.now().toString(36)}`;
}

/** Strip status/name-bound fields from a run spec so it can be re-applied fresh. */
function pruneSpec(spec: TektonRunSpec | undefined): TektonRunSpec {
  if (!spec) return {};
  const out: TektonRunSpec = {};
  if (spec.pipelineRef) out.pipelineRef = spec.pipelineRef;
  if (spec.pipelineSpec) out.pipelineSpec = spec.pipelineSpec;
  if (spec.params) out.params = spec.params;
  if (spec.workspaces) out.workspaces = spec.workspaces;
  if (spec.serviceAccountName) out.serviceAccountName = spec.serviceAccountName;
  if (spec.taskRunTemplate) out.taskRunTemplate = spec.taskRunTemplate;
  if (spec.timeouts) out.timeouts = spec.timeouts;
  // Deliberately drop spec.status (would create a pre-cancelled run).
  return out;
}

function describeErr(e: unknown, prefix: string): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 403) return `${prefix}: not authorized (403).`;
  if (status === 404) return `${prefix}: not found (404).`;
  return `${prefix}: ${e instanceof Error ? e.message : String(e)}`;
}

function IconClose() {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.25'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden
    >
      <path d='M18 6 6 18' />
      <path d='m6 6 12 12' />
    </svg>
  );
}
