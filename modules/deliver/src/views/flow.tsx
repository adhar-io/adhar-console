import { type ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  EmptyState,
  Input,
  Select,
  Spinner,
  useClickOutside,
  useTeamProjects,
  useToast,
  DrawerWidenButton,
  useDrawerWidth,
} from '@adhar/shell-ui';
import { cn } from '@adhar/utils';
import { type argocd, kargo } from '@adhar/api-clients';
import { useAllArgoApps, useAnalysisRun } from '../data/project-environments.ts';
import { useFreight, usePromotions, useRollouts, useStages } from '../data/delivery.ts';
import {
  useAllWarehouses,
  useApplicationXRs,
  useCiRuns,
  useGiteaCommits,
  useGiteaPulls,
  useGiteaRepos,
  useImageArtifacts,
  useProjectXRs,
} from '../data/flow.ts';
import { flowLink, useFlowParams, useSetFlowParams } from '../data/flow-nav.ts';
import {
  appEnvironments,
  appFreight,
  type AppSummary,
  buildFlow,
  collectApps,
  type CommitTrace,
  type EnvView,
  findApp,
  type FlowApp,
  type FlowStage,
  fmtDuration,
  imageRepoFor,
  type LeadTimeBreakdown,
  leadTimes,
  links,
  looksLikeSha,
  newestRunFirst,
  ok,
  type PackageRow,
  platformPackages,
  readRun,
  relTime,
  resolveRepo,
  runIsForApp,
  type RunView,
  sourceProblem,
  type Src,
  stopsAt,
  summarizeApp,
  teamApps,
  type Tone,
  toSrc,
  traceCommit,
  type TraceStep,
} from '../data/value-stream.ts';

/**
 * Delivery Flow — the value stream of the applications TEAMS build.
 *
 * One application at a time, left to right:
 *
 *   Code → Pull request → Build → Scan & sign → Image → Freight → dev → test → prod
 *
 * The app list comes from the control plane (Application XRs), the Argo CD
 * apps it composes per environment (`adhar.io/application`), and — as a
 * fallback — the org's non-platform repositories. Platform packages are
 * excluded (they are installed from the release channel, not built per
 * commit) and can be listed separately in a GitOps-only flow.
 *
 * Every stage is read from the tool that owns it; when a source is forbidden
 * or unreachable, that stage says so. When the change stops somewhere — no
 * environments, a missing warehouse, a paused scan gate — the stage says why
 * instead of the page going blank.
 */

/* ─────────── tones ─────────── */

const TONE_TEXT: Record<Tone, string> = {
  done: 'text-emerald-700 dark:text-emerald-300',
  running: 'text-indigo-700 dark:text-indigo-300',
  failed: 'text-rose-700 dark:text-rose-300',
  blocked: 'text-amber-700 dark:text-amber-300',
  waiting: 'text-sky-700 dark:text-sky-300',
  none: 'text-content-subtle',
  unavailable: 'text-content-subtle',
  loading: 'text-content-subtle',
};
const TONE_BORDER: Record<Tone, string> = {
  done: 'border-emerald-300/80 dark:border-emerald-500/35',
  running: 'border-indigo-300/80 dark:border-indigo-500/40',
  failed: 'border-rose-400/80 dark:border-rose-500/45',
  blocked: 'border-amber-400/80 dark:border-amber-500/45',
  waiting: 'border-sky-300/80 dark:border-sky-500/35',
  none: 'border-edge-default',
  unavailable: 'border-dashed border-edge-strong',
  loading: 'border-edge-default',
};
const TONE_WORD: Record<Tone, string> = {
  done: 'Done',
  running: 'In progress',
  failed: 'Failed',
  blocked: 'Blocked',
  waiting: 'Waiting',
  none: 'Nothing yet',
  unavailable: 'Unavailable',
  loading: 'Loading',
};

