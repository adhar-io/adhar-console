import type { gitea, kargo } from '@adhar/api-clients'
import type { CRDObject } from './flow.ts'
import { orderStages } from './stage-order.ts'

/**
 * Following one commit through the whole delivery pipeline.
 *
 * The Delivery Flow showed the *latest* state of each stage: the newest
 * commit, the newest build, whatever the stages happen to hold. That answers
 * "how is the pipeline right now" and not "where did my change get to", which
 * is the question people open it with.
 *
 * The join key is the commit sha, and every tool records it somewhere
 * different — Tekton in a pipeline result, Kargo inside its freight, Argo CD
 * as the synced revision. Where a tool genuinely does not say, the step is
 * `unknown` rather than assumed cleared: a journey that silently claims a
 * build happened is worse than one that admits it cannot tell.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

export type StepState = 'done' | 'running' | 'failed' | 'skipped' | 'pending' | 'unknown'

export interface JourneyStep {
  id: 'commit' | 'pull-request' | 'build' | 'freight' | 'promotion' | 'deployed'
  label: string
  state: StepState
  /** One line of real detail — a PR number, a run name, a stage list. */
  detail?: string
  at?: string
}

export interface CommitJourney {
  sha: string
  short: string
  subject: string
  author?: string
  at: string
  steps: JourneyStep[]
  /** Stages currently holding freight that contains this commit. */
  inStages: string[]
  /** It reached the running application. */
  live: boolean
}

/* ─────────── sha matching ─────────── */

const FULL_SHA = /^[0-9a-f]{7,40}$/i

/** Whether a string is a git object id rather than a branch or a tag. */
export function looksLikeSha(value: string | undefined): boolean {
  return !!value && FULL_SHA.test(value.trim())
}

/**
 * Compare two revisions that may be abbreviated to different lengths.
 *
 * Gitea gives a 40-character sha and a 10-character short one; Tekton results
 * carry the full sha; a tag might embed only the first 7. Comparing with
 * `===` missed every one of those pairings, so a commit that had plainly been
 * built looked unbuilt.
 */
export function shaEq(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  if (!looksLikeSha(x) || !looksLikeSha(y)) return false
  const n = Math.min(x.length, y.length)
  // Seven is git's own minimum for an unambiguous abbreviation; anything
  // shorter is a coincidence waiting to happen.
  if (n < 7) return false
  return x.slice(0, n) === y.slice(0, n)
}

/**
 * The commit a Tekton PipelineRun or kpack Build actually resolved to.
 *
 * `spec.params[revision]` is frequently a branch — this platform's release
 * pipelines pass `main` — so a parameter is only accepted when it looks like
 * a sha. The resolved commit is published as a pipeline *result*.
 */
export function revisionOf(obj: CRDObject): string | undefined {
  const status = (obj.status ?? {}) as Record<string, unknown>
  const spec = (obj.spec ?? {}) as Record<string, unknown>
  const meta = (obj.metadata ?? {}) as Record<string, unknown>

  const results = (status.results ?? status.pipelineResults ?? []) as Array<Record<string, unknown>>
  for (const r of results) {
    const name = String(r.name ?? '').toLowerCase()
    if (name === 'commit' || name === 'commit-sha' || name === 'chains-git_commit') {
      const v = typeof r.value === 'string' ? r.value : undefined
      if (looksLikeSha(v)) return v!.trim()
    }
  }

  // kpack records the revision it built on the Build itself.
  const source = (spec.source ?? {}) as Record<string, unknown>
  const git = (source.git ?? {}) as Record<string, unknown>
  if (looksLikeSha(git.revision as string)) return (git.revision as string).trim()

  const params = (spec.params ?? []) as Array<Record<string, unknown>>
  for (const p of params) {
    const name = String(p.name ?? '').toLowerCase()
    if (name === 'revision' || name === 'git-revision' || name === 'commit') {
      const v = typeof p.value === 'string' ? p.value : undefined
      // `main` is a branch, not the commit it pointed at.
      if (looksLikeSha(v)) return v!.trim()
    }
  }

  const labels = (meta.labels ?? {}) as Record<string, string>
  for (const key of ['tekton.dev/git-revision', 'adhar.io/commit', 'kpack.io/revision']) {
    if (looksLikeSha(labels[key])) return labels[key].trim()
  }
  return undefined
}

