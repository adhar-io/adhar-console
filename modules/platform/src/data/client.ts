import { k8s } from '@adhar-console/api-clients'

/**
 * Single shared K8s client pointing at the dev Vite proxy.
 *
 * In dev, `/kube-api/*` is forwarded to `http://127.0.0.1:8001` where
 * `kubectl proxy --port=8001` is expected to be running.
 *
 * In prod the same path is served by the console's BFF after authenticating
 * the user's Keycloak session and exchanging for a short-lived kube token.
 */
export const client = k8s.K8sClient.auto()
export { LOCAL_CLUSTER } from '@adhar-console/api-clients/k8s'
