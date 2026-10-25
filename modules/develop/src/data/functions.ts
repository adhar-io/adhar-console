import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { k8s } from '@adhar/api-clients'
import { kube } from '@adhar/api-clients/k8s'

const client = k8s.K8sClient.auto()

export const FUNCTIONS_GVR: k8s.GVR = {
  group: 'platform.adhar.io',
  version: 'v1alpha1',
  resource: 'functions',
  namespaced: true,
}

export interface FunctionXR {
  metadata: {
    name: string
    namespace?: string
    creationTimestamp?: string
  }
  spec?: {
    parameters?: {
      runtime?: string
      image?: string
      minScale?: number
      maxScale?: number
      timeoutSeconds?: number
      trigger?: string
      eventSource?: string
    }
  }
  status?: {
    url?: string
    conditions?: Array<{ type?: string; status?: string }>
  }
}

export interface NewFunctionInput {
  name: string
  namespace: string
  runtime: 'node20' | 'python312' | 'go122' | 'custom'
  image: string
  trigger: 'http' | 'cloudevent' | 'topic' | 'bucket' | 'cron'
  eventSource?: string
  minScale: number
  maxScale: number
  timeoutSeconds: number
}

export interface UpdateFunctionInput {
  name: string
  namespace: string
  runtime: 'node20' | 'python312' | 'go122' | 'custom'
  image: string
  trigger: 'http' | 'cloudevent' | 'topic' | 'bucket' | 'cron'
  eventSource?: string
  minScale: number
  maxScale: number
  timeoutSeconds: number
}

export function useFunctions(namespace: string, enabled = true) {
  const queryKey = ['functions', namespace]
  return useQuery({
    queryKey,
    queryFn: async () => (await client.listGeneric(undefined, FUNCTIONS_GVR, namespace)) as unknown as FunctionXR[],
    enabled,
    retry: false,
  })
}

export function useCreateFunction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: NewFunctionInput) => {
      if (input.minScale < 0 || input.maxScale < 1 || input.minScale > input.maxScale) {
        throw new Error(`Invalid scale bounds: min ${input.minScale}, max ${input.maxScale}`)
      }
      const manifest = {
        apiVersion: 'platform.adhar.io/v1alpha1',
        kind: 'Function',
        metadata: {
          name: input.name,
          namespace: input.namespace,
        },
        spec: {
          crossplane: {
            compositionSelector: {
              matchLabels: {
                feature: 'function',
              },
            },
          },
          parameters: {
            runtime: input.runtime,
            image: input.image,
            trigger: input.trigger,
            eventSource: input.eventSource ?? '',
            minScale: input.minScale,
            maxScale: input.maxScale,
            timeoutSeconds: input.timeoutSeconds,
          },
        },
      }
      return kube.apply(manifest)
    },
    onSuccess: async (_res, input) => {
      await qc.invalidateQueries({ queryKey: ['functions', input.namespace] })
    },
  })
}

export function useUpdateFunction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: UpdateFunctionInput) => {
      if (input.minScale < 0 || input.maxScale < 1 || input.minScale > input.maxScale) {
        throw new Error(`Invalid scale bounds: min ${input.minScale}, max ${input.maxScale}`)
      }
      const current = (await client.getGeneric(undefined, FUNCTIONS_GVR, input.namespace, input.name)) as unknown as FunctionXR & {
        apiVersion?: string
        kind?: string
        metadata?: { name?: string; namespace?: string; resourceVersion?: string; annotations?: Record<string, string>; labels?: Record<string, string> }
        spec?: { crossplane?: unknown; parameters?: Record<string, unknown> }
      }
      const manifest = {
        apiVersion: current.apiVersion ?? 'platform.adhar.io/v1alpha1',
        kind: current.kind ?? 'Function',
        metadata: {
          name: input.name,
          namespace: input.namespace,
          resourceVersion: current.metadata?.resourceVersion,
          annotations: current.metadata?.annotations ?? {},
          labels: current.metadata?.labels ?? {},
        },
        spec: {
          ...(current.spec ?? {}),
          parameters: {
            ...(current.spec?.parameters ?? {}),
            runtime: input.runtime,
            image: input.image,
            trigger: input.trigger,
            eventSource: input.eventSource ?? '',
            minScale: input.minScale,
            maxScale: input.maxScale,
            timeoutSeconds: input.timeoutSeconds,
          },
        },
      }
      return kube.apply(manifest)
    },
    onSuccess: async (_res, input) => {
      await qc.invalidateQueries({ queryKey: ['functions', input.namespace] })
    },
  })
}

export function useDeleteFunction(namespace: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (name: string) => {
      await kube.delete(FUNCTIONS_GVR, namespace, name)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['functions', namespace] })
    },
  })
}
