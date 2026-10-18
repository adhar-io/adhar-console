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
 */
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
const blocks = text.split(/\n(?=TS\d+ \[ERROR\])/).filter((b) => /^TS\d+ \[ERROR\]/.test(b));
const own = blocks.filter((b) => /at file:\/\/\S*\/apps\/console\/app\/server\//.test(b));
console.log(`type errors: ${blocks.length} total, ${own.length} in apps/console/app/server`);
if (own.length > 0) {
  for (const b of own) console.error(b.trim() + '\n');
  Deno.exit(1);
}
