import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?(error: Error, reset: () => void): ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      const reset = () => this.setState({ error: null })
      if (this.props.fallback) return this.props.fallback(this.state.error, reset)
      return (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-6 text-rose-900">
          <div className="text-sm font-semibold">Something went wrong</div>
          <pre className="mt-2 whitespace-pre-wrap text-xs">{this.state.error.message}</pre>
          <button
            type="button"
            onClick={reset}
            className="mt-4 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-900 hover:bg-rose-50"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
