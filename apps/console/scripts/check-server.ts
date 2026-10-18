/**
 * Type-check the console's server code and FAIL on any error located in it.
 *
 * `deno task check` cannot gate CI yet: the shared UI packages carry several
 * hundred older type errors, so CI runs it with continue-on-error and nothing
 * ever fails on a type error. That is how a scaffolder referencing a variable
 * that did not exist (`params is not defined`, 2026-10-18) shipped and broke
 * every scaffold at its final step. The server's own files are clean, so this
 * gate holds them to that: errors elsewhere are reported as a count, errors in
 * app/server fail the run.
 *
 * Deno reports compiler failures in more than one format: typed diagnostics use
 * `TS... [ERROR]`, but syntax and parser errors arrive as plain `error:` output
 * with a `file://.../app/server/...` stack trace instead. The old regex only
 * matched the first shape, so a syntax error in a server file could return exit
 * code 1 and still pass this guard. Any non-zero exit from the server-only check
 * is therefore a real failure for CI.
 */
export function summarizeServerCheck(code: number, text: string) {
  const blocks = text.split(/\n(?=TS\d+ \[ERROR\])/).filter((b) => /^TS\d+ \[ERROR\]/.test(b));
  const own = blocks.filter((b) => /at file:\/\/\S*\/apps\/console\/app\/server\//.test(b));
  const hasServerPath = /at file:\/\/\S*\/apps\/console\/app\/server\//.test(text);
  return {
    code,
    totalErrors: blocks.length,
    serverErrors: own.length,
    isFailure: code !== 0 && (own.length > 0 || hasServerPath),
  }
}

export async function runServerCheck(): Promise<number> {
  const root = new URL('../', import.meta.url).pathname;
  const files: string[] = [];
  for await (const e of Deno.readDir(`${root}app/server`)) {
    if (e.isFile && e.name.endsWith('.ts') && !e.name.endsWith('_test.ts')) {
      files.push(`app/server/${e.name}`);
    }
  }
  const out = await new Deno.Command(Deno.execPath(), {
    args: ['check', ...files.sort()],
    cwd: root,
    stdout: 'piped',
    stderr: 'piped',
    env: { NO_COLOR: '1' },
  }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  const summary = summarizeServerCheck(out.code, text);
  console.log(`type errors: ${summary.totalErrors} total, ${summary.serverErrors} in apps/console/app/server`);
  if (summary.isFailure) {
    const payload = text.trim();
    if (payload) console.error(payload);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  Deno.exit(await runServerCheck());
}
