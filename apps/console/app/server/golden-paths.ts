/**
 * Golden-path starter files.
 *
 * Pure, server-side generators — no I/O, no DOM. Each family returns the
 * complete list of `{ path, content }` files a golden-path repo should be
 * born with: Dockerfile, CI workflow (Gitea Actions), a `deploy/` Kustomize
 * folder Argo CD can sync, and observability wiring (ServiceMonitor +
 * OTEL_EXPORTER_OTLP_ENDPOINT). `/api/scaffold` commits these one by one via
 * the Gitea contents API right after the repo is created.
 *
 * Everything is parameterised by the wizard form values (name, description,
 * owner, port, language) and normalised defensively — a generator must never
 * throw on odd input, it just falls back to sane defaults.
 */

export type GoldenPathFamily = 'microservice' | 'frontend' | 'data-pipeline' | 'ml'

export interface GoldenPathFile {
  path: string
  content: string
}

export interface GoldenPathParams {
  name: string
  description?: string
  owner?: string
  /** Container port the workload listens on. Family default when absent. */
  port?: number
  /** Implementation language where the family supports a choice (microservice: go | node). */
  language?: string
}

const FAMILIES: readonly GoldenPathFamily[] = ['microservice', 'frontend', 'data-pipeline', 'ml']

export function isGoldenPathFamily(v: unknown): v is GoldenPathFamily {
  return typeof v === 'string' && (FAMILIES as readonly string[]).includes(v)
}

/** Entry point used by the scaffolder. */
export function generateGoldenPathFiles(
  family: GoldenPathFamily,
  params: GoldenPathParams,
): GoldenPathFile[] {
  switch (family) {
    case 'microservice':
      return microserviceFiles(params)
    case 'frontend':
      return frontendFiles(params)
    case 'data-pipeline':
      return dataPipelineFiles(params)
    case 'ml':
      return mlFiles(params)
  }
}

/* ─────────────── shared context + snippets ─────────────── */

interface Ctx {
  name: string
  description: string
  owner: string
  port: number
}

function ctx(params: GoldenPathParams, defaultPort: number): Ctx {
  const port =
    Number.isFinite(params.port) && params.port! > 0 && params.port! < 65536
      ? Math.trunc(params.port!)
      : defaultPort
  return {
    name: params.name,
    description: params.description?.trim() || `${params.name} — scaffolded by Adhar golden paths.`,
    owner: params.owner?.trim() || 'group:platform',
    port,
  }
}

const OTEL_ENDPOINT = 'http://otel-collector.observability.svc.cluster.local:4317'

/** Container-level env block (indented for a Deployment pod spec). */
function otelEnvYaml(name: string, extra: Array<[string, string]> = []): string {
  const pairs: Array<[string, string]> = [
    ['OTEL_SERVICE_NAME', name],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', OTEL_ENDPOINT],
    ...extra,
  ]
  return pairs
    .map(([k, v]) => `            - name: ${k}\n              value: ${JSON.stringify(v)}`)
    .join('\n')
}

function catalogInfoYaml(c: Ctx, type: string, tags: string[]): string {
  return `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${c.name}
  description: ${JSON.stringify(c.description)}
  annotations:
    argocd/app-name: ${c.name}
  tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]
spec:
  type: ${type}
  lifecycle: experimental
  owner: ${c.owner}
`
}

/**
 * Gitea Actions CI: build + test (language-specific steps), then
 * containerize + push on main. `testJobSteps` is a pre-indented YAML block
 * (6 spaces) appended after checkout.
 */
function ciWorkflowYaml(name: string, testJobSteps: string): string {
  return `name: ci
on:
  push:
    branches: [main]
  pull_request: {}

env:
  REGISTRY: \${{ vars.REGISTRY || 'registry.adhar.local' }}
  IMAGE: platform/${name}

jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${testJobSteps}

  containerize:
    needs: build-test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Log in to registry
        run: echo "\${{ secrets.REGISTRY_TOKEN }}" | docker login "\$REGISTRY" -u "\${{ secrets.REGISTRY_USER }}" --password-stdin
      - name: Build image
        run: |
          docker build \\
            -t "\$REGISTRY/\$IMAGE:\${GITHUB_SHA::8}" \\
            -t "\$REGISTRY/\$IMAGE:latest" .
      - name: Push image
        run: |
          docker push "\$REGISTRY/\$IMAGE:\${GITHUB_SHA::8}"
          docker push "\$REGISTRY/\$IMAGE:latest"
`
}

