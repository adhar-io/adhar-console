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
ENV DENO_DIR=/deno-dir
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
#     --build-context adhar-ui=../../Adhar/AdharWS/adhar-ui \
#     -f deploy/Dockerfile \
#     -t <registry>/adhar-console:$TAG \
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
#   1. Builds every federated remote in parallel (modules/<m>/dist/).
#   2. Builds the host as a Vite SPA (apps/console/dist/).
#   3. Stages each remote's dist under apps/console/dist/mf/<m>/ so the runtime
#      serves the host SPA + every remote from a single origin.
RUN deno task build

# Warm the Deno GLOBAL cache (DENO_DIR) for the standalone server's runtime deps
# (jose, drizzle, postgres, …) — server-only, not pulled by the client build.
# `--node-modules-dir=none` resolves straight from the global cache so the
# runtime image can drop the multi-hundred-MB node_modules dir entirely; this
# also cuts cold-start time dramatically (no giant node_modules to scan).
RUN deno cache --node-modules-dir=none \
    apps/console/server.ts packages/db/src/index.ts packages/auth/src/server-index.ts

# The runtime only ships packages/ + apps/console (federated remotes are
# pre-built into dist/mf). Drop modules/* from the workspace list so Deno
# doesn't fail on missing member configs at startup. The @adhar-console/*
# import map (unchanged) still resolves every runtime dependency.
RUN deno eval \
    "const p='/build/deno.json'; const j=JSON.parse(Deno.readTextFileSync(p)); j.workspace=(j.workspace||[]).filter((w)=>!String(w).startsWith('./modules/')); Deno.writeTextFileSync(p, JSON.stringify(j,null,2));"

###############################################################################
# Runtime stage — small Deno server hosting the SPA + BFF API.
###############################################################################
FROM denoland/deno:2.1.4 AS runtime

ENV DENO_DIR=/deno-dir
ENV NODE_ENV=production
ENV DENO_ENV=production
ENV DENO_NO_UPDATE_CHECK=1
ENV PORT=3000

WORKDIR /build/apps/console

# The global Deno cache (owned by the deno user) holds every runtime dep, so we
# ship NO node_modules — the image is small and cold-start is fast. Only the
# server sources + built SPA are copied.
COPY --from=builder --chown=deno:deno /deno-dir /deno-dir
COPY --from=builder /build/deno.json /build/deno.lock* /build/
COPY --from=builder /build/packages /build/packages
COPY --from=builder /build/apps/console/deno.json ./deno.json
COPY --from=builder /build/apps/console/server.ts ./server.ts
COPY --from=builder /build/apps/console/app ./app
COPY --from=builder /build/apps/console/dist ./dist

EXPOSE 3000
USER deno

# Keep the base image's tini + docker-entrypoint.sh (proper PID-1 signal
# forwarding); it prepends `deno` to these CMD args → `deno run …`.
#   -A                    : allow-all — never crash on a missed permission.
#   --no-lock             : don't (re)write the root-owned lockfile.
#   --cached-only         : never reach the network for modules at boot.
#   --node-modules-dir=none : resolve deps from the global cache, not a
#                             node_modules dir (fast start, small image).
CMD ["run", "-A", "--no-lock", "--cached-only", "--node-modules-dir=none", "server.ts"]
