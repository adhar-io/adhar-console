import { loadFromFiles, type Pattern } from './patterns.ts'

/**
 * Every `app/content/patterns/*.md`, bundled at build time — adding a file is
 * all it takes to publish a pattern. Kept apart from `patterns.ts` because
 * `import.meta.glob` exists only under Vite, not in the Deno test runner.
 */
const FILES = import.meta.glob(['../content/patterns/*.md', '!../content/patterns/README.md'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export const PATTERNS: Pattern[] = loadFromFiles(FILES)
