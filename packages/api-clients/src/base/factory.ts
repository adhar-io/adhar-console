import { HttpClient, type HttpClientOptions } from './http.ts'

export type ClientFactory<TClient> = {
  create(opts: HttpClientOptions): TClient
  stub(): TClient
  /**
   * Environment-aware client. In a production build it talks to the backing
   * tool through the console's same-origin BFF proxy
   * (`/api/svc/<tool>/…`, cookie-authenticated — the server injects the
   * upstream token). In dev (pure SPA, no server) it returns the stub so the
   * UI still renders. Override `mode` to force one or the other (e.g. tests).
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
      const real = mode ? mode === 'real' : isProdBuild()
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
