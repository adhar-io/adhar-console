/**
 * What a repository file is, from its name.
 *
 * The file viewer used to render every file as undifferentiated monospace
 * text, so a 400-line Go service and a `.gitignore` looked identical. Monaco
 * can highlight all of this; it only needs to be told which grammar to use,
 * and the only thing available to tell it is the path.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React in
 * its import map.
 */

/**
 * Extension → Monaco language id.
 *
 * Ids are Monaco's own, not ours: they are passed through to
 * `monaco.editor.create({ language })`, so a wrong id silently degrades to no
 * highlighting rather than failing, and a right one needs no mapping layer.
 */
const BY_EXT: Record<string, string> = {
  // web
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  // Monaco's JSON support lives in its `language/json` service, which runs in
  // a Web Worker; the viewer is worker-free (see monaco-loader.ts), so JSON
  // uses the JavaScript grammar instead. It highlights strings, numbers,
  // punctuation and the literals identically — what it drops is the schema
  // validation a read-only viewer never showed.
  json: 'javascript',
  jsonc: 'javascript',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  vue: 'html',
  svelte: 'html',
  // config / data
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  properties: 'ini',
  xml: 'xml',
  svg: 'xml',
  csv: 'plaintext',
  // infrastructure
  tf: 'hcl',
  tfvars: 'hcl',
  hcl: 'hcl',
  nomad: 'hcl',
  // languages
  go: 'go',
  mod: 'go',
  sum: 'plaintext',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  scala: 'scala',
  cs: 'csharp',
  fs: 'fsharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  m: 'objective-c',
  php: 'php',
  pl: 'perl',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  clj: 'clojure',
  jl: 'julia',
  // shell & ops
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  // query & docs
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  rst: 'plaintext',
  txt: 'plaintext',
  proto: 'proto',
}

/**
 * Files whose whole name carries the type, with no extension to read.
 *
 * `Dockerfile`, `Makefile` and the dotfiles are the ones a repository
 * actually contains; matched case-insensitively because `dockerfile` and
 * `DOCKERFILE` both occur in the wild.
 */
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  justfile: 'makefile',
  '.gitignore': 'plaintext',
  '.dockerignore': 'plaintext',
  '.gitattributes': 'plaintext',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.env': 'ini',
  'go.mod': 'go',
  'go.sum': 'plaintext',
  'cargo.toml': 'ini',
  license: 'plaintext',
  notice: 'plaintext',
  codeowners: 'plaintext',
}

/** Image extensions the viewer can show directly rather than as bytes. */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp'])

/** Extensions that are never text, so the viewer must not try to decode them. */
const BINARY_EXT = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'ogg',
  'so', 'dylib', 'dll', 'exe', 'bin', 'o', 'a', 'class', 'wasm',
  'db', 'sqlite', 'sqlite3',
])

/** The last path segment, lowercased. */
function baseName(path: string): string {
  return (path.split('/').pop() ?? path).toLowerCase()
}

/** The extension without its dot, or '' when there is none. */
export function extensionOf(path: string): string {
  const base = baseName(path)
  const dot = base.lastIndexOf('.')
  // `.gitignore` is a name, not an extension — a leading dot does not start one.
  if (dot <= 0) return ''
  return base.slice(dot + 1)
}

/**
 * The Monaco language for a path.
 *
 * Whole-name matches win over extensions, because `go.mod` and `go.sum` share
 * an extension family but not a grammar, and `Dockerfile.dev` should still be
 * a Dockerfile.
 */
export function languageForFilename(path: string): string {
  const base = baseName(path)
  if (BY_NAME[base]) return BY_NAME[base]
  // `Dockerfile.dev`, `Makefile.local`
  const stem = base.split('.')[0]
  if (stem && BY_NAME[stem] && !BY_EXT[extensionOf(path)]) return BY_NAME[stem]
  return BY_EXT[extensionOf(path)] ?? 'plaintext'
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(extensionOf(path))
}

export function isBinaryPath(path: string): boolean {
  return BINARY_EXT.has(extensionOf(path))
}

/**
 * Does this decoded content look like bytes rather than text?
 *
 * Extension alone is not enough — repositories hold binaries under names with
 * no extension at all. A NUL byte never appears in UTF-8 text, so one in the
 * first few KB is conclusive; everything else is left to the extension list.
 */
export function looksBinary(text: string): boolean {
  const window = text.slice(0, 4096)
  return window.includes('\u0000')
}

/**
 * Monaco is a code editor, not a log viewer: a multi-megabyte file freezes the
 * tab while it tokenises. Past this the viewer shows the file plainly instead.
 */
export const MAX_EDITOR_BYTES = 800_000