function deploymentYaml(o: {
  name: string
  port: number
  envYaml: string
  cpuRequest?: string
  memRequest?: string
  cpuLimit?: string
  memLimit?: string
  gpuComment?: boolean
  livenessPath?: string
  readinessPath?: string
}): string {
  const gpu = o.gpuComment
    ? `\n              # GPU inference: uncomment and ensure the node pool exposes the resource.\n              # nvidia.com/gpu: "1"`
    : ''
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${o.name}
  labels:
    app.kubernetes.io/name: ${o.name}
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: ${o.name}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${o.name}
    spec:
      containers:
        - name: ${o.name}
          image: registry.adhar.local/platform/${o.name}:latest
          ports:
            - name: http
              containerPort: ${o.port}
          env:
${o.envYaml}
          resources:
            requests:
              cpu: ${o.cpuRequest ?? '100m'}
              memory: ${o.memRequest ?? '128Mi'}
            limits:
              cpu: ${o.cpuLimit ?? '500m'}
              memory: ${o.memLimit ?? '256Mi'}${gpu}
          livenessProbe:
            httpGet:
              path: ${o.livenessPath ?? '/healthz'}
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: ${o.readinessPath ?? '/readyz'}
              port: http
            initialDelaySeconds: 3
            periodSeconds: 5
`
}

function serviceYaml(name: string, port: number): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  labels:
    app.kubernetes.io/name: ${name}
spec:
  selector:
    app.kubernetes.io/name: ${name}
  ports:
    - name: http
      port: 80
      targetPort: http
      protocol: TCP
`
}

function serviceMonitorYaml(name: string): string {
  return `apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ${name}
  labels:
    app.kubernetes.io/name: ${name}
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
`
}

