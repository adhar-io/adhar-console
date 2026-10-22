import type { Plugin } from 'vite'

/**
 * Works around a `@module-federation/vite` 1.14.x build bug that left
 * `ReferenceError: $ is not defined` in production chunks (e.g. the
 * `use-sync-external-store/shim/with-selector` chunk under platform + design).
 *
 * The plugin's `generateBundle` rewrites `import{r as X}from"…commonjs-proxy…"`
 * to use the proxy chunk's own local name whenever it thinks `X` is unused in
 * the importing chunk. It decides "unused" with `new RegExp('\\bX\\b')` — and
 * `\b` never matches next to `$`, which is not a regex word character. So when
 * the minifier names the binding `$`, the plugin renames the import to (say)
 * `f` while the code still reads `var i=$;` → ReferenceError at evaluation,
 * which blanks the page. Fixed upstream in 1.2x (`isIdentifierReferenced`);
 * 1.14.5 is the last 1.14 release.
 *
 * Runs before the federation plugin's `generateBundle` (`order: 'pre'`) and
 * gives every `$`-containing local imported from a loadShare commonjs proxy a
 * plain word-character alias: `import{r as __mf_cjs0}…;const $=__mf_cjs0;`.
 * The plugin then sees the alias used (in the `const`) and leaves it alone.
 * The `const` sits right after the import, before any other top-level code,
 * and the proxy module has finished evaluating by then, so the value is the
 * same one the live binding would have held.
 */
export function mfCjsProxyDollarFix(): Plugin {
  return {
    name: 'adhar:mf-cjs-proxy-dollar-fix',
    apply: 'build',
    // The rewrite below happens after hashing, so a fixed chunk would keep the
    // file name of the broken one that browsers already hold under
    // `Cache-Control: immutable` (server.ts). Salting the hash of every chunk
    // that imports a commonjs proxy gives the fixed content a new URL.
    augmentChunkHash(chunk) {
      if (chunk.imports.some((f) => f.includes('commonjs-proxy'))) return 'mf-cjs-dollar-fix-1'
    },
    generateBundle: {
      order: 'pre',
      handler(_options, bundle) {
        let n = 0
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk' || chunk.fileName.includes('__loadShare__')) continue
          const re = /import\s*\{([^}]+)\}\s*from\s*(["'][^"']*__loadShare__[^"']*commonjs-proxy[^"']*["'])\s*;?/g
          chunk.code = chunk.code.replace(re, (whole, specs: string, from: string) => {
            const aliases: string[] = []
            const next = specs.split(',').map((spec) => {
              const [imported, local = imported] = spec.trim().split(/\s+as\s+/).map((s) => s.trim())
              if (!local.includes('$')) return spec
              const alias = `__mf_cjs${n++}`
              aliases.push(`const ${local}=${alias};`)
              return `${imported} as ${alias}`
            })
            if (aliases.length === 0) return whole
            return `import{${next.join(',')}}from${from};${aliases.join('')}`
          })
        }
      },
    },
  }
}