function ToneIcon({ tone, size = 14 }: { tone: Tone; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  const cls = cn('shrink-0', TONE_TEXT[tone]);
  switch (tone) {
    case 'done':
      return (
        <svg {...p} className={cls}>
          <circle cx='12' cy='12' r='9' />
          <path d='m8 12 3 3 5-6' />
        </svg>
      );
    case 'running':
      return (
        <svg {...p} className={cn(cls, 'animate-spin [animation-duration:2.4s]')}>
          <path d='M21 12a9 9 0 1 1-6.2-8.6' />
        </svg>
      );
    case 'failed':
      return (
        <svg {...p} className={cls}>
          <circle cx='12' cy='12' r='9' />
          <path d='m15 9-6 6M9 9l6 6' />
        </svg>
      );
    case 'blocked':
      return (
        <svg {...p} className={cls}>
          <rect x='5' y='11' width='14' height='9' rx='2' />
          <path d='M8 11V8a4 4 0 0 1 8 0v3' />
        </svg>
      );
    case 'waiting':
      return (
        <svg {...p} className={cls}>
          <circle cx='12' cy='12' r='9' />
          <path d='M12 7v5l3 2' />
        </svg>
      );
    case 'unavailable':
      return (
        <svg {...p} className={cls}>
          <path d='M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.3-1.7M12 20h.01' />
        </svg>
      );
    case 'loading':
      return <Spinner size={size - 2} />;
    default:
      return (
        <svg {...p} className={cls}>
          <circle cx='12' cy='12' r='9' strokeDasharray='3 3' />
        </svg>
      );
  }
}

const STAGE_ICON: Record<string, ReactNode> = {
  code: <path d='m16 18 6-6-6-6M8 6l-6 6 6 6' />,
  pr: (
    <>
      <circle cx='6' cy='6' r='3' />
      <circle cx='6' cy='18' r='3' />
      <path d='M6 9v6' />
      <circle cx='18' cy='18' r='3' />
      <path d='M18 15V9a3 3 0 0 0-3-3h-4' />
    </>
  ),
  build: (
    <path d='M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.4-.6-.6-2.4z' />
  ),
  scan: <path d='M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3zM9 12l2 2 4-4' />,
  image: (
    <>
      <path d='M21 8 12 3 3 8v8l9 5 9-5V8z' />
      <path d='m3 8 9 5 9-5M12 13v8' />
    </>
  ),
  freight: (
    <>
      <rect x='3' y='7' width='18' height='13' rx='2' />
      <path d='M8 7V4h8v3' />
    </>
  ),
  env: (
    <>
      <rect x='3' y='4' width='18' height='12' rx='2' />
      <path d='M8 20h8M12 16v4' />
    </>
  ),
};

function StageIcon({ id }: { id: string }) {
  const key = id.startsWith('env:') ? 'env' : id;
  return (
    <svg
      width='13'
      height='13'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden
    >
      {STAGE_ICON[key] ?? STAGE_ICON.env}
    </svg>
  );
}

const ENV_TITLE: Record<string, string> = {
  dev: 'Development',
  development: 'Development',
  test: 'Test',
  qa: 'QA',
  uat: 'UAT',
  staging: 'Staging',
  stage: 'Staging',
  prod: 'Production',
  production: 'Production',
};
const envTitle = (n: string) => ENV_TITLE[n.toLowerCase()] ?? n;

const HEALTH_DOT: Record<AppSummary['health'], string> = {
  healthy: 'bg-emerald-500',
  progressing: 'bg-indigo-500',
  degraded: 'bg-rose-500',
  unknown: 'bg-slate-300 dark:bg-slate-600',
};
const HEALTH_WORD: Record<AppSummary['health'], string> = {
  healthy: 'Healthy',
  progressing: 'Progressing',
  degraded: 'Degraded',
  unknown: 'No health yet',
};

/* ─────────── root ─────────── */

export function DeliveryFlow() {
  const params = useFlowParams();
  const setParams = useSetFlowParams();
  const toast = useToast();
  const team = useTeamProjects();

  const xrs = useApplicationXRs();
  const projects = useProjectXRs();
  const argo = useAllArgoApps();
  const repos = useGiteaRepos();
  const runsQ = useCiRuns();
  const stages = useStages();
  const freight = useFreight();
  const promotions = usePromotions();
  const warehouses = useAllWarehouses();
  const rollouts = useRollouts();

  const allApps = useMemo(
    () =>
      collectApps({
        xrs: xrs.data ?? [],
        argoApps: argo.data ?? [],
        repos: repos.data ?? [],
        projects: (projects.data ?? []).map((p) => p.metadata.name),
      }),
    [xrs.data, argo.data, repos.data, projects.data],
  );
  const slugs = useMemo(
    () =>
      new Set(
        team.projects.flatMap((p) =>
          [p.slug, p.argoProject].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase())
        ),
      ),
    [team.projects],
  );
  const apps = useMemo(() => teamApps(allApps, { filtering: team.filtering, slugs }), [
    allApps,
    team.filtering,
    slugs,
  ]);

  const runPairs = useMemo(() => (runsQ.data ?? []).map((raw) => ({ raw, view: readRun(raw) })), [
    runsQ.data,
  ]);
  const ctx = useMemo(() => {
    const projectList = projects.data ?? [];
    const out = new Map<
      string,
      { envs: EnvView[]; runs: RunView[]; freight: kargo.Freight[]; summary: AppSummary }
    >();
    for (const app of apps) {
      const envs = appEnvironments({
        app,
        project: projectList.find((p) => p.metadata.name === app.project) ?? null,
        stages: stages.data ?? [],
        freight: freight.data ?? [],
        promotions: promotions.data ?? [],
        argoApps: argo.data ?? [],
        rollouts: rollouts.data ?? [],
      });
      const names = [app.name, app.repo].filter((v): v is string => Boolean(v));
      const runs = runPairs.filter((p) => runIsForApp(p.raw, names)).map((p) => p.view).sort(
        newestRunFirst,
      );
      const extraWh = envs.map((
        e,
      ) => (e.cell?.stage?.shape === 'per-app' ? e.cell.stage.stage.warehouse : undefined)).filter((
        v,
      ): v is string => Boolean(v));
      const fr = appFreight(freight.data ?? [], app, extraWh);
      const hasRepo = Boolean(resolveRepo(app, repos.data ?? []));
      out.set(app.key, {
        envs,
        runs,
        freight: fr,
        summary: summarizeApp(app, { envs, runs, freight: fr, hasRepo }),
      });
    }
    return out;
  }, [
    apps,
    projects.data,
    stages.data,
    freight.data,
    promotions.data,
    argo.data,
    rollouts.data,
    runPairs,
    repos.data,
  ]);

  const app = findApp(apps, params.app) ?? findApp(allApps, params.app) ?? apps[0];
  const platform = useMemo(() => platformPackages(argo.data ?? []), [argo.data]);
  const showPlatform = params.platform === '1';

  const listLoading = (xrs.isLoading || argo.isLoading || repos.isLoading) && !allApps.length;
  const listErrors = [
    xrs.isError && !xrs.data ? sourceProblem('Application resources', toSrc(xrs)) : undefined,
    argo.isError && !argo.data ? sourceProblem('Argo CD', toSrc(argo)) : undefined,
    repos.isError && !repos.data ? sourceProblem('Gitea', toSrc(repos)) : undefined,
  ].filter((v): v is string => Boolean(v));

  const copyLink = () => {
    const url = flowLink({ app: app?.key, commit: params.commit, platform: params.platform });
    const done = () => toast.success('Link copied', { description: url });
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done, () => toast.error('Could not copy the link'));
    } else toast.info('Copy this link', { description: url });
  };

  return (
    <div className='min-w-0 space-y-5'>
      <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
        <div className='flex min-w-0 flex-wrap items-center gap-2'>
          {app
            ? (
              <AppPicker
                apps={apps}
                selected={app}
                summaries={ctx}
                onPick={(a) => setParams({ app: a.key, commit: undefined, stage: undefined })}
              />
            )
            : null}
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          <PlatformToggle
            on={showPlatform}
            count={platform.length}
            onChange={(v) => setParams({ platform: v ? '1' : undefined })}
          />
          <Button size='sm' onClick={copyLink} disabled={!app && !showPlatform}>Copy link</Button>
        </div>
      </div>

      {platform.length && !showPlatform
        ? (
          <p className='-mt-2 text-[11.5px] text-content-subtle'>
            {platform.length}{' '}
            platform packages are not shown — they are installed from the platform's release channel
            and synced by Argo CD, not built per commit.
          </p>
        )
        : null}

      {listErrors.length
        ? (
          <div className='rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
            The application list may be incomplete: {listErrors.join(' ')}
          </div>
        )
        : null}

      {listLoading
        ? (
          <div className='flex items-center gap-2 py-8 text-sm text-content-muted'>
            <Spinner size={14} /> Reading applications…
          </div>
        )
        : app
        ? (
          <AppFlow
            key={app.key}
            app={app}
            c={ctx.get(app.key) ??
              {
                envs: [],
                runs: [],
                freight: [],
                summary: summarizeApp(app, { envs: [], runs: [], freight: [], hasRepo: false }),
              }}
            repos={toSrc(repos)}
            runsSrc={toSrc(runsQ)}
            freightSrc={toSrc(freight)}
            warehouses={toSrc(warehouses)}
            projects={toSrc(projects)}
            stagesSrc={toSrc(stages)}
            argoSrc={toSrc(argo)}
            commitParam={params.commit}
            stageParam={params.stage}
            setParams={setParams}
          />
        )
        : (
          <EmptyState
            title='No team applications yet'
            description={`The delivery flow follows the applications your teams build, from commit to production. An application appears here once it exists as an Application resource (create one from a template in the catalog), is deployed by Argo CD with the adhar.io/application label, or has its own repository in the Gitea org.${
              platform.length
                ? ` The ${platform.length} platform packages are excluded — use “Show platform packages” to see their GitOps status.`
                : ''
            }`}
          />
        )}

      {showPlatform ? <PlatformPackages rows={platform} argo={argo.data ?? []} /> : null}
    </div>
  );
}

