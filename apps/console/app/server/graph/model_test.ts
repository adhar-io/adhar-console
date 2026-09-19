import { assertEquals } from 'jsr:@std/assert'
import {
  fromApplication,
  fromIngress,
  fromNamespace,
  fromPod,
  fromService,
  fromWorkload,
  imageId,
  parseImage,
  selectorMatches,
  stripReplicaSetSuffix,
} from './model.ts'

/**
 * These are the inferences that turn a pile of Kubernetes objects into a
 * graph, and they are where a knowledge graph goes quietly wrong: nothing
 * crashes, the picture just stops being true. Each test pins one judgement.
 */

Deno.test('image references normalise so the same image is one node', () => {
  // The whole value of image nodes is answering "what else runs this", which
  // requires ten workloads pulling one image to converge on one id.
  assertEquals(imageId('nginx'), imageId('nginx:latest'))
  assertEquals(imageId('ghcr.io/adhar-io/console:1.2'), 'image:ghcr.io/adhar-io/console:1.2')
})

Deno.test('a digest is never merged with a tag', () => {
  // Two pods on `:latest` may be running different code. Treating them as one
  // node would state something false about what is deployed.
  const tagged = imageId('app:latest')
  const pinned = imageId('app@sha256:abc123')
  assertEquals(tagged === pinned, false)
})

Deno.test('image parsing tells a registry from a path segment', () => {
  assertEquals(parseImage('nginx'), { registry: undefined, repository: 'nginx', tag: 'latest', digest: undefined })
  // `library` is a path, not a host — it has no dot, colon, and is not localhost.
  assertEquals(parseImage('library/nginx:1.25').registry, undefined)
  assertEquals(parseImage('library/nginx:1.25').repository, 'library/nginx')
  assertEquals(parseImage('ghcr.io/adhar-io/console:v1').registry, 'ghcr.io')
  assertEquals(parseImage('ghcr.io/adhar-io/console:v1').repository, 'adhar-io/console')
  // A port in the registry must not be mistaken for a tag.
  assertEquals(parseImage('registry:5000/app:v2').registry, 'registry:5000')
  assertEquals(parseImage('registry:5000/app:v2').tag, 'v2')
  assertEquals(parseImage('app@sha256:deadbeef').digest, 'sha256:deadbeef')
})

Deno.test('a mutable tag is flagged on the image node', () => {
  const pod = fromPod({
    kind: 'Pod',
    metadata: { name: 'p', namespace: 'n' },
    spec: { containers: [{ image: 'app:latest' }] },
    status: { phase: 'Running' },
  })
  const image = pod.nodes.find((n) => n.kind === 'image')
  assertEquals(image?.props?.mutableTag, true)
})

Deno.test('a pod is linked to its Deployment, not its ReplicaSet', () => {
  // The controller chain is an implementation detail; nobody asks "which
  // ReplicaSet is this pod in".
  const pod = fromPod({
    kind: 'Pod',
    metadata: {
      name: 'api-7d9f8b6c4-x2k9p',
      namespace: 'payments',
      ownerReferences: [{ kind: 'ReplicaSet', name: 'api-7d9f8b6c4', controller: true }],
    },
    spec: { nodeName: 'node-1', containers: [{ image: 'api:1' }] },
    status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
  })
  const owns = pod.edges.find((e) => e.kind === 'owns')
  assertEquals(owns?.from, 'workload:payments/api')
  assertEquals(owns?.to, 'pod:payments/api-7d9f8b6c4-x2k9p')
  assertEquals(pod.edges.some((e) => e.kind === 'runs-on' && e.to === 'node:node-1'), true)
})

Deno.test('the ReplicaSet suffix strip does not eat real name segments', () => {
  assertEquals(stripReplicaSetSuffix('api-7d9f8b6c4'), 'api')
  assertEquals(stripReplicaSetSuffix('payments-api-5f9c8'), 'payments-api')
  // The case that broke the naive version: "controller" is ten alphanumerics,
  // but Kubernetes hashes are vowel-free by construction, so it cannot be one.
  // Truncating here would link every pod to a workload that does not exist.
  assertEquals(stripReplicaSetSuffix('api-gateway-controller'), 'api-gateway-controller')
  assertEquals(stripReplicaSetSuffix('ingress-nginx-admission'), 'ingress-nginx-admission')
  assertEquals(stripReplicaSetSuffix('standalone'), 'standalone')
})