function kustomizationYaml(resources: string[]): string {
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
${resources.map((r) => `  - ${r}`).join('\n')}
`
}

/* ─────────────── microservice (Go / Node) ─────────────── */

function microserviceFiles(params: GoldenPathParams): GoldenPathFile[] {
  const c = ctx(params, 8080)
  const lang = params.language === 'node' ? 'node' : 'go'
  const common: GoldenPathFile[] = [
    {
      path: 'deploy/kustomization.yaml',
      content: kustomizationYaml(['deployment.yaml', 'service.yaml', 'servicemonitor.yaml']),
    },
    {
      path: 'deploy/deployment.yaml',
      content: deploymentYaml({ name: c.name, port: c.port, envYaml: otelEnvYaml(c.name, [['PORT', String(c.port)]]) }),
    },
    { path: 'deploy/service.yaml', content: serviceYaml(c.name, c.port) },
    { path: 'deploy/servicemonitor.yaml', content: serviceMonitorYaml(c.name) },
    { path: 'catalog-info.yaml', content: catalogInfoYaml(c, 'service', ['golden-path', 'microservice', lang]) },
    {
      path: 'README.md',
      content: `# ${c.name}

${c.description}

Golden-path **${lang === 'go' ? 'Go' : 'Node.js'} microservice** scaffolded by the Adhar console.

## What you get

- Minimal HTTP server with \`/healthz\` and \`/readyz\` probes on port ${c.port}
- \`Dockerfile\` producing a slim production image
- CI (\`.gitea/workflows/ci.yaml\`): build + test on every push, containerize + push on \`main\`
- \`deploy/\` Kustomize (Deployment with resource requests/limits + probes, Service) synced by Argo CD
- Observability: Prometheus \`ServiceMonitor\` + \`OTEL_EXPORTER_OTLP_ENDPOINT\` pre-wired

## Run locally

\`\`\`sh
${lang === 'go' ? 'go run .' : 'node server.mjs'}
curl localhost:${c.port}/healthz
\`\`\`
`,
    },
  ]

  if (lang === 'node') {
    return [
      {
        path: 'server.mjs',
        content: `import { createServer } from 'node:http'

const port = Number(process.env.PORT ?? ${c.port})

const server = createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ service: '${c.name}', status: 'ok' }))
})

server.listen(port, () => {
  console.log('${c.name} listening on :' + port)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
`,
      },
      {
        path: 'package.json',
        content: `{
  "name": "${c.name}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.mjs",
    "test": "node --test"
  }
}
`,
      },
      {
        path: 'Dockerfile',
        content: `FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
ENV NODE_ENV=production PORT=${c.port}
EXPOSE ${c.port}
USER node
CMD ["node", "server.mjs"]
`,
      },
      {
        path: '.gitea/workflows/ci.yaml',
        content: ciWorkflowYaml(
          c.name,
          `      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Test
        run: npm test`,
        ),
      },
      ...common,
    ]
  }

  return [
    {
      path: 'main.go',
      content: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "${c.port}"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"service": "${c.name}", "status": "ok"})
	})
	log.Printf("${c.name} listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
`,
    },
    {
      path: 'go.mod',
      content: `module ${c.name}

go 1.23
`,
    },
    {
      path: 'Dockerfile',
      content: `FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -o /out/server .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
ENV PORT=${c.port}
EXPOSE ${c.port}
USER nonroot
ENTRYPOINT ["/server"]
`,
    },
    {
      path: '.gitea/workflows/ci.yaml',
      content: ciWorkflowYaml(
        c.name,
        `      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
      - name: Vet
        run: go vet ./...
      - name: Test
        run: go test ./...`,
      ),
    },
    ...common,
  ]
}

/* ─────────────── frontend (Vite / React static) ─────────────── */

function frontendFiles(params: GoldenPathParams): GoldenPathFile[] {
  const c = ctx(params, 8080)
  return [
    {
      path: 'index.html',
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${c.name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    {
      path: 'src/main.tsx',
      content: `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`,
    },
    {
      path: 'src/App.tsx',
      content: `export function App() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: '4rem', textAlign: 'center' }}>
      <h1>${c.name}</h1>
      <p>${c.description.replace(/</g, '&lt;')}</p>
      <p>Scaffolded by the Adhar golden path — edit <code>src/App.tsx</code> to begin.</p>
    </main>
  )
}
`,
    },
    {
      path: 'vite.config.ts',
      content: `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`,
    },
    {
      path: 'package.json',
      content: `{
  "name": "${c.name}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
`,
    },
    {
      path: 'nginx.conf',
      content: `server {
  listen ${c.port};
  root /usr/share/nginx/html;
  index index.html;

  location /healthz { return 200 "ok"; }
  location /readyz { return 200 "ok"; }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
`,
    },
    {
      path: 'Dockerfile',
      content: `FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE ${c.port}
`,
    },
    {
      path: '.gitea/workflows/ci.yaml',
      content: ciWorkflowYaml(
        c.name,
        `      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install
        run: npm install
      - name: Build
        run: npm run build`,
      ),
    },
    {
      path: 'deploy/kustomization.yaml',
      content: kustomizationYaml(['deployment.yaml', 'service.yaml', 'ingress.yaml']),
    },
    {
      path: 'deploy/deployment.yaml',
      content: deploymentYaml({
        name: c.name,
        port: c.port,
        envYaml: otelEnvYaml(c.name),
        cpuRequest: '50m',
        memRequest: '64Mi',
        cpuLimit: '200m',
        memLimit: '128Mi',
        livenessPath: '/healthz',
        readinessPath: '/readyz',
      }),
    },
    { path: 'deploy/service.yaml', content: serviceYaml(c.name, c.port) },
    {
      path: 'deploy/ingress.yaml',
      content: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${c.name}
  labels:
    app.kubernetes.io/name: ${c.name}
  annotations:
    cert-manager.io/cluster-issuer: platform-issuer
spec:
  ingressClassName: nginx
  rules:
    - host: ${c.name}.apps.adhar.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${c.name}
                port:
                  number: 80
  tls:
    - hosts:
        - ${c.name}.apps.adhar.local
      secretName: ${c.name}-tls
`,
    },
    { path: 'catalog-info.yaml', content: catalogInfoYaml(c, 'website', ['golden-path', 'frontend', 'react', 'vite']) },
    {
      path: 'README.md',
      content: `# ${c.name}

${c.description}

Golden-path **Vite + React frontend** scaffolded by the Adhar console.

## What you get

- Vite + React 19 + TypeScript starter (\`src/App.tsx\`)
- \`Dockerfile\`: Vite build baked into an nginx image (listens on ${c.port}, SPA fallback + probe endpoints)
- CI (\`.gitea/workflows/ci.yaml\`): install + build on every push, containerize + push on \`main\`
- \`deploy/\` Kustomize (Deployment, Service, Ingress with TLS) synced by Argo CD

## Run locally

\`\`\`sh
npm install
npm run dev
\`\`\`
`,
    },
  ]
}

