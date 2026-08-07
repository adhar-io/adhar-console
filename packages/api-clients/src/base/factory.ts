import { HttpClient, type HttpClientOptions } from './http.ts'

export type ClientFactory<TClient> = {
  create(opts: HttpClientOptions): TClient
  stub(): TClient
  /**
   * Environment-aware client. **Real by default** — talks to the backing tool
   * through the console's same-origin BFF proxy (`/api/svc/<tool>/…`,
   * cookie-authenticated; the server injects the upstream token). This holds in
   * dev too: `pnpm dev` runs the BFF and the Vite host proxies `/api/*` to it,
   * so the console connects to the locally-running adhar cluster. Pass
   * `mode: 'stub'` to force the in-memory stub (tests / offline only).
   */
  auto(opts: { tool: string; mode?: BackendMode } & Partial<HttpClientOptions>): TClient
}

export type BackendMode = 'real' | 'stub'

/** The base path of the BFF tool proxy. */
export function svcBaseUrl(tool: string): string {
  return `/api/svc/${tool}`
}

/** True when running in a production build (server-backed). Vite-replaced. */
export function isProdBuild(): boolean {
  try {
    return Boolean((import.meta as { env?: { PROD?: boolean } }).env?.PROD)
  } catch {
    return false
  }
}

export function defineClient<TClient>(
  build: (http: HttpClient) => TClient,
  stubImpl: () => TClient,
): ClientFactory<TClient> {
  return {
    create: (opts) => build(new HttpClient(opts)),
    stub: stubImpl,
    auto: ({ tool, mode, ...opts }) => {
      // Real by default; the in-memory stub is opt-in (tests/offline).
      const real = mode !== 'stub'
      if (!real) return stubImpl()
      return build(
        new HttpClient({
          ...opts,
          baseUrl: opts.baseUrl ?? svcBaseUrl(tool),
          credentials: opts.credentials ?? 'include',
        }),
      )
    },
  }
}
