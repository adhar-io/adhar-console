/**
 * Cloud Shell data — the built-in command snippet library, user snippets,
 * recent targets, restorable session descriptors and terminal preferences.
 * Pure helpers + localStorage; no React.
 *
 * Snippets may use `{{namespace}}`, `{{pod}}` and `{{container}}` placeholders
 * which resolve from the active session when pasted.
 */

export type SnippetGroup =
  | 'Cluster'
  | 'Workloads'
  | 'Debugging'
  | 'Networking'
  | 'Storage & config'
  | 'Helm'
  | 'Argo CD'
  | 'Inside the container'

export interface Snippet {
  id: string
  group: SnippetGroup | string
  label: string
  command: string
  /** Where it makes sense: cluster tools pod, an app container, or both. */
  scope: 'cluster' | 'pod' | 'any'
  /** Run immediately (append newline) instead of just pasting. Default: paste. */
  run?: boolean
  custom?: boolean
}

export const BUILTIN_SNIPPETS: Snippet[] = [
  // ── Cluster ──
  { id: 'nodes', group: 'Cluster', label: 'Nodes (wide)', command: 'kubectl get nodes -o wide', scope: 'cluster' },
  { id: 'top-nodes', group: 'Cluster', label: 'Node utilisation', command: 'kubectl top nodes', scope: 'cluster' },
  { id: 'ns', group: 'Cluster', label: 'Namespaces', command: 'kubectl get ns --show-labels', scope: 'cluster' },
  { id: 'events', group: 'Cluster', label: 'Recent events (all)', command: 'kubectl get events -A --sort-by=.lastTimestamp | tail -n 40', scope: 'cluster' },
  { id: 'api-res', group: 'Cluster', label: 'API resources', command: 'kubectl api-resources --verbs=list -o name', scope: 'cluster' },
  { id: 'k9s', group: 'Cluster', label: 'Launch k9s', command: 'k9s', scope: 'cluster', run: true },
  { id: 'whoami', group: 'Cluster', label: 'Who am I (RBAC)', command: 'kubectl auth whoami; kubectl auth can-i --list -n {{namespace}}', scope: 'cluster' },
  // ── Workloads ──
  { id: 'pods-ns', group: 'Workloads', label: 'Pods in namespace', command: 'kubectl get pods -n {{namespace}} -o wide', scope: 'cluster' },
  { id: 'pods-bad', group: 'Workloads', label: 'Unhealthy pods (all)', command: 'kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded', scope: 'cluster' },
  { id: 'top-pods', group: 'Workloads', label: 'Pod utilisation', command: 'kubectl top pods -n {{namespace}} --sort-by=memory', scope: 'cluster' },
  { id: 'deploy', group: 'Workloads', label: 'Deployments', command: 'kubectl get deploy,sts,ds -n {{namespace}}', scope: 'cluster' },
  { id: 'rollout', group: 'Workloads', label: 'Rollout status', command: 'kubectl rollout status deploy/<name> -n {{namespace}}', scope: 'cluster' },
  { id: 'restart', group: 'Workloads', label: 'Rolling restart', command: 'kubectl rollout restart deploy/<name> -n {{namespace}}', scope: 'cluster' },
  { id: 'scale', group: 'Workloads', label: 'Scale deployment', command: 'kubectl scale deploy/<name> -n {{namespace}} --replicas=2', scope: 'cluster' },
  // ── Debugging ──
  { id: 'describe-pod', group: 'Debugging', label: 'Describe pod', command: 'kubectl describe pod {{pod}} -n {{namespace}}', scope: 'cluster' },
  { id: 'logs', group: 'Debugging', label: 'Tail pod logs', command: 'kubectl logs -f {{pod}} -n {{namespace}} -c {{container}} --tail=200', scope: 'cluster' },
  { id: 'logs-prev', group: 'Debugging', label: 'Previous container logs', command: 'kubectl logs {{pod}} -n {{namespace}} -c {{container}} --previous', scope: 'cluster' },
  { id: 'pod-events', group: 'Debugging', label: 'Pod events', command: 'kubectl get events -n {{namespace}} --field-selector involvedObject.name={{pod}}', scope: 'cluster' },
  { id: 'debug', group: 'Debugging', label: 'Ephemeral debug container', command: 'kubectl debug -it {{pod}} -n {{namespace}} --image=busybox:1.36 --target={{container}} -- sh', scope: 'cluster' },
  { id: 'pod-yaml', group: 'Debugging', label: 'Pod YAML', command: 'kubectl get pod {{pod}} -n {{namespace}} -o yaml', scope: 'cluster' },
  { id: 'cp', group: 'Debugging', label: 'Copy file from pod', command: 'kubectl cp {{namespace}}/{{pod}}:/path/in/pod ./local-file -c {{container}}', scope: 'cluster' },
  // ── Networking ──
  { id: 'svc', group: 'Networking', label: 'Services + endpoints', command: 'kubectl get svc,endpointslices -n {{namespace}}', scope: 'cluster' },
  { id: 'ingress', group: 'Networking', label: 'Ingress & HTTPRoutes', command: 'kubectl get ingress,httproutes.gateway.networking.k8s.io -A', scope: 'cluster' },
  { id: 'netpol', group: 'Networking', label: 'Network policies', command: 'kubectl get networkpolicies -n {{namespace}}', scope: 'cluster' },
  { id: 'pf', group: 'Networking', label: 'Port-forward', command: 'kubectl port-forward -n {{namespace}} pod/{{pod}} 8080:8080', scope: 'cluster' },
  { id: 'dns', group: 'Networking', label: 'DNS check', command: 'kubectl run -it --rm dns-test --image=busybox:1.36 --restart=Never -n {{namespace}} -- nslookup kubernetes.default', scope: 'cluster' },
  // ── Storage & config ──
  { id: 'pvc', group: 'Storage & config', label: 'PVCs', command: 'kubectl get pvc -n {{namespace}}', scope: 'cluster' },
  { id: 'cm', group: 'Storage & config', label: 'ConfigMaps & Secrets', command: 'kubectl get cm,secret -n {{namespace}}', scope: 'cluster' },
  { id: 'quota', group: 'Storage & config', label: 'Quotas & limits', command: 'kubectl describe quota,limitrange -n {{namespace}}', scope: 'cluster' },
  // ── Helm ──
  { id: 'helm-ls', group: 'Helm', label: 'Releases (all)', command: 'helm list -A', scope: 'cluster' },
  { id: 'helm-hist', group: 'Helm', label: 'Release history', command: 'helm history <release> -n {{namespace}}', scope: 'cluster' },
  { id: 'helm-vals', group: 'Helm', label: 'Release values', command: 'helm get values <release> -n {{namespace}} --all', scope: 'cluster' },
  // ── Argo CD ──
  { id: 'argo-apps', group: 'Argo CD', label: 'Applications', command: 'kubectl get applications.argoproj.io -A', scope: 'cluster' },
  { id: 'argo-unsynced', group: 'Argo CD', label: 'Out-of-sync apps', command: "kubectl get applications.argoproj.io -A -o json | jq -r '.items[] | select(.status.sync.status!=\"Synced\") | \"\\(.metadata.namespace)/\\(.metadata.name) \\(.status.sync.status) \\(.status.health.status)\"'", scope: 'cluster' },
  { id: 'argo-sync', group: 'Argo CD', label: 'Force refresh app', command: "kubectl annotate application.argoproj.io/<app> -n argocd argocd.argoproj.io/refresh=hard --overwrite", scope: 'cluster' },
  // ── Inside the container ──
  { id: 'c-env', group: 'Inside the container', label: 'Environment', command: 'env | sort', scope: 'pod' },
  { id: 'c-ps', group: 'Inside the container', label: 'Processes', command: 'ps aux 2>/dev/null || ls /proc | grep -E "^[0-9]+$"', scope: 'pod' },
  { id: 'c-net', group: 'Inside the container', label: 'Listening ports', command: 'ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || cat /proc/net/tcp', scope: 'pod' },
  { id: 'c-disk', group: 'Inside the container', label: 'Disk usage', command: 'df -h; du -sh /tmp 2>/dev/null', scope: 'pod' },
  { id: 'c-sa', group: 'Inside the container', label: 'Service account token', command: 'cat /var/run/secrets/kubernetes.io/serviceaccount/namespace; echo; ls /var/run/secrets/kubernetes.io/serviceaccount', scope: 'pod' },
  { id: 'c-cgroup', group: 'Inside the container', label: 'CPU/memory limits', command: 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes', scope: 'pod' },
  { id: 'c-curl', group: 'Inside the container', label: 'Reach the API server', command: 'curl -sk https://kubernetes.default.svc/version || wget -qO- --no-check-certificate https://kubernetes.default.svc/version', scope: 'pod' },
]

export interface SnippetContext {
  namespace?: string
  pod?: string
  container?: string
}

export function resolveSnippet(command: string, ctx: SnippetContext): string {
  return command
    .replace(/\{\{namespace\}\}/g, ctx.namespace || '<namespace>')
    .replace(/\{\{pod\}\}/g, ctx.pod || '<pod>')
    .replace(/\{\{container\}\}/g, ctx.container || '<container>')
}

/* ─────────── persistence ─────────── */

const KEYS = {
  snippets: 'adhar.cloud-shell.snippets.v1',
  recents: 'adhar.cloud-shell.recents.v1',
  sessions: 'adhar.cloud-shell.sessions.v1',
  prefs: 'adhar.cloud-shell.prefs.v1',
} as const

function read<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    // quota / private mode — all of this is a convenience
  }
}