/* ─────────────── data-pipeline (Python + Argo CronWorkflow) ─────────────── */

function dataPipelineFiles(params: GoldenPathParams): GoldenPathFile[] {
  const c = ctx(params, 8080)
  return [
    {
      path: 'pipeline/main.py',
      content: `"""${c.name} — batch pipeline entrypoint (Adhar golden path)."""

import logging
import os
import sys
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("${c.name}")


def extract() -> list[dict]:
    """Pull raw records from the source system. Replace with a real reader."""
    return [{"id": 1, "value": 42}]


def transform(rows: list[dict]) -> list[dict]:
    """Apply business transformations. Keep this pure and unit-testable."""
    return [{**row, "processed_at": datetime.now(timezone.utc).isoformat()} for row in rows]


def load(rows: list[dict]) -> None:
    """Write to the destination (lakehouse, warehouse, topic, ...)."""
    log.info("loaded %d rows", len(rows))


def main() -> int:
    log.info("starting run · otlp=%s", os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "unset"))
    load(transform(extract()))
    log.info("run complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`,
    },
    {
      path: 'pipeline/__init__.py',
      content: '',
    },
    {
      path: 'requirements.txt',
      content: `# Pin your pipeline dependencies here.
# pandas==2.2.*
# pyarrow==17.*
`,
    },
    {
      path: 'Dockerfile',
      content: `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY pipeline ./pipeline
USER 1000
ENTRYPOINT ["python", "-m", "pipeline.main"]
`,
    },
    {
      path: '.gitea/workflows/ci.yaml',
      content: ciWorkflowYaml(
        c.name,
        `      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Install
        run: pip install -r requirements.txt
      - name: Smoke test
        run: python -m pipeline.main`,
      ),
    },
    {
      path: 'deploy/kustomization.yaml',
      content: kustomizationYaml(['cronworkflow.yaml']),
    },
    {
      path: 'deploy/cronworkflow.yaml',
      content: `apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: ${c.name}
  labels:
    app.kubernetes.io/name: ${c.name}
spec:
  schedule: "0 */6 * * *"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 300
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  workflowSpec:
    entrypoint: run
    ttlStrategy:
      secondsAfterCompletion: 86400
    templates:
      - name: run
        container:
          image: registry.adhar.local/platform/${c.name}:latest
          command: [python, -m, pipeline.main]
          env:
            - name: OTEL_SERVICE_NAME
              value: "${c.name}"
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: "${OTEL_ENDPOINT}"
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: "1"
              memory: 1Gi
`,
    },
    { path: 'catalog-info.yaml', content: catalogInfoYaml(c, 'service', ['golden-path', 'data-pipeline', 'python', 'argo-workflows']) },
    {
      path: 'README.md',
      content: `# ${c.name}

${c.description}

Golden-path **data pipeline** scaffolded by the Adhar console.

## What you get

- Python 3.12 job skeleton (\`pipeline/main.py\`, extract → transform → load)
- \`Dockerfile\` producing the job image
- CI (\`.gitea/workflows/ci.yaml\`): install + smoke test, containerize + push on \`main\`
- \`deploy/cronworkflow.yaml\`: Argo CronWorkflow (every 6h) synced by Argo CD
- \`OTEL_EXPORTER_OTLP_ENDPOINT\` pre-wired for traces/metrics

## Run locally

\`\`\`sh
pip install -r requirements.txt
python -m pipeline.main
\`\`\`

Change the schedule in \`deploy/cronworkflow.yaml\` — Argo CD applies it on merge.
`,
    },
  ]
}

/* ─────────────── ml (FastAPI serving + training CronWorkflow) ─────────────── */

