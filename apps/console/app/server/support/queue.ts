/**
 * A bounded, single-worker job queue.
 *
 * The platform watcher must never wait on Plane: `push` returns immediately,
 * one worker drains jobs in order (which also serialises everything about one
 * incident, so two notifications can never race into two tickets), and when
 * the queue is full the OLDEST job is dropped — an incident burst keeps the
 * newest state, and a dropped job costs one ticket comment, never a stalled
 * watcher. A job that throws is logged (once per distinct message) and the
 * worker moves on.
 */
export class BoundedQueue<T> {
  private items: Array<{ job: T; settle?: (r: unknown) => void; fail?: (e: unknown) => void }> = []
  private running = false
  private idleWaiters: Array<() => void> = []
  dropped = 0
  processed = 0
  failed = 0
  lastError?: { at: string; message: string }
  private logged = new Set<string>()

  constructor(
    private readonly worker: (job: T) => Promise<unknown>,
    private readonly capacity = 200,
    private readonly log: (msg: string) => void = (m) => console.warn(m),
  ) {}

  get depth(): number {
    return this.items.length
  }

  /** Fire and forget. Never throws. */
  push(job: T): void {
    if (this.items.length >= this.capacity) {
      const old = this.items.shift()
      this.dropped++
      old?.fail?.(new Error('support ticket queue overflowed; request dropped'))
    }
    this.items.push({ job })
    void this.drain()
  }

  /** Enqueue and wait for this job's result (the manual "Create support ticket" path). */
  run<R>(job: T): Promise<R> {
    return new Promise<R>((settle, fail) => {
      if (this.items.length >= this.capacity) {
        const old = this.items.shift()
        this.dropped++
        old?.fail?.(new Error('support ticket queue overflowed; request dropped'))
      }
      this.items.push({ job, settle: settle as (r: unknown) => void, fail })
      void this.drain()
    })
  }

  /** Resolves when the queue is empty and the worker idle (tests). */
  idle(): Promise<void> {
    if (!this.running && !this.items.length) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.items.length) {
        const item = this.items.shift()!
        try {
          const r = await this.worker(item.job)
          this.processed++
          item.settle?.(r)
        } catch (e) {
          this.failed++
          const message = e instanceof Error ? e.message : String(e)
          this.lastError = { at: new Date().toISOString(), message }
          // One log line per distinct failure: Plane being down for an hour
          // must not write the same line for every incident in that hour.
          const sig = message.replace(/[0-9a-f-]{8,}/gi, '#').slice(0, 200)
          if (!this.logged.has(sig)) {
            if (this.logged.size > 200) this.logged.clear()
            this.logged.add(sig)
            this.log(`[support] ${message}`)
          }
          item.fail?.(e)
        }
      }
    } finally {
      this.running = false
      for (const w of this.idleWaiters.splice(0)) w()
    }
  }
}