Deno.test('the pod-template-hash label beats the heuristic when present', () => {
  // Kubernetes states the answer on the pod; guessing is only the fallback.
  assertEquals(stripReplicaSetSuffix('metrics-server-abcde', 'abcde'), 'metrics-server')
  // A name whose real last segment happens to look hash-ish is safe when the
  // label disagrees with it.
  assertEquals(stripReplicaSetSuffix('api-gateway-7d9f8', 'nomatch'), 'api-gateway')
})

Deno.test('ReplicaSets contribute nothing of their own', () => {
  assertEquals(fromWorkload({ kind: 'ReplicaSet', metadata: { name: 'api-abc', namespace: 'n' } }).nodes.length, 0)
})

Deno.test('a workload knows its images even with no pods running', () => {
  // A scaled-to-zero or wholly failing workload still answers "what does this
  // run", which is exactly when you need it.
  const wl = fromWorkload({
    kind: 'Deployment',
    metadata: { name: 'api', namespace: 'payments' },
    spec: { replicas: 0, template: { spec: { containers: [{ image: 'ghcr.io/a/api:1' }], initContainers: [{ image: 'busybox:1' }] } } },
    status: {},
  })
  const images = wl.edges.filter((e) => e.kind === 'uses-image').map((e) => e.to)
  assertEquals(images.length, 2)
  assertEquals(images.includes('image:ghcr.io/a/api:1'), true)
  assertEquals(images.includes('image:busybox:1'), true)
})

Deno.test('a CronJob’s nested template images are found', () => {
  const wl = fromWorkload({
    kind: 'CronJob',
    metadata: { name: 'nightly', namespace: 'ops' },
    spec: { schedule: '0 2 * * *', jobTemplate: { spec: { template: { spec: { containers: [{ image: 'backup:3' }] } } } } },
  })
  assertEquals(wl.edges.some((e) => e.kind === 'uses-image' && e.to === 'image:backup:3'), true)
  assertEquals(wl.nodes[0].props?.schedule, '0 2 * * *')
})

Deno.test('workload health reflects readiness against desired', () => {
  const st = (spec: unknown, status: unknown) =>
    fromWorkload({ kind: 'Deployment', metadata: { name: 'a', namespace: 'n' }, spec: spec as Record<string, unknown>, status: status as Record<string, unknown> }).nodes[0].status
  assertEquals(st({ replicas: 3 }, { readyReplicas: 3 }), 'healthy')
  assertEquals(st({ replicas: 3 }, { readyReplicas: 1 }), 'progressing')
  assertEquals(st({ replicas: 3 }, { readyReplicas: 0 }), 'failed')
  // Scaled to zero on purpose is not a failure.
  assertEquals(st({ replicas: 0 }, {}), 'unknown')
})

