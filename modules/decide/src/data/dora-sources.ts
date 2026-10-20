/**
 * Source objects → DORA events. Pure (tested in `dora-sources_test.ts`).
 *
 *   Argo CD Application  → deploy events from `status.history` (+ the latest
 *                          failed sync operation, which history never records).
 *   Kargo Promotion      → deploy events (Succeeded / Failed / Errored).
 *   Kargo Freight        → the commit or image a promotion carried.
 *   Tekton PipelineRun   → the commit an image tag was built from.
 *   Gitea commits        → when each shipped commit was authored.
 */

import type { BuildRun } from './builds-model.ts'
import {
  type DeployEvent,
  envFromNamespace,
  historyToDeploys,
  type HistoryEntry,
  type LeadTimeSample,
  normalizeEnv,
  projectFromNamespace,
  type RepoCommit,
  shaMatch,
  shippedCommits,
} from './dora-model.ts'

const L_PROJECT = 'adhar.io/project'
const L_APP = 'adhar.io/application'
const L_ENV = 'adhar.io/environment'

export interface ProjectRef {
  slug: string
  argoProject?: string
  teams: string[]
}

export interface ArgoAppLike {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  spec: {
    project?: string
    destination?: { namespace?: string }
    source?: { repoURL?: string }
    sources?: Array<{ repoURL?: string }>
  }
  status: {
    history?: HistoryEntry[]
    operationState?: { phase?: string; finishedAt?: string; startedAt?: string; message?: string; revision?: string }
  }
}

export interface PromotionLike {
  name: string
  project: string
  stage: string
  freight: string
  phase: string
  message?: string
  created: string
  finished?: string
  actor?: string
  origin?: string
}

export interface StageLike {
  name: string
  project: string
  labels?: Record<string, string>
}

export interface FreightLike {
  id: string
  warehouse?: string
  images: Array<{ repoURL: string; tag: string }>
  commits?: Array<{ repoURL: string; id: string }>
}

const lower = (s: string | undefined) => (s ?? '').toLowerCase()

/** The project an Argo CD app belongs to. */
export function argoProjectOf(app: ArgoAppLike, projects: ProjectRef[]): string {
  const l = app.metadata.labels ?? {}
  if (l[L_PROJECT]) return lower(l[L_PROJECT])
  const ap = lower(app.spec.project)
  const byArgo = projects.find((p) => lower(p.argoProject) === ap && ap)
  if (byArgo) return byArgo.slug
  const fromNs = projectFromNamespace(app.spec.destination?.namespace)
  if (fromNs) return fromNs
  if (projects.some((p) => p.slug === ap)) return ap
  return ap && ap !== 'default' ? ap : ''
}

/** `<project>-<app>-<env>` → `<app>`, labels first. */
export function argoAppNameOf(app: ArgoAppLike, project: string, env: string): string {
  const l = app.metadata.labels ?? {}
  if (l[L_APP]) return lower(l[L_APP])
  let n = lower(app.metadata.name)
  if (project && n.startsWith(`${project}-`) && n.length > project.length + 1) n = n.slice(project.length + 1)
  if (env && n.endsWith(`-${env}`)) n = n.slice(0, -env.length - 1)
  if (env === 'prod' && n.endsWith('-production')) n = n.slice(0, -'-production'.length)
  return n
}

export function argoEvents(apps: ArgoAppLike[], projects: ProjectRef[]): DeployEvent[] {
  const out: DeployEvent[] = []
  for (const app of apps) {
    const project = argoProjectOf(app, projects)
    const l = app.metadata.labels ?? {}
    const env = normalizeEnv(l[L_ENV]) || envFromNamespace(app.spec.destination?.namespace, project)
    const base = { name: app.metadata.name, app: argoAppNameOf(app, project, env), project, env }
    const events = historyToDeploys(app.status.history ?? [], base)
    const op = app.status.operationState
    const finished = op?.finishedAt ? Date.parse(op.finishedAt) : NaN
    if (op && /^(Failed|Error)$/.test(op.phase ?? '') && Number.isFinite(finished)) {
      // History only records successful syncs; a failed one is the last
      // operation and nowhere else.
      if (!events.some((e) => Math.abs(e.at - finished) < 1000)) {
        out.push({
          ...base,
          id: `argocd:${app.metadata.name}:op:${finished}`,
          at: finished,
          startedAt: op.startedAt ? Date.parse(op.startedAt) : undefined,
          outcome: 'failed',
          source: 'argocd',
          revision: op.revision,
          message: op.message,
        })
      }
    }
    out.push(...events)
  }
  return out
}

/** The environment a Kargo stage promotes into. */
export function stageEnv(stage: StageLike | undefined, stageName: string): string {
  const l = stage?.labels ?? {}
  if (l[L_ENV]) return normalizeEnv(l[L_ENV])
  if (l['adhar.io/stage-scope'] === 'project') return normalizeEnv(stageName)
  const last = stageName.split('-').pop() ?? stageName
  return normalizeEnv(last)
}

