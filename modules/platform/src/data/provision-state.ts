/**
 * What a freshly-applied Crossplane claim is actually doing.
 *
 * The provisioning dialog used to hand straight back to the list the moment
 * the apiserver accepted the manifest. That response carries no `status` —
 * Crossplane has not reconciled yet — so the one moment the person most wants
 * an answer showed a blank status and read as nothing having happened.
 *
 * Reading it correctly is not just "is Ready true":
 *
 *   • `Synced=False` is the one that actually blocks. It means the composition
 *     could not be rendered or the provider rejected the spec, and it will not
 *     clear on its own — that is a failure to show now, not a wait.
 *   • `Ready=False` immediately after apply is NORMAL. A database takes
 *     minutes. Reporting it as a failure would make every successful provision
 *     look broken for its first few seconds.
 *   • No conditions at all means the controller has not looked yet, which is
 *     different again from "looked and is working".
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

export interface Condition {
  type: string
  status: string
  reason?: string
  message?: string
}

export type ProvisionPhase = 'accepted' | 'provisioning' | 'ready' | 'failed'

export interface ProvisionState {
  phase: ProvisionPhase
  /** One line fit for a status strip. */
  title: string
  /** The controller's own words, when it offered any. */
  detail?: string
  /** True while the object is still expected to change on its own. */
  settling: boolean
}

function find(conditions: Condition[], type: string): Condition | undefined {
  return conditions.find((c) => c.type === type)
}

export function provisionState(conditions: Condition[] | undefined): ProvisionState {
  const list = conditions ?? []
  if (list.length === 0) {
    return {
      phase: 'accepted',
      title: 'Accepted — waiting for the controller',
      detail: 'The apiserver stored the claim. Crossplane has not reported on it yet.',
      settling: true,
    }
  }

  const synced = find(list, 'Synced')
  // A composition that cannot be rendered never recovers by waiting, so this
  // is reported as a failure even while Ready is merely absent.
  if (synced?.status === 'False') {
    return {
      phase: 'failed',
      title: synced.reason ? `Not synced — ${synced.reason}` : 'Not synced',
      detail: synced.message,
      settling: false,
    }
  }

  const ready = find(list, 'Ready')
  if (ready?.status === 'True') {
    return { phase: 'ready', title: 'Ready', detail: ready.message, settling: false }
  }

  // Ready=False here is the expected state of a resource being built; the
  // reason is worth showing, but it is progress, not an error.
  return {
    phase: 'provisioning',
    title: ready?.reason ? `Provisioning — ${ready.reason}` : 'Provisioning',
    detail: ready?.message ?? synced?.message,
    settling: true,
  }
}