export function loadUserSnippets(): Snippet[] {
  return read<Snippet[]>(KEYS.snippets, []).map((s) => ({ ...s, custom: true }))
}

export function saveUserSnippet(s: Omit<Snippet, 'id' | 'custom'> & { id?: string }): Snippet[] {
  const id = s.id ?? `u-${Date.now().toString(36)}`
  const next = [{ ...s, id, custom: true }, ...loadUserSnippets().filter((x) => x.id !== id)]
  write(KEYS.snippets, next)
  return next
}

export function deleteUserSnippet(id: string): Snippet[] {
  const next = loadUserSnippets().filter((x) => x.id !== id)
  write(KEYS.snippets, next)
  return next
}

/** A shell target the user opened before — one click to reopen. */
export interface RecentTarget {
  kind: 'pod' | 'cluster'
  cluster?: string
  namespace: string
  pod: string
  container: string
  shell: string
  lastOpened: string
}

const RECENTS_MAX = 12

export function loadRecents(): RecentTarget[] {
  return read<RecentTarget[]>(KEYS.recents, [])
}

export function pushRecent(t: Omit<RecentTarget, 'lastOpened'>): RecentTarget[] {
  const same = (a: RecentTarget) =>
    a.kind === t.kind && a.namespace === t.namespace && a.pod === t.pod && a.container === t.container && (a.cluster ?? '') === (t.cluster ?? '')
  const next = [{ ...t, lastOpened: new Date().toISOString() }, ...loadRecents().filter((r) => !same(r))].slice(0, RECENTS_MAX)
  write(KEYS.recents, next)
  return next
}

