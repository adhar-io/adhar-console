/**
 * Real k6 v1.3 runner output (grafana/k6:1.3.0, `--quiet`), as the k6
 * operator's runner pods print it. The quiet flag means NO progress lines:
 * a failing target logs one warning per failed request, then the summary.
 */

/** Thresholds crossed: every request refused (exit code 99). */
export const V1_FAILING_LOG = `time="2026-10-24T04:10:50Z" level=warning msg="Request Failed" error="Get \\"http://my-service.test.svc.cluster.local/actuator/health/readiness\\": dial tcp 10.102.66.164:80: connect: connection refused"
time="2026-10-24T04:10:50Z" level=warning msg="Request Failed" error="Get \\"http://my-service.test.svc.cluster.local/actuator/health/readiness\\": dial tcp 10.102.66.164:80: connect: connection refused"
time="2026-10-24T04:10:51Z" level=warning msg="Request Failed" error="Get \\"http://my-service.test.svc.cluster.local/actuator/health/readiness\\": dial tcp 10.102.66.164:80: connect: connection refused"


  █ THRESHOLDS 

    checks
    ✗ 'rate>0.99' rate=0.00%

    http_req_duration
    ✓ 'p(95)<500' p(95)=0s

    http_req_failed
    ✗ 'rate<0.01' rate=100.00%


  █ TOTAL RESULTS 

    checks_total.......: 1665    15.807937/s
    checks_succeeded...: 0.00%   0 out of 1665
    checks_failed......: 100.00% 1665 out of 1665

    ✗ status is 2xx
      ↳  0% — ✓ 0 / ✗ 1665

    HTTP
    http_req_duration....: avg=0s       min=0s       med=0s       max=0s       p(90)=0s       p(95)=0s      
    http_req_failed......: 100.00% 1665 out of 1665
    http_reqs............: 1665    15.807937/s

    EXECUTION
    iteration_duration...: avg=501.25ms min=500.24ms med=501.07ms max=539.66ms p(90)=501.67ms p(95)=502.16ms
    iterations...........: 1665    15.807937/s
    vus..................: 1       min=1            max=10
    vus_max..............: 10      min=10           max=10

    NETWORK
    data_received........: 0 B     0 B/s
    data_sent............: 0 B     0 B/s



time="2026-10-24T04:12:35Z" level=error msg="thresholds on metrics 'checks, http_req_failed' have been crossed"
`

/** Passing run: a quiet runner prints nothing but the summary. */
export const V1_PASSING_LOG = `

  █ THRESHOLDS 

    checks
    ✓ 'rate>0.99' rate=100.00%

    http_req_duration
    ✓ 'p(95)<500' p(95)=10.69ms

    http_req_failed
    ✓ 'rate<0.01' rate=0.00%


  █ TOTAL RESULTS 

    checks_total.......: 1658    15.779569/s
    checks_succeeded...: 100.00% 1658 out of 1658
    checks_failed......: 0.00%   0 out of 1658

    ✓ status is 2xx

    HTTP
    http_req_duration..............: avg=2.42ms   min=320.21µs med=596.74µs max=73.78ms  p(90)=3.56ms   p(95)=10.69ms 
      { expected_response:true }...: avg=2.42ms   min=320.21µs med=596.74µs max=73.78ms  p(90)=3.56ms   p(95)=10.69ms 
    http_req_failed................: 0.00%  0 out of 1658
    http_reqs......................: 1658   15.779569/s

    EXECUTION
    iteration_duration.............: avg=503.53ms min=500.54ms med=501.53ms max=574.91ms p(90)=505.33ms p(95)=513.14ms
    iterations.....................: 1658   15.779569/s
    vus............................: 1      min=1         max=10
    vus_max........................: 10     min=10        max=10

    NETWORK
    data_received..................: 1.9 MB 18 kB/s
    data_sent......................: 144 kB 1.4 kB/s
`