/* ─────────── app picker ─────────── */

function AppPicker({ apps, selected, summaries, onPick }: {
  apps: FlowApp[];
  selected: FlowApp;
  summaries: Map<string, { summary: AppSummary }>;
  onPick(a: FlowApp): void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open, { escape: true });
  const sel = summaries.get(selected.key)?.summary;
  const shown = apps.filter((a) =>
    !q || `${a.project}/${a.name} ${a.displayName ?? ''}`.toLowerCase().includes(q.toLowerCase())
  );
  return (
    <div ref={ref} className='relative'>
      <button
        type='button'
        aria-haspopup='listbox'
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className='flex h-9 max-w-full items-center gap-2 rounded-lg border border-edge-default bg-surface-raised px-3 text-left text-sm shadow-sm hover:border-edge-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40 pointer-coarse:h-11'
      >
        <span
          className={cn('h-2 w-2 shrink-0 rounded-full', HEALTH_DOT[sel?.health ?? 'unknown'])}
          aria-hidden
        />
        <span className='min-w-0 truncate font-semibold text-content'>
          {selected.displayName ?? selected.name}
        </span>
        <span className='hidden truncate text-[12px] text-content-subtle sm:inline'>
          {selected.project || 'no project'}
        </span>
        {sel
          ? (
            <span className='hidden shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 text-[10.5px] font-medium text-content-muted sm:inline'>
              {sel.furthestLabel}
            </span>
          )
          : null}
        <svg
          width='12'
          height='12'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2.4'
          className='shrink-0 text-content-subtle'
          aria-hidden
        >
          <path d='m6 9 6 6 6-6' />
        </svg>
      </button>
      {open
        ? (
          <div className='absolute left-0 z-40 mt-1 w-[min(92vw,26rem)] overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-xl'>
            {apps.length > 6
              ? (
                <div className='border-b border-edge-subtle p-2'>
                  <Input
                    autoFocus
                    placeholder='Filter applications'
                    value={q}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setQ(e.currentTarget.value)}
                    className='h-8 text-xs'
                  />
                </div>
              )
              : null}
            <ul
              role='listbox'
              aria-label='Applications'
              className='max-h-[min(60vh,24rem)] overflow-y-auto py-1'
            >
              {shown.map((a) => {
                const s = summaries.get(a.key)?.summary;
                return (
                  <li key={a.key}>
                    <button
                      type='button'
                      role='option'
                      aria-selected={a.key === selected.key}
                      onClick={() => {
                        onPick(a);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-sunken/70 pointer-coarse:py-3',
                        a.key === selected.key && 'bg-surface-sunken/60',
                      )}
                    >
                      <span
                        className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          HEALTH_DOT[s?.health ?? 'unknown'],
                        )}
                        title={HEALTH_WORD[s?.health ?? 'unknown']}
                        aria-hidden
                      />
                      <span className='min-w-0 flex-1'>
                        <span className='block truncate text-[13px] font-medium text-content'>
                          {a.displayName ?? a.name}
                        </span>
                        <span className='block truncate text-[11px] text-content-subtle'>
                          {a.project || 'no project'} · {HEALTH_WORD[s?.health ?? 'unknown']}
                        </span>
                      </span>
                      <span className='shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 text-[10.5px] font-medium text-content-muted'>
                        {s?.furthestLabel ?? '—'}
                      </span>
                    </button>
                  </li>
                );
              })}
              {!shown.length
                ? (
                  <li className='px-3 py-3 text-[12px] text-content-subtle'>
                    No application matches “{q}”.
                  </li>
                )
                : null}
            </ul>
          </div>
        )
        : null}
    </div>
  );
}

function PlatformToggle(
  { on, count, onChange }: { on: boolean; count: number; onChange(v: boolean): void },
) {
  return (
    <button
      type='button'
      role='switch'
      aria-checked={on}
      onClick={() => onChange(!on)}
      className='flex h-8 items-center gap-2 rounded-lg px-2 text-[12px] text-content-muted hover:text-content focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40 pointer-coarse:h-11'
    >
      <span
        className={cn(
          'relative h-4 w-7 rounded-full transition-colors',
          on ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-600',
        )}
        aria-hidden
      >
        <span
          className={cn(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-[left]',
            on ? 'left-3.5' : 'left-0.5',
          )}
        />
      </span>
      <span>
        Show platform packages{count
          ? <span className='text-content-subtle'> ({count})</span>
          : null}
      </span>
    </button>
  );
}

/* ─────────── one app's flow ─────────── */

interface AppFlowProps {
  app: FlowApp;
  c: { envs: EnvView[]; runs: RunView[]; freight: kargo.Freight[]; summary: AppSummary };
  repos: Src<Awaited<ReturnType<typeof useGiteaRepos>>['data']>;
  runsSrc: Src<unknown>;
  freightSrc: Src<unknown>;
  warehouses: Src<kargo.Warehouse[]>;
  projects: Src<Array<{ metadata: { name: string } }>>;
  stagesSrc: Src<kargo.Stage[]>;
  argoSrc: Src<argocd.Application[]>;
  commitParam?: string;
  stageParam?: string;
  setParams: ReturnType<typeof useSetFlowParams>;
}