/** Succeeded / failed / running, from the standard condition. */
export function runState(obj: CRDObject): StepState {
  const conds = ((obj.status as { conditions?: Array<Record<string, unknown>> } | undefined)?.conditions ?? [])
  const succeeded = conds.find((c) => c.type === 'Succeeded' || c.type === 'Ready')
  if (!succeeded) return 'unknown'
  if (succeeded.status === 'True') return 'done'
  if (succeeded.status === 'False') return 'failed'
  return 'running'
}

function name(obj: CRDObject): string {
  return ((obj.metadata ?? {}) as { name?: string }).name ?? 'run'
}

/* ─────────── the journey ─────────── */

export interface JourneyInput {
  commits: gitea.Commit[]
  pulls: gitea.PullRequest[]
  /** Tekton PipelineRuns and kpack Builds, together. */
  builds: CRDObject[]
  freight: kargo.Freight[]
  stages: kargo.Stage[]
  /** `status.sync.revision` of the Argo CD Application following this service. */
  syncedRevision?: string
  /** Whether a build system is installed at all — absence is not failure. */
  buildsAvailable?: boolean
}

export function buildJourneys(input: JourneyInput, limit = 20): CommitJourney[] {
  const ordered = orderStages(input.stages)

  return input.commits.slice(0, limit).map((c) => {
    const steps: JourneyStep[] = []

    steps.push({
      id: 'commit',
      label: 'Committed',
      state: 'done',
      detail: c.author?.login,
      at: c.created,
    })

    // A pull request whose head or merge commit is this one. A commit pushed
    // straight to the branch never had a PR; that is not a gap in the journey.
    const pr = input.pulls.find((p) => shaEq(p.head?.sha, c.sha))
    steps.push(
      pr
        ? {
          id: 'pull-request',
          label: 'Pull request',
          state: pr.merged ? 'done' : pr.state === 'closed' ? 'failed' : 'running',
          detail: `#${pr.number} ${pr.title}`,
          at: pr.merged_at ?? pr.created_at,
        }
        : {
          id: 'pull-request',
          label: 'Pull request',
          state: 'skipped',
          detail: 'pushed directly to the branch',
        },
    )

    const build = input.builds.find((b) => shaEq(revisionOf(b), c.sha))
    steps.push(
      build
        ? {
          id: 'build',
          label: 'Build',
          state: runState(build),
          detail: name(build),
          at: ((build.status ?? {}) as { completionTime?: string; startTime?: string }).completionTime ??
            ((build.status ?? {}) as { startTime?: string }).startTime,
        }
        : {
          id: 'build',
          label: 'Build',
          // No build system, versus a build system that never built this.
          state: input.buildsAvailable === false ? 'unknown' : 'pending',
          detail: input.buildsAvailable === false
            ? 'no build system reachable'
            : 'no run references this commit',
        },
    )

    const freight = input.freight.find((f) => (f.commits ?? []).some((fc) => shaEq(fc.id, c.sha)))
    steps.push(
      freight
        ? {
          id: 'freight',
          label: 'Freight',
          state: 'done',
          detail: freight.alias ?? freight.id.slice(0, 12),
          at: freight.created,
        }
        : { id: 'freight', label: 'Freight', state: 'pending', detail: 'not picked up by a warehouse yet' },
    )

    const inStages = freight
      ? ordered.filter((s) => s.currentFreight === freight.id).map((s) => s.name)
      : []
    steps.push({
      id: 'promotion',
      label: 'Promotion',
      state: inStages.length ? 'done' : freight ? 'pending' : 'pending',
      detail: inStages.length ? inStages.join(' → ') : 'no stage holds it',
    })

    const live = shaEq(input.syncedRevision, c.sha)
    steps.push({
      id: 'deployed',
      label: 'Deployed',
      state: live ? 'done' : input.syncedRevision ? 'pending' : 'unknown',
      detail: live
        ? 'this is the running revision'
        : input.syncedRevision
        ? `running ${input.syncedRevision.slice(0, 12)}`
        : 'the application reports no synced revision',
    })

    return {
      sha: c.sha,
      short: c.short_sha || c.sha.slice(0, 10),
      subject: (c.message ?? '').split('\n')[0],
      author: c.author?.login,
      at: c.created,
      steps,
      inStages,
      live,
    }
  })
}

/** How far a commit got, for the row's summary. */
export function furthestStep(j: CommitJourney): JourneyStep {
  const reached = j.steps.filter((s) => s.state === 'done')
  return reached[reached.length - 1] ?? j.steps[0]
}