/** The script the k6 operator ran for the passing run. */
export const SCRIPT_STAGES = `// Smoke load test for reactapp, wired into the Performance Center.
import http from 'k6/http'
import { check, sleep } from 'k6'

const BASE = __ENV.BASE_URL || 'http://reactapp.test.svc.cluster.local'
const PATH = __ENV.TARGET_PATH || '/'

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 10 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
}

export default function () {
  const res = http.get(BASE + PATH, { tags: { name: 'target' } })
  check(res, { 'status is 2xx': (r) => r.status >= 200 && r.status < 300 })
  sleep(0.5)
}
`

/**
 * The result ConfigMap the console stored on the cluster for a real run
 * (test/k6-result-transaction-service-load-20261025-162828, 2026-10-25):
 * k6 1.3 with its DEFAULT summaryTrendStats — no p(99) anywhere.
 */
export const STORED_NO_P99 = `=== adhar-perf runner transaction-service-load-20261025-162828-1-9kgh4 ===
  █ THRESHOLDS 

    checks
    ✓ 'rate>0.99' rate=100.00%

    http_req_duration
    ✓ 'p(95)<500' p(95)=30.71ms

    http_req_failed
    ✓ 'rate<0.01' rate=0.00%


  █ TOTAL RESULTS 

    checks_total.......: 1625    15.43533/s
    checks_succeeded...: 100.00% 1625 out of 1625
    checks_failed......: 0.00%   0 out of 1625

    ✓ status is 2xx

    HTTP
    http_req_duration..............: avg=11.98ms  min=3.31ms   med=8.14ms   max=224.98ms p(90)=18.71ms p(95)=30.71ms 
      { expected_response:true }...: avg=11.98ms  min=3.31ms   med=8.14ms   max=224.98ms p(90)=18.71ms p(95)=30.71ms 
    http_req_failed................: 0.00%  0 out of 1625
    http_reqs......................: 1625   15.43533/s

    EXECUTION
    iteration_duration.............: avg=513.62ms min=504.07ms med=509.59ms max=730.72ms p(90)=521.7ms p(95)=534.28ms
    iterations.....................: 1625   15.43533/s
    vus............................: 1      min=1         max=10
    vus_max........................: 10     min=10        max=10

    NETWORK
    data_received..................: 723 kB 6.9 kB/s
    data_sent......................: 200 kB 1.9 kB/s
`

/**
 * The same layout with the console's K6_SUMMARY_TREND_STATS
 * (avg,min,med,max,p(90),p(95),p(99)) — k6 1.3 appends `p(99)=` to every
 * trend line and may also judge a p(99) threshold. Shape verified with
 * `docker run -e K6_SUMMARY_TREND_STATS=… grafana/k6:1.3.0` (2026-10-27).
 */
export const V1_WITH_P99_LOG = `
  █ THRESHOLDS 

    http_req_duration
    ✓ 'p(95)<500' p(95)=30.71ms
    ✗ 'p(99)<40' p(99)=61.2ms


  █ TOTAL RESULTS 

    checks_total.......: 1625    15.43533/s
    checks_succeeded...: 100.00% 1625 out of 1625
    checks_failed......: 0.00%   0 out of 1625

    HTTP
    http_req_duration..............: avg=11.98ms  min=3.31ms   med=8.14ms   max=224.98ms p(90)=18.71ms p(95)=30.71ms p(99)=61.2ms
      { expected_response:true }...: avg=11.98ms  min=3.31ms   med=8.14ms   max=224.98ms p(90)=18.71ms p(95)=30.71ms p(99)=61.2ms
    http_req_failed................: 0.00%  0 out of 1625
    http_reqs......................: 1625   15.43533/s

    EXECUTION
    iteration_duration.............: avg=513.62ms min=504.07ms med=509.59ms max=730.72ms p(90)=521.7ms p(95)=534.28ms p(99)=601.4ms
    iterations.....................: 1625   15.43533/s
    vus_max........................: 10     min=10        max=10
`