function mlFiles(params: GoldenPathParams): GoldenPathFile[] {
  const c = ctx(params, 8000)
  return [
    {
      path: 'app/main.py',
      content: `"""${c.name} — model-serving API (Adhar golden path)."""

import os

from fastapi import FastAPI
from pydantic import BaseModel

MODEL_VERSION = os.environ.get("MODEL_VERSION", "0.1.0")

app = FastAPI(title="${c.name}", version=MODEL_VERSION)


class PredictRequest(BaseModel):
    features: list[float]


class PredictResponse(BaseModel):
    prediction: float
    model_version: str


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.get("/readyz")
def readyz() -> dict:
    # Extend: verify the model artifact is loaded before reporting ready.
    return {"status": "ok", "model_version": MODEL_VERSION}


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
    # Placeholder inference — replace with a real model load + forward pass.
    score = sum(req.features) / len(req.features) if req.features else 0.0
    return PredictResponse(prediction=score, model_version=MODEL_VERSION)
`,
    },
    {
      path: 'app/__init__.py',
      content: '',
    },
    {
      path: 'training/train.py',
      content: `"""${c.name} — training job skeleton, run by the training CronWorkflow."""

import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("${c.name}-train")


def main() -> int:
    log.info("loading training data ...")
    # Replace with: fetch dataset, train, evaluate, push artifact to the registry.
    log.info("training complete — publish the model artifact here")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`,
    },
    {
      path: 'requirements.txt',
      content: `fastapi==0.115.*
uvicorn[standard]==0.32.*
pydantic==2.*
`,
    },
    {
      path: 'Dockerfile',
      content: `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY training ./training
ENV PORT=${c.port}
EXPOSE ${c.port}
USER 1000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port \${PORT}"]
`,
    },
    {
      path: '.gitea/workflows/ci.yaml',
      content: ciWorkflowYaml(
        c.name,
        `      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Install
        run: pip install -r requirements.txt
      - name: Import check
        run: python -c "import app.main"`,
      ),
    },
    {
      path: 'deploy/kustomization.yaml',
      content: kustomizationYaml([
        'deployment.yaml',
        'service.yaml',
        'servicemonitor.yaml',
        'training-cronworkflow.yaml',
      ]),
    },
    {
      path: 'deploy/deployment.yaml',
      content: deploymentYaml({
        name: c.name,
        port: c.port,
        envYaml: otelEnvYaml(c.name, [['PORT', String(c.port)], ['MODEL_VERSION', '0.1.0']]),
        cpuRequest: '250m',
        memRequest: '512Mi',
        cpuLimit: '1',
        memLimit: '2Gi',
        gpuComment: true,
      }),
    },
    { path: 'deploy/service.yaml', content: serviceYaml(c.name, c.port) },
    { path: 'deploy/servicemonitor.yaml', content: serviceMonitorYaml(c.name) },
    {
      path: 'deploy/training-cronworkflow.yaml',
      content: `apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: ${c.name}-train
  labels:
    app.kubernetes.io/name: ${c.name}
spec:
  schedule: "0 2 * * 0"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  workflowSpec:
    entrypoint: train
    ttlStrategy:
      secondsAfterCompletion: 172800
    templates:
      - name: train
        container:
          image: registry.adhar.local/platform/${c.name}:latest
          command: [python, training/train.py]
          env:
            - name: OTEL_SERVICE_NAME
              value: "${c.name}-train"
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: "${OTEL_ENDPOINT}"
          resources:
            requests:
              cpu: "1"
              memory: 2Gi
            limits:
              cpu: "2"
              memory: 4Gi
              # Training on GPU: request the resource once the node pool exists.
              # nvidia.com/gpu: "1"
`,
    },
    { path: 'catalog-info.yaml', content: catalogInfoYaml(c, 'service', ['golden-path', 'ml', 'fastapi', 'model-serving']) },
    {
      path: 'README.md',
      content: `# ${c.name}

${c.description}

Golden-path **ML service** scaffolded by the Adhar console.

## What you get

- FastAPI model-serving skeleton (\`app/main.py\`: \`/predict\`, \`/healthz\`, \`/readyz\`) on port ${c.port}
- Training job skeleton (\`training/train.py\`) run weekly by \`deploy/training-cronworkflow.yaml\`
- \`Dockerfile\` for both serving and training images
- CI (\`.gitea/workflows/ci.yaml\`): install + import check, containerize + push on \`main\`
- \`deploy/\` Kustomize (Deployment with resource requests + GPU note, Service, ServiceMonitor) synced by Argo CD

## Run locally

\`\`\`sh
pip install -r requirements.txt
uvicorn app.main:app --reload --port ${c.port}
\`\`\`
`,
    },
  ]
}