function AppFlow(p: AppFlowProps) {
  const { app, c } = p;
  const repo = p.repos.status === 'ok' ? resolveRepo(app, p.repos.data ?? []) : undefined;
  const commitsQ = useGiteaCommits(repo?.name, repo?.default_branch);
  const pullsQ = useGiteaPulls(repo?.name);
  const warehouse = p.warehouses.status === 'ok'
    ? (p.warehouses.data ?? []).find((w) => w.project === app.project && w.name === app.name) ??
      null
    : undefined;
  const imageRepo = imageRepoFor({
    warehouse,
    runs: c.runs,
    freight: c.freight,
    argoApps: app.argoApps,
  });
  const artifactsQ = useImageArtifacts(imageRepo);

  const repoSrc: Src<NonNullable<typeof repo> | null> = p.repos.status === 'ok'
    ? ok(repo ?? null)
    : { status: p.repos.status, message: p.repos.message };
  const commitsSrc = repo ? toSrc(commitsQ) : ok([]);
  const pullsSrc = repo ? toSrc(pullsQ) : ok([]);
  const artifactsSrc = imageRepo ? toSrc(artifactsQ) : ok([]);
  const project = p.projects.status === 'ok'
    ? (p.projects.data ?? []).find((x) => x.metadata.name === app.project) ?? null
    : undefined;
  const projectSrc: Src<kargo.ProjectLike | null> = p.projects.status === 'ok'
    ? ok((project ?? null) as kargo.ProjectLike | null)
    : { status: p.projects.status, message: p.projects.message };

  const stages = buildFlow({
    app,
    repo: repoSrc,
    commits: commitsSrc,
    pulls: pullsSrc,
    runs: p.runsSrc.status === 'ok'
      ? ok(c.runs)
      : { status: p.runsSrc.status, message: p.runsSrc.message },
    imageRepo,
    artifacts: artifactsSrc,
    warehouse: p.warehouses.status === 'ok'
      ? ok(warehouse ?? null)
      : { status: p.warehouses.status, message: p.warehouses.message },
    freight: p.freightSrc.status === 'ok'
      ? ok(c.freight)
      : { status: p.freightSrc.status, message: p.freightSrc.message },
    project: projectSrc,
    stages: p.stagesSrc,
    argo: p.argoSrc,
    envs: c.envs,
  });

  const commits = commitsQ.data ?? [];
  const traceInput = {
    app,
    repo: repo?.name,
    commits,
    pulls: pullsQ.data ?? [],
    runs: c.runs,
    artifacts: artifactsQ.data ?? [],
    freight: c.freight,
    envs: c.envs,
  };
  const recent = useMemo(
    () => commits.slice(0, 15).map((cm) => traceCommit(cm.sha, traceInput)),
    [commits, pullsQ.data, c.runs, artifactsQ.data, c.freight, c.envs],
  );
  const envNames = c.envs.map((e) => e.name);
  const lead = useMemo(() => leadTimes(recent, envNames), [recent, envNames.join(',')]);

  const followSha = p.commitParam && looksLikeSha(p.commitParam) ? p.commitParam : commits[0]?.sha;
  const followed = followSha ? traceCommit(followSha, traceInput) : undefined;
  const stop = stopsAt(stages);
  const open = stages.find((s) => s.id === p.stageParam);
  const setOpen = (id?: string) => p.setParams({ stage: id }, { push: Boolean(id) });

  const buildPath = stages.filter((s) => s.group !== 'env');
  const envStages = stages.filter((s) => s.group === 'env');

  return (
    <div className='min-w-0 space-y-6'>
      <Headline
        app={app}
        latest={recent[0]}
        stop={stop}
        repo={repo?.full_name}
        branch={repo?.default_branch}
        onOpen={setOpen}
      />

      <section aria-label='Build path' className='space-y-2'>
        <RailTitle>Build path</RailTitle>
        <Rail stages={buildPath} active={p.stageParam} onOpen={setOpen} minW='w-48 md:w-auto md:min-w-[156px]' />
      </section>
      <section aria-label='Environments' className='space-y-2'>
        <RailTitle>
          Environments
          {app.project
            ? (
              <span className='font-normal normal-case tracking-normal text-content-subtle'>
                · project {app.project}
              </span>
            )
            : null}
        </RailTitle>
        <Rail stages={envStages} active={p.stageParam} onOpen={setOpen} minW='w-60 md:w-auto md:min-w-[200px]' env />
      </section>

      <FollowCommit
        commits={commits}
        loading={Boolean(repo) && commitsQ.isLoading}
        repo={repo?.name}
        trace={followed}
        selected={followSha}
        onPick={(sha) => p.setParams({ commit: sha })}
      />

      <LeadTime lead={lead} envs={envNames} changes={recent.length} />

      {open
        ? <StageDrawer stage={open} envs={c.envs} app={app} onClose={() => setOpen(undefined)} />
        : null}
    </div>
  );
}

function RailTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className='text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>
      {children}
    </h3>
  );
}

function Headline({ app, latest, stop, repo, branch, onOpen }: {
  app: FlowApp;
  latest?: CommitTrace;
  stop?: FlowStage;
  repo?: string;
  branch?: string;
  onOpen(id: string): void;
}) {
  const tone: Tone = !stop ? 'done' : stop.tone;
  return (
    <div className='flex flex-col gap-x-6 gap-y-1.5 sm:flex-row sm:items-start sm:justify-between'>
      <div className='min-w-0 flex-1'>
        <div className='flex items-start gap-2'>
          <ToneIcon tone={latest ? toneOfHeadline(latest) : tone} size={16} />
          <p className='min-w-0 flex-1 text-[15px] font-semibold leading-snug tracking-tight text-content'>
            {latest
              ? (
                <>
                  <code className='mr-1.5 rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[12px]'>
                    {latest.short}
                  </code>
                  {latest.headline}
                </>
              )
              : stop
              ? (
                `Stops at ${
                  stop.title === stop.title.toLowerCase() ? envTitle(stop.title) : stop.title
                }: ${stop.label}`
              )
              : (
                'Every stage is clear'
              )}
          </p>
        </div>
        {stop && stop.why[0]
          ? (
            <button
              type='button'
              onClick={() => onOpen(stop.id)}
              className='mt-1 block max-w-full truncate text-left text-[12px] text-content-muted hover:text-content'
            >
              {stop.why[0]} <span className='text-brand-700 dark:text-brand-300'>Details →</span>
            </button>
          )
          : null}
      </div>
      <div className='text-[11.5px] text-content-subtle'>
        {repo
          ? (
            <>
              <code className='font-mono text-content-muted'>{repo}</code>
              {branch
                ? (
                  <>
                    @ <code className='font-mono text-content-muted'>{branch}</code>
                  </>
                )
                : null}
            </>
          )
          : (
            'no repository'
          )}
        {app.xr ? ' · Application resource' : ''}
      </div>
    </div>
  );
}

function toneOfHeadline(t: CommitTrace): Tone {
  const steps = t.steps;
  if (steps.some((s) => s.tone === 'failed')) return 'failed';
  if (steps.some((s) => s.tone === 'blocked')) return 'blocked';
  if (steps.some((s) => s.tone === 'running')) return 'running';
  const envs = steps.filter((s) => s.id.startsWith('env:'));
  if (envs.length && envs[envs.length - 1].tone === 'done') return 'done';
  return 'waiting';
}

