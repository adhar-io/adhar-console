import { z } from 'zod'

export interface GVK {
  group: string
  version: string
  kind: string
}

export interface GVR {
  group: string
  version: string
  resource: string
  namespaced: boolean
}

export const ObjectMetaSchema = z.object({
  name: z.string(),
  namespace: z.string().optional(),
  uid: z.string().optional(),
  resourceVersion: z.string().optional(),
  creationTimestamp: z.string().optional(),
  labels: z.record(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
  ownerReferences: z
    .array(
      z.object({
        apiVersion: z.string(),
        kind: z.string(),
        name: z.string(),
        uid: z.string(),
        controller: z.boolean().optional(),
      }),
    )
    .optional(),
})
export type ObjectMeta = z.infer<typeof ObjectMetaSchema>

export const ClusterSchema = z.object({
  name: z.string(),
  server: z.string(),
  version: z.string(),
  platform: z.string(),
  nodeCount: z.number(),
  healthy: z.boolean(),
  source: z.enum(['in-cluster', 'kubeconfig', 'crossplane-managed']),
})
export type Cluster = z.infer<typeof ClusterSchema>

export const NodeSchema = z.object({
  metadata: ObjectMetaSchema,
  status: z.object({
    conditions: z.array(
      z.object({
        type: z.string(),
        status: z.enum(['True', 'False', 'Unknown']),
        reason: z.string().optional(),
        message: z.string().optional(),
        lastTransitionTime: z.string().optional(),
      }),
    ),
    addresses: z
      .array(z.object({ type: z.string(), address: z.string() }))
      .optional(),
    nodeInfo: z.object({
      kubeletVersion: z.string(),
      kubeProxyVersion: z.string().optional(),
      osImage: z.string(),
      operatingSystem: z.string().optional(),
      architecture: z.string(),
      containerRuntimeVersion: z.string(),
      machineID: z.string().optional(),
      systemUUID: z.string().optional(),
      bootID: z.string().optional(),
    }),
    capacity: z.record(z.string()),
    allocatable: z.record(z.string()),
    images: z
      .array(z.object({ names: z.array(z.string()).optional(), sizeBytes: z.number().optional() }))
      .optional(),
    daemonEndpoints: z
      .object({ kubeletEndpoint: z.object({ Port: z.number() }).optional() })
      .optional(),
  }),
  spec: z.object({
    providerID: z.string().optional(),
    podCIDR: z.string().optional(),
    podCIDRs: z.array(z.string()).optional(),
    taints: z
      .array(
        z.object({
          key: z.string(),
          value: z.string().optional(),
          effect: z.string(),
          timeAdded: z.string().optional(),
        }),
      )
      .optional(),
    unschedulable: z.boolean().optional(),
  }),
})
export type Node = z.infer<typeof NodeSchema>

const ContainerPortSchema = z.object({
  name: z.string().optional(),
  containerPort: z.number(),
  protocol: z.string().optional(),
  hostPort: z.number().optional(),
})

const EnvVarSchema = z.object({
  name: z.string(),
  value: z.string().optional(),
  valueFrom: z.record(z.any()).optional(),
})

const ResourceRequirementsSchema = z.object({
  limits: z.record(z.string()).optional(),
  requests: z.record(z.string()).optional(),
})

const ContainerSchema = z.object({
  name: z.string(),
  image: z.string(),
  imagePullPolicy: z.string().optional(),
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  ports: z.array(ContainerPortSchema).optional(),
  env: z.array(EnvVarSchema).optional(),
  envFrom: z.array(z.record(z.any())).optional(),
  resources: ResourceRequirementsSchema.optional(),
  volumeMounts: z
    .array(
      z.object({
        name: z.string(),
        mountPath: z.string(),
        readOnly: z.boolean().optional(),
        subPath: z.string().optional(),
      }),
    )
    .optional(),
  livenessProbe: z.record(z.any()).optional(),
  readinessProbe: z.record(z.any()).optional(),
  startupProbe: z.record(z.any()).optional(),
})

const VolumeSchema = z.object({
  name: z.string(),
  // Volumes are polymorphic — any one of many `emptyDir`, `configMap`, etc.
  configMap: z.object({ name: z.string() }).optional(),
  secret: z.object({ secretName: z.string().optional() }).optional(),
  persistentVolumeClaim: z.object({ claimName: z.string() }).optional(),
  emptyDir: z.record(z.any()).optional(),
  hostPath: z.object({ path: z.string(), type: z.string().optional() }).optional(),
  projected: z.record(z.any()).optional(),
  downwardAPI: z.record(z.any()).optional(),
})

const TolerationSchema = z.object({
  key: z.string().optional(),
  operator: z.string().optional(),
  value: z.string().optional(),
  effect: z.string().optional(),
  tolerationSeconds: z.number().optional(),
})

const ContainerStatusSchema = z.object({
  name: z.string(),
  ready: z.boolean(),
  restartCount: z.number(),
  image: z.string().optional(),
  imageID: z.string().optional(),
  containerID: z.string().optional(),
  started: z.boolean().optional(),
  state: z.record(z.any()).optional(),
  lastState: z.record(z.any()).optional(),
})

export const PodSchema = z.object({
  metadata: ObjectMetaSchema,
  spec: z.object({
    nodeName: z.string().optional(),
    nodeSelector: z.record(z.string()).optional(),
    containers: z.array(ContainerSchema),
    initContainers: z.array(ContainerSchema).optional(),
    volumes: z.array(VolumeSchema).optional(),
    tolerations: z.array(TolerationSchema).optional(),
    restartPolicy: z.string().optional(),
    serviceAccountName: z.string().optional(),
    serviceAccount: z.string().optional(),
    priorityClassName: z.string().optional(),
    schedulerName: z.string().optional(),
    hostNetwork: z.boolean().optional(),
    dnsPolicy: z.string().optional(),
    terminationGracePeriodSeconds: z.number().optional(),
    securityContext: z.record(z.any()).optional(),
    affinity: z.record(z.any()).optional(),
  }),
  status: z.object({
    phase: z.enum(['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']),
    message: z.string().optional(),
    reason: z.string().optional(),
    qosClass: z.string().optional(),
    podIP: z.string().optional(),
    hostIP: z.string().optional(),
    startTime: z.string().optional(),
    containerStatuses: z.array(ContainerStatusSchema).optional(),
    initContainerStatuses: z.array(ContainerStatusSchema).optional(),
    conditions: z
      .array(
        z.object({
          type: z.string(),
          status: z.string(),
          reason: z.string().optional(),
          message: z.string().optional(),
          lastTransitionTime: z.string().optional(),
        }),
      )
      .optional(),
  }),
})
export type Pod = z.infer<typeof PodSchema>

export const DeploymentSchema = z.object({
  metadata: ObjectMetaSchema,
  spec: z.object({
    replicas: z.number(),
    strategy: z.object({ type: z.string() }).optional(),
    selector: z.object({ matchLabels: z.record(z.string()).optional() }),
  }),
  status: z.object({
    replicas: z.number().optional(),
    readyReplicas: z.number().optional(),
    updatedReplicas: z.number().optional(),
    availableReplicas: z.number().optional(),
    conditions: z
      .array(z.object({ type: z.string(), status: z.string(), message: z.string().optional() }))
      .optional(),
  }),
})
export type Deployment = z.infer<typeof DeploymentSchema>

export const ServiceSchema = z.object({
  metadata: ObjectMetaSchema,
  spec: z.object({
    type: z.enum(['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName']),
    clusterIP: z.string().optional(),
    ports: z.array(
      z.object({
        port: z.number(),
        targetPort: z.union([z.number(), z.string()]).optional(),
        protocol: z.string().optional(),
        name: z.string().optional(),
      }),
    ),
    selector: z.record(z.string()).optional(),
  }),
})
export type Service = z.infer<typeof ServiceSchema>

export const IngressSchema = z.object({
  metadata: ObjectMetaSchema,
  spec: z.object({
    ingressClassName: z.string().optional(),
    rules: z
      .array(
        z.object({
          host: z.string().optional(),
          http: z.object({
            paths: z.array(
              z.object({
                path: z.string(),
                pathType: z.string().optional(),
                backend: z.object({
                  service: z.object({
                    name: z.string(),
                    port: z.object({ number: z.number().optional(), name: z.string().optional() }),
                  }),
                }),
              }),
            ),
          }),
        }),
      )
      .optional(),
  }),
})
export type Ingress = z.infer<typeof IngressSchema>

export const NamespaceSchema = z.object({
  metadata: ObjectMetaSchema,
  status: z.object({ phase: z.enum(['Active', 'Terminating']) }),
})
export type Namespace = z.infer<typeof NamespaceSchema>

export const EventSchema = z.object({
  metadata: ObjectMetaSchema,
  type: z.enum(['Normal', 'Warning']),
  reason: z.string(),
  message: z.string(),
  count: z.number().optional(),
  lastTimestamp: z.string().optional(),
  involvedObject: z.object({ kind: z.string(), name: z.string(), namespace: z.string().optional() }),
})
export type Event = z.infer<typeof EventSchema>

export interface Generic {
  apiVersion: string
  kind: string
  metadata: ObjectMeta
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
}

export interface LogsParams {
  container?: string
  tailLines?: number
  sinceSeconds?: number
  follow?: boolean
  timestamps?: boolean
}
