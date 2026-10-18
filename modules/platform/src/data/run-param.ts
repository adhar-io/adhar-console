/** `?run=<namespace>/<name>` → the PipelineRun it names, or null. See Builds' PipelineRuns view. */
export function readRunParam(search = typeof location === 'undefined' ? '' : location.search): { ns: string; name: string } | null {
  const raw = new URLSearchParams(search).get('run');
  if (!raw) return null;
  const i = raw.indexOf('/');
  const ns = i > 0 ? raw.slice(0, i) : '';
  const name = i > 0 ? raw.slice(i + 1) : raw;
  return ns && name ? { ns, name } : null;
}