/* ─────────── the rail ─────────── */

function Rail(
  { stages, active, onOpen, minW, env = false }: {
    stages: FlowStage[];
    active?: string;
    onOpen(id: string): void;
    minW: string;
    env?: boolean;
  },
) {
  return (
    <div className='-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]'>
      <ol className='flex min-w-max items-stretch md:min-w-0'>
        {stages.map((s, i) => (
          <li key={s.id} className={cn('flex shrink-0 items-stretch md:flex-1 md:shrink', minW)}>
            <StageCard stage={s} active={active === s.id} onOpen={() => onOpen(s.id)} env={env} />
            {i < stages.length - 1 ? <Connector tone={s.tone} /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Connector({ tone }: { tone: Tone }) {
  const passed = tone === 'done';
  return (
    <span className='flex w-5 shrink-0 items-center justify-center' aria-hidden>
      <svg
        width='20'
        height='10'
        viewBox='0 0 20 10'
        className={passed ? 'text-emerald-500' : 'text-slate-300 dark:text-slate-600'}
      >
        <path
          d='M1 5h15'
          stroke='currentColor'
          strokeWidth='1.6'
          strokeDasharray={passed ? undefined : '2 2'}
        />
        <path
          d='m13 1.5 4 3.5-4 3.5'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.6'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
    </span>
  );
}

function StageCard(
  { stage: s, active, onOpen, env }: {
    stage: FlowStage;
    active: boolean;
    onOpen(): void;
    env: boolean;
  },
) {
  const title = env ? envTitle(s.title) : s.title;
  return (
    <button
      type='button'
      onClick={onOpen}
      aria-label={`${title} — ${s.label}. Open details`}
      aria-pressed={active}
      className={cn(
        'group flex w-full min-w-0 flex-col rounded-xl border bg-surface-raised p-3 text-left shadow-sm transition-[box-shadow,border-color,transform] hover:-translate-y-px hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40',
        TONE_BORDER[s.tone],
        active && 'ring-2 ring-brand-400/50',
        s.tone === 'loading' && 'animate-pulse',
      )}
    >
      <span className='flex items-center gap-2'>
        <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-content-subtle ring-1 ring-inset ring-edge-subtle'>
          <StageIcon id={s.id} />
        </span>
        <span className='min-w-0 flex-1 truncate text-[12.5px] font-semibold text-content'>
          {title}
        </span>
      </span>
      <span className='mt-2 flex items-center gap-1.5'>
        <ToneIcon tone={s.tone} size={13} />
        <span className={cn('truncate text-[12px] font-semibold', TONE_TEXT[s.tone])}>
          {s.label}
        </span>
      </span>
      <span
        title={s.detail}
        className='mt-1 line-clamp-2 min-h-[2.4em] text-[11.5px] leading-snug text-content-muted'
      >
        {s.detail}
      </span>
      <span className='mt-auto flex items-center justify-between gap-2 pt-2 text-[10.5px] text-content-subtle'>
        <span className='truncate'>{s.at ? relTime(s.at) : ' '}</span>
        {s.durationSec != null
          ? <span className='shrink-0 tabular-nums'>{fmtDuration(s.durationSec)}</span>
          : null}
      </span>
      {s.why.length && s.tone !== 'loading' && s.tone !== 'unavailable'
        ? (
          <span
            className='mt-1.5 line-clamp-2 border-t border-edge-subtle pt-1.5 text-[10.5px] leading-snug text-content-subtle'
            title={s.why.join('\n')}
          >
            {s.why[0]}
          </span>
        )
        : null}
    </button>
  );
}

/* ─────────── drawer ─────────── */

function StageDrawer(
  { stage: s, envs, app, onClose }: {
    stage: FlowStage;
    envs: EnvView[];
    app: FlowApp;
    onClose(): void;
  },
) {
  const width = useDrawerWidth('deliver.flow-stage', { base: 'max-w-lg' });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  const env = s.id.startsWith('env:') ? envs.find((e) => `env:${e.name}` === s.id) : undefined;
  const title = s.group === 'env' && s.id !== 'env:none' ? envTitle(s.title) : s.title;

  return createPortal(
    <div
      className='fixed inset-0 z-[60] flex justify-end'
      role='dialog'
      aria-modal='true'
      aria-label={`${title} details`}
    >
      <button
        type='button'
        aria-label='Close'
        className='absolute inset-0 bg-scrim/40 backdrop-blur-[2px]'
        onClick={onClose}
      />
      <aside className={cn('relative flex h-full w-full flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl', width.className)}>
        <header className='flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-5 py-4'>
          <div className='min-w-0'>
            <div className='text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>
              {app.project ? `${app.project} / ` : ''}
              {app.name}
            </div>
            <h2 className='mt-1 text-lg font-semibold tracking-tight text-content'>{title}</h2>
            <div className='mt-1 flex items-center gap-1.5'>
              <ToneIcon tone={s.tone} />
              <span className={cn('text-[12.5px] font-semibold', TONE_TEXT[s.tone])}>
                {s.label}
              </span>
              <span className='text-[11px] text-content-subtle'>
                · {TONE_WORD[s.tone]}
                {s.at ? ` · ${relTime(s.at)}` : ''}
              </span>
            </div>
            <p className='mt-1 text-[12px] text-content-muted'>{s.detail}</p>
          </div>
          <div className='flex shrink-0 items-center gap-1'>
            <DrawerWidenButton wide={width.wide} onToggle={width.toggle} />
            <button
              type='button'
              onClick={onClose}
              aria-label='Close'
              className='flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content'
            >
              <svg
                width='14'
                height='14'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2.25'
                strokeLinecap='round'
                aria-hidden
              >
                <path d='M18 6 6 18M6 6l12 12' />
              </svg>
            </button>
          </div>
        </header>
        <div className='flex-1 space-y-5 overflow-y-auto px-5 py-4'>
          {s.why.length
            ? (
              <div
                className={cn(
                  'rounded-lg border px-3 py-2.5',
                  s.tone === 'failed'
                    ? 'border-rose-300/70 bg-rose-50 dark:border-rose-500/30 dark:bg-rose-500/10'
                    : 'border-amber-300/70 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10',
                )}
              >
                <div
                  className={cn(
                    'text-[11px] font-semibold uppercase tracking-wider',
                    s.tone === 'failed'
                      ? 'text-rose-800 dark:text-rose-200'
                      : 'text-amber-800 dark:text-amber-200',
                  )}
                >
                  {s.tone === 'done' ? 'Notes' : 'Why it stops here'}
                </div>
                <ul className='mt-1 list-disc space-y-1 pl-4 text-[12.5px] text-content'>
                  {s.why.map((w, i) => <li key={i} className='wrap-break-word'>{w}</li>)}
                </ul>
              </div>
            )
            : null}
          {s.facts.length
            ? (
              <dl className='divide-y divide-edge-subtle rounded-lg border border-edge-subtle bg-surface-raised'>
                {s.facts.map((f, i) => (
                  <div
                    key={`${f.label}-${i}`}
                    className='flex items-start justify-between gap-3 px-3 py-2 text-[12px]'
                  >
                    <dt className='shrink-0 text-content-subtle'>{f.label}</dt>
                    <dd
                      className={cn(
                        'min-w-0 break-all text-right text-content',
                        f.mono && 'font-mono text-[11.5px]',
                      )}
                    >
                      {f.href
                        ? (
                          <a
                            href={f.href}
                            className='text-brand-700 hover:underline dark:text-brand-300'
                          >
                            {f.value}
                          </a>
                        )
                        : f.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )
            : null}
          {env?.cell?.stage?.stage.verification?.analysisRun
            ? <AppVerification env={env} app={app.name} />
            : null}
          {s.items.length
            ? (
              <div>
                <div className='mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>
                  Recent
                </div>
                <ul className='divide-y divide-edge-subtle rounded-lg border border-edge-subtle bg-surface-raised'>
                  {s.items.map((it) => {
                    const body = (
                      <>
                        <ToneIcon tone={it.tone} size={13} />
                        <span className='min-w-0 flex-1'>
                          <span className='block truncate text-[12.5px] text-content'>
                            {it.title}
                          </span>
                          {it.sub
                            ? (
                              <span className='block truncate text-[11px] text-content-subtle'>
                                {it.sub}
                              </span>
                            )
                            : null}
                        </span>
                        <span className='shrink-0 text-right'>
                          <span className={cn('block text-[11px] font-medium', TONE_TEXT[it.tone])}>
                            {it.label}
                          </span>
                          {it.at
                            ? (
                              <span className='block text-[10.5px] text-content-subtle'>
                                {relTime(it.at)}
                              </span>
                            )
                            : null}
                        </span>
                      </>
                    );
                    return (
                      <li key={it.id}>
                        {it.href
                          ? (
                            <a
                              href={it.href}
                              className='flex items-center gap-2.5 px-3 py-2 hover:bg-surface-sunken/60'
                            >
                              {body}
                            </a>
                          )
                          : <div className='flex items-center gap-2.5 px-3 py-2'>{body}</div>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )
            : null}
        </div>
        <footer className='flex flex-wrap gap-x-4 gap-y-1 border-t border-edge-default bg-surface-raised px-5 py-3'>
          {[...s.links, { label: 'Catalog entry', href: links.catalog(app.name) }].map((l) => (
            <a
              key={l.href + l.label}
              href={l.href}
              className='inline-flex items-center gap-1 text-[12px] font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-300'
            >
              {l.label} <span aria-hidden>↗</span>
            </a>
          ))}
        </footer>
      </aside>
    </div>,
    document.body,
  );
}

/** This app's share of a shared environment's verification (per-app metrics). */
function AppVerification({ env, app }: { env: EnvView; app: string }) {
  const ref = env.cell?.stage?.stage.verification?.analysisRun;
  const run = useAnalysisRun(ref);
  if (run.isLoading) {
    return (
      <div className='flex items-center gap-2 text-[12px] text-content-muted'>
        <Spinner size={12} /> Reading verification…
      </div>
    );
  }
  const v = run.data ? kargo.appVerification(run.data, app) : undefined;
  if (!v) return null;
  return (
    <div>
      <div className='mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-subtle'>
        Verification for {app} — {v.phase}
      </div>
      <ul className='divide-y divide-edge-subtle rounded-lg border border-edge-subtle bg-surface-raised'>
        {v.metrics.map((m) => (
          <li
            key={m.name}
            className='flex items-center justify-between gap-3 px-3 py-1.5 text-[12px]'
          >
            <span className='font-mono text-[11.5px] text-content'>{m.name}</span>
            <span
              className={m.phase === 'Successful'
                ? TONE_TEXT.done
                : /Failed|Error/.test(m.phase)
                ? TONE_TEXT.failed
                : 'text-content-muted'}
            >
              {m.phase}
            </span>
          </li>
        ))}
      </ul>
      {v.blockedBy.length
        ? (
          <p className='mt-1.5 text-[11.5px] text-amber-700 dark:text-amber-300'>
            The environment's verification also failed for: {v.blockedBy.join(', ')}.
          </p>
        )
        : null}
    </div>
  );
}

/* ─────────── follow a commit ─────────── */

function FollowCommit({ commits, loading, repo, trace, selected, onPick }: {
  commits: Array<{ sha: string; message: string; created: string }>;
  loading: boolean;
  repo?: string;
  trace?: CommitTrace;
  selected?: string;
  onPick(sha: string): void;
}) {
  const [draft, setDraft] = useState('');
  const inList = commits.some((c) => selected && c.sha.startsWith(selected.toLowerCase()));
  const submit = () => {
    const v = draft.trim().toLowerCase();
    if (looksLikeSha(v)) {
      onPick(v);
      setDraft('');
    }
  };
  return (
    <section aria-label='Follow a commit' className='space-y-3'>
      <div className='flex flex-wrap items-end justify-between gap-x-4 gap-y-2'>
        <div>
          <h3 className='text-[14px] font-semibold tracking-tight text-content'>Follow a commit</h3>
          <p className='text-[11.5px] text-content-subtle'>
            where one change is now, from build to the last environment
          </p>
        </div>
        <div className='flex w-full flex-wrap items-center gap-2 sm:w-auto'>
          {commits.length
            ? (
              <Select
                aria-label='Commit'
                value={inList
                  ? commits.find((c) => c.sha.startsWith(selected!.toLowerCase()))!.sha
                  : ''}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => onPick(e.currentTarget.value)}
                className='h-8 min-w-0 flex-1 text-xs sm:w-72 sm:flex-none'
              >
                {!inList
                  ? (
                    <option value=''>
                      {selected ? `${selected.slice(0, 7)} (pasted)` : 'Pick a commit'}
                    </option>
                  )
                  : null}
                {commits.map((c) => (
                  <option key={c.sha} value={c.sha}>
                    {c.sha.slice(0, 7)} · {c.message.split('\n')[0].slice(0, 60)}
                  </option>
                ))}
              </Select>
            )
            : null}
          <form
            className='flex w-full min-w-0 items-center gap-2 sm:w-auto'
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className='min-w-0 flex-1 sm:w-36 sm:flex-none'>
            <Input
              aria-label='Commit SHA'
              placeholder='Paste a SHA'
              value={draft}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.currentTarget.value)}
              invalid={Boolean(draft) && !looksLikeSha(draft.trim())}
              className='h-8 w-full min-w-0 font-mono text-xs'
            />
            </div>
            <Button size='sm' type='submit' disabled={!looksLikeSha(draft.trim())}>Trace</Button>
          </form>
        </div>
      </div>

      {loading
        ? (
          <div className='flex items-center gap-2 text-sm text-content-muted'>
            <Spinner size={14} /> Reading commits…
          </div>
        )
        : !trace
        ? (
          <EmptyState
            compact
            title='No commit to follow'
            description={repo
              ? 'The default branch has no commits yet.'
              : 'This app has no repository, so there is no commit to follow. Paste a SHA to trace a build by its commit.'}
          />
        )
        : (
          <div className='rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm'>
            <div className='flex flex-wrap items-baseline gap-x-2 gap-y-1'>
              <code className='rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[12px] text-content'>
                {trace.short}
              </code>
              <span className='min-w-0 truncate text-[13px] text-content'>
                {trace.subject ?? 'commit not in the recent history'}
              </span>
              {trace.author
                ? (
                  <span className='text-[11px] text-content-subtle'>
                    {trace.author} · {relTime(trace.committedAt)}
                  </span>
                )
                : null}
            </div>
            <p className={cn('mt-1.5 text-[13px] font-semibold', TONE_TEXT[toneOfHeadline(trace)])}>
              {trace.headline}
            </p>
            <div className='-mx-1 mt-3 overflow-x-auto px-1 pb-1'>
              <ol className='flex min-w-max items-start md:min-w-0'>
                {trace.steps.map((s, i) => (
                  <TraceNode
                    key={s.id}
                    step={s}
                    prev={trace.steps[i - 1]}
                    last={i === trace.steps.length - 1}
                  />
                ))}
              </ol>
            </div>
          </div>
        )}
    </section>
  );
}

function TraceNode({ step: s, prev, last }: { step: TraceStep; prev?: TraceStep; last: boolean }) {
  const from = prev?.at ?? prev?.start;
  const to = s.start ?? s.at;
  const gap = from && to ? (Date.parse(to) - Date.parse(from)) / 1000 : undefined;
  const label = s.id.startsWith('env:') ? envTitle(s.label) : s.label;
  const body = (
    <>
      <span className='block truncate text-[12px] font-semibold text-content' title={label}>
        {label}
      </span>
      <span className={cn('mt-0.5 block text-[11px]', TONE_TEXT[s.tone])}>
        {s.tone === 'none' ? 'unknown' : TONE_WORD[s.tone].toLowerCase()}
        {s.at ? ` · ${relTime(s.at)}` : ''}
      </span>
      {gap != null && gap >= 0
        ? (
          <span className='block text-[10.5px] tabular-nums text-content-subtle'>
            +{fmtDuration(gap, true)} after{' '}
            {prev!.id.startsWith('env:') ? prev!.label : prev!.label.toLowerCase()}
          </span>
        )
        : null}
      {s.detail
        ? (
          <span
            className='mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-content-subtle'
            title={s.detail}
          >
            {s.detail}
          </span>
        )
        : null}
    </>
  );
  return (
    <li className='relative min-w-[8.5rem] flex-1 pr-3 pt-6'>
      {!last
        ? (
          <span
            aria-hidden
            className={cn(
              'absolute left-4 right-0 top-[7px] h-0.5 rounded-full',
              s.tone === 'done' ? 'bg-emerald-400/80' : 'bg-slate-200 dark:bg-slate-700',
            )}
          />
        )
        : null}
      <span className='absolute left-0 top-0 rounded-full bg-surface-raised'>
        <ToneIcon tone={s.tone} size={16} />
      </span>
      {s.href
        ? <a href={s.href} className='block rounded hover:underline'>{body}</a>
        : <div>{body}</div>}
    </li>
  );
}

/* ─────────── lead time ─────────── */

function LeadTime(
  { lead, envs, changes }: { lead: LeadTimeBreakdown; envs: string[]; changes: number },
) {
  const measured = lead.segments.filter((s) => lead.median[s.id] != null);
  const max = Math.max(1, ...measured.map((s) => lead.median[s.id]));
  const last = envs[envs.length - 1];
  return (
    <section aria-label='Lead time' className='space-y-3'>
      <div className='flex flex-wrap items-end justify-between gap-x-4 gap-y-1'>
        <div>
          <h3 className='text-[14px] font-semibold tracking-tight text-content'>Lead time</h3>
          <p className='text-[11.5px] text-content-subtle'>
            median time per step over the last{' '}
            {changes === 1 ? 'commit' : `${changes} commits`}, from real timestamps only
          </p>
        </div>
        <div className='flex flex-wrap gap-x-5 gap-y-1 text-[12px]'>
          {lead.medianTotalSec != null && last
            ? (
              <span>
                <span className='text-content-subtle'>Commit → {last} </span>
                <span className='font-semibold tabular-nums text-content'>
                  {fmtDuration(lead.medianTotalSec)}
                </span>
              </span>
            )
            : null}
          {lead.bottleneck
            ? (
              <span>
                <span className='text-content-subtle'>Bottleneck </span>
                <span className='font-semibold text-amber-700 dark:text-amber-300'>
                  {lead.bottleneck.label}
                </span>
              </span>
            )
            : null}
        </div>
      </div>
      {!measured.length
        ? (
          <EmptyState
            compact
            title='No lead time yet'
            description='Lead time needs at least one commit with a build, and the timestamps of where it went next. None of the recent commits has been built yet.'
          />
        )
        : (
          <div className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]'>
            <ul
              className='space-y-2 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm'
              aria-label='Median time per step'
            >
              {lead.segments.map((s) => {
                const v = lead.median[s.id];
                const isB = lead.bottleneck?.id === s.id;
                return (
                  <li
                    key={s.id}
                    className='grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_3.5rem] items-center gap-2 text-[12px]'
                    title={v != null
                      ? `${s.label}: median ${fmtDuration(v)} over ${lead.samples[s.id]} change${
                        lead.samples[s.id] === 1 ? '' : 's'
                      }`
                      : `${s.label}: no change has both timestamps`}
                  >
                    <span className='truncate text-content-muted'>{s.label}</span>
                    <span className='h-2.5 rounded-full bg-surface-sunken'>
                      {v != null
                        ? (
                          <span
                            className={cn(
                              'block h-full rounded-full',
                              isB ? 'bg-amber-500' : 'bg-brand-500',
                            )}
                            style={{ width: `${Math.max(3, (v / max) * 100)}%` }}
                          />
                        )
                        : null}
                    </span>
                    <span
                      className={cn(
                        'text-right tabular-nums',
                        v != null ? 'font-medium text-content' : 'text-content-subtle',
                      )}
                    >
                      {v != null ? fmtDuration(v, true) : '—'}
                    </span>
                  </li>
                );
              })}
              <li className='pt-1 text-[10.5px] text-content-subtle'>
                n = changes measured per step; “—” means no change has both timestamps.
              </li>
            </ul>
            <div className='overflow-x-auto rounded-xl border border-edge-default bg-surface-raised shadow-sm'>
              <table className='w-full min-w-130 text-[11.5px]'>
                <thead>
                  <tr className='border-b border-edge-subtle text-left text-[10.5px] uppercase tracking-wider text-content-subtle'>
                    <th className='px-3 py-2 font-semibold'>Change</th>
                    {lead.segments.map((s) => (
                      <th key={s.id} className='px-2 py-2 text-right font-semibold' title={s.label}>
                        {s.id.startsWith('env:') ? s.id.slice(4) : s.id}
                      </th>
                    ))}
                    <th
                      className='px-3 py-2 text-right font-semibold'
                      title={`Commit → ${envs[envs.length - 1] ?? 'last environment'}`}
                    >
                      {envs.length ? `To ${envs[envs.length - 1]}` : 'Total'}
                    </th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-edge-subtle'>
                  {lead.changes.slice(0, 10).map((c) => (
                    <tr key={c.sha}>
                      <td className='px-3 py-1.5'>
                        <div className='flex w-52 min-w-0 items-baseline gap-1.5' title={c.subject}>
                          <code className='shrink-0 font-mono text-content'>{c.short}</code>
                          <span className='min-w-0 truncate text-content-subtle'>{c.subject}</span>
                        </div>
                      </td>
                      {lead.segments.map((s) => (
                        <td
                          key={s.id}
                          className={cn(
                            'px-2 py-1.5 text-right tabular-nums',
                            c.seconds[s.id] != null ? 'text-content' : 'text-content-subtle',
                          )}
                        >
                          {c.seconds[s.id] != null ? fmtDuration(c.seconds[s.id], true) : '—'}
                        </td>
                      ))}
                      <td className='px-3 py-1.5 text-right font-medium tabular-nums text-content'>
                        {c.totalSec != null ? fmtDuration(c.totalSec, true) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
    </section>
  );
}

/* ─────────── platform packages ─────────── */

function healthTone(h: string): Tone {
  return h === 'Healthy'
    ? 'done'
    : h === 'Progressing'
    ? 'running'
    : h === 'Degraded' || h === 'Missing'
    ? 'failed'
    : h === 'Suspended'
    ? 'waiting'
    : 'none';
}

function PlatformPackages({ rows, argo }: { rows: PackageRow[]; argo: argocd.Application[] }) {
  const [q, setQ] = useState('');
  const shown = rows.filter((r) =>
    !q || `${r.name} ${r.category} ${r.pkg ?? ''}`.toLowerCase().includes(q.toLowerCase())
  );
  const attention = rows.filter((r) => r.health !== 'Healthy' || r.sync !== 'Synced').length;
  return (
    <section aria-label='Platform packages' className='space-y-3'>
      <div className='flex flex-wrap items-end justify-between gap-x-4 gap-y-2'>
        <div>
          <h3 className='text-[14px] font-semibold tracking-tight text-content'>
            Platform packages
          </h3>
          <p className='text-[11.5px] text-content-subtle'>
            GitOps only: release channel → Argo CD sync → health · {rows.length}{' '}
            packages{attention ? ` · ${attention} need attention` : ''}
          </p>
        </div>
        <Input
          aria-label='Filter packages'
          placeholder='Filter packages'
          value={q}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setQ(e.currentTarget.value)}
          className='h-8 w-full text-xs sm:w-56'
        />
      </div>
      {!argo.length
        ? (
          <EmptyState
            compact
            title='No Argo CD applications'
            description='Argo CD returned no applications you can read.'
          />
        )
        : (
          <ul className='divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm'>
            {shown.map((r) => {
              const syncTone: Tone = r.sync === 'Synced'
                ? 'done'
                : r.sync === 'OutOfSync'
                ? 'waiting'
                : 'none';
              return (
                <li
                  key={r.name}
                  className='grid gap-x-4 gap-y-1.5 px-4 py-2.5 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]'
                >
                  <div className='min-w-0'>
                    <div className='truncate text-[13px] font-medium text-content'>{r.name}</div>
                    <div className='truncate text-[11px] text-content-subtle'>
                      {r.category}
                      {r.pkg && r.pkg !== r.name ? ` · ${r.pkg}` : ''}
                    </div>
                  </div>
                  <ol className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]'>
                    <li className='flex min-w-0 items-center gap-1.5'>
                      <ToneIcon tone='done' size={12} />
                      <span className='truncate font-mono text-content-muted' title={r.source}>
                        {r.source}
                        {r.targetRevision ? `@${r.targetRevision}` : ''}
                      </span>
                    </li>
                    <li aria-hidden className='text-content-subtle'>→</li>
                    <li
                      className='flex items-center gap-1.5'
                      title={r.lastSync
                        ? `last sync ${r.lastSyncPhase ?? ''} ${relTime(r.lastSync)}`
                        : undefined}
                    >
                      <ToneIcon tone={syncTone} size={12} />
                      <span className={TONE_TEXT[syncTone]}>{r.sync}</span>
                      {r.revision
                        ? (
                          <code className='font-mono text-content-subtle'>
                            {r.revision.slice(0, 7)}
                          </code>
                        )
                        : null}
                      {r.lastSync
                        ? <span className='text-content-subtle'>{relTime(r.lastSync)}</span>
                        : null}
                    </li>
                    <li aria-hidden className='text-content-subtle'>→</li>
                    <li className='flex min-w-0 items-center gap-1.5'>
                      <ToneIcon tone={healthTone(r.health)} size={12} />
                      <span className={TONE_TEXT[healthTone(r.health)]}>{r.health}</span>
                      {r.message && r.health !== 'Healthy'
                        ? (
                          <span className='truncate text-content-subtle' title={r.message}>
                            — {r.message}
                          </span>
                        )
                        : null}
                    </li>
                  </ol>
                </li>
              );
            })}
            {!shown.length
              ? (
                <li className='px-4 py-3 text-[12px] text-content-subtle'>
                  No package matches “{q}”.
                </li>
              )
              : null}
          </ul>
        )}
    </section>
  );
}

export default DeliveryFlow;
