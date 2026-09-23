import type { StepNode } from './wf-model.ts'

/**
 * The palette: the kinds of step people actually add to a workflow, each
 * with an image pinned to a tag and a command that runs as written.
 *
 * A preset is a starting point, not a type — once dropped it is an ordinary
 * step whose image and command are editable, so the palette never limits
 * what a workflow can do; it only saves typing `alpine/git:2.45.2` from
 * memory.
 */
export interface StepPreset {
  id: string
  title: string
  blurb: string
  /** Two-letter glyph for the palette and the node. */
  glyph: string
  /** A Tailwind tone family for the glyph tile. */
  tone: 'slate' | 'orange' | 'sky' | 'emerald' | 'violet' | 'amber' | 'rose' | 'indigo' | 'cyan'
  image: string
  command: string
  env?: Record<string, string>
}

export const STEP_PRESETS: StepPreset[] = [
  {
    id: 'shell',
    title: 'Shell',
    blurb: 'Run a script in a small Alpine container.',
    glyph: 'SH',
    tone: 'slate',
    image: 'alpine:3.20',
    command: 'echo "hello from $(hostname)"',
  },
  {
    id: 'git-clone',
    title: 'Git clone',
    blurb: 'Fetch a repository into /work for later steps.',
    glyph: 'GT',
    tone: 'orange',
    image: 'alpine/git:2.45.2',
    command: 'git clone --depth 1 "$REPO_URL" /work && ls /work',
    env: { REPO_URL: '{{workflow.parameters.repo}}' },
  },
  {
    id: 'build-image',
    title: 'Build image',
    blurb: 'Build and push a container with Kaniko, no Docker daemon.',
    glyph: 'BI',
    tone: 'sky',
    image: 'gcr.io/kaniko-project/executor:v1.23.2',
    command: '/kaniko/executor --context /work --destination "$IMAGE:$TAG"',
    env: { IMAGE: '{{workflow.parameters.image}}', TAG: '{{workflow.parameters.tag}}', DOCKER_CONFIG: '/kaniko/.docker' },
  },
  {
    id: 'node',
    title: 'Node.js',
    blurb: 'Install and run a Node project — tests, lint, a build.',
    glyph: 'ND',
    tone: 'emerald',
    image: 'node:22-alpine',
    command: 'cd /work && npm ci && npm test',
  },
  {
    id: 'python',
    title: 'Python',
    blurb: 'Run a Python script or module.',
    glyph: 'PY',
    tone: 'indigo',
    image: 'python:3.12-slim',
    command: 'python -c "print(\'hello\')"',
  },
  {
    id: 'kubectl',
    title: 'kubectl',
    blurb: 'Talk to the cluster with the workflow\'s service account.',
    glyph: 'KC',
    tone: 'cyan',
    image: 'bitnami/kubectl:1.31',
    command: 'kubectl get pods -n "$NAMESPACE"',
    env: { NAMESPACE: '{{workflow.namespace}}' },
  },
  {
    id: 'http',
    title: 'HTTP request',
    blurb: 'Call an endpoint — a health check, a webhook, an API.',
    glyph: 'HT',
    tone: 'violet',
    image: 'curlimages/curl:8.9.1',
    command: 'curl -fsS "$URL"',
    env: { URL: 'https://example.com/health' },
  },
  {
    id: 'argocd-sync',
    title: 'Argo CD sync',
    blurb: 'Sync an application and wait for it to be healthy.',
    glyph: 'AC',
    tone: 'orange',
    image: 'quay.io/argoproj/argocd:v2.12.3',
    command: 'argocd app sync "$APP" && argocd app wait "$APP" --health --timeout 600',
    env: { APP: '{{workflow.parameters.app}}' },
  },
  {
    id: 'helm',
    title: 'Helm',
    blurb: 'Install or upgrade a chart.',
    glyph: 'HM',
    tone: 'indigo',
    image: 'alpine/helm:3.15.4',
    command: 'helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE"',
    env: { RELEASE: 'my-release', CHART: './chart', NAMESPACE: '{{workflow.namespace}}' },
  },
  {
    id: 'notify',
    title: 'Notify',
    blurb: 'Post a message to a chat webhook.',
    glyph: 'NT',
    tone: 'amber',
    image: 'curlimages/curl:8.9.1',
    command: 'curl -fsS -X POST -H "content-type: application/json" -d "{\\"text\\":\\"$MESSAGE\\"}" "$WEBHOOK"',
    env: { WEBHOOK: '{{workflow.parameters.webhook}}', MESSAGE: 'Workflow {{workflow.name}} finished' },
  },
  {
    id: 'approval-wait',
    title: 'Wait',
    blurb: 'Pause for a fixed time — a soak, a cool-down.',
    glyph: 'WT',
    tone: 'rose',
    image: 'alpine:3.20',
    command: 'sleep "$SECONDS"',
    env: { SECONDS: '300' },
  },
]

export function presetById(id: string): StepPreset | undefined {
  return STEP_PRESETS.find((p) => p.id === id)
}

/** A step from a preset, placed at `x,y` with a unique name. */
export function stepFromPreset(preset: StepPreset, id: string, x: number, y: number): StepNode {
  return {
    id,
    label: preset.title,
    image: preset.image,
    command: preset.command,
    dependsOn: [],
    x,
    y,
    ...(preset.env ? { env: { ...preset.env } } : {}),
  }
}
