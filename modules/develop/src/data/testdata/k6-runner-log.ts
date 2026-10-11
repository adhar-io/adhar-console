/** Test fixture shared by the perf result and runner tests. */

// A real k6 v0.49 runner log: progress lines, then the end-of-test summary.
export const RUNNER_LOG = `
          /\\      |‾‾| /‾‾/   /‾‾/
     /\\  /  \\     |  |/  /   /  /
execution: local
running (0m01.0s), 05/50 VUs, 10 complete and 0 interrupted iterations
default   [   3% ] 05/50 VUs  0m01.0s/0m30.0s
running (0m30.2s), 00/50 VUs, 1482 complete and 0 interrupted iterations
default ✓ [======================================] 50 VUs  30s

     ✓ status is 200

     checks.........................: 99.00% ✓ 2934      ✗ 30
     data_received..................: 12 MB  397 kB/s
     http_req_duration..............: avg=99.42ms min=21.1ms  med=88.3ms  max=1.02s  p(90)=180ms   p(95)=241ms
       { expected_response:true }...: avg=98.1ms  min=21.1ms  med=87.9ms  max=980ms  p(90)=178ms   p(95)=237ms
     http_req_failed................: 1.00%  ✓ 15        ✗ 1467
     http_reqs......................: 1482   49.06/s
     iterations.....................: 1482   49.06/s
     vus_max........................: 50     min=50      max=50

     ✓ http_req_duration
       p(95)<500
     ✗ http_req_failed
       rate<0.01
`
