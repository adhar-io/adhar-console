---
title: GPU scheduling and isolation
category: AI & MCP
summary: Share expensive GPUs safely — dedicated, partitioned or time-sliced — and run untrusted AI workloads in micro-VMs.
tools: [NVIDIA GPU Operator, Kata Containers, Kyverno, DCGM]
order: 110
---

## Why
GPUs are the most expensive thing in the cluster and often sit idle. Sharing them saves money but can leak memory between tenants; AI code and models from the internet are untrusted code. Scheduling and isolation have to be decided together.

## How Adhar does it
Optional packages, off by default:
- **NVIDIA GPU Operator** installs drivers, the container toolkit, feature discovery, the DCGM exporter (with a ServiceMonitor) and the MIG manager. The device-plugin config `adhar-gpu-sharing` offers three profiles, chosen per node by label `nvidia.com/device-plugin.config`: `dedicated` (default), `mig-single` (hardware partitions) and `time-slice-4` (four pods per GPU, **no memory isolation**).
- **Kata Containers** runs on nodes labelled `adhar.io/microvm=true` and adds the RuntimeClasses `kata-qemu` and `kata-qemu-nvidia-gpu` (GPU passthrough into a micro-VM).
- **Kyverno `ai-workload-isolation`** mutates pods in namespaces labelled `platform.adhar.io/application-type: ai`: it sets the runtime class and places GPU pods on matching MIG or time-sliced nodes. An `Application` of `type: ai` sets `ai.isolation` (`microvm` by default, or `container`) and `ai.gpu.sharing` (`mig` by default, `timeslice` or `none`), and gets an `AgentWorkload` for its namespace.

Adhar doesn't ship a batch queue (no Kueue) or gVisor.

## Use it
1. Label GPU nodes with the sharing profile you want.
2. Declare `ai.gpu.count` and `ai.gpu.sharing` on the Application, or label the namespace.
3. Use `microvm` isolation for third-party models and agent code.

## Watch out
- Time-slicing shares memory — never mix tenants on one time-sliced GPU. It also doesn't work across micro-VMs: with `microvm` isolation it falls back to one GPU per pod.
- The Kyverno policy uses `failurePolicy: Ignore`: if Kyverno is down, pods start without the mutation.
- Watch DCGM utilisation; an allocated GPU at 5% is the usual waste.