Deno.test('a waiting container is degraded, not healthy', () => {
  // CrashLoopBackOff and ImagePullBackOff both surface as `waiting`, and a pod
  // in that state reporting healthy is the worst thing this graph could say.
  const pod = fromPod({
    kind: 'Pod',
    metadata: { name: 'p', namespace: 'n' },
    spec: { containers: [{ image: 'a:1' }] },
    status: { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
  })
  assertEquals(pod.nodes[0].status, 'degraded')
  assertEquals(pod.nodes[0].props?.restarts, 7)
})

Deno.test('service selectors match on labels, not endpoints', () => {
  // Endpoints only list READY pods, so an empty service and one whose pods are
  // all crashing look identical through them. Label matching shows the broken
  // pods still attached, which is the picture a debugger needs.
  assertEquals(selectorMatches({ app: 'api' }, { app: 'api', tier: 'web' }), true)
  assertEquals(selectorMatches({ app: 'api', tier: 'web' }, { app: 'api' }), false)
  // An empty selector selects everything in Kubernetes; treating that as "all
  // pods" here would connect a headless service to the entire namespace.
  assertEquals(selectorMatches({}, { app: 'api' }), false)
  assertEquals(selectorMatches(undefined, { app: 'api' }), false)
})

Deno.test('an ingress links to the services it routes to', () => {
  const ing = fromIngress({
    kind: 'Ingress',
    metadata: { name: 'web', namespace: 'payments' },
    spec: {
      rules: [{
        host: 'pay.example.com',
        http: { paths: [{ backend: { service: { name: 'api' } } }, { backend: { service: { name: 'ui' } } }] },
      }],
    },
  })
  const targets = ing.edges.filter((e) => e.kind === 'routes-to').map((e) => e.to)
  assertEquals(targets, ['service:payments/api', 'service:payments/ui'])
  assertEquals(ing.nodes[0].props?.hosts, 'pay.example.com')
})

Deno.test('an Argo CD application links to its repo and what it manages', () => {
  const app = fromApplication({
    kind: 'Application',
    metadata: { name: 'payments', namespace: 'argocd' },
    spec: {
      source: { repoURL: 'https://gitea.example.com/adhar/payments.git', path: 'deploy' },
      destination: { namespace: 'payments' },
    },
    status: {
      health: { status: 'Degraded' },
      sync: { status: 'Synced', revision: 'abc1234def567' },
      resources: [
        { kind: 'Deployment', name: 'api', namespace: 'payments' },
        { kind: 'Service', name: 'api', namespace: 'payments' },
        { kind: 'ReplicaSet', name: 'api-abc', namespace: 'payments' },
      ],
    },
  })
  assertEquals(app.nodes[0].status, 'failed')
  assertEquals(app.nodes[0].props?.revision, 'abc1234')
  assertEquals(app.edges.some((e) => e.kind === 'sources-from' && e.to === 'repository:adhar/payments'), true)
  assertEquals(app.edges.some((e) => e.kind === 'manages' && e.to === 'workload:payments/api'), true)
  assertEquals(app.edges.some((e) => e.kind === 'manages' && e.to === 'service:payments/api'), true)
  // ReplicaSets are not graph nodes, so nothing should claim to manage one.
  assertEquals(app.edges.some((e) => e.to.includes('api-abc')), false)
})

Deno.test('healthy-but-drifted is degraded, not healthy', () => {
  const drifted = fromApplication({
    kind: 'Application',
    metadata: { name: 'a', namespace: 'argocd' },
    status: { health: { status: 'Healthy' }, sync: { status: 'OutOfSync' } },
  })
  assertEquals(drifted.nodes[0].status, 'degraded')
})

Deno.test('a namespace carries its tenant, and the org node is shared', () => {
  const a = fromNamespace({ kind: 'Namespace', metadata: { name: 'pay', labels: { 'adhar.io/org': 'acme' } }, status: { phase: 'Active' } })
  const b = fromNamespace({ kind: 'Namespace', metadata: { name: 'search', labels: { 'adhar.io/org': 'acme' } }, status: { phase: 'Active' } })
  assertEquals(a.nodes.some((n) => n.id === 'org:acme'), true)
  assertEquals(b.nodes.some((n) => n.id === 'org:acme'), true)
  assertEquals(a.edges[0], { from: 'namespace:pay', to: 'org:acme', kind: 'belongs-to' })
})

Deno.test('a namespace with no org label produces no org node', () => {
  const plain = fromNamespace({ kind: 'Namespace', metadata: { name: 'kube-system' }, status: { phase: 'Active' } })
  assertEquals(plain.nodes.length, 1)
  assertEquals(plain.edges.length, 0)
})

Deno.test('secrets appear by name and never by content', () => {
  const pod = fromPod({
    kind: 'Pod',
    metadata: { name: 'p', namespace: 'n' },
    spec: {
      containers: [{ image: 'a:1' }],
      volumes: [{ secret: { secretName: 'db-password' } }, { configMap: { name: 'settings' } }, { persistentVolumeClaim: { claimName: 'data' } }],
    },
    status: { phase: 'Running' },
  })
  const secret = pod.nodes.find((n) => n.kind === 'secret')
  assertEquals(secret?.name, 'db-password')
  // The graph must never become a way to read a Secret the apiserver would
  // have refused, so there is nowhere for content to live.
  assertEquals(secret?.props, undefined)
  assertEquals(pod.edges.filter((e) => e.kind === 'mounts').length, 3)
})

Deno.test('a service records its selector for later matching', () => {
  const svc = fromService({ kind: 'Service', metadata: { name: 'api', namespace: 'n' }, spec: { selector: { app: 'api' }, type: 'ClusterIP' } })
  assertEquals(svc.nodes[0].props?.selector, 'app=api')
})
