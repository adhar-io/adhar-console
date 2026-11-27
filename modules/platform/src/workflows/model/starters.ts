import { edit, parse, print, setNode } from './doc.ts'

/**
 * The starters gallery (design 0026 §6.6): whole templates a new workflow can
 * begin from. Each is YAML text, opened like any other document — a starter is
 * not a special case of the model, it is a file somebody could have written.
 *
 * `starters_test.ts` holds every starter to: it parses, it projects to an
 * editable graph, and it validates with no errors and no warnings.
 */

export interface Starter {
  id: string
  title: string
  description: string
  kind: 'WorkflowTemplate' | 'CronWorkflow'
  /** Hidden unless the cluster has the capability. */
  requires?: 'batch' | 'gamedays'
  yaml: string
}

const SMALL = `resources:
          requests: {cpu: 100m, memory: 128Mi}
          limits: {cpu: 500m, memory: 256Mi}
        securityContext:
          runAsNonRoot: true
          runAsUser: 65532
          allowPrivilegeEscalation: false
          capabilities: {drop: [ALL]}
          seccompProfile: {type: RuntimeDefault}`

export const STARTERS: readonly Starter[] = [
  {
    id: 'blank',
    title: 'Blank workflow',
    description: 'One step, ready to build on.',
    kind: 'WorkflowTemplate',
    yaml: `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: new-workflow
spec:
  entrypoint: main
  activeDeadlineSeconds: 3600
  templates:
    - name: main
      dag:
        tasks:
          - name: hello
            template: hello
    - name: hello
      container:
        image: docker.io/library/busybox:1.37
        command: [sh, -c]
        args: ["echo hello"]
        ${SMALL}
`,
  },
  {
    id: 'nightly-maintenance',
    title: 'Nightly maintenance',
    description: 'A schedule that runs a job every night and reports when it fails.',
    kind: 'CronWorkflow',
    yaml: `apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: nightly-maintenance
spec:
  schedules:
    - "0 2 * * *"
  timezone: Etc/UTC
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 600
  workflowSpec:
    entrypoint: main
    onExit: on-exit
    activeDeadlineSeconds: 3600
    templates:
      - name: main
        dag:
          tasks:
            - name: maintain
              template: maintain
      - name: maintain
        retryStrategy:
          limit: 2
          retryPolicy: OnError
        container:
          image: docker.io/library/busybox:1.37
          command: [sh, -c]
          args: ["echo maintenance"]
          ${SMALL.replaceAll('\n        ', '\n          ')}
      - name: on-exit
        dag:
          tasks:
            - name: report
              template: report
              when: "{{workflow.status}} != Succeeded"
      - name: report
        container:
          image: docker.io/library/busybox:1.37
          command: [sh, -c]
          args: ["echo the nightly run ended as $STATUS"]
          env:
            - name: STATUS
              value: "{{workflow.status}}"
          ${SMALL.replaceAll('\n        ', '\n          ')}
`,
  },
  {
    id: 'approval-gated-release',
    title: 'Approval-gated release check',
    description: 'Check a release, ask a person, and continue only on approval.',
    kind: 'WorkflowTemplate',
    yaml: `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: release-check
spec:
  entrypoint: main
  activeDeadlineSeconds: 21600
  workflowMetadata:
    labels:
      adhar.io/has-approvals: "true"
  arguments:
    parameters:
      - name: version
        description: The version to release
  templates:
    - name: main
      dag:
        tasks:
          - name: check
            template: check
          - name: approve
            depends: check
            templateRef:
              name: adhar-steps
              template: approval
              clusterScope: true
            arguments:
              parameters:
                - name: question
                  value: "Release {{workflow.parameters.version}}?"
                - name: approvers
                  value: ""
          - name: release
            depends: approve
            # A rejection is an output, not a failure.
            when: "{{tasks.approve.outputs.parameters.decision}} == approve"
            template: release
    - name: check
      container:
        image: docker.io/library/busybox:1.37
        command: [sh, -c]
        args: ["echo checking $VERSION"]
        env:
          - name: VERSION
            value: "{{workflow.parameters.version}}"
        ${SMALL}
    - name: release
      container:
        image: docker.io/library/busybox:1.37
        command: [sh, -c]
        args: ["echo releasing $VERSION"]
        env:
          - name: VERSION
            value: "{{workflow.parameters.version}}"
        ${SMALL}
`,
  },
  {
    id: 'fan-out',
    title: 'Fan-out over items',
    description: 'List the work, run one step per item in parallel, then summarise.',
    kind: 'WorkflowTemplate',
    yaml: `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: fan-out
spec:
  entrypoint: main
  activeDeadlineSeconds: 3600
  templates:
    - name: main
      dag:
        tasks:
          - name: list
            template: list
          - name: process
            depends: list
            template: process
            # One run of the step per element of the JSON list.
            withParam: "{{tasks.list.outputs.result}}"
            arguments:
              parameters:
                - name: item
                  value: "{{item}}"
          - name: summarise
            depends: process
            template: summarise
    - name: list
      script:
        image: docker.io/library/python:3.13-slim
        command: [python]
        source: |
          import json
          print(json.dumps(["a", "b", "c"]))
        ${SMALL}
    - name: process
      parallelism: 4
      inputs:
        parameters:
          - name: item
      container:
        image: docker.io/library/busybox:1.37
        command: [sh, -c]
        args: ["echo processing $ITEM"]
        env:
          - name: ITEM
            value: "{{inputs.parameters.item}}"
        ${SMALL}
    - name: summarise
      container:
        image: docker.io/library/busybox:1.37
        command: [sh, -c]
        args: ["echo done"]
        ${SMALL}
`,
  },
  {
    id: 'etl-quality-gate',
    title: 'ETL with a data-quality gate',
    description: 'Extract, transform, check the result, and load only when the check passes.',
    kind: 'WorkflowTemplate',
    yaml: `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: etl
spec:
  entrypoint: main
  activeDeadlineSeconds: 7200
  templates:
    - name: main
      dag:
        tasks:
          - name: extract
            template: step
            arguments: {parameters: [{name: what, value: extract}]}
          - name: transform
            depends: extract
            template: step
            arguments: {parameters: [{name: what, value: transform}]}
          - name: quality
            depends: transform
            template: quality
          - name: load
            depends: quality
            when: "{{tasks.quality.outputs.parameters.verdict}} == pass"
            template: step
            arguments: {parameters: [{name: what, value: load}]}
    - name: step
      inputs:
        parameters:
          - name: what
      container:
        image: docker.io/library/busybox:1.37
        command: [sh, -c]
        args: ["echo $WHAT"]
        env:
          - name: WHAT
            value: "{{inputs.parameters.what}}"
        ${SMALL}
    - name: quality
      outputs:
        parameters:
          - name: verdict
            valueFrom:
              path: /tmp/verdict
              default: fail
      script:
        image: docker.io/library/python:3.13-slim
        command: [python]
        source: |
          rows, bad = 1000, 3
          open("/tmp/verdict", "w").write("pass" if bad / rows < 0.01 else "fail")
        ${SMALL}
`,
  },
  {
    id: 'smoke-after-promotion',
    title: 'Smoke test after a promotion',
    description: 'Wait for the rollout, check the endpoint answers, then a short load test.',
    kind: 'WorkflowTemplate',
    yaml: `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: smoke-test
spec:
  entrypoint: main
  activeDeadlineSeconds: 1800
  arguments:
    parameters:
      - name: deployment
        description: The Deployment that was promoted
      - name: url
        description: The URL to test
  templates:
    - name: main
      dag:
        tasks:
          - name: rolled-out
            templateRef: {name: adhar-steps, template: wait-healthy, clusterScope: true}
            arguments:
              parameters:
                - {name: kind, value: Deployment}
                - {name: name, value: "{{workflow.parameters.deployment}}"}
          - name: answers
            depends: rolled-out
            templateRef: {name: adhar-steps, template: http-check, clusterScope: true}
            arguments:
              parameters:
                - {name: url, value: "{{workflow.parameters.url}}"}
          - name: load
            depends: answers
            templateRef: {name: adhar-steps, template: k6-load, clusterScope: true}
            arguments:
              parameters:
                - {name: url, value: "{{workflow.parameters.url}}"}
                - {name: failOnThresholds, value: "true"}
`,
  },
  {
    id: 'gameday-launcher',
    title: 'Game-day launcher',
    description: 'Ask for approval, then run a vetted game-day plan.',
    kind: 'WorkflowTemplate',
    requires: 'gamedays',
    yaml: `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: gameday-launcher
spec:
  entrypoint: main
  activeDeadlineSeconds: 14400
  workflowMetadata:
    labels:
      adhar.io/has-approvals: "true"
  arguments:
    parameters:
      - name: plan
        description: The GameDay plan to run
  templates:
    - name: main
      dag:
        tasks:
          - name: approve
            templateRef: {name: adhar-steps, template: approval, clusterScope: true}
            arguments:
              parameters:
                - {name: question, value: "Start the game day {{workflow.parameters.plan}}?"}
          - name: gameday
            depends: approve
            when: "{{tasks.approve.outputs.parameters.decision}} == approve"
            templateRef: {name: adhar-steps, template: run-gameday, clusterScope: true}
            arguments:
              parameters:
                - {name: plan, value: "{{workflow.parameters.plan}}"}
`,
  },
  {
    id: 'batch-pipeline',
    title: 'Batch pipeline',
    description: 'Run batch jobs in order; the second starts only when the first completed.',
    kind: 'WorkflowTemplate',
    requires: 'batch',
    yaml: `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: batch-pipeline
spec:
  entrypoint: main
  activeDeadlineSeconds: 43200
  templates:
    - name: main
      dag:
        tasks:
          - name: import
            templateRef: {name: adhar-batch-steps, template: run, clusterScope: true}
            arguments:
              parameters:
                - {name: batchJob, value: ""}
          - name: settle
            depends: import
            templateRef: {name: adhar-batch-steps, template: run, clusterScope: true}
            arguments:
              parameters:
                - {name: batchJob, value: ""}
`,
  },
]

export function starters(capabilities: { batch?: boolean; gamedays?: boolean } = {}): Starter[] {
  return STARTERS.filter((s) => !s.requires || capabilities[s.requires] === true)
}

/** A starter's YAML with the name (and namespace) the user chose. */
export function instantiate(s: Starter, into: { name: string; namespace?: string }): string {
  return print(edit(parse(s.yaml), (doc) => {
    setNode(doc, ['metadata', 'name'], into.name)
    if (into.namespace) setNode(doc, ['metadata', 'namespace'], into.namespace)
  }))
}