export function clearRecents(): RecentTarget[] {
  write(KEYS.recents, [])
  return []
}

/** Descriptors of the sessions that were open when the user left — offered for one-click restore. */
export interface RestorableSession {
  kind: 'pod' | 'cluster'
  cluster?: string
  namespace: string
  pod: string
  container: string
  shell: string
  label: string
}

export function saveOpenSessions(list: RestorableSession[]) {
  try {
    globalThis.sessionStorage?.setItem(KEYS.sessions, JSON.stringify(list))
  } catch {
    // ignore
  }
}

export function loadOpenSessions(): RestorableSession[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEYS.sessions)
    return raw ? (JSON.parse(raw) as RestorableSession[]) : []
  } catch {
    return []
  }
}

export interface ShellPrefs {
  fontSize: number
  /** Show the snippet/launch sidebar. */
  sidebar: boolean
  /** Confirm before closing a connected session. */
  confirmClose: boolean
  /** Default shell for new pod sessions. */
  shell: 'auto' | 'bash' | 'sh' | 'custom'
  customShell: string
}

export const DEFAULT_SHELL_PREFS: ShellPrefs = {
  fontSize: 13,
  sidebar: true,
  confirmClose: true,
  shell: 'auto',
  customShell: '/bin/bash -l',
}

export function loadShellPrefs(): ShellPrefs {
  return { ...DEFAULT_SHELL_PREFS, ...read<Partial<ShellPrefs>>(KEYS.prefs, {}) }
}

