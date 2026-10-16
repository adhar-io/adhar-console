import { Performance } from './views/performance.tsx'

/**
 * The Performance Center as its own federated entry.
 *
 * It sits in the Deliver sidebar (`/deliver?section=performance`), beside
 * Chaos Engineering — load tests and fault injection are both how a release
 * proves it is ready — while its code stays in Develop with the k6 runner,
 * the git-backed test suite and the result store it is built on. The host
 * loads this entry for that one Deliver section.
 */
export default function DevelopPerformance() {
  return (
    <div className="space-y-6">
      <Performance />
    </div>
  )
}
