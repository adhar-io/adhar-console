# syntax=docker/dockerfile:1.7

###############################################################################
# Build stage
###############################################################################
FROM denoland/deno:2.1.4 AS builder

# pnpm is needed so Deno's `nodeModulesDir: auto` can resolve workspace packages
# during Vite builds. Install the statically-linked release binary (pinned to
# the repo's packageManager version) straight onto PATH — this avoids the
# get.pnpm.io installer's shell-rc/PATH + libatomic quirks and works on both
# amd64 and arm64.
ENV PNPM_VERSION=10.13.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && ARCH="$(dpkg --print-architecture)" \
 && case "$ARCH" in \
      amd64) PNPM_ARCH=x64 ;; \
      arm64) PNPM_ARCH=arm64 ;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linuxstatic-${PNPM_ARCH}" -o /usr/local/bin/pnpm \
 && chmod +x /usr/local/bin/pnpm \
 && pnpm --version

WORKDIR /build

# adhar-ui is a separate repo that the console consumes via Vite aliases.
# Pass it as an additional BuildKit build context:
#
#   docker build \
#     --build-context adhar-ui=../adhar-ui \
#     -f deploy/Dockerfile \
#     -t harbor.adhar.local/adhar/console:$TAG \
#     .
#
COPY --from=adhar-ui . /build/adhar-ui
ENV ADHAR_UI_PATH=/build/adhar-ui

# Pull in manifests first so pnpm + deno can cache deps before source changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc deno.json turbo.json tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/
COPY modules/ modules/
COPY scripts/ scripts/

RUN pnpm install --frozen-lockfile || pnpm install

# `deno task build` runs scripts/build.ts which:
#   1. Builds every remote in parallel (modules/<m>/dist/).
#   2. Builds the host (apps/console/.output/).
#   3. Stages each remote's dist under apps/console/.output/public/mf/<m>/
#      so the runtime container serves host + remotes from one origin.
RUN deno task build

###############################################################################
# Runtime stage
###############################################################################
FROM denoland/deno:distroless-2.1.4

WORKDIR /app

COPY --from=builder /build/apps/console/.output ./.output
COPY --from=builder /build/deno.json ./deno.json

ENV NODE_ENV=production
ENV DENO_ENV=production
ENV PORT=3000

USER nonroot
EXPOSE 3000

# The TanStack Start Nitro build produces `.output/server/index.mjs`.
# If the installed Start version uses a different entry, update this CMD.
#   --allow-net  : Keycloak, backing-tool proxy, Postgres (postgres.js TCP)
#   --allow-read : SA token / CA files, static assets
#   --allow-env  : runtime config (KEYCLOAK_URL, DATABASE_URL, AUTH_*, …)
#   --allow-sys  : postgres.js reads system info for connection defaults
CMD ["run", "--allow-net", "--allow-read", "--allow-env", "--allow-sys", ".output/server/index.mjs"]