export function kargoEvents(promotions: PromotionLike[], stages: StageLike[], freight: FreightLike[]): DeployEvent[] {
  const stageBy = new Map(stages.map((s) => [`${s.project}/${s.name}`, s]))
  const freightBy = new Map(freight.map((f) => [f.id, f]))
  const out: DeployEvent[] = []
  for (const p of promotions) {
    const outcome = p.phase === 'Succeeded' ? 'succeeded' : p.phase === 'Failed' || p.phase === 'Errored' ? 'failed' : null
    if (!outcome) continue
    const stage = stageBy.get(`${p.project}/${p.stage}`)
    const at = Date.parse(p.finished ?? p.created)
    if (!Number.isFinite(at)) continue
    const app = lower(p.origin ?? freightBy.get(p.freight)?.warehouse ?? stage?.labels?.[L_APP])
    out.push({
      id: `kargo:${p.project}:${p.name}`,
      name: p.name,
      app,
      project: lower(stage?.labels?.[L_PROJECT] ?? p.project),
      env: stageEnv(stage, p.stage),
      at,
      startedAt: Date.parse(p.created),
      outcome,
      source: 'kargo',
      freight: p.freight,
      actor: p.actor,
      message: outcome === 'failed' ? p.message : undefined,
    })
  }
  return out
}

/* ─────────── commits ─────────── */

/** `https://host/org/repo.git` → `org/repo` (lower-case); '' when not a repo URL. */
export function repoPath(url: string | undefined): string {
  if (!url) return ''
  let p = url.trim()
  try {
    p = new URL(p).pathname
  } catch {
    p = p.replace(/^[^:]+:/, '/') // git@host:org/repo
  }
  const parts = p.replace(/\.git$/, '').split('/').filter(Boolean)
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase() : ''
}

/** A repository that holds deploy config, whose revisions are not code changes. */
export function isConfigRepo(path: string): boolean {
  return /(gitops|deploy|manifest|config|infra|helm|charts?|environments?)(\b|-|$)/.test(path.split('/').pop() ?? '')
}

const SHA = /^[0-9a-f]{7,40}$/i

/** Image tags that carry a commit: `abc1234`, `sha-abc1234`, `main-abc1234`, `1.2.0-abc1234`. */
export function shaInTag(tag: string): string | undefined {
  const t = tag.toLowerCase()
  if (SHA.test(t) && /[a-f]/.test(t)) return t
  const m = t.match(/(?:^|[-_.])([0-9a-f]{7,40})$/)
  return m && /[a-f]/.test(m[1]) ? m[1] : undefined
}

export interface ChangeRef {
  repo: string
  sha: string
  via: LeadTimeSample['via']
  /** The build that produced it, when one was matched. */
  run?: BuildRun
}

/** Which source commit a deploy put in production, and how we know. */
export function changeRefFor(
  d: DeployEvent,
  ctx: { freightById: Map<string, FreightLike>; runs: BuildRun[]; org: string; argoRepo?: string },
): ChangeRef | null {
  if (d.source === 'kargo' && d.freight) {
    const f = ctx.freightById.get(d.freight)
    const c = f?.commits?.find((x) => SHA.test(x.id) && !isConfigRepo(repoPath(x.repoURL)))
    if (c) return { repo: repoPath(c.repoURL), sha: c.id.toLowerCase(), via: 'freight-commit' }
    for (const img of f?.images ?? []) {
      const sha = shaInTag(img.tag)
      if (!sha) continue
      const run = ctx.runs.find((r) => shaMatch(r.commit, sha))
      if (run?.repo) return { repo: `${ctx.org}/${run.repo}`.toLowerCase(), sha: run.commit!, via: 'image-tag', run }
    }
    return null
  }
  if (d.source === 'argocd' && d.revision && SHA.test(d.revision)) {
    const repo = repoPath(ctx.argoRepo)
    if (repo && !isConfigRepo(repo)) {
      return { repo, sha: d.revision.toLowerCase(), via: 'argo-revision', run: ctx.runs.find((r) => shaMatch(r.commit, d.revision)) }
    }
  }
  return null
}

/**
 * Lead time per shipped commit for SUCCESSFUL production deploys (a failed
 * deploy delivered nothing). Commits come from the repo's newest-first list;
 * a commit Gitea does not know falls back to its build's creation time
 * (`build-start`, an under-estimate — flagged as such).
 */
export function resolveLeads(
  prodDeploys: DeployEvent[],
  refs: Map<string, ChangeRef>,
  commitsByRepo: Map<string, RepoCommit[]>,
): LeadTimeSample[] {
  const out: LeadTimeSample[] = []
  const lastSha = new Map<string, string>()
  const seen = new Set<string>()
  for (const d of [...prodDeploys].sort((a, b) => a.at - b.at)) {
    if (d.outcome !== 'succeeded' || d.rollback) continue
    const ref = refs.get(d.id)
    if (!ref) continue
    const key = `${d.project}|${d.app}|${ref.repo}`
    const prev = lastSha.get(key)
    lastSha.set(key, ref.sha)
    if (prev && shaMatch(prev, ref.sha)) continue // a re-deploy ships nothing new
    const commits = commitsByRepo.get(ref.repo) ?? []
    const shipped = shippedCommits(commits, ref.sha, prev)
    if (shipped.length) {
      for (const c of shipped) {
        const k = `${ref.repo}@${c.sha}`
        if (seen.has(k) || c.at > d.at) continue
        seen.add(k)
        out.push({
          sha: c.sha,
          repo: ref.repo,
          app: d.app,
          project: d.project,
          committedAt: c.at,
          deployedAt: d.at,
          hours: (d.at - c.at) / 3_600_000,
          via: ref.via,
          deployId: d.id,
        })
      }
    } else if (ref.run && ref.run.createdAt && ref.run.createdAt <= d.at) {
      out.push({
        sha: ref.sha,
        repo: ref.repo,
        app: d.app,
        project: d.project,
        committedAt: ref.run.createdAt,
        deployedAt: d.at,
        hours: (d.at - ref.run.createdAt) / 3_600_000,
        via: 'build-start',
        deployId: d.id,
      })
    }
  }
  return out
}