export function saveShellPrefs(p: ShellPrefs) {
  write(KEYS.prefs, p)
}

/**
 * The rc every Cloud Shell session sources, after the image's own bashrc.
 *
 * POSIX-only at the top level: `sh`/`ash`/`dash` read it through `$ENV`, so
 * bash-only syntax lives inside `eval` strings that only run under bash.
 */
const SHELL_RC = [
  '[ -n "$BASH_VERSION" ] && [ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
  '[ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
  'export TERM=xterm-256color COLORTERM=truecolor',
  '[ -n "$LANG" ] || export LANG=C.UTF-8',
  // user@pod  ~/cwd  (two lines, so a long path never pushes the cursor off-screen)
  "PS1='\\[\\e[1;38;5;117m\\]\\u\\[\\e[0;38;5;245m\\]@\\h\\[\\e[0m\\] \\[\\e[38;5;222m\\]\\w\\[\\e[0m\\]\\n\\[\\e[38;5;117m\\]\\$\\[\\e[0m\\] '",
  "alias ll='ls -alF' la='ls -A' l='ls -CF' ..='cd ..'",
  'if ls --color=auto / >/dev/null 2>&1; then alias ls="ls --color=auto"; alias grep="grep --color=auto"; fi',
  'command -v kubectl >/dev/null 2>&1 && alias k=kubectl',
  '[ -n "$BASH_VERSION" ] && eval \'HISTSIZE=10000; HISTCONTROL=ignoredups:erasedups; shopt -s histappend checkwinsize cdspell 2>/dev/null; bind "\\"\\e[A\\": history-search-backward" 2>/dev/null; bind "\\"\\e[B\\": history-search-forward" 2>/dev/null\'',
  '[ -n "$BASH_VERSION" ] && command -v kubectl >/dev/null 2>&1 && eval \'source <(kubectl completion bash) 2>/dev/null && complete -o default -F __start_kubectl k\'',
  '[ -n "$BASH_VERSION" ] && [ -f /usr/share/bash-completion/bash_completion ] && . /usr/share/bash-completion/bash_completion 2>/dev/null',
].join('\n')

/**
 * argv that starts an interactive shell with the Cloud Shell rc.
 *
 * The old `auto` command was `exec /bin/bash 2>/dev/null || exec /bin/sh`.
 * Under `exec` that redirect stays on bash for the whole session, and bash
 * draws its prompt and line editing on stderr — so the prompt and every typed
 * character went to /dev/null while command output still showed. Redirects
 * here are scoped to single probes, never to the shell itself.
 */
function interactive(prefer: 'auto' | 'bash' | 'sh'): string[] {
  const start = prefer === 'sh'
    ? 'exec sh -i'
    : prefer === 'bash'
    ? 'exec bash ${RC:+--rcfile "$RC"} -i'
    : 'if command -v bash >/dev/null 2>&1; then exec bash ${RC:+--rcfile "$RC"} -i; fi; exec sh -i'
  const script = [
    'RC="${TMPDIR:-/tmp}/.adhar-shellrc"',
    "cat > \"$RC\" 2>/dev/null <<'ADHAR_RC' || RC=",
    SHELL_RC,
    'ADHAR_RC',
    '[ -n "$RC" ] && export ENV="$RC"',
    'export TERM=xterm-256color COLORTERM=truecolor',
    start,
  ].join('\n')
  return ['/bin/sh', '-c', script]
}

/** argv for a shell preference. `auto` uses bash when the image has it, else sh. */
export function shellCommand(shell: ShellPrefs['shell'], custom: string): string[] {
  switch (shell) {
    case 'bash':
      return interactive('bash')
    case 'sh':
      return interactive('sh')
    case 'custom':
      return ['/bin/sh', '-c', `export TERM=xterm-256color COLORTERM=truecolor; exec ${custom.trim() || '/bin/sh -i'}`]
    default:
      return interactive('auto')
  }
}

export function shellLabel(shell: ShellPrefs['shell'], custom: string): string {
  return shell === 'auto' ? 'bash → sh' : shell === 'custom' ? custom.trim() || '/bin/sh' : `/bin/${shell}`
}
