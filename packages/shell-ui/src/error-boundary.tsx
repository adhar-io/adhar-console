import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?(error: Error, reset: () => void): ReactNode
  /**
   * Clears a caught error whenever this value changes — pass the route path so
   * navigating away from a page that crashed renders the next page instead of
   * the same error card (the boundary lives in the shell, which survives
   * navigations between pages of the same route component).
   */
  resetKey?: unknown
}

interface State {
  error: Error | null
  key: unknown
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (!Object.is(props.resetKey, state.key)) return { key: props.resetKey, error: null }
    return null
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  override render() {
    if (this.state.error) {
      const reset = () => this.setState({ error: null })
      if (this.props.fallback) return this.props.fallback(this.state.error, reset)
      return (
        <div
          role="alert"
          className="flex flex-col items-center rounded-xl border border-edge-default bg-surface-raised px-6 py-12 text-center shadow-sm"
        >
          <span
            aria-hidden
            className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </span>
          <div className="text-base font-semibold tracking-tight text-content">This part of the page failed to render</div>
          <p className="mt-1.5 max-w-md text-sm leading-relaxed text-content-muted">
            The rest of the console still works. Try again, or reload if it keeps happening.
          </p>
          <pre className="mt-3 max-h-32 max-w-full overflow-auto whitespace-pre-wrap rounded-lg bg-surface-sunken px-3 py-2 text-left font-mono text-[11px] text-content-muted [overflow-wrap:anywhere]">
            {this.state.error.message}
          </pre>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-9 items-center rounded-lg bg-brand-600 px-3.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => globalThis.location?.reload()}
              className="inline-flex h-9 items-center rounded-lg border border-edge-default bg-surface-raised px-3.5 text-sm font-medium text-content transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
            >
              Reload page
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
