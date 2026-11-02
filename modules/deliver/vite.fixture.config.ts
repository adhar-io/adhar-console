// TEMPORARY (sweep harness) — delete after. Stub-backs uncredentialed tools; k8s stays live.
import base from './vite.config.ts'
const STUBBED = "['gitea','argocd','harbor','coder','airbyte','argo-rollouts','strapi','nexus','k6']"
export default (env: any) => {
  const c = (base as any)(env)
  c.build = { ...(c.build ?? {}), outDir: Deno.env.get('FIX_OUT') }
  c.plugins = [{ name: 'fixture-stub', enforce: 'pre', transform(code: string, id: string) {
    if (id.includes('api-clients/src/base/factory.ts')) return code.replace("const real = mode !== 'stub'", "const real = mode !== 'stub' && !" + STUBBED + ".includes(tool)")
  } }, ...c.plugins]
  return c
}
