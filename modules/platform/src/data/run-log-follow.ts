import { useEffect, useRef, useState } from 'react'
import { type QueryKey, useQueryClient } from '@tanstack/react-query'
import { kube } from '@adhar/api-clients/k8s'
import { POLL_FLOOR_MS, useLiveRefetch } from '@adhar/shell-ui'
import { watchOf } from './live.ts'

/**
 * Follow a resilience gate run's log while it runs, instead of re-reading the
 * tail on a timer.
 *
 * The BFF (`/api/resilience/runs/log`) does the first read: it checks the Job
 * is a gate run and resolves its newest pod. From there, while the run is
 * live, this opens ONE `follow=true` log stream on that pod (as the signed-in
 * user — the BFF reads it with the same identity, so the same RBAC applies)
 * and hands back the accumulated text, flushed at most once a second.
 *
 * A pod watch on `job-name=<job>` invalidates the BFF read when the run's pods
 * change (a Job retry starts a new pod; a pulling pod starts running), and when
 * the run ends the BFF read is refreshed once so the final log is the
 * authoritative one.
 */

const RUNNER_NAMESPACE = 'adhar-system'
const PODS = { group: '', version: 'v1', resource: 'pods' }
const FLUSH_MS = 1000
const RETRY_MIN_MS = 3000
const RETRY_MAX_MS = 30_000
const RETRY_LIMIT = 8

/** The last `max` lines of `text` (a trailing partial line counts as one). */
export function keepTail(text: string, max: number): string {
  if (max <= 0) return ''
  let idx = text.length
  // A trailing newline terminates the last line rather than starting a new one.
  if (text.endsWith('\n')) idx -= 1
  for (let n = 0; n < max; n++) {
    idx = text.lastIndexOf('\n', idx - 1)
    if (idx < 0) return text
  }
  return text.slice(idx + 1)
}

export function useFollowedRunLog(input: {
  job: string | null
  pod: string | null
  live: boolean
  timestamps?: boolean
  /** The BFF read(s) to refresh when the run's pods change or the run ends. */
  queryKeys: QueryKey[]
}): string | undefined {
  const { job, pod, live, timestamps = false, queryKeys } = input
  const qc = useQueryClient()
  const keysRef = useRef(queryKeys)
  keysRef.current = queryKeys
  const maxLines = timestamps ? 2000 : 300
  const [text, setText] = useState<string | undefined>(undefined)

  useLiveRefetch(
    job ? watchOf(PODS, { namespace: RUNNER_NAMESPACE, labelSelector: `job-name=${job}` }) : null,
    queryKeys,
    POLL_FLOOR_MS,
    !!job && live,
  )

  // A different run: nothing streamed so far belongs to it.
  useEffect(() => setText(undefined), [job])

  // Stream while live and a pod is known.
  useEffect(() => {
    if (!live || !pod) return
    setText(undefined)
    const ac = new AbortController()
    let buf = ''
    let dirty = false
    let attempt = 0
    let retryTimer: number | undefined
    const flush = setInterval(() => {
      if (!dirty) return
      dirty = false
      setText(buf)
    }, FLUSH_MS)
    const open = () => {
      kube
        .logStream(
          RUNNER_NAMESPACE,
          pod,
          { follow: true, timestamps, tailLines: maxLines, signal: ac.signal, onOpen: () => { attempt = 0 } },
          (chunk) => {
            // Each (re)open re-sends the tail, so start from it rather than append.
            buf = keepTail(buf + chunk, maxLines)
            dirty = true
          },
        )
        .catch(() => {
          // The container may not be up yet (image pull) or the stream dropped;
          // back off and reopen, a bounded number of times.
          if (ac.signal.aborted || attempt >= RETRY_LIMIT) return
          const delay = Math.min(RETRY_MIN_MS * 2 ** attempt++, RETRY_MAX_MS)
          retryTimer = setTimeout(() => {
            buf = ''
            open()
          }, delay) as unknown as number
        })
    }
    open()
    return () => {
      ac.abort()
      clearInterval(flush)
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [live, pod, timestamps, maxLines])

  // The run just ended: refresh the BFF read once, then drop the streamed copy.
  const wasLive = useRef(live)
  useEffect(() => {
    if (wasLive.current && !live) {
      void Promise.all(keysRef.current.map((k) => qc.refetchQueries({ queryKey: k }))).finally(() => setText(undefined))
    }
    wasLive.current = live
  }, [live, qc])

  return text
}
